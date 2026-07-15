import { describe, expect, it, vi } from 'vitest';

vi.mock('forma-embedded-view-sdk/auto', () => ({ Forma: {} }));

import {
  deriveOrientedSiteFrame,
  makePlacementTransform,
  sampleContainingElevationFromTriangles,
  siteLocalOffsetToWorld,
} from './mass_generator';

type Point2 = [number, number];

function rotatedRectangle(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  rotationRad: number,
): Point2[] {
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const localCorners: Point2[] = [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2],
  ];

  return localCorners.map(([x, y]) => [
    centerX + x * cos - y * sin,
    centerY + x * sin + y * cos,
  ]);
}

/** Distance between two unoriented axes: angle and angle + PI are equivalent. */
function halfTurnAngleDistance(actual: number, expected: number): number {
  return Math.abs(Math.atan2(
    Math.sin(2 * (actual - expected)),
    Math.cos(2 * (actual - expected)),
  ) / 2);
}

function applyColumnMajorTransform(
  transform: number[],
  [x, y, z]: [number, number, number],
): [number, number, number] {
  return [
    transform[0] * x + transform[4] * y + transform[8] * z + transform[12],
    transform[1] * x + transform[5] * y + transform[9] * z + transform[13],
    transform[2] * x + transform[6] * y + transform[10] * z + transform[14],
  ];
}

describe('deriveOrientedSiteFrame', () => {
  it.each([
    ['0 degrees', 0],
    ['+30 degrees', Math.PI / 6],
    ['-30 degrees', -Math.PI / 6],
    ['90 degrees', Math.PI / 2],
  ])('recovers a rectangular constraint at %s', (_label, rotationRad) => {
    const polygon = rotatedRectangle(105, -37, 24, 8, rotationRad);

    const frame = deriveOrientedSiteFrame(polygon);

    expect(frame).not.toBeNull();
    if (!frame) return;
    expect(frame.centerX).toBeCloseTo(105, 10);
    expect(frame.centerY).toBeCloseTo(-37, 10);
    expect(frame.width).toBeCloseTo(24, 10);
    expect(frame.height).toBeCloseTo(8, 10);
    expect(halfTurnAngleDistance(frame.rotationRad, rotationRad)).toBeLessThan(1e-10);
  });

  it('is stable when the ring start vertex and winding direction change', () => {
    const rotationRad = Math.PI / 6;
    const polygon = rotatedRectangle(12, 34, 30, 10, rotationRad);
    const shifted = [...polygon.slice(2), ...polygon.slice(0, 2)];
    const reversed = [...polygon].reverse();
    const closed = [...shifted, shifted[0]];

    const reference = deriveOrientedSiteFrame(polygon);
    expect(reference).not.toBeNull();
    if (!reference) return;
    for (const candidate of [shifted, reversed, closed]) {
      const frame = deriveOrientedSiteFrame(candidate);
      expect(frame).not.toBeNull();
      if (!frame) continue;
      expect(frame.centerX).toBeCloseTo(reference.centerX, 10);
      expect(frame.centerY).toBeCloseTo(reference.centerY, 10);
      expect(frame.width).toBeCloseTo(reference.width, 10);
      expect(frame.height).toBeCloseTo(reference.height, 10);
      expect(halfTurnAngleDistance(frame.rotationRad, reference.rotationRad)).toBeLessThan(1e-10);
    }
  });
});

describe('makePlacementTransform', () => {
  it('maps local coordinates into world coordinates using a column-major transform', () => {
    const rotationRad = Math.PI / 6;
    const transform = makePlacementTransform(10, -4, 7, rotationRad);
    const world = applyColumnMajorTransform(transform, [2, 3, 5]);
    const cos = Math.cos(rotationRad);
    const sin = Math.sin(rotationRad);

    expect(transform).toHaveLength(16);
    expect(world[0]).toBeCloseTo(10 + 2 * cos - 3 * sin, 10);
    expect(world[1]).toBeCloseTo(-4 + 2 * sin + 3 * cos, 10);
    expect(world[2]).toBeCloseTo(12, 10);
    expect(transform[15]).toBe(1);
  });
});

describe('siteLocalOffsetToWorld', () => {
  it.each([
    ['0 degrees', 0],
    ['+30 degrees', Math.PI / 6],
    ['-30 degrees', -Math.PI / 6],
    ['90 degrees', Math.PI / 2],
  ])('rotates position-hint fractions along the site local axes at %s', (_label, rotationRad) => {
    const ox = 0.25;
    const oy = -0.5;
    const width = 40;
    const height = 20;
    const { x: worldX, y: worldY } = siteLocalOffsetToWorld(ox, oy, width, height, rotationRad);
    const localX = ox * width;
    const localY = oy * height;
    const cos = Math.cos(rotationRad);
    const sin = Math.sin(rotationRad);

    expect(worldX).toBeCloseTo(localX * cos - localY * sin, 10);
    expect(worldY).toBeCloseTo(localX * sin + localY * cos, 10);
  });

  it('maps an east hint to world north for a 90-degree site', () => {
    const { x: worldX, y: worldY } = siteLocalOffsetToWorld(0.25, 0, 40, 20, Math.PI / 2);

    expect(worldX).toBeCloseTo(0, 10);
    expect(worldY).toBeCloseTo(10, 10);
  });
});

describe('sampleContainingElevationFromTriangles', () => {
  const triangleAtZ = (z: number): number[] => [
    0, 0, z,
    10, 0, z,
    0, 10, z,
  ];

  it('interpolates Z only when the query point is covered by a triangle', () => {
    expect(sampleContainingElevationFromTriangles(triangleAtZ(12), 2, 3)).toBeCloseTo(12, 10);
  });

  it('does not borrow the nearest vertex elevation outside the mesh', () => {
    expect(sampleContainingElevationFromTriangles(triangleAtZ(48), 20, 20)).toBeNull();
  });

  it('uses the upper surface when overlapping terrain triangles cover the point', () => {
    const triangles = [...triangleAtZ(4), ...triangleAtZ(6)];
    expect(sampleContainingElevationFromTriangles(triangles, 2, 3)).toBeCloseTo(6, 10);
  });
});
