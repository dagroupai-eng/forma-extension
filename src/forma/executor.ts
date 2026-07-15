import { Forma } from 'forma-embedded-view-sdk/auto';
import { calculateSurfaceArea, round2 } from './geometry';
import { highlightElements, clearHighlights } from './highlight';
import { classifyRoomUnitType } from './room_classification';
import { GYEONGJU_LIBRARY_REQUIREMENTS, parseRequirementsFromText } from '../data/building_requirements';
import type { BuildingRequirements, CorePosition, CoreTemplate } from '../data/building_requirements';
import {
  clearAllMasses,
  placeBuildingMasses,
  recreateBuildingsWithFloorPlans,
  canonicalizeRequirementsForFloorStack,
  resolveAuthorizedFloorLabels,
  testGenericRoomProgramCompatibility,
  testMinimalFloorPlanRecreation,
  testFloorPlanUnitCompatibility,
  testProgressiveFloorPlanRecreation,
  testCombinedFloorPlanRecreation,
  testCircularFloorStackMass,
  testRingAtriumFloorStackMass,
  testFloorStackPlanUnits,
} from './mass_generator';

/**
 * Normalizes raw requirements supplied by Claude, PDF extraction, or pasted JSON
 * into the BuildingRequirements shape used by the Forma execution layer.
 *
 * - Derives footprint_area from target_floor_area / target_floors when needed.
 * - Fills missing position_hint values with conservative defaults.
 * - Recomputes derived_metrics from normalized building values.
 */
function normalizeRequirements(raw: Record<string, any>): BuildingRequirements {
  const DEFAULT_POSITIONS = ['center', 'northeast', 'southwest', 'southeast', 'northwest', 'north', 'south'];
  const CORE_POSITIONS: CorePosition[] = [
    'center',
    'west',
    'east',
    'north',
    'south',
    'northwest',
    'northeast',
    'southwest',
    'southeast',
  ];
  const cleanText = (value: unknown): string =>
    String(value ?? '')
      .replace(/\uFFFD/g, ' ')
      .replace(/\?{2,}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const normalizeSpecialUnitType = (
    value: unknown,
    roomId?: unknown,
    fallbackName?: unknown,
  ): 'CORE' | 'CORRIDOR' | 'PARKING' | undefined => {
    const unitType = classifyRoomUnitType({
      group: cleanText(value),
      room_id: cleanText(roomId),
      function_id: cleanText(roomId),
      name: cleanText(fallbackName),
    });
    return unitType === 'LIVING_UNIT' ? undefined : unitType;
  };
  const normalizeCoreProximity = (value: unknown): 'required' | 'preferred' | 'neutral' | undefined => {
    const raw = cleanText(value).toLowerCase().replace(/[-_\s]/g, '');
    if (!raw) return undefined;
    if (['required', 'require', 'core', 'coreadjacent', 'nearcore', 'adjacentcore', 'yes', 'true'].includes(raw)) return 'required';
    if (['preferred', 'prefer', 'near', 'close'].includes(raw)) return 'preferred';
    if (['neutral', 'none', 'no', 'false', 'n/a', 'na'].includes(raw)) return 'neutral';
    return undefined;
  };
  const normalizeDaylightPriority = (value: unknown): 'high' | 'medium' | 'low' | undefined => {
    const raw = cleanText(value).toLowerCase();
    if (!raw) return undefined;
    if (raw.includes('high')) return 'high';
    if (raw.includes('medium') || raw.includes('mid')) return 'medium';
    if (raw.includes('low') || raw.includes('none')) return 'low';
    return undefined;
  };
  const normalizeNoiseLevel = (value: unknown): 'low' | 'medium' | 'medium-high' | 'high' | undefined => {
    const raw = cleanText(value).toLowerCase();
    if (!raw) return undefined;
    if (raw.includes('very') || raw.includes('high')) return raw.includes('medium') ? 'medium-high' : 'high';
    if (raw.includes('medium-high') || raw.includes('medium high')) return 'medium-high';
    if (raw.includes('medium') || raw.includes('mid')) return 'medium';
    if (raw.includes('low') || raw.includes('none')) return 'low';
    return undefined;
  };
  const normalizeShapePreference = (value: unknown):
    | 'RECTANGLE'
    | 'L_SHAPE'
    | 'U_SHAPE'
    | 'COMPACT_RECTANGLE'
    | 'LONG_RECTANGLE_AVOID'
    | 'CORE'
    | undefined => {
    const raw = cleanText(value).toUpperCase().replace(/[\s-]+/g, '_');
    if (!raw) return undefined;
    if (raw.includes('L_SHAPE') || raw.includes('\\u3131')) return 'L_SHAPE';
    if (raw.includes('U_SHAPE') || raw.includes('\\u3137')) return 'U_SHAPE';
    if (raw.includes('LONG') && raw.includes('AVOID')) return 'LONG_RECTANGLE_AVOID';
    if (raw.includes('COMPACT')) return 'COMPACT_RECTANGLE';
    if (raw.includes('CORE')) return 'CORE';
    if (raw.includes('RECT')) return 'RECTANGLE';
    return undefined;
  };
  const normalizeStringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const items = value.map((item) => cleanText(item)).filter(Boolean);
    return items.length > 0 ? items : undefined;
  };
  const normalizeAspectRatioPreference = (value: any): { min?: number; max?: number } | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const min = Number(value.min);
    const max = Number(value.max);
    const result: { min?: number; max?: number } = {};
    if (Number.isFinite(min) && min > 0) result.min = min;
    if (Number.isFinite(max) && max > 0) result.max = max;
    return Object.keys(result).length > 0 ? result : undefined;
  };
  const normalizeFootprintDimensions = (
    areaValue: unknown,
    widthValue: unknown,
    depthValue: unknown,
  ): { footprint_width_m?: number; footprint_depth_m?: number } => {
    const area = Number(areaValue);
    const width = Number(widthValue);
    const depth = Number(depthValue);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(depth) || depth <= 0) return {};
    if (!Number.isFinite(area) || area <= 0) {
      return { footprint_width_m: width, footprint_depth_m: depth };
    }

    const product = width * depth;
    if (product <= 0) return {};
    const mismatchRatio = Math.abs(product - area) / area;
    if (mismatchRatio <= 0.05) {
      return { footprint_width_m: width, footprint_depth_m: depth };
    }

    const scale = Math.sqrt(area / product);
    return {
      footprint_width_m: parseFloat((width * scale).toFixed(2)),
      footprint_depth_m: parseFloat((depth * scale).toFixed(2)),
    };
  };
  const normalizeCoreTemplate = (value: any): CoreTemplate | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const width = Number(value.width_m ?? value.width ?? value.w ?? 0);
    const depth = Number(value.depth_m ?? value.depth ?? value.d ?? 0);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(depth) || depth <= 0) return undefined;
    const rawPosition = String(value.position ?? 'center').toLowerCase();
    const position = (CORE_POSITIONS.includes(rawPosition as CorePosition) ? rawPosition : 'center') as CorePosition;
    const polygon = Array.isArray(value.polygon)
      ? value.polygon
          .filter((point: any) => Array.isArray(point) && point.length >= 2)
          .map((point: any) => [Number(point[0]), Number(point[1])])
          .filter((point: number[]) => point.every((coord) => Number.isFinite(coord)))
      : undefined;

    return {
      width_m: width,
      depth_m: depth,
      position,
      ...(value.fixed_across_floors !== undefined ? { fixed_across_floors: Boolean(value.fixed_across_floors) } : {}),
      ...(Array.isArray(value.applicable_floors) ? { applicable_floors: value.applicable_floors.map((v: any) => String(v)) } : {}),
      ...(Number.isFinite(Number(value.center_x_m)) ? { center_x_m: Number(value.center_x_m) } : {}),
      ...(Number.isFinite(Number(value.center_y_m)) ? { center_y_m: Number(value.center_y_m) } : {}),
      ...(Number.isFinite(Number(value.offset_x_m)) ? { offset_x_m: Number(value.offset_x_m) } : {}),
      ...(Number.isFinite(Number(value.offset_y_m)) ? { offset_y_m: Number(value.offset_y_m) } : {}),
      ...(value.room_name ? { room_name: String(value.room_name) } : {}),
      ...(value.function_id ? { function_id: String(value.function_id) } : {}),
      ...(polygon && polygon.length >= 4 ? { polygon } : {}),
    };
  };
  const normalizeCoreTemplateCollection = (value: any): CoreTemplate | CoreTemplate[] | undefined => {
    if (Array.isArray(value)) {
      const templates = value
        .map((entry) => normalizeCoreTemplate(entry))
        .filter((entry): entry is CoreTemplate => Boolean(entry));
      return templates.length > 0 ? templates : undefined;
    }
    return normalizeCoreTemplate(value);
  };

  const normalizeFloorLabel = (label: string): string => {
    const normalized = String(label ?? '').trim().toUpperCase();
    const numericBasement = normalized.match(/^-(\d+)$/);
    if (numericBasement) return `B${numericBasement[1]}`;
    const above = normalized.match(/^(\d+)$/);
    if (above) return `${above[1]}F`;
    return String(label);
  };
  const floorLabelAliases = (label: string): string[] => {
    const normalized = normalizeFloorLabel(label);
    const aliases = new Set<string>([label, normalized]);
    const basement = normalized.toUpperCase().match(/^B(\d+)$/);
    if (basement) aliases.add(`-${basement[1]}`);
    const above = normalized.toUpperCase().match(/^(\d+)F$/);
    if (above) aliases.add(above[1]);
    return [...aliases];
  };
  const getFloorRecordValue = <T>(record: Record<string, T> | undefined, label: string): T | undefined => {
    if (!record) return undefined;
    for (const alias of floorLabelAliases(label)) {
      if (Object.prototype.hasOwnProperty.call(record, alias)) return record[alias];
    }
    return undefined;
  };

  const normalizeRoom = (room: any): any | null => {
    const area = Number(room?.area_m2 ?? room?.area ?? room?.size);
    if (!Number.isFinite(area) || area <= 0) return null;
    const roomName = cleanText(room?.name ?? room?.room_name ?? room?.name_ko ?? room?.name_en ?? room?.label ?? room?.id ?? 'Room');
    const roomId = cleanText(room?.room_id ?? room?.id ?? '');
    const unitType = normalizeSpecialUnitType(
      room?.unit_type ?? room?.functionGroup ?? room?.group,
      roomId,
      roomName,
    );

    return {
      name: roomName,
      ...(roomId ? { room_id: roomId } : {}),
      area_m2: area,
      ...(room?.function_id || roomId ? { function_id: cleanText(room.function_id ?? roomId) } : {}),
      ...(unitType ? { unit_type: unitType } : {}),
      ...(room?.group || room?.functionGroup ? { group: cleanText(room.group ?? room.functionGroup) } : {}),
      ...(room?.facade_required !== undefined || room?.facade !== undefined
        ? { facade_required: Boolean(room.facade_required ?? room.facade) }
        : {}),
      ...(normalizeCoreProximity(room?.core_proximity ?? room?.coreProximity) ? { core_proximity: normalizeCoreProximity(room.core_proximity ?? room.coreProximity) } : {}),
      ...(normalizeDaylightPriority(room?.daylight_priority ?? room?.daylight) ? { daylight_priority: normalizeDaylightPriority(room.daylight_priority ?? room.daylight) } : {}),
      ...(normalizeNoiseLevel(room?.noise_level ?? room?.noise) ? { noise_level: normalizeNoiseLevel(room.noise_level ?? room.noise) } : {}),
      ...(room?.placement_hint ? { placement_hint: cleanText(room.placement_hint) } : {}),
      ...(room?.zone_hint ? { zone_hint: cleanText(room.zone_hint) } : {}),
      ...(room?.edge_preference ? { edge_preference: cleanText(room.edge_preference) } : {}),
      ...(normalizeShapePreference(room?.shape_preference) ? { shape_preference: normalizeShapePreference(room.shape_preference) } : {}),
      ...(normalizeAspectRatioPreference(room?.aspect_ratio_preference) ? { aspect_ratio_preference: normalizeAspectRatioPreference(room.aspect_ratio_preference) } : {}),
      ...(normalizeStringArray(room?.adjacent_to) ? { adjacent_to: normalizeStringArray(room.adjacent_to) } : {}),
      ...(normalizeStringArray(room?.required_adjacency) ? { required_adjacency: normalizeStringArray(room.required_adjacency) } : {}),
      ...(normalizeStringArray(room?.avoid_adjacency) ? { avoid_adjacency: normalizeStringArray(room.avoid_adjacency) } : {}),
      ...(Array.isArray(room?.polygon)
        ? {
            polygon: room.polygon
              .filter((point: any) => Array.isArray(point) && point.length >= 2)
              .map((point: any) => [Number(point[0]), Number(point[1])]),
          }
        : {}),
    };
  };

  const polygonArea = (polygon: [number, number][]): number => {
    if (!Array.isArray(polygon) || polygon.length < 3) return 0;
    const normalized =
      polygon.length > 1 &&
      polygon[0][0] === polygon[polygon.length - 1][0] &&
      polygon[0][1] === polygon[polygon.length - 1][1]
        ? polygon
        : [...polygon, polygon[0]];

    let area = 0;
    for (let i = 0; i < normalized.length - 1; i += 1) {
      const [x1, y1] = normalized[i];
      const [x2, y2] = normalized[i + 1];
      area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area) / 2;
  };

  const normalizePolygon = (polygon: any): [number, number][] =>
    Array.isArray(polygon)
      ? polygon
          .filter((point: any) => Array.isArray(point) && point.length >= 2)
          .map((point: any) => [Number(point[0]), Number(point[1])])
      : [];

  const normalizeFloorPlanEntry = (floor: string, entry: any): any[] => {
    if (Array.isArray(entry)) {
      return entry.map(normalizeRoom).filter(Boolean);
    }

    if (!entry || typeof entry !== 'object') return [];

    const roomArray = Array.isArray(entry.rooms)
      ? entry.rooms
      : Array.isArray(entry.zones)
        ? entry.zones
        : null;

    if (roomArray) {
      const rooms = roomArray.map(normalizeRoom).filter(Boolean);
      const corridorRooms = Array.isArray(entry.corridor_polygons)
        ? entry.corridor_polygons
            .map((polygon: any, index: number) => {
              const normalizedPolygon = normalizePolygon(polygon);
              if (normalizedPolygon.length < 4) return null;
              return normalizeRoom({
                name: `Corridor ${index + 1}`,
                area_m2: polygonArea(normalizedPolygon),
                unit_type: 'CORRIDOR',
                function_id: `corridor-${floor.toLowerCase()}-${index + 1}`,
                polygon: normalizedPolygon,
              });
            })
            .filter(Boolean)
        : [];

      return [...rooms, ...corridorRooms];
    }

    const nestedArray = Object.values(entry).find((nested) => Array.isArray(nested));
    if (Array.isArray(nestedArray)) {
      return nestedArray.map(normalizeRoom).filter(Boolean);
    }

    return Object.values(entry).map(normalizeRoom).filter(Boolean);
  };

  const normalizeFloorPlans = (value: any): Record<string, any[]> => {
    if (!value || typeof value !== 'object') return {};

    return Object.fromEntries(
      Object.entries(value).map(([floor, rooms]) => [floor, normalizeFloorPlanEntry(floor, rooms)]),
    );
  };
  const inferUnitTypeFromZone = (zone: any): 'CORE' | 'CORRIDOR' | 'PARKING' | undefined =>
    normalizeSpecialUnitType(zone?.use_type, zone?.zone_id ?? zone?.id, zone?.name);

  const slugify = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

  const parseLevelToken = (value: unknown): { levelNum: number; label: string } | null => {
    if (Number.isFinite(Number(value))) {
      const n = Number(value);
      return { levelNum: n, label: n < 0 ? `B${Math.abs(n)}` : `${n}F` };
    }

    const text = String(value ?? '').trim();
    const basement = /^B(\d+)$/i.exec(text);
    if (basement) {
      const n = Number(basement[1]);
      return { levelNum: -n, label: `B${n}` };
    }

    const floor = /^(\d+)F$/i.exec(text);
    if (floor) {
      const n = Number(floor[1]);
      return { levelNum: n, label: `${n}F` };
    }

    const plain = /^-?\d+$/.exec(text);
    if (plain) {
      const n = Number(plain[0]);
      return { levelNum: n, label: n < 0 ? `B${Math.abs(n)}` : `${n}F` };
    }

    return null;
  };

  const unwrapProjectPlanningPayload = (value: Record<string, any>): Record<string, any> => {
    const project = value?.project;
    if (
      !project ||
      typeof project !== 'object' ||
      Array.isArray(value.levels) ||
      Array.isArray(value.buildings) ||
      (!Array.isArray(project.levels) && !Array.isArray(project.rooms))
    ) {
      return value;
    }

    return {
      ...project,
      project: { name: project.name },
      project_name: project.name,
      coordinateSystem: project.coordinateSystem,
      coreFixed: project.coreFixed,
      levels: project.levels,
      rooms: project.rooms,
      site_limits: {
        total_site_area: Number(project.siteArea_m2 ?? project.site_area_m2 ?? 0),
        max_floor_area_ratio: Number(project.targetFAR_percent ?? 0) > 0
          ? Number(project.targetFAR_percent) / 100
          : undefined,
        max_height_floors: Array.isArray(project.levels)
          ? project.levels.filter((level: any) => !String(level?.id ?? level?.level ?? '').toUpperCase().startsWith('B')).length
          : undefined,
      },
    };
  };

  raw = unwrapProjectPlanningPayload(raw);

  const convertZoneJsonToRequirements = (zoneJson: Record<string, any>): BuildingRequirements | null => {
    const levels = Array.isArray(zoneJson.levels) ? zoneJson.levels : [];
    if (!levels.length) return null;
    const topLevelRooms = Array.isArray(zoneJson.rooms) ? zoneJson.rooms : [];
    const roomsByLevel = new Map<string, any[]>();
    for (const room of topLevelRooms) {
      const parsed = parseLevelToken(room?.level ?? room?.floor ?? room?.floor_name);
      if (!parsed) continue;
      roomsByLevel.set(parsed.label, [...(roomsByLevel.get(parsed.label) ?? []), room]);
    }

    const sortedLevels = [...levels]
      .map((level) => {
        const parsed = parseLevelToken(level?.level ?? level?.floor_name ?? level?.id);
        return parsed ? { ...level, __level_num: parsed.levelNum, __level_label: parsed.label } : null;
      })
      .filter((level): level is Record<string, any> => level !== null)
      .sort((a, b) => Number(a.__level_num) - Number(b.__level_num));
    const aboveFloorBreakdown: Record<string, number> = {};
    const aboveFloorHeights: Record<string, number> = {};
    const aboveFloorPlans: Record<string, any[]> = {};
    const basementFloorBreakdown: Record<string, number> = {};
    const basementFloorHeights: Record<string, number> = {};
    const basementFloorPlans: Record<string, any[]> = {};
    const coreFloors: string[] = [];
    let derivedCoreTemplate: Record<string, any> | undefined;
    let maxAboveFootprintArea = 0;

    if (zoneJson.coreFixed && typeof zoneJson.coreFixed === 'object') {
      const core = zoneJson.coreFixed;
      const width = Number(core.dimensions?.x ?? core.width_m ?? 0);
      const depth = Number(core.dimensions?.y ?? core.depth_m ?? 0);
      const centerX = Number(core.centerPosition?.x ?? core.center_x_m);
      const centerY = Number(core.centerPosition?.y ?? core.center_y_m);
      if (Number.isFinite(width) && width > 0 && Number.isFinite(depth) && depth > 0) {
        derivedCoreTemplate = {
          width_m: width,
          depth_m: depth,
          position: 'center',
          fixed_across_floors: Boolean(core.fixed ?? true),
          ...(Number.isFinite(centerX) ? { center_x_m: centerX } : {}),
          ...(Number.isFinite(centerY) ? { center_y_m: centerY } : {}),
          room_name: 'Core',
          function_id: 'core',
        };
      }
    }

    const normalizeScheduleRoom = (room: any): any => {
      const roomName = cleanText(room?.name_ko ?? room?.name ?? room?.name_en ?? room?.id ?? 'Room');
      const group = cleanText(room?.functionGroup ?? room?.group ?? '');
      const unitType = normalizeSpecialUnitType(room?.unit_type ?? group, room?.id, roomName);
      return {
        name: roomName,
        ...(room?.id ? { room_id: cleanText(room.id) } : {}),
        area_m2: Number(room?.area_m2 ?? 0),
        function_id: cleanText(room?.id ?? roomName).toLowerCase(),
        ...(unitType ? { unit_type: unitType } : {}),
        ...(group ? { group } : {}),
        ...(room?.facade !== undefined ? { facade_required: Boolean(room.facade) } : {}),
        ...(room?.coreProximity ? { core_proximity: cleanText(room.coreProximity).toLowerCase() } : {}),
        ...(room?.daylight ? { daylight_priority: cleanText(room.daylight).toLowerCase() } : {}),
        ...(room?.noise ? { noise_level: cleanText(room.noise).toLowerCase() } : {}),
        ...(Array.isArray(room?.adjacency) ? { required_adjacency: room.adjacency.map((value: any) => cleanText(value)).filter(Boolean) } : {}),
        ...(Array.isArray(room?.avoid) ? { avoid_adjacency: room.avoid.map((value: any) => cleanText(value)).filter(Boolean) } : {}),
      };
    };

    for (const level of sortedLevels) {
      const levelNum = Number(level.__level_num);
      const label = String(level.__level_label);
      const zones = Array.isArray(level.zones) ? level.zones : [];
      const levelRooms = roomsByLevel.get(label) ?? [];
      const normalizedZones = zones.length > 0
        ? zones.map((zone: any) => ({
            name: cleanText(zone?.name ?? zone?.zone_id ?? 'Room'),
            area_m2: Number(zone?.area_m2 ?? 0),
            function_id: slugify(cleanText(zone?.name ?? zone?.zone_id ?? 'room')),
            ...(inferUnitTypeFromZone(zone) ? { unit_type: inferUnitTypeFromZone(zone) } : {}),
            polygon: Array.isArray(zone?.polygon)
              ? zone.polygon
                  .filter((point: any) => Array.isArray(point) && point.length >= 2)
                  .map((point: any) => [Number(point[0]), Number(point[1])])
              : undefined,
          }))
        : levelRooms.map(normalizeScheduleRoom);

      const roomArea = normalizedZones.reduce((sum: number, zone: any) => sum + (Number(zone.area_m2) || 0), 0);
      const floorArea = Number(level.plate_m2 ?? level.area_m2 ?? roomArea) || roomArea;
      const floorHeight = Number(level.height_m ?? level.height ?? Math.max(...zones.map((zone: any) => Number(zone?.height_m ?? 0)), 0));
      const coreZone = zones.find((zone: any) => {
        return normalizeSpecialUnitType(zone?.use_type, zone?.zone_id ?? zone?.id, zone?.name) === 'CORE';
      });

      if (coreZone?.is_consistent_across_floors && Array.isArray(coreZone?.polygon) && coreZone.polygon.length >= 4) {
        const xs = coreZone.polygon.map((point: any) => Number(point[0]));
        const ys = coreZone.polygon.map((point: any) => Number(point[1]));
        derivedCoreTemplate = {
          width_m: Math.max(...xs) - Math.min(...xs),
          depth_m: Math.max(...ys) - Math.min(...ys),
          position: 'center',
          center_x_m: (Math.max(...xs) + Math.min(...xs)) / 2,
          center_y_m: (Math.max(...ys) + Math.min(...ys)) / 2,
          fixed_across_floors: true,
          room_name: cleanText(coreZone.name ?? 'Core'),
          function_id: slugify(cleanText(coreZone.name ?? 'core')),
        };
        coreFloors.push(label);
      }

      if (levelNum < 0) {
        basementFloorBreakdown[label] = floorArea;
        basementFloorHeights[label] = floorHeight;
        basementFloorPlans[label] = normalizedZones;
      } else {
        aboveFloorBreakdown[label] = floorArea;
        aboveFloorHeights[label] = floorHeight;
        aboveFloorPlans[label] = normalizedZones;
        maxAboveFootprintArea = Math.max(maxAboveFootprintArea, floorArea);
      }
    }

    if (derivedCoreTemplate && coreFloors.length) {
      derivedCoreTemplate.applicable_floors = coreFloors;
    }

    const totalAbove = Object.values(aboveFloorBreakdown).reduce((sum, value) => sum + value, 0);
    const totalBasement = Object.values(basementFloorBreakdown).reduce((sum, value) => sum + value, 0);
    const building: any = {
      name: cleanText(zoneJson.project?.name ?? zoneJson.project_name ?? 'Imported Zone Building'),
      target_floor_area: totalAbove + totalBasement,
      target_floors: Object.keys(aboveFloorBreakdown).length,
      footprint_area: maxAboveFootprintArea || totalAbove,
      ...(Number.isFinite(Number(zoneJson.coordinateSystem?.typicalFloorPlate?.x_dim)) ? { footprint_width_m: Number(zoneJson.coordinateSystem.typicalFloorPlate.x_dim) } : {}),
      ...(Number.isFinite(Number(zoneJson.coordinateSystem?.typicalFloorPlate?.y_dim)) ? { footprint_depth_m: Number(zoneJson.coordinateSystem.typicalFloorPlate.y_dim) } : {}),
      mass_layout_type: 'RECTANGLE',
      position_hint: 'center',
      floor_breakdown: aboveFloorBreakdown,
      floor_heights_m: aboveFloorHeights,
      floor_plans: aboveFloorPlans,
      ...(derivedCoreTemplate ? { core_template: derivedCoreTemplate } : {}),
      ...(Object.keys(basementFloorBreakdown).length
        ? {
            basement: {
              floors: Object.keys(basementFloorBreakdown).length,
              area_m2: totalBasement,
              use: 'Basement',
              floor_breakdown: basementFloorBreakdown,
              floor_heights_m: basementFloorHeights,
              floor_plans: basementFloorPlans,
            },
          }
        : {}),
    };

    const siteLimits = zoneJson.site_limits && typeof zoneJson.site_limits === 'object' ? zoneJson.site_limits : {};
    const siteArea = Number(siteLimits.total_site_area ?? zoneJson.siteArea_m2 ?? zoneJson.site_area_m2 ?? 0);
    const targetFar = Number(siteLimits.max_floor_area_ratio ?? zoneJson.targetFAR_percent);

    return normalizeRequirements({
      project_name: cleanText(zoneJson.project?.name ?? zoneJson.project_name ?? 'Imported Zone Building'),
      location: cleanText(zoneJson.site_id ?? ''),
      site_limits: {
        ...siteLimits,
        total_site_area: Number.isFinite(siteArea) && siteArea > 0 ? siteArea : 0,
        max_floor_area_ratio: Number.isFinite(targetFar) && targetFar > 0
          ? (targetFar > 100 ? targetFar / 100 : targetFar)
          : 10,
        max_building_coverage_ratio: Number(siteLimits.max_building_coverage_ratio ?? 1),
        max_height_floors: Object.keys(aboveFloorBreakdown).length,
      },
      buildings: [building],
      parking: {},
    });
  };


  if (Array.isArray(raw.levels) && raw.levels.length > 0) {
    const converted = convertZoneJsonToRequirements(raw);
    if (converted) return converted;
  }

  const buildings = ((raw.buildings ?? []) as any[]).map((b, i) => {
    const floors = b.target_floors ?? 3;
    const floorArea = b.target_floor_area ?? 1000;
    const footprint = b.footprint_area ?? Math.round(floorArea / floors);
    const normalizedFootprint = normalizeFootprintDimensions(footprint, b.footprint_width_m, b.footprint_depth_m);
    const basementArea = Number(b.basement?.area_m2 ?? 0);
    const normalizedBasementFootprint = normalizeFootprintDimensions(
      basementArea || Object.values(b.basement?.floor_breakdown ?? {}).reduce((sum: number, value: any) => sum + (Number(value) || 0), 0),
      b.basement?.footprint_width_m,
      b.basement?.footprint_depth_m,
    );

    return {
      name: cleanText(b.name ?? `Building ${String.fromCharCode(65 + i)}`),
      target_floor_area: floorArea,
      target_floors: floors,
      footprint_area: footprint,
      mass_layout_type: b.mass_layout_type ?? 'AUTO',
      ...normalizedFootprint,
      ...(Number.isFinite(Number(b.base_offset_m)) ? { base_offset_m: Number(b.base_offset_m) } : {}),
      ...(normalizeCoreTemplateCollection(b.core_template) ? { core_template: normalizeCoreTemplateCollection(b.core_template) } : {}),
      position_hint: b.position_hint ?? DEFAULT_POSITIONS[i % DEFAULT_POSITIONS.length],
      floor_breakdown: b.floor_breakdown ?? {},
      floor_heights_m: b.floor_heights_m ?? b.floor_heights ?? {},
      floor_plans: normalizeFloorPlans(b.floor_plans),
      floor_layout_types: b.floor_layout_types ?? {},
      floor_layout_intents: b.floor_layout_intents ?? {},
      ...(b.basement ? {
        basement: {
          ...b.basement,
          ...normalizedBasementFootprint,
          ...(normalizeCoreTemplateCollection(b.basement.core_template)
            ? { core_template: normalizeCoreTemplateCollection(b.basement.core_template) }
            : {}),
          floor_plans: normalizeFloorPlans(b.basement.floor_plans),
          floor_layout_types: b.basement.floor_layout_types ?? {},
          floor_layout_intents: b.basement.floor_layout_intents ?? {},
        },
      } : {}),
    };
  });

  const siteLimits = raw.site_limits ?? {};
  const siteArea: number = siteLimits.total_site_area ?? 0;
  const totalFootprint = buildings.reduce((s, b) => s + b.footprint_area, 0);
  const totalFloorArea = buildings.reduce((s, b) => s + b.target_floor_area, 0);
  const coverageRatio = siteLimits.max_building_coverage_ratio ?? 0.6;

  return {
    project: {
      name: cleanText(raw.project_name ?? '(uploaded project)'),
      location: cleanText(raw.location ?? ''),
      total_floor_area_m2: totalFloorArea,
    },
    site_limits: {
      total_site_area: siteArea,
      max_building_coverage_ratio: coverageRatio,
      max_floor_area_ratio: siteLimits.max_floor_area_ratio ?? 2.0,
      max_height_floors: siteLimits.max_height_floors ?? 20,
    },
    buildings,
    parking: {
      required_parking_spots: raw.parking?.required_parking_spots ?? 0,
      location_hint: raw.parking?.location_hint ?? '',
    },
    derived_metrics: {
      total_footprint_area: totalFootprint,
      actual_coverage_ratio: siteArea > 0 ? parseFloat((totalFootprint / siteArea).toFixed(4)) : 0,
      actual_floor_area_ratio: siteArea > 0 ? parseFloat((totalFloorArea / siteArea).toFixed(4)) : 0,
      remaining_buildable_area: siteArea > 0 ? siteArea * coverageRatio - totalFootprint : 0,
    },
  };
}
function normalizeFloorAreasFromRooms(requirements: BuildingRequirements): BuildingRequirements {
  const normalizeFloorLabel = (label: string): string => {
    const normalized = String(label ?? '').trim().toUpperCase();
    const numericBasement = normalized.match(/^-(\d+)$/);
    if (numericBasement) return `B${numericBasement[1]}`;
    const above = normalized.match(/^(\d+)$/);
    if (above) return `${above[1]}F`;
    return String(label);
  };
  const floorLabelAliases = (label: string): string[] => {
    const normalized = normalizeFloorLabel(label);
    const aliases = new Set<string>([label, normalized]);
    const basement = normalized.toUpperCase().match(/^B(\d+)$/);
    if (basement) aliases.add(`-${basement[1]}`);
    const above = normalized.toUpperCase().match(/^(\d+)F$/);
    if (above) aliases.add(above[1]);
    return [...aliases];
  };
  const getFloorRecordValue = <T>(record: Record<string, T> | undefined, label: string): T | undefined => {
    if (!record) return undefined;
    for (const alias of floorLabelAliases(label)) {
      if (Object.prototype.hasOwnProperty.call(record, alias)) return record[alias];
    }
    return undefined;
  };
  const sumRooms = (rooms?: any[]): number =>
    (Array.isArray(rooms) ? rooms : []).reduce((sum, room) => sum + (Number(room?.area_m2) || 0), 0);
  const polygonBoundsArea = (rooms?: any[]): number => {
    const points = (Array.isArray(rooms) ? rooms : [])
      .flatMap((room) => Array.isArray(room?.polygon) ? room.polygon : [])
      .filter((point) => Array.isArray(point) && point.length >= 2)
      .map((point) => [Number(point[0]), Number(point[1])] as [number, number])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (!points.length) return 0;

    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  };

  return {
    ...requirements,
    buildings: requirements.buildings.map((building) => {
      const normalizedAbovePlans = Object.fromEntries(
        Object.entries(building.floor_plans ?? {}).map(([floor, rooms]) => [floor, Array.isArray(rooms) ? rooms : []]),
      );
      const normalizedBasementPlans = Object.fromEntries(
        Object.entries(building.basement?.floor_plans ?? {}).map(([floor, rooms]) => [floor, Array.isArray(rooms) ? rooms : []]),
      );

      const authorizedAboveLabels = resolveAuthorizedFloorLabels(building, 'above');
      const authorizedBasementLabels = resolveAuthorizedFloorLabels(building, 'basement');

      const normalizedAboveBreakdown: Record<string, number> = Object.fromEntries(
        authorizedAboveLabels.map((floor) => {
          const rooms = getFloorRecordValue(normalizedAbovePlans, floor) ?? [];
          const roomSum = sumRooms(rooms);
          const boundsArea = polygonBoundsArea(rooms);
          const fallback = Number(getFloorRecordValue(building.floor_breakdown, floor) ?? 0);
          return [floor, fallback > 0 ? fallback : Math.max(roomSum, boundsArea)];
        }),
      );

      const normalizedBasementBreakdown: Record<string, number> = Object.fromEntries(
        authorizedBasementLabels.map((floor) => {
          const rooms = getFloorRecordValue(normalizedBasementPlans, floor) ?? [];
          const roomSum = sumRooms(rooms);
          const boundsArea = polygonBoundsArea(rooms);
          const fallback = Number(getFloorRecordValue(building.basement?.floor_breakdown, floor) ?? 0);
          return [floor, fallback > 0 ? fallback : Math.max(roomSum, boundsArea)];
        }),
      );

      const allFloorAreas = [
        ...Object.values(normalizedAboveBreakdown),
        ...Object.values(normalizedBasementBreakdown),
      ].filter((value) => Number.isFinite(value) && value > 0);
      const aboveFloorAreas = Object.values(normalizedAboveBreakdown)
        .filter((value) => Number.isFinite(value) && value > 0);

      return {
        ...building,
        target_floor_area: allFloorAreas.reduce((sum, value) => sum + value, 0) || building.target_floor_area,
        target_floors: building.target_floors > 0
          ? building.target_floors
          : Object.keys(normalizedAboveBreakdown).length,
        footprint_area: Math.max(...aboveFloorAreas, Number(building.footprint_area || 0)) || building.footprint_area,
        floor_breakdown: normalizedAboveBreakdown,
        floor_plans: Object.fromEntries(
          authorizedAboveLabels.map((floor) => [floor, getFloorRecordValue(normalizedAbovePlans, floor) ?? []]),
        ),
        ...(building.basement
          ? {
              basement: {
                ...building.basement,
                area_m2:
                  Object.values(normalizedBasementBreakdown).reduce((sum, value) => sum + value, 0) ||
                  building.basement.area_m2,
                floors: Object.keys(normalizedBasementBreakdown).length || building.basement.floors,
                floor_breakdown: normalizedBasementBreakdown,
                floor_plans: Object.fromEntries(
                  authorizedBasementLabels.map((floor) => [floor, getFloorRecordValue(normalizedBasementPlans, floor) ?? []]),
                ),
              },
            }
          : {}),
      };
    }),
  };
}

function summarizeZoneJson(raw: Record<string, any>): {
  status: 'success' | 'failed';
  project_name?: string;
  site_id?: string;
  level_count?: number;
  zone_count?: number;
  consistent_core_levels?: string[];
  normalized_zone_json?: Record<string, any>;
  mass_shell_requirements?: BuildingRequirements;
  note?: string;
  message?: string;
} {
  const levels = Array.isArray(raw.levels) ? raw.levels : [];
  const cleanText = (value: unknown): string =>
    String(value ?? '')
      .replace(/\uFFFD/g, ' ')
      .replace(/\?{2,}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const parseLevelToken = (value: unknown): { levelNum: number; label: string } | null => {
    if (Number.isFinite(Number(value))) {
      const n = Number(value);
      return { levelNum: n, label: n < 0 ? `B${Math.abs(n)}` : `${n}F` };
    }
    const text = String(value ?? '').trim();
    const basement = /^B(\d+)$/i.exec(text);
    if (basement) {
      const n = Number(basement[1]);
      return { levelNum: -n, label: `B${n}` };
    }
    const floor = /^(\d+)F$/i.exec(text);
    if (floor) {
      const n = Number(floor[1]);
      return { levelNum: n, label: `${n}F` };
    }
    const plain = /^-?\d+$/.exec(text);
    if (plain) {
      const n = Number(plain[0]);
      return { levelNum: n, label: n < 0 ? `B${Math.abs(n)}` : `${n}F` };
    }
    return null;
  };
  if (!levels.length) {
    return {
      status: 'failed',
      message: 'A levels array is required to prepare a Zone JSON package.',
    };
  }

  const normalizedLevels = levels
    .map((level: any) => {
      const parsedLevel = parseLevelToken(level.level ?? level.floor_name);
      if (!parsedLevel) return null;
      const levelNum = parsedLevel.levelNum;
      const levelLabel = parsedLevel.label;
      const elevationM = Number(level.elevation_m ?? 0);
      const zones = Array.isArray(level.zones) ? level.zones : [];
      const normalizedZones = zones
        .map((zone: any) => ({
          zone_id: cleanText(zone?.zone_id ?? zone?.name ?? 'zone'),
          name: cleanText(zone?.name ?? zone?.zone_id ?? 'Zone'),
          polygon: Array.isArray(zone?.polygon)
            ? zone.polygon
                .filter((point: any) => Array.isArray(point) && point.length >= 2)
                .map((point: any) => [Number(point[0]), Number(point[1])])
            : [],
          area_m2: Number(zone?.area_m2 ?? 0),
          use_type: cleanText(zone?.use_type ?? ''),
          color: cleanText(zone?.color ?? '#9B9B9B'),
          height_m: Number(zone?.height_m ?? level.height_m ?? 0),
          is_consistent_across_floors: Boolean(zone?.is_consistent_across_floors),
        }))
        .filter((zone: any) => zone.polygon.length >= 4 && Number.isFinite(zone.area_m2) && zone.area_m2 > 0);

      return {
        level: levelNum,
        elevation_m: elevationM,
        floor_name: cleanText(level.floor_name ?? levelLabel),
        zones: normalizedZones,
      };
    })
    .filter((level: any) => level && Number.isFinite(level.level) && level.zones.length > 0)
    .sort((a: any, b: any) => a.level - b.level);

  if (!normalizedLevels.length) {
    return {
      status: 'failed',
      message: 'No valid zones with polygon coordinates were found in the levels array.',
    };
  }

  const consistentCoreLevels = normalizedLevels
    .filter((level: any) =>
      level.zones.some((zone: any) => zone.is_consistent_across_floors && String(zone.use_type).toLowerCase().includes('core')),
    )
    .map((level: any) => (level.level < 0 ? `B${Math.abs(level.level)}` : `${level.level}F`));

  const zoneCount = normalizedLevels.reduce((sum: number, level: any) => sum + level.zones.length, 0);
  const normalizedZoneJson = {
    site_id: cleanText(raw.site_id ?? ''),
    project_name: cleanText(raw.project_name ?? 'Imported Zone Project'),
    coordinate_system: cleanText(raw.coordinate_system ?? ''),
    levels: normalizedLevels,
  };

  return {
    status: 'success',
    project_name: normalizedZoneJson.project_name,
    site_id: normalizedZoneJson.site_id,
    level_count: normalizedLevels.length,
    zone_count: zoneCount,
    consistent_core_levels: Array.from(new Set(consistentCoreLevels)),
    normalized_zone_json: normalizedZoneJson,
    mass_shell_requirements: normalizeRequirements(normalizedZoneJson),
    note: 'This package preserves exact zone polygons and consistent core coordinates. Use it as the source of truth when FloorStack room-unit creation is rejected by Forma.',
  };
}

function floorLabelToLevel(label: string): number | null {
  const basementMatch = /^B(\d+)$/i.exec(label.trim());
  if (basementMatch) return -Number(basementMatch[1]);

  const floorMatch = /^(\d+)F$/i.exec(label.trim());
  if (floorMatch) return Number(floorMatch[1]);

  return null;
}

function buildSyntheticFloorZones(
  floorLabel: string,
  rooms: any[],
  heightM: number,
  footprintArea: number,
  coreTemplate?: any,
): Array<Record<string, any>> {
  const normalizeSyntheticUseType = (room: any): string => {
    const raw = `${room?.unit_type ?? ''} ${room?.name ?? ''}`.toLowerCase();
    if (raw.includes('parking') || raw.includes('주차')) return 'PARKING';
    if (raw.includes('corridor') || raw.includes('lobby') || raw.includes('복도') || raw.includes('로비')) return 'CORRIDOR';
    if (
      raw.includes('core') ||
      raw.includes('코어')
    ) {
      return 'CORE';
    }
    return '';
  };
  const width = Math.max(12, Math.sqrt(Math.max(footprintArea, 1)) * 1.2);
  const depth = Math.max(12, footprintArea / width);
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  return rooms
    .map((room: any, index: number) => {
      const roomName = String(room?.name ?? `Room ${index + 1}`);
      const areaM2 = Number(room?.area_m2 ?? 0);
      if (!Number.isFinite(areaM2) || areaM2 <= 0) return null;

      let polygon = Array.isArray(room?.polygon) ? room.polygon : null;
      if (!polygon || polygon.length < 4) {
        const isCore = roomName.toLowerCase().includes('core');
        if (isCore && coreTemplate?.width_m && coreTemplate?.depth_m) {
          const cx = Number(coreTemplate.center_x_m ?? width / 2);
          const cy = Number(coreTemplate.center_y_m ?? depth / 2);
          const halfW = Number(coreTemplate.width_m) / 2;
          const halfD = Number(coreTemplate.depth_m) / 2;
          polygon = [
            [cx - halfW, cy - halfD],
            [cx + halfW, cy - halfD],
            [cx + halfW, cy + halfD],
            [cx - halfW, cy + halfD],
          ];
        } else {
          const targetWidth = Math.min(width, Math.max(4, Math.sqrt(areaM2)));
          const targetDepth = Math.max(4, areaM2 / targetWidth);

          if (cursorX + targetWidth > width) {
            cursorX = 0;
            cursorY += rowHeight;
            rowHeight = 0;
          }

          polygon = [
            [cursorX, cursorY],
            [cursorX + targetWidth, cursorY],
            [cursorX + targetWidth, cursorY + targetDepth],
            [cursorX, cursorY + targetDepth],
          ];

          cursorX += targetWidth;
          rowHeight = Math.max(rowHeight, targetDepth);
        }
      }

      return {
        zone_id: `${floorLabel}_${String(index + 1).padStart(2, '0')}`,
        name: roomName,
        polygon,
        area_m2: areaM2,
        use_type: normalizeSyntheticUseType(room),
        color: '#9B9B9B',
        height_m: heightM,
        is_consistent_across_floors: roomName.toLowerCase().includes('core'),
      };
    })
    .filter(Boolean) as Array<Record<string, any>>;
}

function requirementsToZoneJson(requirements: BuildingRequirements): Record<string, any> | null {
  const building = requirements.buildings?.[0];
  if (!building) return null;

  const levelMap = new Map<string, Record<string, any>>();
  let currentElevation = 0;

  const addLevel = (
    floorLabel: string,
    floorPlans: Record<string, any[]>,
    floorHeights: Record<string, number>,
    defaultElevation: number | null = null,
  ) => {
    const rooms = Array.isArray(floorPlans[floorLabel]) ? floorPlans[floorLabel] : [];
    if (!rooms.length) return;

    const levelNumber = floorLabelToLevel(floorLabel);
    if (levelNumber === null) return;

    const heightM = Number(floorHeights[floorLabel] ?? 0);
    const zones = buildSyntheticFloorZones(
      floorLabel,
      rooms,
      heightM,
      Number(building.footprint_area ?? building.target_floor_area ?? 1000),
      building.core_template,
    );

    if (!zones.length) return;

    const normalizedLevel = {
      level: levelNumber,
      elevation_m: defaultElevation ?? currentElevation,
      floor_name: floorLabel,
      zones,
    };
    levelMap.set(`${levelNumber}|${floorLabel}`, normalizedLevel);

    if (defaultElevation === null) currentElevation += heightM;
  };

  const basementLabels = Object.keys(building.basement?.floor_plans ?? {})
    .sort((a, b) => (floorLabelToLevel(a) ?? 0) - (floorLabelToLevel(b) ?? 0));
  const basementHeights = building.basement?.floor_heights_m ?? {};
  let basementElevation = 0;
  for (let i = basementLabels.length - 1; i >= 0; i -= 1) {
    const label = basementLabels[i];
    basementElevation -= Number(basementHeights[label] ?? 0);
    addLevel(label, building.basement?.floor_plans ?? {}, basementHeights, basementElevation);
  }

  const aboveLabels = Object.keys(building.floor_plans ?? {})
    .sort((a, b) => (floorLabelToLevel(a) ?? 0) - (floorLabelToLevel(b) ?? 0));
  for (const label of aboveLabels) {
    addLevel(label, building.floor_plans ?? {}, building.floor_heights_m ?? {});
  }

  const levels = Array.from(levelMap.values()).sort((a, b) => Number(a.level) - Number(b.level));
  if (!levels.length) return null;

  return {
    site_id: String(requirements.project.location || '')
      .replace(/\uFFFD/g, ' ')
      .replace(/\?{2,}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    project_name: String(building.name || requirements.project.name || 'Converted Zone Package')
      .replace(/\uFFFD/g, ' ')
      .replace(/\?{2,}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    coordinate_system: '',
    levels,
  };
}

/**
 * Executes Forma API calls requested by Claude tool use.
 * agent.ts calls this function after Claude selects a tool and input payload.
 */
export async function executeFormaTool(
  toolName: string,
  input: Record<string, any>,
): Promise<unknown> {
  switch (toolName) {
    // Geometry inspection.
    case 'get_elements_by_category': {
      const paths = await Forma.geometry.getPathsByCategory({
        category: input.category,
      });
      return {
        category: input.category,
        paths,
        count: paths.length,
      };
    }

    // Mesh diagnostics.
    case 'get_element_mesh_info': {
      const triangles = await Forma.geometry.getTriangles({ path: input.path });
      const surfaceArea = calculateSurfaceArea(triangles);
      return {
        path: input.path,
        triangleCount: triangles.length / 9,
        surfaceArea_m2: round2(surfaceArea),
      };
    }

    // Batch mesh diagnostics.
    case 'get_multiple_elements_mesh_info': {
      const paths: string[] = input.paths;
      const results = await Promise.all(
        paths.map(async (path) => {
          try {
            const triangles = await Forma.geometry.getTriangles({ path });
            return {
              path,
              surfaceArea_m2: round2(calculateSurfaceArea(triangles)),
              error: null,
            };
          } catch (err) {
            return { path, surfaceArea_m2: 0, error: String(err) };
          }
        }),
      );
      const totalArea = results.reduce((sum, r) => sum + r.surfaceArea_m2, 0);
      return {
        elements: results,
        totalArea_m2: round2(totalArea),
        count: paths.length,
      };
    }

    // Selection diagnostics.
    case 'get_current_selection': {
      const paths = await Forma.selection.getSelection();

      // Classify selected paths by known Forma categories.
      const CATEGORIES = ['site_limit', 'terrain', 'building', 'buildings', 'road', 'generic'] as const;
      const categorySets: Partial<Record<(typeof CATEGORIES)[number], Set<string>>> = {};

      await Promise.all(CATEGORIES.map(async (category) => {
        try {
          const catPaths = await Forma.geometry.getPathsByCategory({ category });
          categorySets[category] = new Set(catPaths);
        } catch {
          // Some categories may not be supported in the current Forma context.
        }
      }));

      const classified = paths.map((p) => {
        const matchedCategories = CATEGORIES.filter((c) => categorySets[c]?.has(p));
        return {
          path: p,
          matchedCategories,
          isSiteLimit: matchedCategories.includes('site_limit'),
        };
      });

      return {
        paths,
        count: paths.length,
        classified,
      };
    }

    // Visual highlighting.
    case 'highlight_elements': {
      const { succeeded, failed } = await highlightElements(
        input.paths,
        input.color ?? 'yellow',
      );
      return {
        color: input.color ?? 'yellow',
        highlightedCount: succeeded.length,
        failedCount: failed.length,
        succeeded,
        failed,
      };
    }

    // Highlight cleanup.
    case 'clear_highlights': {
      await clearHighlights();
      return { cleared: true };
    }

    // FloorStack compatibility tests.
    case 'test_floorstack_plan_units': {
      return await testFloorStackPlanUnits();
    }

    case 'test_generic_room_program_compatibility': {
      return await testGenericRoomProgramCompatibility();
    }

    case 'test_minimal_floorplan_recreation': {
      let requirements: BuildingRequirements;
      if (input.requirements && Array.isArray(input.requirements.buildings) && input.requirements.buildings.length > 0) {
        requirements = normalizeRequirements(input.requirements);
      } else {
        return {
          status: 'failed',
          message: 'requirements.buildings is required for test_minimal_floorplan_recreation.',
        };
      }

      return await testMinimalFloorPlanRecreation(requirements);
    }

    case 'test_floor_plan_unit_compatibility': {
      let requirements: BuildingRequirements;
      if (input.requirements && Array.isArray(input.requirements.buildings) && input.requirements.buildings.length > 0) {
        requirements = normalizeRequirements(input.requirements);
      } else {
        return {
          status: 'failed',
          message: 'requirements.buildings is required for test_floor_plan_unit_compatibility.',
        };
      }

      return await testFloorPlanUnitCompatibility(
        canonicalizeRequirementsForFloorStack(normalizeFloorAreasFromRooms(requirements)),
        typeof input.floor_label === 'string' ? input.floor_label : '1F',
      );
    }

    case 'test_circular_floorstack_mass': {
      return await testCircularFloorStackMass();
    }

    case 'test_ring_atrium_floorstack_mass': {
      return await testRingAtriumFloorStackMass();
    }

    case 'recreate_buildings_with_floor_plans': {
      let requirements: BuildingRequirements;

      if (input.requirements && (
        (Array.isArray(input.requirements.buildings) && input.requirements.buildings.length > 0) ||
        (Array.isArray(input.requirements.levels) && input.requirements.levels.length > 0) ||
        (Array.isArray(input.requirements.project?.levels) && input.requirements.project.levels.length > 0)
      )) {
        requirements = normalizeRequirements(input.requirements);
      } else if (
        (Array.isArray(input.levels) && input.levels.length > 0) ||
        (Array.isArray(input.project?.levels) && input.project.levels.length > 0)
      ) {
        requirements = normalizeRequirements(input as Record<string, any>);
      } else {
        return {
          status: 'failed',
          message: 'requirements.buildings or requirements.levels is required. Include floor_plans rooms or a levels/zones JSON schema.',
        };
      }

      requirements = canonicalizeRequirementsForFloorStack(
        normalizeFloorAreasFromRooms(requirements),
      );

      const recreateResult = await recreateBuildingsWithFloorPlans(requirements);
      return recreateResult;
    }

    case 'prepare_zone_import_package': {
      const payload =
        input.requirements && Array.isArray(input.requirements.levels)
          ? input.requirements
          : input;
      return summarizeZoneJson(payload as Record<string, any>);
    }

    case 'place_building_masses': {
      const projectName: string = input.project_name ?? '';
      const targetPath = typeof input.target_path === 'string'
        ? input.target_path.trim()
        : '';

      // Use explicit extracted requirements when available. The built-in sample
      // is only selected by name; an empty payload must never mutate the model.
      let requirements: BuildingRequirements;

      if (input.requirements && (
        (Array.isArray(input.requirements.buildings) && input.requirements.buildings.length > 0) ||
        (Array.isArray(input.requirements.levels) && input.requirements.levels.length > 0) ||
        (Array.isArray(input.requirements.project?.levels) && input.requirements.project.levels.length > 0)
      )) {
        requirements = normalizeRequirements(input.requirements);
      } else if (
        (Array.isArray(input.levels) && input.levels.length > 0) ||
        (Array.isArray(input.project?.levels) && input.project.levels.length > 0)
      ) {
        requirements = normalizeRequirements(input as Record<string, any>);
      } else if (projectName.includes('Gyeongju') || projectName.includes('Library')) {
        requirements = GYEONGJU_LIBRARY_REQUIREMENTS;
      } else if (!projectName) {
        return {
          status: 'failed',
          massesPlaced: 0,
          message: 'No building requirements or project_name were supplied. Mass placement was not executed.',
        };
      } else {
        return {
          status: 'not_found',
          message: `"${projectName}" project data was not found. Attach a PDF so the AI can extract parameters from the document and place the mass.`,
        };
      }

      const result = await placeBuildingMasses(
        requirements,
        targetPath ? { targetPath } : {},
      );
      const buildingLayerPlaced = result.placed.filter((m) => m.method === 'building_element');
      const temporaryOverlays = result.placed.filter((m) => m.method !== 'building_element');

      const summary = buildingLayerPlaced.map((m) => ({
        name: m.name,
        elementPath: m.geojsonId,
        layerConfirmed: m.confirmation.buildingLayer,
        visibleVolumeConfirmed: m.confirmation.visibleVolume,
        worldTransformConfirmed: m.confirmation.worldTransform,
        nonVirtualConfirmed: m.confirmation.nonVirtual,
        position: `(${m.centerX.toFixed(4)}, ${m.centerY.toFixed(4)})`,
        placementZ: `${m.placementZ.toFixed(2)}m`,
        actualTransformZ: `${m.confirmation.actualTransformZ.toFixed(2)}m`,
        dimensions: `${m.widthM}m x ${m.depthM}m`,
        height: `${m.heightM}m (${m.floors} above grade${m.basementFloors > 0 ? `, ${m.basementFloors} basement` : ''})`,
        footprint: `${m.footprintArea}m2`,
        totalFloorArea: `${m.totalFloorArea}m2`,
        floors: m.floorDetails,
        layer: m.method === 'building_element' ? 'Buildings layer' : 'temporary overlay',
        debug: `meshZ=${m.debug.localMeshElevation === null ? 'null' : `${m.debug.localMeshElevation.toFixed(2)}m`}, baseZ=${m.debug.baseElevation.toFixed(2)}m, zSource=${m.debug.elevationSourcePath || 'none'}`,
      }));
      const warnings = [...result.warnings];
      if (temporaryOverlays.length > 0) {
        warnings.push(
          `${temporaryOverlays.length} temporary overlay(s) were created, but they are not counted as generated buildings because no Buildings layer element was created.`,
        );
      }

      return {
        status: buildingLayerPlaced.length > 0 ? 'success' : 'failed',
        massesPlaced: buildingLayerPlaced.length,
        temporaryOverlays: temporaryOverlays.length,
        siteReference: result.siteReference,
        totalFootprint_m2: buildingLayerPlaced.reduce((sum, m) => sum + m.footprintArea, 0),
        actualCoverageRatio: `${(
          (requirements.site_limits.total_site_area > 0
            ? buildingLayerPlaced.reduce((sum, m) => sum + m.footprintArea, 0) / requirements.site_limits.total_site_area
            : 0) * 100
        ).toFixed(1)}%`,
        maxAllowedCoverage: `${(requirements.site_limits.max_building_coverage_ratio * 100).toFixed(0)}%`,
        summary,
        warnings,
      };
    }

    // Mass cleanup.
    case 'clear_building_masses': {
      const { removedCount } = await clearAllMasses();
      return {
        status: 'success',
        removedCount,
        message: `Removed ${removedCount} tracked mass overlays.`,
      };
    }

    // Requirement parsing.
    case 'parse_building_requirements': {
      const projectName: string = input.project_name ?? '';
      const rawText: string = input.raw_text ?? '';

      // Parse directly from uploaded document text when available.
      if (rawText && rawText.trim().length > 0) {
        const data = parseRequirementsFromText(rawText);
        return {
          status: 'success',
          source: 'uploaded_document_text',
          data,
          summary: {
            total_buildings: data.buildings.length,
            building_names: data.buildings.map((b) => b.name),
            total_floor_area_m2: data.project.total_floor_area_m2,
            site_area_m2: data.site_limits.total_site_area,
            max_allowed_coverage_pct: `${(data.site_limits.max_building_coverage_ratio * 100).toFixed(0)}%`,
            max_allowed_far_pct: `${(data.site_limits.max_floor_area_ratio * 100).toFixed(0)}%`,
            max_height_floors: data.site_limits.max_height_floors,
            parking_required: data.parking.required_parking_spots,
          },
        };
      }

      // Built-in fallback sample.
      if (!projectName || projectName.includes('Gyeongju') || projectName.includes('Library')) {
        const data = GYEONGJU_LIBRARY_REQUIREMENTS;
        return {
          status: 'success',
          source: 'built_in_gyeongju_library_sample',
          data,
          summary: {
            total_buildings: data.buildings.length,
            building_names: data.buildings.map((b) => b.name),
            total_footprint_m2: data.derived_metrics.total_footprint_area,
            actual_coverage_pct: `${(data.derived_metrics.actual_coverage_ratio * 100).toFixed(1)}%`,
            actual_far_pct: `${(data.derived_metrics.actual_floor_area_ratio * 100).toFixed(1)}%`,
            max_allowed_coverage_pct: `${(data.site_limits.max_building_coverage_ratio * 100).toFixed(0)}%`,
            parking_required: data.parking.required_parking_spots,
          },
        };
      }

      return {
        status: 'not_found',
        message: `"${projectName}" project data was not found. The built-in fallback currently supports the Gyeongju complex cultural library sample.`,
      };
    }

    // Site bounds diagnostics.
    case 'debug_site_bounds': {
      const CATEGORIES = ['site_limit', 'terrain', 'generic', 'building', 'road'];
      const results: Record<string, any> = {};

      for (const category of CATEGORIES) {
        try {
          const paths = await Forma.geometry.getPathsByCategory({ category });
          if (paths.length === 0) {
            results[category] = { found: false };
            continue;
          }

          const categoryResult: any = { found: true, paths, elements: [] };

          for (const path of paths.slice(0, 3)) {
            const elemInfo: any = { path };

            // Footprint diagnostics.
            try {
              const fp = await Forma.geometry.getFootprint({ path });
              elemInfo.footprint = fp;
              elemInfo.footprintType = typeof fp;

              // GeoJSON-like shape check.
              if (fp && typeof fp === 'object') {
                const fpAny = fp as any;
                if (fpAny.coordinates) {
                  const ring = fpAny.coordinates[0] as [number, number][];
                  if (ring?.length > 0) {
                    const xs = ring.map(([x]) => x);
                    const ys = ring.map(([, y]) => y);
                    elemInfo.footprintBbox = {
                      minX: Math.min(...xs).toFixed(2),
                      maxX: Math.max(...xs).toFixed(2),
                      minY: Math.min(...ys).toFixed(2),
                      maxY: Math.max(...ys).toFixed(2),
                      width: (Math.max(...xs) - Math.min(...xs)).toFixed(2),
                      height: (Math.max(...ys) - Math.min(...ys)).toFixed(2),
                      centerX: ((Math.min(...xs) + Math.max(...xs)) / 2).toFixed(2),
                      centerY: ((Math.min(...ys) + Math.max(...ys)) / 2).toFixed(2),
                    };
                    elemInfo.footprintStatus = 'OK - coordinates parsed';
                  }
                } else if (fpAny.geometry?.coordinates) {
                  elemInfo.footprintStatus = 'geometry.coordinates exists, but bbox was not parsed';
                } else if (fpAny.polygon?.coordinates) {
                  elemInfo.footprintStatus = 'polygon.coordinates exists, but bbox was not parsed';
                } else {
                  elemInfo.footprintStatus = `Unknown footprint shape. keys=${Object.keys(fpAny).join(',')}`;
                }
              }
            } catch (e) {
              elemInfo.footprintError = String(e);
            }

            // Triangle-based bbox fallback.
            try {
              const triangles = await Forma.geometry.getTriangles({ path });
              if (triangles.length > 0) {
                let minX = Infinity, maxX = -Infinity;
                let minY = Infinity, maxY = -Infinity;
                for (let i = 0; i < triangles.length; i += 3) {
                  const x = triangles[i];
                  const y = triangles[i + 1];
                  if (x < minX) minX = x;
                  if (x > maxX) maxX = x;
                  if (y < minY) minY = y;
                  if (y > maxY) maxY = y;
                }
                elemInfo.trianglesBbox = {
                  minX: minX.toFixed(2),
                  maxX: maxX.toFixed(2),
                  minY: minY.toFixed(2),
                  maxY: maxY.toFixed(2),
                  width: (maxX - minX).toFixed(2),
                  height: (maxY - minY).toFixed(2),
                  centerX: ((minX + maxX) / 2).toFixed(2),
                  centerY: ((minY + maxY) / 2).toFixed(2),
                  triangleCount: triangles.length / 9,
                };
                elemInfo.trianglesStatus = 'OK';
              }
            } catch (e) {
              elemInfo.trianglesError = String(e);
            }

            categoryResult.elements.push(elemInfo);
          }

          results[category] = categoryResult;
        } catch (e) {
          results[category] = { error: String(e) };
        }
      }

      return {
        diagnosis: results,
        recommendation: 'Prefer site_limit bounds when available. If site_limit is missing, use terrain or generic geometry and compare footprintBbox/trianglesBbox centerX and centerY before placing masses.',
      };
    }

    // Unknown tool.
    default:
      throw new Error(`Unknown Forma tool: ${toolName}`);
  }
}
