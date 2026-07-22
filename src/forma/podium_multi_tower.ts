import type {
  BuildingMass,
  FloorHeights,
  MassComponent,
  MassGenerationSettings,
} from '../data/building_requirements';
import { isRingContainedInBoundary } from '../layout/geometry_contract';

export type Point2 = [number, number];

export interface ComponentPlacementDiagnostic {
  component_id: string;
  requested_area: number;
  maximum_feasible_area: number;
  parent_component_id: string | null;
  parent_top_footprint_area: number;
  available_zone_width: number;
  available_zone_depth: number;
  attempted_width: number;
  attempted_depth: number;
  containment_result: boolean;
  overlap_result: boolean;
  failure_reason: string;
}

export interface ResolvedMassComponent {
  componentId: string;
  componentType: string;
  parentComponentId: string | null;
  startFloor: string;
  endFloor: string;
  floorLabels: string[];
  floorHeightsM: number[];
  floorCount: number;
  baseElevationM: number;
  totalHeightM: number;
  topElevationM: number;
  requestedAreaM2: number;
  widthM: number;
  depthM: number;
  centerXM: number;
  centerYM: number;
  footprintPolygon: Point2[];
  localFloorStackPolygon: Point2[];
  containedInParent: boolean;
  overlapsSibling: boolean;
}

export interface ResolvedBasementMass {
  componentId: 'BASEMENT';
  componentType: 'BASEMENT';
  floorLabels: string[];
  floorHeightsM: number[];
  floorAreasM2: number[];
  floorCount: number;
  baseElevationM: number;
  totalHeightM: number;
  topElevationM: 0;
  widthM: number;
  depthM: number;
  footprintAreaM2: number;
  totalFloorAreaM2: number;
  localFloorStackPolygons: Point2[][];
}

export class MassComponentPlanningError extends Error {
  constructor(public readonly diagnostic: ComponentPlacementDiagnostic) {
    super(`${diagnostic.component_id}: ${diagnostic.failure_reason}`);
    this.name = 'MassComponentPlanningError';
  }
}

const DEFAULT_FLOOR_HEIGHT_M = 4;
const DEFAULT_TOLERANCE_M = 0.02;

function finitePositive(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function floorNumber(value: unknown): number | null {
  const match = /^(\d+)(?:F)?$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  const numberValue = Number(match[1]);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function floorLabel(value: unknown): string | null {
  const numberValue = floorNumber(value);
  return numberValue === null ? null : `${numberValue}F`;
}

function diagnosticFor(
  component: MassComponent,
  failureReason: string,
  values: Partial<Omit<ComponentPlacementDiagnostic, 'component_id' | 'requested_area' | 'parent_component_id' | 'failure_reason'>> = {},
): ComponentPlacementDiagnostic {
  return {
    component_id: String(component.component_id ?? '').trim() || '(missing component_id)',
    requested_area: Number(component.footprint_area) || 0,
    maximum_feasible_area: values.maximum_feasible_area ?? 0,
    parent_component_id: component.parent_component_id ? String(component.parent_component_id) : null,
    parent_top_footprint_area: values.parent_top_footprint_area ?? 0,
    available_zone_width: values.available_zone_width ?? 0,
    available_zone_depth: values.available_zone_depth ?? 0,
    attempted_width: values.attempted_width ?? 0,
    attempted_depth: values.attempted_depth ?? 0,
    containment_result: values.containment_result ?? false,
    overlap_result: values.overlap_result ?? false,
    failure_reason: failureReason,
  };
}

function fail(
  component: MassComponent,
  failureReason: string,
  values?: Parameters<typeof diagnosticFor>[2],
): never {
  throw new MassComponentPlanningError(diagnosticFor(component, failureReason, values));
}

/** Floor plans are intentionally not consulted here. */
export function resolveComponentFloorLabels(component: MassComponent): string[] {
  const hasApplicableFloors = Object.prototype.hasOwnProperty.call(component, 'applicable_floors');
  if (hasApplicableFloors) {
    if (!Array.isArray(component.applicable_floors) || component.applicable_floors.length === 0) {
      fail(component, 'applicable_floors must be a non-empty array; no floor-count fallback was used.');
    }
    const normalized = component.applicable_floors.map(floorLabel);
    if (normalized.some((label) => label === null)) {
      fail(component, 'applicable_floors contains an invalid above-grade floor label.');
    }
    const labels = normalized as string[];
    if (new Set(labels).size !== labels.length) {
      fail(component, 'applicable_floors contains duplicate floor labels.');
    }
    const start = floorNumber(component.start_floor) ?? floorNumber(labels[0]);
    const end = floorNumber(component.end_floor) ?? floorNumber(labels[labels.length - 1]);
    if (start === null || end === null || end < start) {
      fail(component, 'start_floor/end_floor is invalid.');
    }
    const expected = Array.from({ length: end - start + 1 }, (_, index) => `${start + index}F`);
    if (labels.length !== expected.length || labels.some((label, index) => label !== expected[index])) {
      fail(component, 'applicable_floors must be the complete ordered inclusive start_floor-to-end_floor range.');
    }
    return labels;
  }

  const start = floorNumber(component.start_floor);
  const end = floorNumber(component.end_floor);
  if (start === null || end === null || end < start) {
    fail(component, 'Neither applicable_floors nor a valid inclusive start_floor/end_floor range was provided.');
  }
  return Array.from({ length: end - start + 1 }, (_, index) => `${start + index}F`);
}

function floorHeight(label: string, component: MassComponent, building: BuildingMass): number {
  const value = component.floor_heights_m?.[label] ?? building.floor_heights_m?.[label];
  return finitePositive(value) ?? DEFAULT_FLOOR_HEIGHT_M;
}

function priorFloorElevation(component: MassComponent, building: BuildingMass, start: number): number {
  let elevation = 0;
  const heightRecords: FloorHeights[] = [component.floor_heights_m ?? {}, building.floor_heights_m ?? {}];
  for (let floor = 1; floor < start; floor += 1) {
    const label = `${floor}F`;
    const explicit = heightRecords.map((record) => finitePositive(record[label])).find((height) => height !== null);
    if (explicit === undefined) {
      fail(component, `Cannot calculate base elevation: floor height for ${label} is missing and no parent top elevation is available.`);
    }
    elevation += explicit;
  }
  return elevation;
}

function rectangle(centerX: number, centerY: number, width: number, depth: number): Point2[] {
  return [
    [centerX - width / 2, centerY - depth / 2],
    [centerX + width / 2, centerY - depth / 2],
    [centerX + width / 2, centerY + depth / 2],
    [centerX - width / 2, centerY + depth / 2],
  ];
}

function rectangleBounds(polygon: Point2[]): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: Math.min(...polygon.map(([x]) => x)),
    maxX: Math.max(...polygon.map(([x]) => x)),
    minY: Math.min(...polygon.map(([, y]) => y)),
    maxY: Math.max(...polygon.map(([, y]) => y)),
  };
}

function rectanglesOverlapInArea(left: Point2[], right: Point2[], toleranceM: number): boolean {
  const a = rectangleBounds(left);
  const b = rectangleBounds(right);
  return Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > toleranceM
    && Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > toleranceM;
}

function rootDimensions(component: MassComponent, area: number): { width: number; depth: number } {
  const explicitWidth = finitePositive(component.footprint_width_m);
  const explicitDepth = finitePositive(component.footprint_depth_m);
  if (explicitWidth && explicitDepth) {
    const scale = Math.sqrt(area / (explicitWidth * explicitDepth));
    return { width: explicitWidth * scale, depth: explicitDepth * scale };
  }
  if (explicitWidth) return { width: explicitWidth, depth: area / explicitWidth };
  if (explicitDepth) return { width: area / explicitDepth, depth: explicitDepth };
  const depth = Math.sqrt(area / 1.5);
  return { width: depth * 1.5, depth };
}

function basementFloorLabel(value: unknown): string | null {
  const match = /^(?:B|-)(\d+)$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  const floor = Number(match[1]);
  return Number.isInteger(floor) && floor > 0 ? `B${floor}` : null;
}

function normalizedBasementRecord(record: Record<string, number> | undefined): Map<string, number> {
  const normalized = new Map<string, number>();
  for (const [rawLabel, rawValue] of Object.entries(record ?? {})) {
    const label = basementFloorLabel(rawLabel);
    if (!label) continue;
    normalized.set(label, Number(rawValue));
  }
  return normalized;
}

/** Resolves building.basement without consulting room/floor-plan data. */
export function resolvePodiumMultiTowerBasement(building: BuildingMass): ResolvedBasementMass | null {
  const basement = building.basement;
  if (!basement) return null;

  const breakdown = normalizedBasementRecord(basement.floor_breakdown);
  const declaredFloorCount = Number(basement.floors);
  const floorCount = Number.isInteger(declaredFloorCount) && declaredFloorCount > 0
    ? declaredFloorCount
    : breakdown.size;
  const requestedArea = breakdown.size > 0
    ? Math.max(...breakdown.values())
    : finitePositive(basement.area_m2) !== null && floorCount > 0
      ? Number(basement.area_m2) / floorCount
      : 0;
  const syntheticComponent: MassComponent = {
    component_id: 'BASEMENT',
    component_type: 'BASEMENT',
    footprint_area: requestedArea,
  };
  if (floorCount <= 0) {
    fail(syntheticComponent, 'building.basement must provide a positive floors count or a non-empty floor_breakdown.');
  }

  const labels = Array.from({ length: floorCount }, (_, index) => `B${floorCount - index}`);
  let areas: number[];
  if (breakdown.size > 0) {
    const complete = breakdown.size === labels.length
      && labels.every((label) => finitePositive(breakdown.get(label)) !== null);
    if (!complete) {
      fail(syntheticComponent, `building.basement.floor_breakdown must define exactly ${labels.join(', ')} with positive areas.`);
    }
    areas = labels.map((label) => Number(breakdown.get(label)));
  } else {
    const totalArea = finitePositive(basement.area_m2);
    if (totalArea === null) {
      fail(syntheticComponent, 'building.basement.area_m2 must be positive when floor_breakdown is absent.');
    }
    areas = labels.map(() => totalArea / floorCount);
  }

  const basementHeights = normalizedBasementRecord(basement.floor_heights_m);
  const buildingHeights = normalizedBasementRecord(building.floor_heights_m);
  const heights = labels.map((label) =>
    finitePositive(basementHeights.get(label))
    ?? finitePositive(buildingHeights.get(label))
    ?? DEFAULT_FLOOR_HEIGHT_M);
  const width = finitePositive(basement.footprint_width_m);
  const depth = finitePositive(basement.footprint_depth_m);
  const dimensions = areas.map((area) => rootDimensions({
    ...syntheticComponent,
    footprint_width_m: width,
    footprint_depth_m: depth,
  }, area));
  const polygons = dimensions.map(({ width: floorWidth, depth: floorDepth }) => {
    const polygon = rectangle(0, 0, floorWidth, floorDepth);
    return [...polygon, polygon[0]];
  });
  const totalHeight = heights.reduce((sum, height) => sum + height, 0);
  const largestFloorIndex = areas.indexOf(Math.max(...areas));
  const resolved: ResolvedBasementMass = {
    componentId: 'BASEMENT',
    componentType: 'BASEMENT',
    floorLabels: labels,
    floorHeightsM: heights,
    floorAreasM2: areas,
    floorCount,
    baseElevationM: -totalHeight,
    totalHeightM: totalHeight,
    topElevationM: 0,
    widthM: dimensions[largestFloorIndex].width,
    depthM: dimensions[largestFloorIndex].depth,
    footprintAreaM2: areas[largestFloorIndex],
    totalFloorAreaM2: areas.reduce((sum, area) => sum + area, 0),
    localFloorStackPolygons: polygons,
  };
  console.info('[PODIUM_MULTI_TOWER basement]', {
    component_id: resolved.componentId,
    floor_labels: resolved.floorLabels,
    floor_count: resolved.floorCount,
    calculated_base_elevation_m: resolved.baseElevationM,
    calculated_total_height_m: resolved.totalHeightM,
    calculated_top_elevation_m: resolved.topElevationM,
    floor_areas_m2: resolved.floorAreasM2,
    calculated_width_m: resolved.widthM,
    calculated_depth_m: resolved.depthM,
    below_grade: true,
  });
  return resolved;
}

function fittedChildDimensions(
  component: MassComponent,
  area: number,
  zoneWidth: number,
  zoneDepth: number,
): { width: number; depth: number } {
  const explicitWidth = finitePositive(component.footprint_width_m);
  const explicitDepth = finitePositive(component.footprint_depth_m);
  if (explicitWidth && explicitDepth) {
    const scale = Math.sqrt(area / (explicitWidth * explicitDepth));
    return { width: explicitWidth * scale, depth: explicitDepth * scale };
  }
  if (explicitWidth) return { width: explicitWidth, depth: area / explicitWidth };
  if (explicitDepth) return { width: area / explicitDepth, depth: explicitDepth };

  // Match the available half-podium aspect ratio, then clamp while preserving
  // the requested area. This is a zone-fit calculation, not a square fallback.
  const zoneRatio = zoneWidth / zoneDepth;
  let width = Math.sqrt(area * zoneRatio);
  let depth = area / width;
  if (width > zoneWidth) {
    width = zoneWidth;
    depth = area / width;
  }
  if (depth > zoneDepth) {
    depth = zoneDepth;
    width = area / depth;
  }
  return { width, depth };
}

function normalizedSettings(settings?: MassGenerationSettings): Required<MassGenerationSettings> {
  return {
    towerSetbackM: Math.max(0, finiteNumber(settings?.towerSetbackM) ?? 0),
    towerGapM: Math.max(0, finiteNumber(settings?.towerGapM) ?? 0),
    containmentToleranceM: Math.min(0.05, Math.max(0.01, finiteNumber(settings?.containmentToleranceM) ?? DEFAULT_TOLERANCE_M)),
  };
}

function logResolvedComponent(component: ResolvedMassComponent): void {
  console.info('[PODIUM_MULTI_TOWER component]', {
    component_id: component.componentId,
    component_type: component.componentType,
    parent_component_id: component.parentComponentId,
    start_floor: component.startFloor,
    end_floor: component.endFloor,
    applicable_floor_count: component.floorCount,
    calculated_base_elevation_m: component.baseElevationM,
    calculated_total_height_m: component.totalHeightM,
    requested_footprint_area_m2: component.requestedAreaM2,
    calculated_width_m: component.widthM,
    calculated_depth_m: component.depthM,
    calculated_center_x_m: component.centerXM,
    calculated_center_y_m: component.centerYM,
    parent_containment_result: component.containedInParent,
    sibling_overlap_result: component.overlapsSibling,
  });
}

/**
 * Resolves an entire component set before any Forma SDK write occurs. The
 * returned polygons share the podium's local metre coordinate system.
 */
export function resolvePodiumMultiTowerComponents(
  building: BuildingMass,
  rawSettings?: MassGenerationSettings,
): ResolvedMassComponent[] {
  const components = building.mass_components ?? [];
  if (components.length === 0) return [];
  const settings = normalizedSettings(rawSettings);
  const componentsById = new Map<string, MassComponent>();
  for (const component of components) {
    const id = String(component.component_id ?? '').trim();
    if (!id) fail(component, 'component_id is required.');
    if (componentsById.has(id)) fail(component, `Duplicate component_id: ${id}.`);
    componentsById.set(id, component);
  }

  const resolvedById = new Map<string, ResolvedMassComponent>();
  const resolving = new Set<string>();
  const ordered: ResolvedMassComponent[] = [];

  const resolveOne = (component: MassComponent): ResolvedMassComponent => {
    const id = String(component.component_id).trim();
    const existing = resolvedById.get(id);
    if (existing) return existing;
    if (resolving.has(id)) fail(component, 'parent_component_id contains a cycle.');
    resolving.add(id);

    const componentType = String(component.component_type ?? '').trim().toUpperCase();
    if (!componentType) fail(component, 'component_type is required.');
    const parentId = component.parent_component_id ? String(component.parent_component_id).trim() : null;
    const isTower = /^TOWER(?:_|$)/.test(componentType);
    if (isTower && !parentId) {
      fail(component, 'A TOWER component requires parent_component_id.');
    }
    const parentSource = parentId ? componentsById.get(parentId) : undefined;
    if (parentId && !parentSource) {
      fail(component, `parent_component_id ${parentId} was not found.`);
    }
    const parent = parentSource ? resolveOne(parentSource) : null;
    if (isTower && parent && parent.componentType !== 'PODIUM') {
      fail(component, 'A TOWER parent_component_id must reference a PODIUM component.', {
        parent_top_footprint_area: parent.requestedAreaM2,
      });
    }
    const labels = resolveComponentFloorLabels(component);
    const start = floorNumber(component.start_floor) ?? floorNumber(labels[0]);
    const end = floorNumber(component.end_floor) ?? floorNumber(labels[labels.length - 1]);
    if (start === null || end === null) fail(component, 'Unable to resolve start_floor/end_floor.');
    if (isTower && parent && floorNumber(parent.endFloor)! + 1 !== start) {
      fail(component, `Tower start_floor ${start}F must immediately follow parent top floor ${parent.endFloor}.`, {
        parent_top_footprint_area: parent.requestedAreaM2,
      });
    }
    const area = finitePositive(component.footprint_area);
    if (area === null) fail(component, 'footprint_area must be a positive number.');
    const heights = labels.map((label) => floorHeight(label, component, building));
    const totalHeight = heights.reduce((sum, height) => sum + height, 0);
    const explicitBase = finiteNumber(component.base_offset_m);
    const baseElevation = parent
      ? parent.topElevationM
      : explicitBase ?? (start === 1 ? 0 : priorFloorElevation(component, building, start));

    let width: number;
    let depth: number;
    let centerX = finiteNumber(component.center_x_m) ?? 0;
    let centerY = finiteNumber(component.center_y_m) ?? 0;
    let contained = parent === null;
    let overlap = false;
    let maximumFeasibleArea = area;
    let zoneWidth = 0;
    let zoneDepth = 0;

    if (!parent) {
      ({ width, depth } = rootDimensions(component, area));
    } else {
      const parentBounds = rectangleBounds(parent.footprintPolygon);
      const parentCenterX = (parentBounds.minX + parentBounds.maxX) / 2;
      const hint = String(component.position_hint ?? '').trim().toLowerCase();
      if (hint !== 'podium_west' && hint !== 'podium_east') {
        fail(component, 'A child tower position_hint must be podium_west or podium_east.', {
          parent_top_footprint_area: parent.requestedAreaM2,
        });
      }
      const zoneMinY = parentBounds.minY + settings.towerSetbackM;
      const zoneMaxY = parentBounds.maxY - settings.towerSetbackM;
      const zoneMinX = hint === 'podium_west'
        ? parentBounds.minX + settings.towerSetbackM
        : parentCenterX + settings.towerGapM / 2;
      const zoneMaxX = hint === 'podium_west'
        ? parentCenterX - settings.towerGapM / 2
        : parentBounds.maxX - settings.towerSetbackM;
      zoneWidth = Math.max(0, zoneMaxX - zoneMinX);
      zoneDepth = Math.max(0, zoneMaxY - zoneMinY);
      maximumFeasibleArea = zoneWidth * zoneDepth;
      ({ width, depth } = fittedChildDimensions(component, area, zoneWidth, zoneDepth));
      if (finiteNumber(component.center_x_m) === null) centerX = (zoneMinX + zoneMaxX) / 2;
      if (finiteNumber(component.center_y_m) === null) centerY = (zoneMinY + zoneMaxY) / 2;

      const attemptedPolygon = rectangle(centerX, centerY, width, depth);
      const withinZone = attemptedPolygon.every(([x, y]) =>
        x >= zoneMinX - settings.containmentToleranceM
        && x <= zoneMaxX + settings.containmentToleranceM
        && y >= zoneMinY - settings.containmentToleranceM
        && y <= zoneMaxY + settings.containmentToleranceM);
      contained = withinZone && isRingContainedInBoundary(attemptedPolygon, parent.footprintPolygon, true);
      const siblings = ordered.filter((candidate) => candidate.parentComponentId === parentId);
      overlap = siblings.some((sibling) => rectanglesOverlapInArea(attemptedPolygon, sibling.footprintPolygon, settings.containmentToleranceM));
      const areaTolerance = Math.max(0.05, area * 1e-6);
      const areaMatches = Math.abs(width * depth - area) <= areaTolerance;
      const exceedsZone = width > zoneWidth + settings.containmentToleranceM || depth > zoneDepth + settings.containmentToleranceM;
      if (!(width > 0 && depth > 0) || exceedsZone
        || !areaMatches || !contained || overlap) {
        const reason = !areaMatches
          ? 'The fitted rectangle does not preserve the requested footprint area.'
          : overlap
            ? 'The fitted tower footprint overlaps a sibling tower.'
            : exceedsZone
              ? 'The requested footprint area cannot fit inside the assigned podium half-zone.'
              : !contained
              ? 'The fitted tower footprint is not completely contained in the parent podium top footprint.'
              : 'The requested footprint area cannot fit inside the assigned podium half-zone.';
        fail(component, reason, {
          maximum_feasible_area: maximumFeasibleArea,
          parent_top_footprint_area: parent.requestedAreaM2,
          available_zone_width: zoneWidth,
          available_zone_depth: zoneDepth,
          attempted_width: width,
          attempted_depth: depth,
          containment_result: contained,
          overlap_result: overlap,
        });
      }
    }

    const footprintPolygon = rectangle(centerX, centerY, width, depth);
    const resolved: ResolvedMassComponent = {
      componentId: id,
      componentType,
      parentComponentId: parentId,
      startFloor: `${start}F`,
      endFloor: `${end}F`,
      floorLabels: labels,
      floorHeightsM: heights,
      floorCount: labels.length,
      baseElevationM: baseElevation,
      totalHeightM: totalHeight,
      topElevationM: baseElevation + totalHeight,
      requestedAreaM2: area,
      widthM: width,
      depthM: depth,
      centerXM: centerX,
      centerYM: centerY,
      footprintPolygon,
      localFloorStackPolygon: (() => {
        const polygon = rectangle(0, 0, width, depth);
        return [...polygon, polygon[0]];
      })(),
      containedInParent: contained,
      overlapsSibling: overlap,
    };
    resolving.delete(id);
    resolvedById.set(id, resolved);
    ordered.push(resolved);
    return resolved;
  };

  for (const component of components) resolveOne(component);
  ordered.forEach(logResolvedComponent);
  return ordered;
}
