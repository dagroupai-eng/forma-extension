import { describe, expect, it } from 'vitest';
import {
  geometryAuthorityPolicy,
  validateFloorGeometryContract,
  type FloorGeometryContractInput,
} from './geometry_contract';

const rectangle = (width: number, depth: number, x = 0, y = 0): [number, number][] => [
  [x, y],
  [x + width, y],
  [x + width, y + depth],
  [x, y + depth],
  [x, y],
];

const baseInput = (overrides: Partial<FloorGeometryContractInput> = {}): FloorGeometryContractInput => ({
  schemaVersion: '1.0',
  levelId: 'B1',
  source: 'existing-gfa',
  coordinateSystem: 'local-meters',
  outerBoundary: rectangle(100, 80),
  rooms: [],
  ...overrides,
});

describe('geometry authority policy', () => {
  it('recognizes existing GFA authority but never auto-deletes without explicit confirmation', () => {
    expect(geometryAuthorityPolicy('existing-gfa')).toMatchObject({
      mode: 'exact',
      preservesExistingMassShape: true,
      mayAutoDeleteOriginal: false,
    });
    for (const source of ['source-room-polygons', 'authored-json', 'pdf-program'] as const) {
      expect(geometryAuthorityPolicy(source).mayAutoDeleteOriginal).toBe(false);
      expect(geometryAuthorityPolicy(source).preservesExistingMassShape).toBe(false);
    }
    expect(geometryAuthorityPolicy('pdf-program').mode).toBe('conceptual');
  });
});

describe('validateFloorGeometryContract', () => {
  it('returns violations instead of throwing for malformed top-level collections', () => {
    const malformed = {
      ...baseInput(),
      holes: {},
      fixedObstacles: [null],
      rooms: [{ roomId: 'A', targetAreaM2: 10, requiredAdjacency: 'B' }],
    } as unknown as FloorGeometryContractInput;

    const result = validateFloorGeometryContract(malformed);

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.violations.map((violation) => violation.code)).toEqual(expect.arrayContaining([
      'MALFORMED_HOLES',
      'MALFORMED_OBSTACLE',
      'MALFORMED_ROOM_RELATION',
    ]));
  });
  it('normalizes a closed 7,850m2 ring and reports exact area', () => {
    const result = validateFloorGeometryContract(baseInput({ outerBoundary: rectangle(100, 78.5) }));

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.contract.outerBoundary).toHaveLength(4);
    expect(result.contract.outerAreaM2).toBe(7_850);
    expect(result.contract.usableAreaM2).toBe(7_850);
  });

  it('subtracts holes and non-overlapping fixed obstacles from usable area', () => {
    const result = validateFloorGeometryContract(baseInput({
      outerBoundary: rectangle(100, 100),
      holes: [rectangle(10, 10, 10, 10)],
      fixedObstacles: [{ id: 'core', polygon: rectangle(10, 15, 40, 40) }],
    }));

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.contract.holesAreaM2).toBe(100);
    expect(result.contract.fixedObstacleAreaM2).toBe(150);
    expect(result.contract.usableAreaM2).toBe(9_750);
  });

  it('rejects self-intersecting outer boundaries', () => {
    const result = validateFloorGeometryContract(baseInput({
      outerBoundary: [[0, 0], [10, 10], [0, 10], [10, 0]],
    }));

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.violations.map((item) => item.code)).toContain('SELF_INTERSECTING_RING');
  });

  it('rejects malformed coordinates instead of silently deleting them', () => {
    const result = validateFloorGeometryContract(baseInput({
      outerBoundary: [[0, 0], [10, 0], null, [10, 10], [0, 10]] as any,
    }));

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.violations.map((item) => item.code)).toContain('MALFORMED_COORDINATE');
  });

  it('rejects holes and obstacles outside the floor boundary', () => {
    const result = validateFloorGeometryContract(baseInput({
      holes: [rectangle(10, 10, 95, 10)],
      fixedObstacles: [{ id: 'outside-core', polygon: rectangle(5, 5, 110, 10) }],
    }));

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.violations.map((item) => item.code)).toEqual(expect.arrayContaining([
      'HOLE_OUTSIDE_BOUNDARY',
      'OBSTACLE_OUTSIDE_BOUNDARY',
    ]));
  });

  it('rejects overlapping obstacles instead of double-subtracting their areas', () => {
    const result = validateFloorGeometryContract(baseInput({
      fixedObstacles: [
        { id: 'core-a', polygon: rectangle(20, 20, 10, 10) },
        { id: 'core-b', polygon: rectangle(20, 20, 20, 20) },
      ],
    }));

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.violations.map((item) => item.code)).toContain('OVERLAPPING_OBSTACLES');
  });

  it('rejects duplicate obstacle IDs case-insensitively', () => {
    const result = validateFloorGeometryContract(baseInput({
      fixedObstacles: [
        { id: 'Core', polygon: rectangle(5, 5, 10, 10) },
        { id: ' core ', polygon: rectangle(5, 5, 30, 30) },
      ],
    }));

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.violations.map((item) => item.code)).toContain('DUPLICATE_OBSTACLE_ID');
  });

  it('rejects infeasible room demand and invalid room relationships before layout', () => {
    const result = validateFloorGeometryContract(baseInput({
      outerBoundary: rectangle(10, 10),
      rooms: [
        { roomId: 'A', targetAreaM2: 60, requiredAdjacency: ['missing', 'B'] },
        { roomId: 'b', targetAreaM2: 50, avoidAdjacency: ['A'] },
        { roomId: 'B', targetAreaM2: 5 },
      ],
    }));

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.violations.map((item) => item.code)).toEqual(expect.arrayContaining([
      'DUPLICATE_ROOM_ID',
      'UNKNOWN_ROOM_RELATION',
      'ROOM_PROGRAM_EXCEEDS_USABLE_AREA',
    ]));
  });

  it('rejects required/avoid conflicts declared from opposite rooms', () => {
    const result = validateFloorGeometryContract(baseInput({
      rooms: [
        { roomId: 'A', targetAreaM2: 20, requiredAdjacency: ['B'] },
        { roomId: 'B', targetAreaM2: 20, avoidAdjacency: ['A'] },
      ],
    }));

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.violations.map((item) => item.code)).toContain('CONFLICTING_ROOM_RELATION');
  });

  it('returns violations for unsupported sources and invalid circulation reserve', () => {
    const result = validateFloorGeometryContract(baseInput({
      source: 'unknown' as any,
      reservedCirculationAreaM2: -10,
    }));

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.violations.map((item) => item.code)).toEqual(expect.arrayContaining([
      'UNSUPPORTED_GEOMETRY_SOURCE',
      'INVALID_RESERVED_CIRCULATION_AREA',
    ]));
  });

  it('marks a PDF-program rectangle as conceptual and unable to prove existing shape', () => {
    const result = validateFloorGeometryContract(baseInput({ source: 'pdf-program' }));

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.contract.authority).toMatchObject({
      mode: 'conceptual',
      preservesExistingMassShape: false,
      mayAutoDeleteOriginal: false,
    });
    expect(result.warnings.map((item) => item.code)).toContain('EXISTING_SHAPE_NOT_PROVEN');
  });
});
