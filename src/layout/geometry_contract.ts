export type Point2 = [number, number];

export type GeometryAuthoritySource =
  | 'existing-gfa'
  | 'source-room-polygons'
  | 'authored-json'
  | 'pdf-program';

export type GeometryMode = 'exact' | 'conceptual';

export interface GeometryAuthorityPolicy {
  mode: GeometryMode;
  preservesExistingMassShape: boolean;
  mayAutoDeleteOriginal: boolean;
  description: string;
}

export interface GeometryRoomProgram {
  roomId: string;
  targetAreaM2: number;
  requiredAdjacency?: string[];
  avoidAdjacency?: string[];
}

export interface FloorGeometryContractInput {
  schemaVersion: '1.0';
  levelId: string;
  source: GeometryAuthoritySource;
  coordinateSystem: 'local-meters';
  outerBoundary: Point2[];
  holes?: Point2[][];
  fixedObstacles?: Array<{ id: string; polygon: Point2[] }>;
  /** When true, obstacle edges may touch/overlap the outer boundary but may never cross outside it. */
  allowFixedObstacleBoundaryContact?: boolean;
  rooms?: GeometryRoomProgram[];
  reservedCirculationAreaM2?: number;
}

export interface FloorGeometryContract extends FloorGeometryContractInput {
  holes: Point2[][];
  fixedObstacles: Array<{ id: string; polygon: Point2[] }>;
  rooms: GeometryRoomProgram[];
  authority: GeometryAuthorityPolicy;
  outerAreaM2: number;
  holesAreaM2: number;
  fixedObstacleAreaM2: number;
  usableAreaM2: number;
  roomDemandAreaM2: number;
}

export interface GeometryContractViolation {
  code: string;
  entityId?: string;
  message: string;
}

export type GeometryContractValidationResult =
  | { ok: true; contract: FloorGeometryContract; warnings: GeometryContractViolation[] }
  | { ok: false; violations: GeometryContractViolation[]; warnings: GeometryContractViolation[] };

const COORD_EPSILON = 1e-8;
const AREA_EPSILON_M2 = 1e-6;

export function geometryAuthorityPolicy(source: GeometryAuthoritySource): GeometryAuthorityPolicy {
  switch (source) {
    case 'existing-gfa':
      return {
        mode: 'exact',
        preservesExistingMassShape: true,
        mayAutoDeleteOriginal: false,
        description: 'Existing mass rectangular GFA floor outline is authoritative; replacement still requires explicit confirmation.',
      };
    case 'source-room-polygons':
      return {
        mode: 'exact',
        preservesExistingMassShape: false,
        mayAutoDeleteOriginal: false,
        description: 'Source-authored requested room geometry is exact; equivalence to the existing mass is unknown.',
      };
    case 'authored-json':
      return {
        mode: 'exact',
        preservesExistingMassShape: false,
        mayAutoDeleteOriginal: false,
        description: 'Authored floor geometry is exact; equivalence to the existing mass is unknown.',
      };
    case 'pdf-program':
      return {
        mode: 'conceptual',
        preservesExistingMassShape: false,
        mayAutoDeleteOriginal: false,
        description: 'Only the floor program area is authoritative; the generated rectangular shape is conceptual.',
      };
  }
}

function samePoint(a: Point2, b: Point2): boolean {
  return Math.abs(a[0] - b[0]) <= COORD_EPSILON && Math.abs(a[1] - b[1]) <= COORD_EPSILON;
}

export function normalizeRing(value: Point2[]): Point2[] {
  const points: Point2[] = [];
  for (const point of value ?? []) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const normalized: Point2 = [Number(point[0]), Number(point[1])];
    if (points.length === 0 || !samePoint(points[points.length - 1], normalized)) points.push(normalized);
  }
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  return points;
}

function normalizeRingForValidation(
  value: unknown,
  entityId: string,
  violations: GeometryContractViolation[],
): Point2[] {
  if (!Array.isArray(value)) {
    violations.push({ code: 'MALFORMED_RING', entityId, message: `${entityId} must be an array of coordinate pairs.` });
    return [];
  }
  const points: Point2[] = [];
  value.forEach((point, index) => {
    if (!Array.isArray(point) || point.length < 2 ||
        typeof point[0] !== 'number' || typeof point[1] !== 'number' ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      violations.push({
        code: 'MALFORMED_COORDINATE',
        entityId,
        message: `${entityId} contains an invalid coordinate at index ${index}.`,
      });
      return;
    }
    const normalized: Point2 = [point[0], point[1]];
    if (points.length === 0 || !samePoint(points[points.length - 1], normalized)) points.push(normalized);
  });
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  return points;
}

export function signedRingArea(ring: Point2[]): number {
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    sum += current[0] * next[1] - next[0] * current[1];
  }
  return sum / 2;
}

export function ringArea(ring: Point2[]): number {
  return Math.abs(signedRingArea(ring));
}

function cross(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointOnSegment(point: Point2, a: Point2, b: Point2): boolean {
  if (Math.abs(cross(a, b, point)) > COORD_EPSILON) return false;
  return point[0] >= Math.min(a[0], b[0]) - COORD_EPSILON &&
    point[0] <= Math.max(a[0], b[0]) + COORD_EPSILON &&
    point[1] >= Math.min(a[1], b[1]) - COORD_EPSILON &&
    point[1] <= Math.max(a[1], b[1]) + COORD_EPSILON;
}

type SegmentIntersection = 'none' | 'touch' | 'cross' | 'overlap';

function segmentIntersection(a: Point2, b: Point2, c: Point2, d: Point2): SegmentIntersection {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  const abCZero = Math.abs(abC) <= COORD_EPSILON;
  const abDZero = Math.abs(abD) <= COORD_EPSILON;
  const cdAZero = Math.abs(cdA) <= COORD_EPSILON;
  const cdBZero = Math.abs(cdB) <= COORD_EPSILON;

  if (abCZero && abDZero && cdAZero && cdBZero) {
    const useX = Math.abs(a[0] - b[0]) >= Math.abs(a[1] - b[1]);
    const values1 = [useX ? a[0] : a[1], useX ? b[0] : b[1]].sort((x, y) => x - y);
    const values2 = [useX ? c[0] : c[1], useX ? d[0] : d[1]].sort((x, y) => x - y);
    const overlap = Math.min(values1[1], values2[1]) - Math.max(values1[0], values2[0]);
    if (overlap > COORD_EPSILON) return 'overlap';
    if (overlap >= -COORD_EPSILON) return 'touch';
    return 'none';
  }

  if ((abC > COORD_EPSILON && abD < -COORD_EPSILON || abC < -COORD_EPSILON && abD > COORD_EPSILON) &&
      (cdA > COORD_EPSILON && cdB < -COORD_EPSILON || cdA < -COORD_EPSILON && cdB > COORD_EPSILON)) {
    return 'cross';
  }

  if ((abCZero && pointOnSegment(c, a, b)) || (abDZero && pointOnSegment(d, a, b)) ||
      (cdAZero && pointOnSegment(a, c, d)) || (cdBZero && pointOnSegment(b, c, d))) {
    return 'touch';
  }
  return 'none';
}

export type PointLocation = 'inside' | 'boundary' | 'outside';

export function classifyPointInRing(point: Point2, ring: Point2[]): PointLocation {
  for (let index = 0; index < ring.length; index += 1) {
    if (pointOnSegment(point, ring[index], ring[(index + 1) % ring.length])) return 'boundary';
  }
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[previous];
    if ((y1 > point[1]) !== (y2 > point[1]) &&
        point[0] < ((x2 - x1) * (point[1] - y1)) / (y2 - y1) + x1) {
      inside = !inside;
    }
  }
  return inside ? 'inside' : 'outside';
}

function ringSelfIntersects(ring: Point2[]): boolean {
  for (let first = 0; first < ring.length; first += 1) {
    const firstNext = (first + 1) % ring.length;
    for (let second = first + 1; second < ring.length; second += 1) {
      const secondNext = (second + 1) % ring.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (first === 0 && secondNext === 0) continue;
      if (segmentIntersection(ring[first], ring[firstNext], ring[second], ring[secondNext]) !== 'none') return true;
    }
  }
  return false;
}

function ringsIntersect(a: Point2[], b: Point2[]): boolean {
  for (let ai = 0; ai < a.length; ai += 1) {
    for (let bi = 0; bi < b.length; bi += 1) {
      if (segmentIntersection(a[ai], a[(ai + 1) % a.length], b[bi], b[(bi + 1) % b.length]) !== 'none') return true;
    }
  }
  return false;
}

function ringsOverlapOrContain(a: Point2[], b: Point2[]): boolean {
  return ringsIntersect(a, b) || classifyPointInRing(a[0], b) !== 'outside' || classifyPointInRing(b[0], a) !== 'outside';
}

/** True only when every vertex and edge stays inside the boundary. */
export function isRingContainedInBoundary(inner: Point2[], outer: Point2[], allowBoundaryContact: boolean): boolean {
  if (inner.length < 3 || outer.length < 3) return false;
  if (inner.some((point) => classifyPointInRing(point, outer) === 'outside')) return false;
  for (let innerIndex = 0; innerIndex < inner.length; innerIndex += 1) {
    const innerStart = inner[innerIndex];
    const innerEnd = inner[(innerIndex + 1) % inner.length];
    const parameters = [0, 1];
    for (let outerIndex = 0; outerIndex < outer.length; outerIndex += 1) {
      const intersection = segmentIntersection(
        innerStart, innerEnd,
        outer[outerIndex], outer[(outerIndex + 1) % outer.length],
      );
      if (intersection === 'cross') return false;
      if (!allowBoundaryContact && intersection !== 'none') return false;
      if (intersection !== 'none') {
        const dx = innerEnd[0] - innerStart[0];
        const dy = innerEnd[1] - innerStart[1];
        const denominator = dx * (outer[(outerIndex + 1) % outer.length][1] - outer[outerIndex][1]) -
          dy * (outer[(outerIndex + 1) % outer.length][0] - outer[outerIndex][0]);
        if (Math.abs(denominator) > COORD_EPSILON) {
          const cx = outer[outerIndex][0] - innerStart[0];
          const cy = outer[outerIndex][1] - innerStart[1];
          const sx = outer[(outerIndex + 1) % outer.length][0] - outer[outerIndex][0];
          const sy = outer[(outerIndex + 1) % outer.length][1] - outer[outerIndex][1];
          const parameter = (cx * sy - cy * sx) / denominator;
          if (parameter >= -COORD_EPSILON && parameter <= 1 + COORD_EPSILON) {
            parameters.push(Math.max(0, Math.min(1, parameter)));
          }
        } else {
          // Collinear overlap: split at both outer endpoints so every interval
          // between boundary events can be classified independently.
          const useX = Math.abs(dx) >= Math.abs(dy);
          const span = useX ? dx : dy;
          if (Math.abs(span) > COORD_EPSILON) {
            for (const point of [outer[outerIndex], outer[(outerIndex + 1) % outer.length]]) {
              const parameter = ((useX ? point[0] - innerStart[0] : point[1] - innerStart[1])) / span;
              if (parameter >= -COORD_EPSILON && parameter <= 1 + COORD_EPSILON) {
                parameters.push(Math.max(0, Math.min(1, parameter)));
              }
            }
          }
        }
      }
    }
    const ordered = [...new Set(parameters.map((value) => Math.round(value / COORD_EPSILON) * COORD_EPSILON))]
      .sort((a, b) => a - b);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      if (ordered[index + 1] - ordered[index] <= COORD_EPSILON) continue;
      const parameter = (ordered[index] + ordered[index + 1]) / 2;
      const midpoint: Point2 = [
        innerStart[0] + (innerEnd[0] - innerStart[0]) * parameter,
        innerStart[1] + (innerEnd[1] - innerStart[1]) * parameter,
      ];
      if (classifyPointInRing(midpoint, outer) === 'outside') return false;
    }
  }
  return true;
}

function validateRing(ring: Point2[], entityId: string, violations: GeometryContractViolation[]): void {
  if (ring.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
    violations.push({ code: 'NON_FINITE_COORDINATE', entityId, message: `${entityId} contains a non-finite coordinate.` });
    return;
  }
  if (new Set(ring.map(([x, y]) => `${x},${y}`)).size < 3) {
    violations.push({ code: 'INSUFFICIENT_VERTICES', entityId, message: `${entityId} must contain at least three distinct vertices.` });
    return;
  }
  if (ringSelfIntersects(ring)) {
    violations.push({ code: 'SELF_INTERSECTING_RING', entityId, message: `${entityId} is self-intersecting or self-touching.` });
  }
  if (ringArea(ring) <= AREA_EPSILON_M2) {
    violations.push({ code: 'ZERO_AREA_RING', entityId, message: `${entityId} has zero or negligible area.` });
  }
}

export function validateFloorGeometryContract(input: FloorGeometryContractInput): GeometryContractValidationResult {
  const violations: GeometryContractViolation[] = [];
  const warnings: GeometryContractViolation[] = [];
  const levelId = String(input.levelId ?? '').trim();
  if (!levelId) violations.push({ code: 'MISSING_LEVEL_ID', message: 'A non-empty levelId is required.' });
  if (input.schemaVersion !== '1.0') violations.push({ code: 'UNSUPPORTED_SCHEMA_VERSION', message: 'Only geometry contract schemaVersion 1.0 is supported.' });
  if (input.coordinateSystem !== 'local-meters') violations.push({ code: 'UNSUPPORTED_COORDINATE_SYSTEM', message: 'Geometry must use level-local metre coordinates.' });

  const validSources: GeometryAuthoritySource[] = ['existing-gfa', 'source-room-polygons', 'authored-json', 'pdf-program'];
  const sourceIsValid = validSources.includes(input.source);
  if (!sourceIsValid) violations.push({ code: 'UNSUPPORTED_GEOMETRY_SOURCE', message: `Unsupported geometry source: ${String(input.source)}.` });

  const outer = normalizeRingForValidation(input.outerBoundary, 'outerBoundary', violations);
  const rawHoles: unknown[] = input.holes === undefined
    ? []
    : Array.isArray(input.holes) ? input.holes : [];
  if (input.holes !== undefined && !Array.isArray(input.holes)) {
    violations.push({ code: 'MALFORMED_HOLES', message: 'holes must be an array of polygon rings.' });
  }
  const holes = rawHoles.map((hole, index) => normalizeRingForValidation(hole, `hole:${index}`, violations));
  const rawObstacles: unknown[] = input.fixedObstacles === undefined
    ? []
    : Array.isArray(input.fixedObstacles) ? input.fixedObstacles : [];
  if (input.fixedObstacles !== undefined && !Array.isArray(input.fixedObstacles)) {
    violations.push({ code: 'MALFORMED_OBSTACLES', message: 'fixedObstacles must be an array.' });
  }
  const obstacles = rawObstacles.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      violations.push({ code: 'MALFORMED_OBSTACLE', entityId: `obstacle:${index}`, message: `obstacle:${index} must be an object.` });
      return { id: '', polygon: [] as Point2[] };
    }
    const obstacle = value as { id?: unknown; polygon?: unknown };
    const id = String(obstacle.id ?? '').trim();
    return {
      id,
      polygon: normalizeRingForValidation(obstacle.polygon, id || `obstacle:${index}`, violations),
    };
  });
  validateRing(outer, 'outerBoundary', violations);
  holes.forEach((hole, index) => validateRing(hole, `hole:${index}`, violations));
  obstacles.forEach((obstacle, index) => {
    if (!obstacle.id) violations.push({ code: 'MISSING_OBSTACLE_ID', entityId: `obstacle:${index}`, message: 'Every fixed obstacle requires an ID.' });
    validateRing(obstacle.polygon, obstacle.id || `obstacle:${index}`, violations);
  });
  const obstacleIds = new Set<string>();
  for (const obstacle of obstacles) {
    const key = obstacle.id.toLowerCase();
    if (!key) continue;
    if (obstacleIds.has(key)) violations.push({ code: 'DUPLICATE_OBSTACLE_ID', entityId: obstacle.id, message: `Duplicate fixed obstacle ID: ${obstacle.id}.` });
    obstacleIds.add(key);
  }

  if (violations.length === 0) {
    holes.forEach((hole, index) => {
      const contained = hole.every((point) => classifyPointInRing(point, outer) === 'inside') && !ringsIntersect(hole, outer);
      if (!contained) violations.push({ code: 'HOLE_OUTSIDE_BOUNDARY', entityId: `hole:${index}`, message: `hole:${index} must be strictly inside the outer boundary.` });
    });
    for (let first = 0; first < holes.length; first += 1) {
      for (let second = first + 1; second < holes.length; second += 1) {
        if (ringsOverlapOrContain(holes[first], holes[second])) {
          violations.push({ code: 'OVERLAPPING_HOLES', entityId: `hole:${first}|hole:${second}`, message: 'Holes may not overlap, touch, or nest.' });
        }
      }
    }
    obstacles.forEach((obstacle) => {
      const contained = isRingContainedInBoundary(
        obstacle.polygon,
        outer,
        input.allowFixedObstacleBoundaryContact === true,
      );
      if (!contained) violations.push({ code: 'OBSTACLE_OUTSIDE_BOUNDARY', entityId: obstacle.id, message: `${obstacle.id} must be inside the outer boundary.` });
      if (holes.some((hole) => ringsOverlapOrContain(obstacle.polygon, hole))) {
        violations.push({ code: 'OBSTACLE_INTERSECTS_HOLE', entityId: obstacle.id, message: `${obstacle.id} may not overlap a floor hole.` });
      }
    });
    for (let first = 0; first < obstacles.length; first += 1) {
      for (let second = first + 1; second < obstacles.length; second += 1) {
        if (ringsOverlapOrContain(obstacles[first].polygon, obstacles[second].polygon)) {
          violations.push({ code: 'OVERLAPPING_OBSTACLES', entityId: `${obstacles[first].id}|${obstacles[second].id}`, message: 'Fixed obstacles may not overlap or contain one another.' });
        }
      }
    }
  }

  const rawRooms: unknown[] = input.rooms === undefined
    ? []
    : Array.isArray(input.rooms) ? input.rooms : [];
  if (input.rooms !== undefined && !Array.isArray(input.rooms)) {
    violations.push({ code: 'MALFORMED_ROOMS', message: 'rooms must be an array.' });
  }
  const rooms = rawRooms.map((value, index): GeometryRoomProgram => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      violations.push({ code: 'MALFORMED_ROOM', entityId: `room:${index}`, message: `room:${index} must be an object.` });
      return { roomId: '', targetAreaM2: Number.NaN, requiredAdjacency: [], avoidAdjacency: [] };
    }
    const room = value as Record<string, unknown>;
    const roomId = String(room.roomId ?? '').trim();
    const normalizeRelations = (field: 'requiredAdjacency' | 'avoidAdjacency'): string[] => {
      const relationValue = room[field];
      if (relationValue === undefined) return [];
      if (!Array.isArray(relationValue)) {
        violations.push({ code: 'MALFORMED_ROOM_RELATION', entityId: roomId || `room:${index}`, message: `${field} must be an array of room IDs.` });
        return [];
      }
      return relationValue.map((entry) => String(entry).trim()).filter(Boolean);
    };
    return {
      roomId,
      targetAreaM2: room.targetAreaM2 as number,
      requiredAdjacency: normalizeRelations('requiredAdjacency'),
      avoidAdjacency: normalizeRelations('avoidAdjacency'),
    };
  });
  const roomByKey = new Map<string, GeometryRoomProgram>();
  for (const room of rooms) {
    const key = room.roomId.toLowerCase();
    if (!room.roomId) violations.push({ code: 'MISSING_ROOM_ID', message: 'Every room requires a roomId.' });
    else if (roomByKey.has(key)) violations.push({ code: 'DUPLICATE_ROOM_ID', entityId: room.roomId, message: `Duplicate roomId: ${room.roomId}.` });
    else roomByKey.set(key, room);
    if (!Number.isFinite(room.targetAreaM2) || room.targetAreaM2 <= 0) {
      violations.push({ code: 'INVALID_ROOM_AREA', entityId: room.roomId, message: `${room.roomId || 'room'} requires a positive target area.` });
    }
  }
  const requiredPairs = new Set<string>();
  const avoidPairs = new Set<string>();
  const relationPair = (first: string, second: string) => [first.toLowerCase(), second.toLowerCase()].sort().join('|');
  for (const room of rooms) {
    const required = new Set((room.requiredAdjacency ?? []).map((value) => value.toLowerCase()));
    const avoid = new Set((room.avoidAdjacency ?? []).map((value) => value.toLowerCase()));
    for (const relationId of [...required, ...avoid]) {
      if (relationId === room.roomId.toLowerCase()) violations.push({ code: 'SELF_ROOM_RELATION', entityId: room.roomId, message: `${room.roomId} may not reference itself.` });
      else if (!roomByKey.has(relationId)) violations.push({ code: 'UNKNOWN_ROOM_RELATION', entityId: room.roomId, message: `${room.roomId} references unknown room ${relationId}.` });
    }
    for (const relationId of required) {
      if (avoid.has(relationId)) violations.push({ code: 'CONFLICTING_ROOM_RELATION', entityId: room.roomId, message: `${room.roomId} both requires and avoids ${relationId}.` });
      requiredPairs.add(relationPair(room.roomId, relationId));
    }
    for (const relationId of avoid) avoidPairs.add(relationPair(room.roomId, relationId));
  }
  for (const pair of requiredPairs) {
    if (avoidPairs.has(pair)) {
      violations.push({ code: 'CONFLICTING_ROOM_RELATION', entityId: pair, message: `Room pair ${pair} is both required and avoided.` });
    }
  }

  const outerAreaM2 = ringArea(outer);
  const holesAreaM2 = holes.reduce((sum, hole) => sum + ringArea(hole), 0);
  const fixedObstacleAreaM2 = obstacles.reduce((sum, obstacle) => sum + ringArea(obstacle.polygon), 0);
  const usableAreaM2 = Math.max(outerAreaM2 - holesAreaM2 - fixedObstacleAreaM2, 0);
  let reservedCirculationAreaM2 = 0;
  if (input.reservedCirculationAreaM2 !== undefined) {
    if (typeof input.reservedCirculationAreaM2 !== 'number' || !Number.isFinite(input.reservedCirculationAreaM2) || input.reservedCirculationAreaM2 < 0) {
      violations.push({ code: 'INVALID_RESERVED_CIRCULATION_AREA', entityId: levelId || undefined, message: 'reservedCirculationAreaM2 must be a finite, non-negative number.' });
    } else {
      reservedCirculationAreaM2 = input.reservedCirculationAreaM2;
    }
  }
  const roomDemandAreaM2 = rooms.reduce((sum, room) => sum + (Number(room.targetAreaM2) || 0), 0) + reservedCirculationAreaM2;
  const areaTolerance = Math.max(2, usableAreaM2 * 0.001);
  if (roomDemandAreaM2 > usableAreaM2 + areaTolerance) {
    violations.push({
      code: 'ROOM_PROGRAM_EXCEEDS_USABLE_AREA',
      entityId: levelId || undefined,
      message: `Room demand ${roomDemandAreaM2.toFixed(2)}m2 exceeds usable area ${usableAreaM2.toFixed(2)}m2.`,
    });
  }

  const authority = sourceIsValid ? geometryAuthorityPolicy(input.source) : null;
  if (authority && !authority.preservesExistingMassShape) {
    warnings.push({ code: 'EXISTING_SHAPE_NOT_PROVEN', entityId: levelId || undefined, message: authority.description });
  }

  if (violations.length > 0 || !authority) return { ok: false, violations, warnings };
  return {
    ok: true,
    warnings,
    contract: {
      ...input,
      levelId,
      outerBoundary: signedRingArea(outer) < 0 ? [...outer].reverse() : outer,
      holes: holes.map((hole) => signedRingArea(hole) > 0 ? [...hole].reverse() : hole),
      fixedObstacles: obstacles,
      rooms,
      reservedCirculationAreaM2,
      authority,
      outerAreaM2,
      holesAreaM2,
      fixedObstacleAreaM2,
      usableAreaM2,
      roomDemandAreaM2,
    },
  };
}
