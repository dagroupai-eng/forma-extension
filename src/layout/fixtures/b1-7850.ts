import type { CoreTemplate, RoomLayout } from '../../data/building_requirements';

export const B1_7850_AREA_M2 = 7_850;

// The regeneration diagnostic reported an area-preserving 1.5:1 working
// rectangle. Keep the unrounded dimensions so the fixture is exactly 7,850m2.
export const B1_7850_DEPTH_M = Math.sqrt(B1_7850_AREA_M2 / 1.5);
export const B1_7850_WIDTH_M = B1_7850_AREA_M2 / B1_7850_DEPTH_M;

// The diagnostic proves the 150m2 area, but did not expose the normalized core
// dimensions or position. Stage 0 therefore records this as an explicit
// synthetic assumption; replace it with a captured runtime template when the
// diagnostic schema exposes those fields.
export const B1_7850_ASSUMED_CORE_TEMPLATE: CoreTemplate = {
  width_m: Math.sqrt(150),
  depth_m: Math.sqrt(150),
  position: 'center',
  fixed_across_floors: true,
  room_name: 'Core',
  function_id: 'B1_CORE',
};

const B1_7850_ROOM_VALUES: RoomLayout[] = [
  {
    room_id: 'B1_P01',
    name: 'Parking Lot',
    area_m2: 5_500,
    function_id: 'B1_P01',
    unit_type: 'PARKING',
  },
  {
    room_id: 'B1_M01',
    name: 'Mechanical Room',
    area_m2: 800,
    function_id: 'B1_M01',
    unit_type: 'LIVING_UNIT',
  },
  {
    room_id: 'B1_E01',
    name: 'Electrical Room',
    area_m2: 500,
    function_id: 'B1_E01',
    unit_type: 'LIVING_UNIT',
  },
  {
    room_id: 'B1_R01',
    name: 'Generator Room',
    area_m2: 300,
    function_id: 'B1_R01',
    unit_type: 'LIVING_UNIT',
  },
  {
    room_id: 'B1_S01',
    name: 'Storage',
    area_m2: 600,
    function_id: 'B1_S01',
    unit_type: 'LIVING_UNIT',
  },
  {
    room_id: 'B1_CORE',
    name: 'Core',
    area_m2: 150,
    function_id: 'B1_CORE',
    unit_type: 'CORE',
  },
];

export function createB17850Rooms(): RoomLayout[] {
  return B1_7850_ROOM_VALUES.map((room) => ({ ...room }));
}
