import { describe, expect, it } from 'vitest';
import { createB17850Rooms, B1_7850_DEPTH_M, B1_7850_WIDTH_M } from './fixtures/b1-7850';
import { normalizeLayoutProblem } from './normalize';

function b1Geometry() {
  return {
    schemaVersion: '1.0' as const,
    levelId: 'B1',
    source: 'pdf-program' as const,
    coordinateSystem: 'local-meters' as const,
    outerBoundary: [
      [0, 0],
      [B1_7850_WIDTH_M, 0],
      [B1_7850_WIDTH_M, B1_7850_DEPTH_M],
      [0, B1_7850_DEPTH_M],
    ] as [number, number][],
  };
}

describe('normalizeLayoutProblem', () => {
  it('preserves the complete B1 7,850m2 six-room program without inventing coordinates', () => {
    const result = normalizeLayoutProblem({
      problemId: 'main-tower:B1',
      buildingId: 'main-tower',
      levelId: 'B1',
      geometry: b1Geometry(),
      rooms: createB17850Rooms(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problem.geometry.outerAreaM2).toBeCloseTo(7_850, 6);
    expect(result.problem.programAreaM2).toBe(7_850);
    expect(result.problem.rooms).toHaveLength(6);
    expect(result.problem.rooms.reduce((sum, room) => sum + room.targetAreaM2, 0)).toBe(7_850);
    expect(result.problem.rooms.find((room) => room.id === 'B1_P01')?.targetAreaM2).toBe(5_500);
    expect(result.problem.rooms.find((room) => room.id === 'B1_CORE')?.kind).toBe('CORE');
    expect(result.problem.rooms.every((room) => room.fixedPlacement === undefined)).toBe(true);
  });

  it('normalizes room and relation order deterministically and upgrades soft adjacency to hard', () => {
    const rooms = [
      { room_id: 'B', name: 'B', area_m2: 40, adjacent_to: ['A'] },
      { room_id: 'A', name: 'A', area_m2: 60, required_adjacency: ['b'] },
    ];
    const first = normalizeLayoutProblem({ problemId: 'p', levelId: 'L1', geometry: {
      ...b1Geometry(), levelId: 'L1', outerBoundary: [[0, 0], [10, 0], [10, 10], [0, 10]],
    }, rooms });
    const second = normalizeLayoutProblem({ problemId: 'p', levelId: 'L1', geometry: {
      ...b1Geometry(), levelId: 'L1', outerBoundary: [[0, 0], [10, 0], [10, 10], [0, 10]],
    }, rooms: [...rooms].reverse() });

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.problem.rooms.map((room) => room.id)).toEqual(['A', 'B']);
    expect(first.problem.relations).toEqual([{
      roomA: 'A', roomB: 'B', type: 'adjacent', strength: 'hard', weight: 25,
    }]);
  });

  it('rejects a program core that is also subtracted as an obstacle', () => {
    const result = normalizeLayoutProblem({
      problemId: 'p', levelId: 'B1', geometry: {
        ...b1Geometry(),
        excludedAreas: [{ id: 'B1_CORE', polygon: [[0, 0], [10, 0], [10, 15], [0, 15]] }],
      },
      rooms: createB17850Rooms(),
    });

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errors.some((error) => error.code === 'PROGRAM_ROOM_MUST_NOT_BE_OBSTACLE')).toBe(true);
  });

  it('rejects conflicting and unknown relations before a solver is called', () => {
    const result = normalizeLayoutProblem({
      problemId: 'p', levelId: 'L1', geometry: {
        ...b1Geometry(), levelId: 'L1', outerBoundary: [[0, 0], [10, 0], [10, 10], [0, 10]],
      },
      rooms: [
        { room_id: 'A', area_m2: 50, required_adjacency: ['B'], avoid_adjacency: ['b', 'missing'] },
        { room_id: 'B', area_m2: 50 },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errors.some((error) => error.code === 'CONFLICTING_ROOM_RELATION')).toBe(true);
    expect(result.errors.some((error) => error.code === 'UNKNOWN_ROOM_RELATION')).toBe(true);
  });

  it('carries only explicit room polygons as fixed placements', () => {
    const result = normalizeLayoutProblem({
      problemId: 'p', levelId: 'L1', geometry: {
        ...b1Geometry(), levelId: 'L1', source: 'authored-json', outerBoundary: [[0, 0], [10, 0], [10, 10], [0, 10]],
      },
      rooms: [
        { room_id: 'A', area_m2: 50, polygon: [[0, 0], [5, 0], [5, 10], [0, 10]], locked: true },
        { room_id: 'B', area_m2: 50 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problem.rooms[0].fixedPlacement?.source).toBe('user-lock');
    expect(result.problem.rooms[1].fixedPlacement).toBeUndefined();
  });

  it('returns validation issues for malformed room collections and ranges', () => {
    const malformed = normalizeLayoutProblem({
      problemId: 'p', levelId: 'L1', geometry: b1Geometry(), rooms: 'bad' as never,
    });
    expect(malformed.ok).toBe(false);
    if (malformed.ok === false) expect(malformed.errors.some((error) => error.code === 'MALFORMED_ROOMS')).toBe(true);

    const invalidRange = normalizeLayoutProblem({
      problemId: 'p', levelId: 'L1', geometry: b1Geometry(),
      rooms: [{ room_id: 'A', area_m2: 50, min_area_m2: 60, max_area_m2: 40 }],
    });
    expect(invalidRange.ok).toBe(false);
    if (invalidRange.ok === false) expect(invalidRange.errors.some((error) => error.code === 'INVALID_ROOM_AREA_RANGE')).toBe(true);
  });

  it('rejects room/function aliases deterministically regardless of input order', () => {
    const rooms = [
      { room_id: 'A', function_id: 'B', area_m2: 50 },
      { room_id: 'B', area_m2: 50 },
    ];
    const make = (values: typeof rooms) => normalizeLayoutProblem({
      problemId: 'p', levelId: 'L1', geometry: {
        ...b1Geometry(), levelId: 'L1', outerBoundary: [[0, 0], [10, 0], [10, 10], [0, 10]],
      }, rooms: values,
    });

    const first = make(rooms);
    const second = make([...rooms].reverse());
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok !== false || second.ok !== false) return;
    expect(first.errors.filter((value) => value.code === 'DUPLICATE_ROOM_ALIAS')).toEqual(
      second.errors.filter((value) => value.code === 'DUPLICATE_ROOM_ALIAS'),
    );
  });

  it('rejects malformed relation entries and runtime-only invalid room attributes', () => {
    const result = normalizeLayoutProblem({
      problemId: 'p', levelId: 'L1', geometry: b1Geometry(), rooms: [{
        room_id: 'A', area_m2: 100,
        required_adjacency: [123, null, ''] as never,
        daylight_priority: 'urgent' as never,
        core_proximity: 'near' as never,
        facade_required: 'true' as never,
        locked: 'true' as never,
        aspect_ratio_preference: 5 as never,
      }],
    });

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errors.filter((value) => value.code === 'MALFORMED_ROOM_RELATION')).toHaveLength(3);
    expect(result.errors.some((value) => value.code === 'INVALID_ROOM_ATTRIBUTE')).toBe(true);
    expect(result.errors.some((value) => value.code === 'INVALID_ASPECT_RATIO')).toBe(true);
  });

  it('rejects a fixed polygon whose edge crosses outside a concave boundary', () => {
    const result = normalizeLayoutProblem({
      problemId: 'concave', levelId: 'L1', geometry: {
        schemaVersion: '1.0', levelId: 'L1', source: 'authored-json', coordinateSystem: 'local-meters',
        outerBoundary: [[0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10]],
      },
      rooms: [{ room_id: 'A', area_m2: 8, polygon: [[2, 8], [8, 8], [8, 9], [2, 9]] }],
    });

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errors.some((value) =>
      value.code === 'FIXED_PLACEMENT_OBSTACLE_OUTSIDE_BOUNDARY')).toBe(true);
  });

  it('rejects a boundary-to-boundary chord that lies in a concave floor notch', () => {
    const result = normalizeLayoutProblem({
      problemId: 'concave-chord', levelId: 'L1', geometry: {
        schemaVersion: '1.0', levelId: 'L1', source: 'authored-json', coordinateSystem: 'local-meters',
        outerBoundary: [[0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10]],
      },
      rooms: [{ room_id: 'A', area_m2: 4, polygon: [[3, 7], [7, 7], [7, 8], [3, 8]] }],
    });

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errors.some((value) =>
      value.code === 'FIXED_PLACEMENT_OBSTACLE_OUTSIDE_BOUNDARY')).toBe(true);
  });

  it('detects a core obstacle through its function alias', () => {
    const result = normalizeLayoutProblem({
      problemId: 'p', levelId: 'L1', geometry: {
        ...b1Geometry(),
        excludedAreas: [{ id: 'core', polygon: [[0, 0], [10, 0], [10, 15], [0, 15]] }],
      },
      rooms: createB17850Rooms().map((room) => room.room_id === 'B1_CORE'
        ? { ...room, function_id: 'core' }
        : room),
    });

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.errors.some((value) => value.code === 'PROGRAM_ROOM_MUST_NOT_BE_OBSTACLE')).toBe(true);
  });
});
