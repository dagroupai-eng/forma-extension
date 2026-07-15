import { describe, expect, it, vi } from 'vitest';

vi.mock('forma-embedded-view-sdk/auto', () => ({ Forma: {} }));

import {
  evaluateBuildingPlacementConfirmation,
  inspectVisibleBuildingMesh,
  validateVisibleBuildingMesh,
} from './mass_generator';

describe('evaluateBuildingPlacementConfirmation', () => {
  it('confirms placement only when the building layer, geometry, and world transform are all valid', () => {
    expect(evaluateBuildingPlacementConfirmation({
      inBuildingLayer: true,
      hasVisibleVolume: true,
      worldTransformValid: true,
      nonVirtual: true,
    })).toBe(true);
  });

  it('rejects readable geometry that is not registered in the Buildings layer', () => {
    expect(evaluateBuildingPlacementConfirmation({
      inBuildingLayer: false,
      hasVisibleVolume: true,
      worldTransformValid: true,
      nonVirtual: true,
    })).toBe(false);
  });

  it.each([
    ['unreadable geometry', false, true],
    ['an unverified world transform', true, false],
    ['unreadable geometry and an unverified world transform', false, false],
  ])('rejects a Buildings-layer element with %s', (_case, hasVisibleVolume, worldTransformValid) => {
    expect(evaluateBuildingPlacementConfirmation({
      inBuildingLayer: true,
      hasVisibleVolume,
      worldTransformValid,
      nonVirtual: true,
    })).toBe(false);
  });

  it('rejects an invalid world transform even when layer registration and geometry are valid', () => {
    expect(evaluateBuildingPlacementConfirmation({
      inBuildingLayer: true,
      hasVisibleVolume: true,
      worldTransformValid: false,
      nonVirtual: true,
    })).toBe(false);
  });

  it('rejects virtual geometry even when the other evidence is valid', () => {
    expect(evaluateBuildingPlacementConfirmation({
      inBuildingLayer: true,
      hasVisibleVolume: true,
      worldTransformValid: true,
      nonVirtual: false,
    })).toBe(false);
  });
});

function boxTriangles(
  centerX: number,
  centerY: number,
  minZ: number,
  width: number,
  depth: number,
  height: number,
): number[] {
  const x0 = centerX - width / 2;
  const x1 = centerX + width / 2;
  const y0 = centerY - depth / 2;
  const y1 = centerY + depth / 2;
  const z0 = minZ;
  const z1 = minZ + height;
  const vertices = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  return faces.flatMap((face) => face.flatMap((index) => vertices[index]));
}

function translationTransform(x: number, y: number, z: number): number[] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ];
}

describe('validateVisibleBuildingMesh', () => {
  const expected = { x: 222.8, y: 6.4, z: 18.35, heightM: 38 };

  it('accepts a finite 3D volume at the requested placement', () => {
    const result = validateVisibleBuildingMesh(
      boxTriangles(expected.x, expected.y, expected.z, 68.2, 45.5, expected.heightM),
      expected,
    );

    expect(result?.heightM).toBeCloseTo(38, 5);
    expect(result?.horizontalAreaM2).toBeGreaterThan(3_000);
    expect(result?.coordinateFrame).toBe('world');
  });

  it('transforms a local FloorStack mesh into world coordinates before placement validation', () => {
    const localMesh = boxTriangles(0, 0, 0, 68.2, 45.5, expected.heightM);

    const result = inspectVisibleBuildingMesh(
      localMesh,
      expected,
      translationTransform(expected.x, expected.y, expected.z),
    );

    expect(result.failureReason).toBeNull();
    expect(result.evidence?.coordinateFrame).toBe('local_transformed');
    expect(result.evidence?.centerX).toBeCloseTo(expected.x, 5);
    expect(result.evidence?.minZ).toBeCloseTo(expected.z, 5);
  });

  it('does not apply the world transform twice when triangles are already in world coordinates', () => {
    const worldMesh = boxTriangles(expected.x, expected.y, expected.z, 68.2, 45.5, expected.heightM);

    const result = inspectVisibleBuildingMesh(
      worldMesh,
      expected,
      translationTransform(expected.x, expected.y, expected.z),
    );

    expect(result.failureReason).toBeNull();
    expect(result.evidence?.coordinateFrame).toBe('world');
  });

  it.each([
    ['an empty mesh', []],
    ['one flat triangle', [0, 0, 0, 10, 0, 0, 0, 10, 0]],
    ['a degenerate triangle', [0, 0, 0, 0, 0, 0, 0, 0, 0]],
    ['non-finite coordinates', [0, 0, 0, 10, 0, 0, 0, Number.NaN, 0]],
  ])('rejects %s', (_label, triangles) => {
    expect(validateVisibleBuildingMesh(triangles, expected)).toBeNull();
  });

  it('rejects a valid volume created at the wrong elevation', () => {
    const mesh = boxTriangles(expected.x, expected.y, 0, 68.2, 45.5, expected.heightM);

    expect(validateVisibleBuildingMesh(mesh, expected)).toBeNull();
  });

  it('accepts a visible FloorStack volume with non-manifold/open tessellation and reports it', () => {
    const closedBox = boxTriangles(expected.x, expected.y, expected.z, 68.2, 45.5, expected.heightM);
    const openBoxMissingOneFace = closedBox.slice(0, -18);

    const result = validateVisibleBuildingMesh(openBoxMissingOneFace, expected);

    expect(result).not.toBeNull();
    expect(result?.closedTriangleBoundaries).toBe(false);
  });

  it('rejects a valid volume created away from the requested site center', () => {
    const mesh = boxTriangles(2_000, 2_000, expected.z, 68.2, 45.5, expected.heightM);

    expect(validateVisibleBuildingMesh(mesh, expected)).toBeNull();
  });

  it('reports position mismatch instead of collapsing mesh validation to null', () => {
    const mesh = boxTriangles(2_000, 2_000, expected.z, 68.2, 45.5, expected.heightM);

    const result = inspectVisibleBuildingMesh(mesh, expected);

    expect(result.evidence).toBeNull();
    expect(result.failureReason).toBe('position_mismatch');
    expect(result.raw?.triangleCount).toBe(12);
  });
});
