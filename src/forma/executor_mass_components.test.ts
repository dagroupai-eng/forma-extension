import { describe, expect, it, vi } from 'vitest';

vi.mock('forma-embedded-view-sdk/auto', () => ({ Forma: {} }));

import { normalizeRequirements } from './executor';
import { resolvePodiumMultiTowerBasement, resolvePodiumMultiTowerComponents } from './podium_multi_tower';

describe('mass_components requirements normalization', () => {
  it('preserves component hierarchy, floor ranges, hints, and null geometry values', () => {
    const raw = {
      project_name: 'Normalized components',
      buildings: [{
        name: 'Building',
        target_floor_area: 1,
        target_floors: 21,
        footprint_area: 9600,
        mass_layout_type: 'PODIUM_MULTI_TOWER',
        floor_heights_m: {
          '1F': 4.5, '2F': 4.5, '3F': 4, '4F': 4, '5F': 4, '6F': 4, '7F': 4, '8F': 4,
        },
        mass_components: [
          {
            component_id: 'PODIUM', component_type: 'PODIUM', start_floor: '1F', end_floor: '8F',
            applicable_floors: Array.from({ length: 8 }, (_, index) => `${index + 1}F`),
            footprint_area: 9600, footprint_width_m: 120, footprint_depth_m: 80,
          },
          {
            component_id: 'TOWER_A', component_type: 'TOWER', parent_component_id: 'PODIUM',
            start_floor: '9F', end_floor: '21F',
            applicable_floors: Array.from({ length: 13 }, (_, index) => `${index + 9}F`),
            footprint_area: 2713, footprint_width_m: null, footprint_depth_m: null,
            center_x_m: null, center_y_m: null, position_hint: 'podium_west',
          },
          {
            component_id: 'TOWER_B', component_type: 'TOWER', parent_component_id: 'PODIUM',
            start_floor: '9F', end_floor: '21F',
            applicable_floors: Array.from({ length: 13 }, (_, index) => `${index + 9}F`),
            footprint_area: 2713, position_hint: 'podium_east',
          },
        ],
      }],
    };

    const normalized = normalizeRequirements(raw);
    const [podium, towerA, towerB] = resolvePodiumMultiTowerComponents(normalized.buildings[0]);

    expect(normalized.buildings[0].mass_components).toHaveLength(3);
    expect(normalized.buildings[0].mass_components?.[1]).toMatchObject({
      parent_component_id: 'PODIUM',
      position_hint: 'podium_west',
      footprint_width_m: null,
      footprint_depth_m: null,
      center_x_m: null,
      center_y_m: null,
    });
    expect(podium.floorCount).toBe(8);
    expect(towerA.floorCount).toBe(13);
    expect(towerB.floorCount).toBe(13);
    expect(towerA.baseElevationM).toBe(33);
    expect(towerB.baseElevationM).toBe(33);
  });

  it('keeps start/end fallback available when applicable_floors is absent', () => {
    const normalized = normalizeRequirements({
      buildings: [{
        name: 'Building', target_floor_area: 100, target_floors: 2, footprint_area: 100,
        mass_components: [{
          component_id: 'PODIUM', component_type: 'PODIUM', start_floor: '1F', end_floor: '2F', footprint_area: 100,
        }],
      }],
    });
    expect(resolvePodiumMultiTowerComponents(normalized.buildings[0])[0].floorCount).toBe(2);
  });

  it('preserves a document-level multi-floor basement for component mass generation', () => {
    const normalized = normalizeRequirements({
      buildings: [{
        name: 'Building', target_floor_area: 100, target_floors: 1, footprint_area: 100,
        mass_components: [{
          component_id: 'PODIUM', component_type: 'PODIUM', start_floor: '1F', end_floor: '1F', footprint_area: 100,
        }],
      }],
      basement: {
        floors: 2,
        area_m2: 15_400,
        use: 'Parking and plant',
        footprint_width_m: 110,
        footprint_depth_m: 70,
        floor_breakdown: { B2: 7600, B1: 7800 },
        floor_heights_m: { B2: 4, B1: 3.5 },
      },
    });

    expect(normalized.buildings[0].basement).toMatchObject({
      floors: 2,
      footprint_width_m: 110,
      footprint_depth_m: 70,
      floor_breakdown: { B2: 7600, B1: 7800 },
    });
    expect(resolvePodiumMultiTowerBasement(normalized.buildings[0])).toMatchObject({
      floorLabels: ['B2', 'B1'],
      baseElevationM: -7.5,
      topElevationM: 0,
    });
  });
});
