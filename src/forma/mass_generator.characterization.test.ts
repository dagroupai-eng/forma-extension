import { describe, expect, it, vi } from 'vitest';
import {
  B1_7850_AREA_M2,
  B1_7850_ASSUMED_CORE_TEMPLATE,
  B1_7850_DEPTH_M,
  B1_7850_WIDTH_M,
  createB17850Rooms,
} from '../layout/fixtures/b1-7850';

vi.mock('forma-embedded-view-sdk/auto', () => ({ Forma: {} }));

import { getGeneratedRectangularPlanAreaSummary } from './mass_generator';

describe('production B1 FloorStack candidate characterization', () => {
  it('captures the current generated-plan area loss before any Forma SDK call', () => {
    const summary = getGeneratedRectangularPlanAreaSummary({
      label: 'B1',
      areaM2: B1_7850_AREA_M2,
      heightM: 4,
      belowGrade: true,
      rooms: createB17850Rooms(),
      layoutType: 'AUTO',
      massLayoutType: 'RECTANGLE',
      coreTemplate: B1_7850_ASSUMED_CORE_TEMPLATE,
      envelopeWidthM: B1_7850_WIDTH_M,
      envelopeDepthM: B1_7850_DEPTH_M,
      preserveRoomAreas: true,
    });

    expect(summary).not.toBeNull();
    expect(summary!.unitCount).toBe(6);
    expect(summary!.areasByFunctionId.b1_m01).toBeCloseTo(800, 0);
    expect(summary!.areasByFunctionId.b1_e01).toBeCloseTo(500, 0);
    expect(summary!.areasByFunctionId.b1_r01).toBeCloseTo(300, 0);
    expect(summary!.areasByFunctionId.b1_s01).toBeCloseTo(600, 0);
    expect(summary!.areasByFunctionId.b1_core).toBeCloseTo(150, 0);
    expect(summary!.areasByFunctionId.b1_p01).toBeCloseTo(3_481.97, 1);
    expect(summary!.totalAreaM2).toBeCloseTo(5_832.03, 1);
  });

  it('rejects an undersized working envelope instead of producing another clipped plan', () => {
    const summary = getGeneratedRectangularPlanAreaSummary({
      label: 'B1',
      areaM2: B1_7850_AREA_M2,
      heightM: 4,
      belowGrade: true,
      rooms: createB17850Rooms(),
      layoutType: 'AUTO',
      massLayoutType: 'RECTANGLE',
      coreTemplate: B1_7850_ASSUMED_CORE_TEMPLATE,
      envelopeWidthM: 93,
      envelopeDepthM: 70,
      preserveRoomAreas: true,
    });

    expect(summary).toBeNull();
  });
});
