import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildingRequirements } from '../data/building_requirements';

type Point2D = [number, number];

interface PlacementScenario {
  selectedPaths: string[];
  siteLimitPaths: string[];
  genericPaths: string[];
  virtualPaths: string[];
  terrainPaths: string[];
  buildingPaths: string[];
  categoryErrors: string[];
  footprints: Record<string, Point2D[]>;
  triangles: Record<string, number[] | Float32Array>;
}

const sdk = vi.hoisted(() => {
  const state: {
    scenario: PlacementScenario;
    addedTransform: number[] | null;
  } = {
    scenario: {
      selectedPaths: [],
      siteLimitPaths: [],
      genericPaths: [],
      virtualPaths: [],
      terrainPaths: [],
      buildingPaths: [],
      categoryErrors: [],
      footprints: {},
      triangles: {},
    },
    addedTransform: null,
  };

  const getPathsByCategory = vi.fn(async ({ category }: { category: string }) => {
    if (state.scenario.categoryErrors.includes(category)) {
      throw new Error(`Category lookup failed for ${category}`);
    }
    if (category === 'site_limit') return state.scenario.siteLimitPaths;
    if (category === 'terrain') return state.scenario.terrainPaths;
    if (category === 'generic') return state.scenario.genericPaths;
    if (category === 'virtual') return state.scenario.virtualPaths;
    if (category === 'building' || category === 'buildings') {
      return [
        ...state.scenario.buildingPaths,
        ...(state.addedTransform ? ['/generated-building'] : []),
      ];
    }
    return [];
  });

  const getTriangles = vi.fn(async ({ path }: { path: string }) => {
    if (path === '/generated-building' && state.addedTransform) {
      return makeBoxTriangles(
        0,
        0,
        0,
        10,
        10,
        4,
      );
    }
    const triangles = state.scenario.triangles[path];
    if (!triangles) throw new Error(`No triangles for ${path}`);
    return triangles;
  });

  const getFootprint = vi.fn(async ({ path }: { path: string }) => {
    const coordinates = state.scenario.footprints[path];
    if (!coordinates) return undefined;
    return { type: 'Polygon', coordinates };
  });

  const addElement = vi.fn(async ({ transform }: { transform: number[] }) => {
    state.addedTransform = Array.from(transform);
    return { path: '/generated-building' };
  });

  const getWorldTransform = vi.fn(async ({ path }: { path: string }) => {
    if (path === '/generated-building' && state.addedTransform) {
      return { transform: state.addedTransform };
    }
    const triangles = state.scenario.triangles[path];
    const zValues = triangles?.filter((_value, index) => index % 3 === 2) ?? [];
    const z = zValues.length > 0 ? Math.min(...zValues) : 0;
    return { transform: translationTransform(0, 0, z) };
  });

  return {
    state,
    mocks: {
      getCanEdit: vi.fn(async () => true),
      getSelection: vi.fn(async () => state.scenario.selectedPaths),
      getPathsByCategory,
      getPathsForVirtualElements: vi.fn(async () => state.scenario.virtualPaths),
      getFootprint,
      getTriangles,
      createFromFloors: vi.fn(async () => ({ urn: 'urn:test-floor-stack' })),
      addElement,
      awaitProposalPersisted: vi.fn(async () => undefined),
      removeElement: vi.fn(async () => undefined),
      getWorldTransform,
      getByPath: vi.fn(async ({ path }: { path: string }) => ({
        element: {
          urn: `urn:${path}`,
          category: state.scenario.siteLimitPaths.includes(path) ? 'site_limit' : 'generic',
        },
      })),
      unhideElement: vi.fn(async () => undefined),
    },
  };
});

vi.mock('forma-embedded-view-sdk/auto', () => ({
  Forma: {
    getCanEdit: sdk.mocks.getCanEdit,
    selection: {
      getSelection: sdk.mocks.getSelection,
    },
    geometry: {
      getPathsByCategory: sdk.mocks.getPathsByCategory,
      getPathsForVirtualElements: sdk.mocks.getPathsForVirtualElements,
      getFootprint: sdk.mocks.getFootprint,
      getTriangles: sdk.mocks.getTriangles,
    },
    elements: {
      getByPath: sdk.mocks.getByPath,
      getWorldTransform: sdk.mocks.getWorldTransform,
      floorStack: {
        createFromFloors: sdk.mocks.createFromFloors,
      },
    },
    proposal: {
      addElement: sdk.mocks.addElement,
      awaitProposalPersisted: sdk.mocks.awaitProposalPersisted,
      removeElement: sdk.mocks.removeElement,
    },
    render: {
      unhideElement: sdk.mocks.unhideElement,
      geojson: {
        add: vi.fn(),
        remove: vi.fn(),
      },
    },
  },
}));

import { placeBuildingMasses } from './mass_generator';

const requirements: BuildingRequirements = {
  project: {
    name: 'Constraint placement regression',
    location: 'test',
    total_floor_area_m2: 100,
  },
  site_limits: {
    total_site_area: 10_000,
    max_building_coverage_ratio: 1,
    max_floor_area_ratio: 1,
    max_height_floors: 10,
  },
  buildings: [{
    name: 'Test building',
    target_floor_area: 100,
    target_floors: 1,
    footprint_area: 100,
    position_hint: 'center',
    floor_breakdown: { '1F': 100 },
    floor_heights_m: { '1F': 4 },
  }],
  parking: {
    required_parking_spots: 0,
    location_hint: 'none',
  },
  derived_metrics: {
    total_footprint_area: 100,
    actual_coverage_ratio: 0.01,
    actual_floor_area_ratio: 0.01,
    remaining_buildable_area: 9_900,
  },
};

function translationTransform(x: number, y: number, z: number): number[] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ];
}

function rotatedRectangle(
  centerX: number,
  centerY: number,
  width: number,
  depth: number,
  yaw: number,
): Point2D[] {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const local: Point2D[] = [
    [-width / 2, -depth / 2],
    [width / 2, -depth / 2],
    [width / 2, depth / 2],
    [-width / 2, depth / 2],
  ];
  return local.map(([x, y]) => [
    centerX + x * cos - y * sin,
    centerY + x * sin + y * cos,
  ]);
}

function makeSurfaceTriangles(ring: Point2D[], z: number): number[] {
  const [a, b, c, d] = ring;
  return [
    a[0], a[1], z, b[0], b[1], z, c[0], c[1], z,
    a[0], a[1], z, c[0], c[1], z, d[0], d[1], z,
  ];
}

function makeTriangleMeshWithCount(ring: Point2D[], z: number, triangleCount: number): Float32Array {
  const surface = makeSurfaceTriangles(ring, z);
  const twoTriangleCopies = Math.ceil(triangleCount / 2);
  const values = Array.from({ length: twoTriangleCopies }, () => surface).flat();
  return Float32Array.from(values.slice(0, triangleCount * 9));
}

function makeBoxTriangles(
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

function setScenario(overrides: Partial<PlacementScenario>): void {
  sdk.state.scenario = {
    selectedPaths: [],
    siteLimitPaths: [],
    genericPaths: [],
    virtualPaths: [],
    terrainPaths: [],
    buildingPaths: [],
    categoryErrors: [],
    footprints: {},
    triangles: {},
    ...overrides,
  };
}

function expectLastPlacement(expected: { x: number; y: number; z: number; yaw: number }): void {
  expect(sdk.mocks.addElement).toHaveBeenCalledTimes(1);
  const request = sdk.mocks.addElement.mock.calls[0][0] as { transform: number[] };
  const transform = request.transform;
  expect(transform[12]).toBeCloseTo(expected.x, 5);
  expect(transform[13]).toBeCloseTo(expected.y, 5);
  expect(transform[14]).toBeCloseTo(expected.z, 5);
  expect(Math.atan2(transform[1], transform[0])).toBeCloseTo(expected.yaw, 5);
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.state.addedTransform = null;
  setScenario({});
});

describe('Constraint mass placement', () => {
  it('uses an explicit generic Constraint footprint center, rotation, and elevation', async () => {
    const targetPath = '/constraints/generic-1';
    const center = { x: 120, y: -35, z: 7.5 };
    const yaw = Math.PI / 6;
    const ring = rotatedRectangle(center.x, center.y, 80, 40, yaw);
    setScenario({
      genericPaths: [targetPath],
      footprints: { [targetPath]: ring },
      triangles: { [targetPath]: makeSurfaceTriangles(ring, center.z) },
    });

    const result = await placeBuildingMasses(requirements, { targetPath });

    expect(result.placed).toHaveLength(1);
    expectLastPlacement({ ...center, yaw });
  });

  it('uses the currently selected virtual Constraint as the placement reference', async () => {
    const targetPath = '/constraints/virtual-1';
    const center = { x: -42, y: 73, z: 3.25 };
    const yaw = -Math.PI / 4;
    const ring = rotatedRectangle(center.x, center.y, 60, 30, yaw);
    setScenario({
      selectedPaths: [targetPath],
      virtualPaths: [targetPath],
      footprints: { [targetPath]: ring },
      triangles: { [targetPath]: makeSurfaceTriangles(ring, center.z) },
    });

    const result = await placeBuildingMasses(requirements);

    expect(result.placed).toHaveLength(1);
    expectLastPlacement({ ...center, yaw });
  });

  it('does not let a higher terrain mesh override the selected Constraint elevation', async () => {
    const targetPath = '/constraints/generic-low';
    const terrainPath = '/terrain/high';
    const center = { x: 25, y: 30, z: 4 };
    const yaw = Math.PI / 9;
    const ring = rotatedRectangle(center.x, center.y, 70, 35, yaw);
    const terrainRing = rotatedRectangle(center.x, center.y, 500, 500, 0);
    setScenario({
      selectedPaths: [targetPath],
      genericPaths: [targetPath],
      terrainPaths: [terrainPath],
      footprints: { [targetPath]: ring, [terrainPath]: terrainRing },
      triangles: {
        [targetPath]: makeSurfaceTriangles(ring, center.z),
        [terrainPath]: makeSurfaceTriangles(terrainRing, 100),
      },
    });

    const result = await placeBuildingMasses(requirements);

    expect(result.placed).toHaveLength(1);
    expectLastPlacement({ ...center, yaw });
    expect(sdk.mocks.getTriangles).not.toHaveBeenCalledWith({ path: terrainPath });
  });

  it('places an explicit unclassified triangle-only Constraint using its exact target path', async () => {
    const targetPath = '/constraints/unclassified-explicit';
    const center = { x: 48, y: -21, z: 6.75 };
    const yaw = Math.PI / 7;
    const ring = rotatedRectangle(center.x, center.y, 84, 36, yaw);
    const triangles = makeTriangleMeshWithCount(ring, center.z, 152);
    setScenario({
      triangles: { [targetPath]: triangles },
    });

    const result = await placeBuildingMasses(requirements, { targetPath });

    expect(triangles).toBeInstanceOf(Float32Array);
    expect(triangles.length / 9).toBe(152);
    expect(result.placed).toHaveLength(1);
    expect(sdk.mocks.getFootprint).toHaveBeenCalledWith({ path: targetPath });
    expect(sdk.mocks.getTriangles).toHaveBeenCalledWith({ path: targetPath });
    expectLastPlacement({ ...center, yaw });
  });

  it('places a selected unclassified triangle-only Constraint without unrelated fallback', async () => {
    const targetPath = '/constraints/unclassified-selected';
    const unrelatedSiteLimit = '/site-limits/unrelated-unclassified';
    const unrelatedTerrain = '/terrain/unrelated-unclassified';
    const center = { x: -64, y: 92, z: 8.5 };
    const yaw = -Math.PI / 8;
    const ring = rotatedRectangle(center.x, center.y, 76, 34, yaw);
    const siteLimitRing = rotatedRectangle(900, 900, 120, 60, 0);
    const terrainRing = rotatedRectangle(900, 900, 500, 500, 0);
    setScenario({
      selectedPaths: [targetPath],
      siteLimitPaths: [unrelatedSiteLimit],
      terrainPaths: [unrelatedTerrain],
      footprints: {
        [unrelatedSiteLimit]: siteLimitRing,
        [unrelatedTerrain]: terrainRing,
      },
      triangles: {
        [targetPath]: makeTriangleMeshWithCount(ring, center.z, 152),
        [unrelatedSiteLimit]: makeSurfaceTriangles(siteLimitRing, 30),
        [unrelatedTerrain]: makeSurfaceTriangles(terrainRing, 35),
      },
    });

    const result = await placeBuildingMasses(requirements);

    expect(result.placed).toHaveLength(1);
    expectLastPlacement({ ...center, yaw });
    expect(sdk.mocks.getFootprint).not.toHaveBeenCalledWith({ path: unrelatedSiteLimit });
    expect(sdk.mocks.getFootprint).not.toHaveBeenCalledWith({ path: unrelatedTerrain });
    expect(sdk.mocks.getTriangles).not.toHaveBeenCalledWith({ path: unrelatedTerrain });
  });

  it('tries the exact target geometry before an empty related generic or virtual path', async () => {
    const targetPath = '/constraints/hierarchy/selected';
    const genericParent = '/constraints/hierarchy';
    const virtualChild = `${targetPath}/virtual-metadata`;
    const center = { x: 31, y: 44, z: 2.25 };
    const yaw = Math.PI / 5;
    const ring = rotatedRectangle(center.x, center.y, 66, 28, yaw);
    setScenario({
      genericPaths: [genericParent],
      virtualPaths: [virtualChild],
      triangles: {
        [targetPath]: makeTriangleMeshWithCount(ring, center.z, 152),
        [genericParent]: new Float32Array(),
        [virtualChild]: new Float32Array(),
      },
    });

    const result = await placeBuildingMasses(requirements, { targetPath });

    expect(result.placed).toHaveLength(1);
    expect(sdk.mocks.getFootprint.mock.calls[0][0]).toEqual({ path: targetPath });
    expect(sdk.mocks.getTriangles.mock.calls[0][0]).toEqual({ path: targetPath });
    expectLastPlacement({ ...center, yaw });
  });

  it('does not promote a selected building child to its site_limit parent', async () => {
    const siteLimitParent = '/site-limits/parent';
    const buildingChild = `${siteLimitParent}/building-child`;
    const parentRing = rotatedRectangle(500, 500, 200, 100, 0);
    const childRing = rotatedRectangle(500, 500, 40, 30, Math.PI / 10);
    setScenario({
      selectedPaths: [buildingChild],
      siteLimitPaths: [siteLimitParent],
      buildingPaths: [buildingChild],
      footprints: {
        [siteLimitParent]: parentRing,
        [buildingChild]: childRing,
      },
      triangles: {
        [siteLimitParent]: makeSurfaceTriangles(parentRing, 5),
        [buildingChild]: makeTriangleMeshWithCount(childRing, 5, 152),
      },
    });

    const result = await placeBuildingMasses(requirements, { targetPath: buildingChild });

    expect(result.placed).toHaveLength(0);
    expect(sdk.mocks.addElement).not.toHaveBeenCalled();
    expect(sdk.mocks.getFootprint).not.toHaveBeenCalledWith({ path: siteLimitParent });
  });

  it('fails closed when an excluded-category lookup rejects', async () => {
    const targetPath = '/constraints/category-lookup-unknown';
    const ring = rotatedRectangle(75, 125, 72, 32, -Math.PI / 11);
    setScenario({
      categoryErrors: ['building'],
      triangles: {
        [targetPath]: makeTriangleMeshWithCount(ring, 9, 152),
      },
    });

    const result = await placeBuildingMasses(requirements, { targetPath });

    expect(sdk.mocks.getPathsByCategory).toHaveBeenCalledWith({ category: 'building' });
    expect(result.placed).toHaveLength(0);
    expect(sdk.mocks.addElement).not.toHaveBeenCalled();
  });

  it('preserves the existing selected site_limit placement behavior', async () => {
    const targetPath = '/site-limits/main';
    const terrainPath = '/terrain/site';
    const center = { x: 200, y: 300, z: 12 };
    const yaw = -Math.PI / 12;
    const ring = rotatedRectangle(center.x, center.y, 100, 50, yaw);
    const terrainRing = rotatedRectangle(center.x, center.y, 500, 500, 0);
    setScenario({
      selectedPaths: [targetPath],
      siteLimitPaths: [targetPath],
      terrainPaths: [terrainPath],
      footprints: { [targetPath]: ring, [terrainPath]: terrainRing },
      triangles: {
        [targetPath]: makeSurfaceTriangles(ring, center.z),
        [terrainPath]: makeSurfaceTriangles(terrainRing, center.z),
      },
    });

    const result = await placeBuildingMasses(requirements);

    expect(result.placed).toHaveLength(1);
    expectLastPlacement({ ...center, yaw });
  });

  it('does not silently fall back to an unrelated site_limit when an explicit target is unreadable', async () => {
    const targetPath = '/constraints/unreadable';
    const unrelatedSiteLimit = '/site-limits/unrelated';
    const ring = rotatedRectangle(1_000, 1_000, 100, 50, 0);
    setScenario({
      siteLimitPaths: [unrelatedSiteLimit],
      footprints: { [unrelatedSiteLimit]: ring },
      triangles: { [unrelatedSiteLimit]: makeSurfaceTriangles(ring, 50) },
    });

    await placeBuildingMasses(requirements, { targetPath }).catch(() => undefined);

    expect(sdk.mocks.addElement).not.toHaveBeenCalled();
    expect(sdk.mocks.getFootprint).not.toHaveBeenCalledWith({ path: unrelatedSiteLimit });
  });

  it('does not fall back when the selected virtual Constraint geometry is unreadable', async () => {
    const selectedConstraint = '/constraints/selected-unreadable';
    const unrelatedSiteLimit = '/site-limits/unrelated-selected-fallback';
    const unrelatedTerrain = '/terrain/unrelated-selected-fallback';
    const siteLimitRing = rotatedRectangle(1_500, 1_500, 120, 60, 0);
    const terrainRing = rotatedRectangle(1_500, 1_500, 500, 500, 0);
    setScenario({
      selectedPaths: [selectedConstraint],
      genericPaths: [selectedConstraint],
      virtualPaths: [selectedConstraint],
      siteLimitPaths: [unrelatedSiteLimit],
      terrainPaths: [unrelatedTerrain],
      footprints: {
        [unrelatedSiteLimit]: siteLimitRing,
        [unrelatedTerrain]: terrainRing,
      },
      triangles: {
        [unrelatedSiteLimit]: makeSurfaceTriangles(siteLimitRing, 20),
        [unrelatedTerrain]: makeSurfaceTriangles(terrainRing, 25),
      },
    });

    await placeBuildingMasses(requirements).catch(() => undefined);

    expect(sdk.mocks.addElement).not.toHaveBeenCalled();
    expect(sdk.mocks.getFootprint).not.toHaveBeenCalledWith({ path: unrelatedSiteLimit });
    expect(sdk.mocks.getFootprint).not.toHaveBeenCalledWith({ path: unrelatedTerrain });
  });
});
