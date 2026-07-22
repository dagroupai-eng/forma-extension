import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildingRequirements } from '../data/building_requirements';

const sdk = vi.hoisted(() => {
  type Generated = { transform: number[]; width: number; depth: number; height: number };
  const state = {
    pending: null as Omit<Generated, 'transform'> | null,
    generated: new Map<string, Generated>(),
    nextPath: 1,
  };
  const boxTriangles = (width: number, depth: number, height: number): number[] => {
    const x0 = -width / 2; const x1 = width / 2;
    const y0 = -depth / 2; const y1 = depth / 2;
    const z0 = 0; const z1 = height;
    const v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    const faces = [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
      [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ];
    return faces.flatMap((face) => face.flatMap((index) => v[index]));
  };
  const createFromFloors = vi.fn(async ({ floors }: { floors: Array<{ polygon: [number, number][]; height: number }> }) => {
    const polygon = floors[0].polygon;
    const xs = polygon.map(([x]) => x);
    const ys = polygon.map(([, y]) => y);
    state.pending = {
      width: Math.max(...xs) - Math.min(...xs),
      depth: Math.max(...ys) - Math.min(...ys),
      height: floors.reduce((sum, floor) => sum + floor.height, 0),
    };
    return { urn: `urn:component-${state.nextPath}` };
  });
  const addElement = vi.fn(async ({ transform }: { transform: number[] }) => {
    const path = `/generated-component-${state.nextPath++}`;
    if (!state.pending) throw new Error('No pending FloorStack');
    state.generated.set(path, { ...state.pending, transform: Array.from(transform) });
    state.pending = null;
    return { path };
  });
  return {
    state,
    createFromFloors,
    addElement,
    getPathsByCategory: vi.fn(async ({ category }: { category: string }) =>
      category === 'building' || category === 'buildings' ? [...state.generated.keys()] : []),
    getTriangles: vi.fn(async ({ path }: { path: string }) => {
      const generated = state.generated.get(path);
      if (!generated) throw new Error(`No mesh for ${path}`);
      return boxTriangles(generated.width, generated.depth, generated.height);
    }),
    getWorldTransform: vi.fn(async ({ path }: { path: string }) => ({ transform: state.generated.get(path)?.transform ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })),
  };
});

vi.mock('forma-embedded-view-sdk/auto', () => ({
  Forma: {
    getCanEdit: vi.fn(async () => true),
    selection: { getSelection: vi.fn(async () => []) },
    geometry: {
      getPathsByCategory: sdk.getPathsByCategory,
      getPathsForVirtualElements: vi.fn(async () => []),
      getFootprint: vi.fn(async () => undefined),
      getTriangles: sdk.getTriangles,
    },
    elements: {
      getByPath: vi.fn(async ({ path }: { path: string }) => ({ element: { urn: `urn:${path}`, category: 'building' } })),
      getWorldTransform: sdk.getWorldTransform,
      floorStack: { createFromFloors: sdk.createFromFloors },
    },
    proposal: {
      addElement: sdk.addElement,
      awaitProposalPersisted: vi.fn(async () => undefined),
      removeElement: vi.fn(async () => undefined),
    },
    render: {
      unhideElement: vi.fn(async () => undefined),
      geojson: { add: vi.fn(), remove: vi.fn() },
    },
  },
}));

import { placeBuildingMasses } from './mass_generator';

function requirements(towerArea = 2713): BuildingRequirements {
  const podiumFloors = Array.from({ length: 8 }, (_, index) => `${index + 1}F`);
  const towerFloors = Array.from({ length: 13 }, (_, index) => `${index + 9}F`);
  return {
    project: { name: 'Integration', location: '', total_floor_area_m2: 1 },
    site_limits: { total_site_area: 30_000, max_building_coverage_ratio: 1, max_floor_area_ratio: 10, max_height_floors: 30 },
    buildings: [{
      name: 'PODIUM_MULTI_TOWER',
      target_floor_area: 1,
      target_floors: 21,
      footprint_area: 9600,
      footprint_width_m: 120,
      footprint_depth_m: 80,
      mass_layout_type: 'PODIUM_MULTI_TOWER',
      position_hint: 'center',
      floor_breakdown: {},
      floor_heights_m: {
        '1F': 4.5, '2F': 4.5, '3F': 4, '4F': 4, '5F': 4, '6F': 4, '7F': 4, '8F': 4,
        ...Object.fromEntries(towerFloors.map((label) => [label, 4])),
      },
      mass_components: [
        { component_id: 'PODIUM', component_type: 'PODIUM', start_floor: '1F', end_floor: '8F', applicable_floors: podiumFloors, footprint_area: 9600, footprint_width_m: 120, footprint_depth_m: 80 },
        { component_id: 'TOWER_A', component_type: 'TOWER', parent_component_id: 'PODIUM', start_floor: '9F', end_floor: '21F', applicable_floors: towerFloors, footprint_area: towerArea, position_hint: 'podium_west' },
        { component_id: 'TOWER_B', component_type: 'TOWER', parent_component_id: 'PODIUM', start_floor: '9F', end_floor: '21F', applicable_floors: towerFloors, footprint_area: towerArea, position_hint: 'podium_east' },
      ],
    }],
    parking: { required_parking_spots: 0, location_hint: '' },
    derived_metrics: { total_footprint_area: 9600, actual_coverage_ratio: 0.32, actual_floor_area_ratio: 0, remaining_buildable_area: 20_400 },
  };
}

function requirementsWithBasement(): BuildingRequirements {
  const result = requirements();
  result.buildings[0].basement = {
    floors: 2,
    area_m2: 15_400,
    use: 'Parking and plant',
    footprint_width_m: 110,
    footprint_depth_m: 70,
    floor_breakdown: { B2: 7600, B1: 7800 },
    floor_heights_m: { B2: 4, B1: 3.5 },
  };
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.state.pending = null;
  sdk.state.generated.clear();
  sdk.state.nextPath = 1;
});

describe('PODIUM_MULTI_TOWER Forma writer integration', () => {
  it('writes BASEMENT before the podium and keeps the basement top at Z=0m', async () => {
    const result = await placeBuildingMasses(requirementsWithBasement());

    expect(sdk.createFromFloors).toHaveBeenCalledTimes(4);
    expect(sdk.addElement).toHaveBeenCalledTimes(4);
    expect(sdk.createFromFloors.mock.calls.map(([request]) => request.floors.length)).toEqual([2, 8, 13, 13]);
    expect(sdk.createFromFloors.mock.calls[0][0].floors.map((floor) => floor.height)).toEqual([4, 3.5]);
    expect(result.placed.map((mass) => mass.componentId)).toEqual(['BASEMENT', 'PODIUM', 'TOWER_A', 'TOWER_B']);
    expect(result.placed.map((mass) => mass.placementZ)).toEqual([-7.5, 0, 33, 33]);
    expect(result.placed[0].placementZ + result.placed[0].heightM).toBe(0);
    expect(result.placed[0]).toMatchObject({ floors: 0, basementFloors: 2, belowGrade: true });
    expect(result.totalFootprint).toBe(9600);
  });

  it('writes three independent FloorStacks with 8/13/13 floors and tower Z=33m', async () => {
    const result = await placeBuildingMasses(requirements());

    expect(sdk.createFromFloors).toHaveBeenCalledTimes(3);
    expect(sdk.addElement).toHaveBeenCalledTimes(3);
    expect(sdk.createFromFloors.mock.calls.map(([request]) => request.floors.length)).toEqual([8, 13, 13]);
    expect(result.placed.map((mass) => mass.componentId)).toEqual(['PODIUM', 'TOWER_A', 'TOWER_B']);
    expect(result.placed.map((mass) => mass.floors)).toEqual([8, 13, 13]);
    expect(result.placed.map((mass) => mass.placementZ)).toEqual([0, 33, 33]);
    expect(result.totalFootprint).toBe(9600);
  });

  it('performs no FloorStack SDK write when exact area cannot fit the parent', async () => {
    const result = await placeBuildingMasses(requirements(5000));

    expect(result.placed).toEqual([]);
    expect(sdk.createFromFloors).not.toHaveBeenCalled();
    expect(sdk.addElement).not.toHaveBeenCalled();
    expect(result.componentErrors?.[0]).toMatchObject({
      component_id: 'TOWER_A',
      requested_area: 5000,
      maximum_feasible_area: 4800,
      containment_result: false,
      overlap_result: false,
    });
  });

  it('performs no SDK write when declared basement floors are incomplete', async () => {
    const input = requirementsWithBasement();
    input.buildings[0].basement!.floor_breakdown = { B1: 7800 };

    const result = await placeBuildingMasses(input);

    expect(result.placed).toEqual([]);
    expect(sdk.createFromFloors).not.toHaveBeenCalled();
    expect(sdk.addElement).not.toHaveBeenCalled();
    expect(result.componentErrors?.[0]).toMatchObject({
      component_id: 'BASEMENT',
      failure_reason: expect.stringContaining('must define exactly B2, B1'),
    });
  });
});
