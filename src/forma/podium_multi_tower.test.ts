import { describe, expect, it, vi } from 'vitest';
import type { BuildingMass } from '../data/building_requirements';
import { isRingContainedInBoundary } from '../layout/geometry_contract';
import {
  MassComponentPlanningError,
  resolveComponentFloorLabels,
  resolvePodiumMultiTowerBasement,
  resolvePodiumMultiTowerComponents,
} from './podium_multi_tower';

function componentBuilding(towerArea = 2713): BuildingMass {
  const podiumFloors = Array.from({ length: 8 }, (_, index) => `${index + 1}F`);
  const towerFloors = Array.from({ length: 13 }, (_, index) => `${index + 9}F`);
  return {
    name: 'Podium and twin towers',
    target_floor_area: 8 * 9600 + 26 * towerArea,
    target_floors: 21,
    footprint_area: 9600,
    footprint_width_m: 120,
    footprint_depth_m: 80,
    mass_layout_type: 'PODIUM_MULTI_TOWER',
    position_hint: 'center',
    floor_breakdown: {},
    floor_heights_m: {
      '1F': 4.5,
      '2F': 4.5,
      '3F': 4,
      '4F': 4,
      '5F': 4,
      '6F': 4,
      '7F': 4,
      '8F': 4,
      ...Object.fromEntries(towerFloors.map((label) => [label, 4])),
    },
    mass_components: [
      {
        component_id: 'PODIUM',
        component_type: 'PODIUM',
        start_floor: '1F',
        end_floor: '8F',
        applicable_floors: podiumFloors,
        footprint_area: 9600,
        footprint_width_m: 120,
        footprint_depth_m: 80,
        position_hint: 'center',
      },
      {
        component_id: 'TOWER_A',
        component_type: 'TOWER',
        parent_component_id: 'PODIUM',
        start_floor: '9F',
        end_floor: '21F',
        applicable_floors: towerFloors,
        footprint_area: towerArea,
        footprint_width_m: null,
        footprint_depth_m: null,
        center_x_m: null,
        center_y_m: null,
        position_hint: 'podium_west',
      },
      {
        component_id: 'TOWER_B',
        component_type: 'TOWER',
        parent_component_id: 'PODIUM',
        start_floor: '9F',
        end_floor: '21F',
        applicable_floors: towerFloors,
        footprint_area: towerArea,
        footprint_width_m: null,
        footprint_depth_m: null,
        center_x_m: null,
        center_y_m: null,
        position_hint: 'podium_east',
      },
    ],
  };
}

function bounds(polygon: [number, number][]) {
  return {
    minX: Math.min(...polygon.map(([x]) => x)),
    maxX: Math.max(...polygon.map(([x]) => x)),
    minY: Math.min(...polygon.map(([, y]) => y)),
    maxY: Math.max(...polygon.map(([, y]) => y)),
  };
}

describe('PODIUM_MULTI_TOWER component planning', () => {
  it('resolves B2 and B1 as an independent basement stack ending exactly at ground level', () => {
    const building = componentBuilding();
    building.basement = {
      floors: 2,
      area_m2: 15_400,
      use: 'Parking and plant',
      footprint_width_m: 110,
      footprint_depth_m: 70,
      floor_breakdown: { B2: 7600, B1: 7800 },
      floor_heights_m: { B2: 4, B1: 3.5 },
    };

    const basement = resolvePodiumMultiTowerBasement(building)!;

    expect(basement.floorLabels).toEqual(['B2', 'B1']);
    expect(basement.floorHeightsM).toEqual([4, 3.5]);
    expect(basement.floorAreasM2).toEqual([7600, 7800]);
    expect(basement.baseElevationM).toBe(-7.5);
    expect(basement.totalHeightM).toBe(7.5);
    expect(basement.topElevationM).toBe(0);
    expect(basement.localFloorStackPolygons).toHaveLength(2);
  });

  it('resolves PODIUM, TOWER_A, and TOWER_B as three independent component units', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const plans = resolvePodiumMultiTowerComponents(componentBuilding());
    info.mockRestore();

    expect(plans.map((plan) => plan.componentId)).toEqual(['PODIUM', 'TOWER_A', 'TOWER_B']);
    expect(plans.map((plan) => plan.floorCount)).toEqual([8, 13, 13]);
    expect(plans[0].floorLabels).toEqual(Array.from({ length: 8 }, (_, index) => `${index + 1}F`));
    expect(plans[1].floorLabels).toEqual(Array.from({ length: 13 }, (_, index) => `${index + 9}F`));
    expect(plans[2].floorLabels).toEqual(Array.from({ length: 13 }, (_, index) => `${index + 9}F`));
  });

  it('starts both towers at the actual 33m podium top elevation', () => {
    const plans = resolvePodiumMultiTowerComponents(componentBuilding());
    const podium = plans.find((plan) => plan.componentId === 'PODIUM')!;
    const towers = plans.filter((plan) => plan.componentType === 'TOWER');

    expect(podium.baseElevationM).toBe(0);
    expect(podium.topElevationM).toBe(33);
    expect(towers.map((tower) => tower.baseElevationM)).toEqual([33, 33]);
    expect(towers.every((tower) => tower.baseElevationM === podium.topElevationM)).toBe(true);
  });

  it('fits the exact requested tower areas inside the west/east podium top zones without overlap', () => {
    const [podium, towerA, towerB] = resolvePodiumMultiTowerComponents(componentBuilding());
    const a = bounds(towerA.footprintPolygon);
    const b = bounds(towerB.footprintPolygon);

    expect(towerA.widthM * towerA.depthM).toBeCloseTo(2713, 8);
    expect(towerB.widthM * towerB.depthM).toBeCloseTo(2713, 8);
    expect(isRingContainedInBoundary(towerA.footprintPolygon, podium.footprintPolygon, true)).toBe(true);
    expect(isRingContainedInBoundary(towerB.footprintPolygon, podium.footprintPolygon, true)).toBe(true);
    expect(Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)).toBeLessThanOrEqual(0);
    expect(towerA.overlapsSibling).toBe(false);
    expect(towerB.overlapsSibling).toBe(false);
  });

  it('uses applicable_floors length and never falls back to five floors', () => {
    const building = componentBuilding();
    building.floor_plans = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`${index + 9}F`, []]),
    );
    const tower = building.mass_components![1];
    expect(resolveComponentFloorLabels(tower)).toHaveLength(13);
    expect(resolveComponentFloorLabels(tower)).not.toHaveLength(5);
    expect(resolvePodiumMultiTowerComponents(building)[1].floorCount).toBe(13);
  });

  it('leaves SINGLE_MASS buildings outside the component planner', () => {
    const single = { ...componentBuilding(), mass_layout_type: 'RECTANGLE' as const, mass_components: undefined };
    expect(resolvePodiumMultiTowerComponents(single)).toEqual([]);
  });

  it('returns the required structured diagnostic instead of protruding an infeasible tower', () => {
    const building = componentBuilding(5000);
    expect(() => resolvePodiumMultiTowerComponents(building)).toThrow(MassComponentPlanningError);
    try {
      resolvePodiumMultiTowerComponents(building);
    } catch (error) {
      const diagnostic = (error as MassComponentPlanningError).diagnostic;
      expect(diagnostic).toMatchObject({
        component_id: 'TOWER_A',
        requested_area: 5000,
        maximum_feasible_area: 4800,
        parent_component_id: 'PODIUM',
        parent_top_footprint_area: 9600,
        available_zone_width: 60,
        available_zone_depth: 80,
        containment_result: false,
        overlap_result: false,
      });
      expect(diagnostic.attempted_width).toBeGreaterThan(0);
      expect(diagnostic.attempted_depth).toBeGreaterThan(0);
      expect(diagnostic.failure_reason).toContain('cannot fit');
    }
  });

  it('rejects a tower with an empty applicable_floors array', () => {
    const building = componentBuilding();
    building.mass_components![1].applicable_floors = [];
    expect(() => resolvePodiumMultiTowerComponents(building)).toThrow(/applicable_floors must be a non-empty array/);
  });

  it('rejects a tower whose parent_component_id cannot be resolved', () => {
    const building = componentBuilding();
    building.mass_components![1].parent_component_id = 'MISSING_PODIUM';
    expect(() => resolvePodiumMultiTowerComponents(building)).toThrow(/parent_component_id MISSING_PODIUM was not found/);
  });

  it('rejects incomplete basement floor metadata instead of silently omitting B2', () => {
    const building = componentBuilding();
    building.basement = {
      floors: 2,
      area_m2: 7800,
      use: 'Parking',
      floor_breakdown: { B1: 7800 },
      floor_heights_m: { B2: 4, B1: 3.5 },
    };
    expect(() => resolvePodiumMultiTowerBasement(building)).toThrow(/must define exactly B2, B1/);
  });
});
