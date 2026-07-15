import type { FloorGeometryContractInput, GeometryContractViolation, Point2 } from './geometry_contract';
import { ringArea, validateFloorGeometryContract } from './geometry_contract';
import type {
  LayoutProblem,
  LayoutRelation,
  LayoutRoom,
  LayoutRoomKind,
  LayoutWeights,
} from './types';

export interface LayoutRoomSource {
  room_id?: string;
  function_id?: string;
  name?: string;
  area_m2?: number;
  min_area_m2?: number;
  max_area_m2?: number;
  unit_type?: LayoutRoomKind;
  group?: string;
  facade_required?: boolean;
  daylight_priority?: 'high' | 'medium' | 'low';
  core_proximity?: 'required' | 'preferred' | 'neutral';
  noise_level?: 'low' | 'medium' | 'medium-high' | 'high';
  required_adjacency?: string[];
  avoid_adjacency?: string[];
  adjacent_to?: string[];
  aspect_ratio_preference?: { min?: number; max?: number };
  placement_hint?: string;
  zone_hint?: string;
  edge_preference?: string;
  shape_preference?: 'RECTANGLE' | 'L_SHAPE' | 'U_SHAPE' | 'COMPACT_RECTANGLE' | 'LONG_RECTANGLE_AVOID' | 'CORE';
  polygon?: Point2[];
  locked?: boolean;
}

export type LayoutGeometrySource = Omit<
  FloorGeometryContractInput,
  'rooms' | 'reservedCirculationAreaM2' | 'fixedObstacles' | 'allowFixedObstacleBoundaryContact'
> & {
  /** True no-program/no-go regions only. Fixed program rooms belong on room.polygon. */
  excludedAreas?: Array<{ id: string; polygon: Point2[] }>;
};

export interface NormalizeLayoutProblemInput {
  problemId: string;
  buildingId?: string;
  levelId: string;
  geometry: LayoutGeometrySource;
  rooms: LayoutRoomSource[];
  reservedCirculationAreaM2?: number;
  seed?: number;
  weights?: Partial<LayoutWeights>;
}

export interface LayoutNormalizationIssue {
  code: string;
  entityId?: string;
  message: string;
}

export type LayoutProblemNormalizationResult =
  | { ok: true; problem: LayoutProblem; warnings: LayoutNormalizationIssue[] }
  | { ok: false; errors: LayoutNormalizationIssue[]; warnings: LayoutNormalizationIssue[] };

export const DEFAULT_LAYOUT_WEIGHTS: LayoutWeights = Object.freeze({
  areaAccuracy: 30,
  requiredAdjacency: 25,
  preferredAdjacency: 8,
  separation: 25,
  facadeContact: 20,
  daylight: 10,
  coreProximity: 10,
  aspectRatio: 8,
  compactness: 5,
});

const AREA_TOLERANCE_RATIO = 0.03;
const AREA_TOLERANCE_M2 = 2;

function issue(code: string, message: string, entityId?: string): LayoutNormalizationIssue {
  return { code, message, ...(entityId ? { entityId } : {}) };
}

function stableCompare(a: string, b: string): number {
  const lower = a.toLowerCase().localeCompare(b.toLowerCase(), 'en');
  return lower !== 0 ? lower : a.localeCompare(b, 'en');
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.trim();
  return result || undefined;
}

function relationValues(value: unknown, entityId: string, field: string, errors: LayoutNormalizationIssue[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(issue('MALFORMED_ROOM_RELATION', `${field} must be an array of room IDs.`, entityId));
    return [];
  }
  const values: string[] = [];
  value.forEach((entry, index) => {
    const normalized = cleanString(entry);
    if (!normalized) {
      errors.push(issue('MALFORMED_ROOM_RELATION', `${field}[${index}] must be a non-empty string.`, entityId));
    } else values.push(normalized);
  });
  return [...new Set(values)];
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
  roomId: string,
  errors: LayoutNormalizationIssue[],
): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && allowed.includes(value as T)) return value as T;
  errors.push(issue('INVALID_ROOM_ATTRIBUTE', `${field} must be one of: ${allowed.join(', ')}.`, roomId));
  return fallback;
}

function booleanValue(value: unknown, fallback: boolean, field: string, roomId: string, errors: LayoutNormalizationIssue[]): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  errors.push(issue('INVALID_ROOM_ATTRIBUTE', `${field} must be boolean.`, roomId));
  return fallback;
}

function normalizeWeights(value: Partial<LayoutWeights> | undefined, errors: LayoutNormalizationIssue[]): LayoutWeights {
  const result = { ...DEFAULT_LAYOUT_WEIGHTS };
  if (value === undefined) return result;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(issue('MALFORMED_WEIGHTS', 'weights must be an object.'));
    return result;
  }
  for (const key of Object.keys(DEFAULT_LAYOUT_WEIGHTS) as Array<keyof LayoutWeights>) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
      errors.push(issue('INVALID_WEIGHT', `${key} must be a finite, non-negative number.`, key));
    } else result[key] = candidate;
  }
  return result;
}

function inferRoomKind(room: LayoutRoomSource): LayoutRoomKind {
  const explicit = cleanString(room.unit_type)?.toUpperCase();
  if (explicit === 'CORE' || explicit === 'CORRIDOR' || explicit === 'PARKING' || explicit === 'LIVING_UNIT') return explicit;
  const identity = `${room.room_id ?? ''} ${room.function_id ?? ''} ${room.name ?? ''} ${room.group ?? ''}`.toLowerCase();
  if (/(^|[_\-\s])core($|[_\-\s])|코어/.test(identity)) return 'CORE';
  if (/parking|주차/.test(identity)) return 'PARKING';
  if (/corridor|복도|lobby|로비/.test(identity)) return 'CORRIDOR';
  return 'LIVING_UNIT';
}

function normalizeFixedPlacement(
  room: LayoutRoomSource,
  roomId: string,
  targetAreaM2: number,
  errors: LayoutNormalizationIssue[],
): LayoutRoom['fixedPlacement'] {
  const locked = booleanValue(room.locked, false, 'locked', roomId, errors);
  if (room.polygon === undefined) {
    if (locked) errors.push(issue('LOCKED_ROOM_REQUIRES_POLYGON', 'A locked room requires an explicit polygon.', roomId));
    return undefined;
  }
  if (!Array.isArray(room.polygon)) {
    errors.push(issue('MALFORMED_ROOM_POLYGON', 'Room polygon must be an array of coordinate pairs.', roomId));
    return undefined;
  }
  const polygon: Point2[] = [];
  room.polygon.forEach((point, index) => {
    if (!Array.isArray(point) || point.length < 2 ||
        typeof point[0] !== 'number' || typeof point[1] !== 'number' ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      errors.push(issue('MALFORMED_ROOM_POLYGON', `Invalid coordinate at index ${index}.`, roomId));
    } else polygon.push([point[0], point[1]]);
  });
  if (polygon.length < 3) return undefined;
  const actualArea = ringArea(polygon);
  const tolerance = Math.max(AREA_TOLERANCE_M2, targetAreaM2 * AREA_TOLERANCE_RATIO);
  if (Math.abs(actualArea - targetAreaM2) > tolerance) {
    errors.push(issue(
      'FIXED_ROOM_AREA_MISMATCH',
      `Fixed polygon area ${actualArea.toFixed(2)}m2 does not match target ${targetAreaM2.toFixed(2)}m2.`,
      roomId,
    ));
  }
  return { polygon, source: locked ? 'user-lock' : 'source-room-polygon' };
}

function mapGeometryIssues(values: GeometryContractViolation[]): LayoutNormalizationIssue[] {
  return values.map((value) => issue(value.code, value.message, value.entityId));
}

export function normalizeLayoutProblem(input: NormalizeLayoutProblemInput): LayoutProblemNormalizationResult {
  const errors: LayoutNormalizationIssue[] = [];
  const warnings: LayoutNormalizationIssue[] = [];
  const problemId = cleanString(input?.problemId);
  const levelId = cleanString(input?.levelId);
  const buildingId = cleanString(input?.buildingId);
  if (!problemId) errors.push(issue('MISSING_PROBLEM_ID', 'A non-empty problemId is required.'));
  if (!levelId) errors.push(issue('MISSING_LEVEL_ID', 'A non-empty levelId is required.'));

  const seed = input?.seed ?? 0;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    errors.push(issue('INVALID_SEED', 'seed must be an integer between 0 and 4294967295.'));
  }
  const weights = normalizeWeights(input?.weights, errors);
  if (!Array.isArray(input?.rooms)) {
    errors.push(issue('MALFORMED_ROOMS', 'rooms must be an array.'));
    return { ok: false, errors, warnings };
  }

  const aliases = new Map<string, string>();
  const roomSources = new Map<string, LayoutRoomSource>();
  for (const [index, rawRoom] of input.rooms.entries()) {
    if (!rawRoom || typeof rawRoom !== 'object' || Array.isArray(rawRoom)) {
      errors.push(issue('MALFORMED_ROOM', `Room at index ${index} must be an object.`, `room:${index}`));
      continue;
    }
    const roomId = cleanString(rawRoom.room_id) ?? cleanString(rawRoom.function_id);
    if (!roomId) {
      errors.push(issue('MISSING_ROOM_ID', 'Every room requires room_id or function_id.', `room:${index}`));
      continue;
    }
    const key = roomId.toLowerCase();
    if (roomSources.has(key)) {
      errors.push(issue('DUPLICATE_ROOM_ID', `Duplicate room ID: ${roomId}.`, roomId));
      continue;
    }
    roomSources.set(key, rawRoom);
  }
  // Register the complete canonical ID namespace first, then aliases. This
  // makes collisions independent of source array order.
  for (const [key, rawRoom] of roomSources) {
    aliases.set(key, cleanString(rawRoom.room_id) ?? cleanString(rawRoom.function_id)!);
  }
  for (const [key, rawRoom] of roomSources) {
    const roomId = aliases.get(key)!;
    const functionId = cleanString(rawRoom.function_id);
    if (!functionId) continue;
    const aliasKey = functionId.toLowerCase();
    const existing = aliases.get(aliasKey);
    if (existing && existing.toLowerCase() !== key) {
      errors.push(issue('DUPLICATE_ROOM_ALIAS', `function_id ${functionId} conflicts with room ${existing}.`, roomId));
      continue;
    }
    aliases.set(aliasKey, roomId);
  }

  const rooms: LayoutRoom[] = [];
  const rawRelations: Array<{ a: string; b: string; type: 'adjacent' | 'separate'; strength: 'hard' | 'soft' }> = [];
  for (const [key, rawRoom] of roomSources) {
    const id = aliases.get(key)!;
    const target = rawRoom.area_m2;
    const min = rawRoom.min_area_m2 ?? target;
    const max = rawRoom.max_area_m2 ?? target;
    if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) {
      errors.push(issue('INVALID_ROOM_AREA', 'area_m2 must be a positive finite number.', id));
      continue;
    }
    if (typeof min !== 'number' || !Number.isFinite(min) || min <= 0 ||
        typeof max !== 'number' || !Number.isFinite(max) || max <= 0 || min > target || target > max) {
      errors.push(issue('INVALID_ROOM_AREA_RANGE', 'Expected 0 < min_area_m2 <= area_m2 <= max_area_m2.', id));
      continue;
    }
    const aspect = rawRoom.aspect_ratio_preference;
    let aspectRatio: LayoutRoom['aspectRatio'];
    if (aspect !== undefined && (!aspect || typeof aspect !== 'object' || Array.isArray(aspect))) {
      errors.push(issue('INVALID_ASPECT_RATIO', 'aspect_ratio_preference must be an object.', id));
    } else if (aspect !== undefined) {
      const aspectMin = aspect?.min ?? 1;
      const aspectMax = aspect?.max ?? aspectMin;
      if (typeof aspectMin !== 'number' || !Number.isFinite(aspectMin) || aspectMin < 1 ||
          typeof aspectMax !== 'number' || !Number.isFinite(aspectMax) || aspectMax < aspectMin) {
        errors.push(issue('INVALID_ASPECT_RATIO', 'Aspect ratio requires 1 <= min <= max.', id));
      } else aspectRatio = { min: aspectMin, max: aspectMax };
    }
    const fixedPlacement = normalizeFixedPlacement(rawRoom, id, target, errors);
    if (rawRoom.unit_type !== undefined &&
        !['CORE', 'CORRIDOR', 'PARKING', 'LIVING_UNIT'].includes(String(rawRoom.unit_type))) {
      errors.push(issue('INVALID_ROOM_ATTRIBUTE', 'unit_type must be CORE, CORRIDOR, PARKING, or LIVING_UNIT.', id));
    }
    const shapePreference = rawRoom.shape_preference === undefined
      ? undefined
      : enumValue(
          rawRoom.shape_preference,
          ['RECTANGLE', 'L_SHAPE', 'U_SHAPE', 'COMPACT_RECTANGLE', 'LONG_RECTANGLE_AVOID', 'CORE'],
          'RECTANGLE',
          'shape_preference',
          id,
          errors,
        );
    rooms.push({
      id,
      name: cleanString(rawRoom.name) ?? id,
      targetAreaM2: target,
      minAreaM2: min,
      maxAreaM2: max,
      kind: inferRoomKind(rawRoom),
      group: cleanString(rawRoom.group),
      facadeRequired: booleanValue(rawRoom.facade_required, false, 'facade_required', id, errors),
      daylightPriority: enumValue(rawRoom.daylight_priority, ['high', 'medium', 'low'], 'low', 'daylight_priority', id, errors),
      coreProximity: enumValue(rawRoom.core_proximity, ['required', 'preferred', 'neutral'], 'neutral', 'core_proximity', id, errors),
      noiseLevel: rawRoom.noise_level === undefined
        ? undefined
        : enumValue(rawRoom.noise_level, ['low', 'medium', 'medium-high', 'high'], 'low', 'noise_level', id, errors),
      aspectRatio,
      shapePreference,
      placementHint: cleanString(rawRoom.placement_hint),
      zoneHint: cleanString(rawRoom.zone_hint),
      edgePreference: cleanString(rawRoom.edge_preference),
      fixedPlacement,
    });
    for (const relationId of relationValues(rawRoom.required_adjacency, id, 'required_adjacency', errors)) {
      rawRelations.push({ a: id, b: relationId, type: 'adjacent', strength: 'hard' });
    }
    for (const relationId of relationValues(rawRoom.avoid_adjacency, id, 'avoid_adjacency', errors)) {
      rawRelations.push({ a: id, b: relationId, type: 'separate', strength: 'hard' });
    }
    for (const relationId of relationValues(rawRoom.adjacent_to, id, 'adjacent_to', errors)) {
      rawRelations.push({ a: id, b: relationId, type: 'adjacent', strength: 'soft' });
    }
  }

  const relationByPair = new Map<string, LayoutRelation>();
  for (const relation of rawRelations) {
    const canonicalB = aliases.get(relation.b.toLowerCase());
    if (!canonicalB) {
      errors.push(issue('UNKNOWN_ROOM_RELATION', `${relation.a} references unknown room ${relation.b}.`, relation.a));
      continue;
    }
    if (canonicalB.toLowerCase() === relation.a.toLowerCase()) {
      errors.push(issue('SELF_ROOM_RELATION', `${relation.a} may not reference itself.`, relation.a));
      continue;
    }
    const [roomA, roomB] = [relation.a, canonicalB].sort(stableCompare);
    const pair = `${roomA.toLowerCase()}|${roomB.toLowerCase()}`;
    const existing = relationByPair.get(pair);
    if (existing && existing.type !== relation.type) {
      errors.push(issue('CONFLICTING_ROOM_RELATION', `${roomA} and ${roomB} are both adjacent and separate constraints.`, pair));
      continue;
    }
    const weight = relation.type === 'separate'
      ? weights.separation
      : relation.strength === 'hard' ? weights.requiredAdjacency : weights.preferredAdjacency;
    if (!existing || (existing.strength === 'soft' && relation.strength === 'hard')) {
      relationByPair.set(pair, { roomA, roomB, type: relation.type, strength: relation.strength, weight });
    }
  }

  const roomIds = new Set(rooms.map((room) => room.id.toLowerCase()));
  const obstacleIds = Array.isArray(input?.geometry?.excludedAreas)
    ? input.geometry.excludedAreas
      .map((obstacle) => cleanString(obstacle?.id)?.toLowerCase())
      .filter((value): value is string => Boolean(value))
    : [];
  for (const obstacleId of obstacleIds) {
    const canonicalRoomId = aliases.get(obstacleId);
    if (roomIds.has(obstacleId) || canonicalRoomId) {
      errors.push(issue(
        'PROGRAM_ROOM_MUST_NOT_BE_OBSTACLE',
        `${canonicalRoomId ?? obstacleId} is a program room and may not also be subtracted as an excluded area.`,
        canonicalRoomId ?? obstacleId,
      ));
    }
  }

  if (!input?.geometry || typeof input.geometry !== 'object') {
    errors.push(issue('MISSING_GEOMETRY', 'A floor geometry source is required.'));
    return { ok: false, errors, warnings };
  }
  rooms.sort((a, b) => stableCompare(a.id, b.id));
  const { excludedAreas: rawExcludedAreas, ...boundaryGeometry } = input.geometry;
  const excludedAreas = Array.isArray(rawExcludedAreas) ? rawExcludedAreas : [];
  if (rawExcludedAreas !== undefined && !Array.isArray(rawExcludedAreas)) {
    errors.push(issue('MALFORMED_EXCLUDED_AREAS', 'excludedAreas must be an array.'));
  }
  const geometryValidation = validateFloorGeometryContract({
    ...boundaryGeometry,
    levelId: levelId ?? boundaryGeometry.levelId,
    fixedObstacles: excludedAreas,
    rooms: rooms.map((room) => ({
      roomId: room.id,
      targetAreaM2: room.targetAreaM2,
      requiredAdjacency: Array.from(relationByPair.values())
        .filter((relation) => relation.type === 'adjacent' && relation.strength === 'hard' && (relation.roomA === room.id || relation.roomB === room.id))
        .map((relation) => relation.roomA === room.id ? relation.roomB : relation.roomA),
      avoidAdjacency: Array.from(relationByPair.values())
        .filter((relation) => relation.type === 'separate' && (relation.roomA === room.id || relation.roomB === room.id))
        .map((relation) => relation.roomA === room.id ? relation.roomB : relation.roomA),
    })),
    reservedCirculationAreaM2: input.reservedCirculationAreaM2,
  });
  warnings.push(...mapGeometryIssues(geometryValidation.warnings));
  if (geometryValidation.ok === false) errors.push(...mapGeometryIssues(geometryValidation.violations));

  const fixedRooms = rooms.filter((room) => room.fixedPlacement);
  if (fixedRooms.length > 0) {
    const placementValidation = validateFloorGeometryContract({
      ...boundaryGeometry,
      levelId: levelId ?? boundaryGeometry.levelId,
      fixedObstacles: [
        ...excludedAreas,
        ...fixedRooms.map((room) => ({ id: `fixed-room:${room.id}`, polygon: room.fixedPlacement!.polygon })),
      ],
      allowFixedObstacleBoundaryContact: true,
      rooms: [],
    });
    if (placementValidation.ok === false) {
      errors.push(...mapGeometryIssues(placementValidation.violations).map((value) => ({
        ...value,
        code: `FIXED_PLACEMENT_${value.code}`,
      })));
    }
  }

  if (errors.length > 0 || geometryValidation.ok === false || !problemId || !levelId) {
    return { ok: false, errors, warnings };
  }
  const relations = Array.from(relationByPair.values()).sort((a, b) =>
    stableCompare(`${a.roomA}|${a.roomB}|${a.type}`, `${b.roomA}|${b.roomB}|${b.type}`));
  return {
    ok: true,
    warnings,
    problem: {
      schemaVersion: '1.0',
      problemId,
      ...(buildingId ? { buildingId } : {}),
      levelId,
      seed,
      geometry: (({ rooms: _rooms, reservedCirculationAreaM2: _reserve, roomDemandAreaM2: _demand, ...geometry }) => geometry)(geometryValidation.contract),
      reservedCirculationAreaM2: input.reservedCirculationAreaM2 ?? 0,
      programAreaM2: geometryValidation.contract.roomDemandAreaM2,
      rooms,
      relations,
      weights,
    },
  };
}
