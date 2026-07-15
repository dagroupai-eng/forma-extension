import { describe, expect, it } from 'vitest';
import {
  B1_7850_AREA_M2,
  B1_7850_ASSUMED_CORE_TEMPLATE,
  B1_7850_DEPTH_M,
  B1_7850_WIDTH_M,
  createB17850Rooms,
} from '../layout/fixtures/b1-7850';
import {
  buildFullCoverageCoreSlices,
  calculateFixedCoreBounds,
  findCoreRoom,
  tryLayoutAtEnvelope,
} from './full_coverage_layout';

describe('B1 7,850m2 layout characterization', () => {
  it('preserves the PDF room schedule as six rooms totaling exactly 7,850m2', () => {
    const rooms = createB17850Rooms();
    const roomArea = rooms.reduce((sum, room) => sum + room.area_m2, 0);

    expect(rooms).toHaveLength(6);
    expect(roomArea).toBe(B1_7850_AREA_M2);
    expect(B1_7850_WIDTH_M * B1_7850_DEPTH_M).toBeCloseTo(B1_7850_AREA_M2, 8);
    expect(rooms.find((room) => room.room_id === 'B1_P01')?.area_m2).toBe(5_500);
  });

  it('places the declared 150m2 core deterministically at the envelope center', () => {
    const rooms = createB17850Rooms();
    const coreRoom = findCoreRoom(rooms, B1_7850_ASSUMED_CORE_TEMPLATE);
    expect(coreRoom).toBeDefined();

    const first = calculateFixedCoreBounds(
      B1_7850_ASSUMED_CORE_TEMPLATE,
      coreRoom!,
      B1_7850_WIDTH_M,
      B1_7850_DEPTH_M,
    );
    const second = calculateFixedCoreBounds(
      B1_7850_ASSUMED_CORE_TEMPLATE,
      coreRoom!,
      B1_7850_WIDTH_M,
      B1_7850_DEPTH_M,
    );

    expect(second).toEqual(first);
    expect(first).not.toBeNull();
    expect((first!.coreX1 - first!.coreX0) * (first!.coreY1 - first!.coreY0)).toBeCloseTo(150, 0);
    expect((first!.coreX0 + first!.coreX1) / 2).toBe(0);
    expect((first!.coreY0 + first!.coreY1) / 2).toBe(0);
  });

  it('records the current regression: a 5,500m2 parking room cannot fit in one core-side zone', () => {
    const layout = tryLayoutAtEnvelope(
      createB17850Rooms(),
      B1_7850_ASSUMED_CORE_TEMPLATE,
      B1_7850_WIDTH_M,
      B1_7850_DEPTH_M,
    );

    // This is a characterization assertion for Stage 0. The current solver
    // assigns each room to one zone, so the parking room is rejected even
    // though the complete 7,850m2 program fits the envelope. Stage 4 will
    // replace this expectation with a valid core-wrapping solution.
    expect(layout).toBeNull();
  });

  it('records that the current full-coverage fallback also rejects the feasible B1 program', () => {
    const first = buildFullCoverageCoreSlices(
      createB17850Rooms(),
      B1_7850_ASSUMED_CORE_TEMPLATE,
      B1_7850_AREA_M2,
      undefined,
      undefined,
      B1_7850_WIDTH_M,
      B1_7850_DEPTH_M,
    );
    const second = buildFullCoverageCoreSlices(
      createB17850Rooms(),
      B1_7850_ASSUMED_CORE_TEMPLATE,
      B1_7850_AREA_M2,
      undefined,
      undefined,
      B1_7850_WIDTH_M,
      B1_7850_DEPTH_M,
    );

    // The complete room schedule equals the complete envelope area, so this is
    // geometrically feasible when the parking room may wrap around the core.
    // The current fallback cannot express that shape and returns null before
    // any Forma SDK call. This assertion is the Stage 0 regression baseline.
    expect(first).toBeNull();
    expect(second).toEqual(first);
  });
});
