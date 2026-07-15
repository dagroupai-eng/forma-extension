import type { RoomLayout } from '../data/building_requirements';

type RoomIdentity = Pick<RoomLayout, 'room_id' | 'function_id' | 'name' | 'group' | 'unit_type'>;

/**
 * A fixed core must be explicitly identified in the schedule. A public
 * restroom remains a support room even when the core itself contains toilets.
 */
export function isExplicitCoreRoom(room: RoomIdentity): boolean {
  if (String(room.unit_type ?? '').trim().toUpperCase() === 'CORE') return true;

  const group = String(room.group ?? '').trim().toLowerCase();
  if (group === 'core' || group === '\ucf54\uc5b4') return true;

  return [room.room_id, room.function_id]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean)
    .some((value) => /(^|[_\-\s])core($|[_\-\s])/i.test(value));
}

export function classifyRoomUnitType(room: RoomIdentity): 'CORE' | 'CORRIDOR' | 'PARKING' | 'LIVING_UNIT' {
  if (isExplicitCoreRoom(room)) return 'CORE';

  const raw = `${room.group ?? ''} ${room.room_id ?? ''} ${room.function_id ?? ''} ${room.name ?? ''}`.toLowerCase();
  if (raw.includes('parking') || raw.includes('\uc8fc\ucc28')) return 'PARKING';
  if (
    String(room.group ?? '').trim().toLowerCase() === 'support' ||
    raw.includes('corridor') || raw.includes('lobby') ||
    raw.includes('\ubcf5\ub3c4') || raw.includes('\ub85c\ube44')
  ) return 'CORRIDOR';
  return 'LIVING_UNIT';
}
