import type { CoreTemplate, RoomLayout } from '../data/building_requirements';
import { isExplicitCoreRoom } from './room_classification';

export interface CoverageSlice {
  room: RoomLayout;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function isCoreRoom(room: RoomLayout): boolean {
  return isExplicitCoreRoom(room);
}

export function findCoreRoom(rooms: RoomLayout[], template?: CoreTemplate): RoomLayout | undefined {
  const byType = rooms.find((room) => isCoreRoom(room));
  if (byType) return byType;
  if (template?.room_name) {
    const named = rooms.find((room) => room.name === template.room_name);
    if (named) return named;
  }
  return undefined;
}

/** PDF footprint corner-origin 좌표를 층 envelope 기준 local 중심 좌표로 변환 */
function resolveCoreCenter(template: CoreTemplate, width: number, depth: number): { cx: number; cy: number } {
  const position = template.position ?? 'center';
  const xMargin = width * 0.25;
  const yMargin = depth * 0.25;
  const fromPosition = (): { cx: number; cy: number } => {
    switch (position) {
      case 'west': return { cx: -xMargin, cy: 0 };
      case 'east': return { cx: xMargin, cy: 0 };
      case 'north': return { cx: 0, cy: yMargin };
      case 'south': return { cx: 0, cy: -yMargin };
      case 'northwest': return { cx: -xMargin, cy: yMargin };
      case 'northeast': return { cx: xMargin, cy: yMargin };
      case 'southwest': return { cx: -xMargin, cy: -yMargin };
      case 'southeast': return { cx: xMargin, cy: -yMargin };
      case 'center':
      default:
        return { cx: 0, cy: 0 };
    }
  };

  const rawX = Number(template.center_x_m);
  const rawY = Number(template.center_y_m);
  if (Number.isFinite(rawX) && Number.isFinite(rawY)) {
    const looksLikeLowerLeftOrigin =
      rawX >= 0 &&
      rawY >= 0 &&
      rawX <= width + 0.01 &&
      rawY <= depth + 0.01 &&
      (rawX >= width / 2 - 0.01 || rawY >= depth / 2 - 0.01);
    if (looksLikeLowerLeftOrigin) {
      return { cx: rawX - width / 2, cy: rawY - depth / 2 };
    }
    if (Math.abs(rawX) <= width / 2 + 0.01 && Math.abs(rawY) <= depth / 2 + 0.01) {
      return { cx: rawX, cy: rawY };
    }
  }

  if (template.fixed_across_floors) {
    return fromPosition();
  }

  return {
    cx: Number(template.offset_x_m) || 0,
    cy: Number(template.offset_y_m) || 0,
  };
}

export function scaleCoreTemplateToEnvelope(
  template: CoreTemplate,
  refWidth: number,
  refDepth: number,
  envWidth: number,
  envDepth: number,
): CoreTemplate {
  if (refWidth <= 0 || refDepth <= 0) return template;
  const sx = envWidth / refWidth;
  const sy = envDepth / refDepth;
  const scaled: CoreTemplate = { ...template };
  if (Number.isFinite(Number(template.center_x_m))) {
    scaled.center_x_m = round2(Number(template.center_x_m) * sx);
  }
  if (Number.isFinite(Number(template.center_y_m))) {
    scaled.center_y_m = round2(Number(template.center_y_m) * sy);
  }
  return scaled;
}

export function calculateFixedCoreBounds(
  template: CoreTemplate,
  coreRoom: RoomLayout,
  width: number,
  depth: number,
): { coreX0: number; coreX1: number; coreY0: number; coreY1: number } | null {
  const declaredCoreArea = Number(coreRoom.area_m2);
  const templateWidth = Number(template.width_m);
  const coreWidth = Math.max(
    Number.isFinite(templateWidth) && templateWidth > 0 ? templateWidth : Math.sqrt(declaredCoreArea),
    0.5,
  );
  const templateDepth = Number(template.depth_m);
  let coreDepth = Number.isFinite(templateDepth) && templateDepth > 0 ? templateDepth : 0;
  if (
    (!Number.isFinite(templateDepth) || templateDepth <= 0 ||
      Math.abs((coreWidth * templateDepth) - declaredCoreArea) / Math.max(declaredCoreArea, 1) > 0.05) &&
    Number.isFinite(declaredCoreArea) &&
    declaredCoreArea > 0 &&
    coreWidth > 0
  ) {
    coreDepth = declaredCoreArea / coreWidth;
  }
  coreDepth = Math.max(coreDepth, 0.5);

  const { cx, cy } = resolveCoreCenter(template, width, depth);

  const coreX0 = round2(cx - coreWidth / 2);
  const coreX1 = round2(cx + coreWidth / 2);
  const coreY0 = round2(cy - coreDepth / 2);
  const coreY1 = round2(cy + coreDepth / 2);

  if (coreX1 <= coreX0 || coreY1 <= coreY0) return null;
  if (
    coreX0 < -width / 2 - 0.01 ||
    coreX1 > width / 2 + 0.01 ||
    coreY0 < -depth / 2 - 0.01 ||
    coreY1 > depth / 2 + 0.01
  ) {
    return null;
  }
  return { coreX0, coreX1, coreY0, coreY1 };
}

function orderRoomsByAdjacency(rooms: RoomLayout[]): RoomLayout[] {
  if (rooms.length <= 1) return rooms;
  const byId = new Map(rooms.map((r) => [r.room_id ?? r.name, r]));
  const used = new Set<string>();
  const ordered: RoomLayout[] = [];

  const adjIds = (room: RoomLayout) => [
    ...(room.required_adjacency ?? []),
    ...(room.adjacent_to ?? []),
  ];

  const seed = [...rooms].sort((a, b) => b.area_m2 - a.area_m2)[0];
  ordered.push(seed);
  used.add(seed.room_id ?? seed.name);

  let grew = true;
  while (grew) {
    grew = false;
    for (const room of rooms) {
      const key = room.room_id ?? room.name;
      if (used.has(key)) continue;
      const touches = ordered.some((placed) =>
        adjIds(room).includes(placed.room_id ?? placed.name)
        || adjIds(placed).includes(key),
      );
      if (touches) {
        ordered.push(room);
        used.add(key);
        grew = true;
      }
    }
  }

  for (const room of [...rooms].sort((a, b) => b.area_m2 - a.area_m2)) {
    const key = room.room_id ?? room.name;
    if (!used.has(key)) ordered.push(room);
  }
  return ordered;
}

function makeFillRoom(id: string, areaM2: number): RoomLayout {
  return {
    name: `Circulation ${id}`,
    area_m2: areaM2,
    function_id: `circulation-${id}`,
    unit_type: 'CORRIDOR',
  };
}

function packHorizontallyExact(
  rooms: RoomLayout[],
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): CoverageSlice[] | null {
  const bandH = y1 - y0;
  if (bandH <= 0.01 || !rooms.length) return [];
  const slices: CoverageSlice[] = [];
  let curX = x0;
  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    const w = round2(room.area_m2 / bandH);
    const nextX = round2(curX + w);
    if (nextX > x1 + 0.05) return null;
    slices.push({ room, x0: curX, x1: nextX, y0, y1 });
    curX = nextX;
  }
  const fillArea = round2(Math.max(0, (x1 - curX) * bandH));
  if (fillArea > 0.5) {
    slices.push({ room: makeFillRoom('fill', fillArea), x0: curX, x1, y0, y1 });
  }
  return slices;
}

function packVerticallyExact(
  rooms: RoomLayout[],
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): CoverageSlice[] | null {
  const bandW = x1 - x0;
  if (bandW <= 0.01 || !rooms.length) return [];
  const slices: CoverageSlice[] = [];
  let curY = y1;
  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    const h = round2(room.area_m2 / bandW);
    const nextY = round2(curY - h);
    if (nextY < y0 - 0.05) return null;
    slices.push({ room, x0, x1, y0: nextY, y1: curY });
    curY = nextY;
  }
  const fillArea = round2(Math.max(0, bandW * (curY - y0)));
  if (fillArea > 0.5) {
    slices.push({ room: makeFillRoom('fill', fillArea), x0, x1, y0, y1: curY });
  }
  return slices;
}

interface Zone {
  id: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  capacity: number;
  rooms: RoomLayout[];
  used: number;
  vertical: boolean;
}

function buildZonesAroundCore(
  width: number,
  depth: number,
  coreX0: number,
  coreX1: number,
  coreY0: number,
  coreY1: number,
): Zone[] {
  const hw = width / 2;
  const hd = depth / 2;
  const zones: Zone[] = [
    {
      id: 'left',
      x0: -hw,
      x1: coreX0,
      y0: -hd,
      y1: hd,
      capacity: Math.max(0, (coreX0 + hw) * depth),
      rooms: [],
      used: 0,
      vertical: true,
    },
    {
      id: 'right',
      x0: coreX1,
      x1: hw,
      y0: -hd,
      y1: hd,
      capacity: Math.max(0, (hw - coreX1) * depth),
      rooms: [],
      used: 0,
      vertical: true,
    },
    {
      id: 'top',
      x0: coreX0,
      x1: coreX1,
      y0: coreY1,
      y1: hd,
      capacity: Math.max(0, (coreX1 - coreX0) * (hd - coreY1)),
      rooms: [],
      used: 0,
      vertical: false,
    },
    {
      id: 'bottom',
      x0: coreX0,
      x1: coreX1,
      y0: -hd,
      y1: coreY0,
      capacity: Math.max(0, (coreX1 - coreX0) * (coreY0 + hd)),
      rooms: [],
      used: 0,
      vertical: false,
    },
  ];
  return zones.filter((zone) => zone.capacity > 1);
}

function assignRoomsToZones(zones: Zone[], rooms: RoomLayout[]): boolean {
  const sorted = orderRoomsByAdjacency([...rooms].sort((a, b) => b.area_m2 - a.area_m2));

  for (const room of sorted) {
    let best: Zone | null = null;
    let bestSlack = Number.POSITIVE_INFINITY;
    for (const zone of zones) {
      const spare = zone.capacity - zone.used;
      if (spare + 0.5 < room.area_m2) continue;
      const slack = spare - room.area_m2;
      if (slack < bestSlack) {
        bestSlack = slack;
        best = zone;
      }
    }
    if (!best) return false;
    best.rooms.push(room);
    best.used += room.area_m2;
  }
  return true;
}

function packZone(zone: Zone): CoverageSlice[] | null {
  if (!zone.rooms.length) return [];
  if (zone.vertical) {
    return packVerticallyExact(zone.rooms, zone.x0, zone.x1, zone.y0, zone.y1);
  }
  return packHorizontallyExact(zone.rooms, zone.x0, zone.x1, zone.y0, zone.y1);
}

function allFloorsFitAtEnvelope(
  floorAreaM2: number,
  floorRoomSets: RoomLayout[][],
  template: CoreTemplate,
  w: number,
  d: number,
  refFootprintWidth?: number,
  refFootprintDepth?: number,
): boolean {
  if (w < 5 || d < 5) return false;
  return floorRoomSets.every((rooms) =>
    buildFullCoverageCoreSlices(
      rooms,
      template,
      floorAreaM2,
      refFootprintWidth,
      refFootprintDepth,
      w,
      d,
    ) !== null,
  );
}

function envelopeAspectScore(
  w: number,
  d: number,
  refFootprintWidth?: number,
  refFootprintDepth?: number,
): number {
  if (refFootprintWidth && refFootprintDepth && refFootprintWidth > 0 && refFootprintDepth > 0) {
    return Math.abs(w / d - refFootprintWidth / refFootprintDepth);
  }
  return Math.abs(w / d - 1.5);
}

function finalizeEnvelopeDimensions(
  floorAreaM2: number,
  floorRoomSets: RoomLayout[][],
  template: CoreTemplate | undefined,
  w: number,
  d: number,
  refFootprintWidth?: number,
  refFootprintDepth?: number,
): { w: number; d: number } | null {
  if (!template || !floorRoomSets.length) return null;
  const rounded = { w: round2(w), d: round2(d) };
  if (allFloorsFitAtEnvelope(
    floorAreaM2,
    floorRoomSets,
    template,
    rounded.w,
    rounded.d,
    refFootprintWidth,
    refFootprintDepth,
  )) {
    return rounded;
  }
  if (allFloorsFitAtEnvelope(
    floorAreaM2,
    floorRoomSets,
    template,
    w,
    d,
    refFootprintWidth,
    refFootprintDepth,
  )) {
    return { w: round2(w), d: round2(d) };
  }
  return null;
}

/** 건물 그룹(지상/지하) 전체 층이 공유하는 단일 envelope */
export function resolveBuildingEnvelope(
  floorAreaM2: number,
  coreWidth: number,
  floorRoomSets: RoomLayout[][],
  template?: CoreTemplate,
  refFootprintWidth?: number,
  refFootprintDepth?: number,
): { w: number; d: number } {
  const candidates: Array<{ w: number; d: number }> = [];

  if (refFootprintWidth && refFootprintDepth && refFootprintWidth > 0 && refFootprintDepth > 0) {
    candidates.push({ w: refFootprintWidth, d: floorAreaM2 / refFootprintWidth });
    candidates.push({ w: floorAreaM2 / refFootprintDepth, d: refFootprintDepth });
    const aspect = refFootprintWidth / refFootprintDepth;
    const dFromAspect = Math.sqrt(floorAreaM2 / aspect);
    candidates.push({ w: floorAreaM2 / dFromAspect, d: dFromAspect });
  }

  if (template && floorRoomSets.length > 0) {
    for (let ratio = 0.25; ratio <= 6; ratio += 0.025) {
      const d = Math.sqrt(floorAreaM2 / ratio);
      candidates.push({ w: floorAreaM2 / d, d });
    }
  }

  let best: { w: number; d: number } | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  if (template && floorRoomSets.length > 0) {
    for (const candidate of candidates) {
      const finalized = finalizeEnvelopeDimensions(
        floorAreaM2,
        floorRoomSets,
        template,
        candidate.w,
        candidate.d,
        refFootprintWidth,
        refFootprintDepth,
      );
      if (!finalized) continue;

      const score = envelopeAspectScore(
        finalized.w,
        finalized.d,
        refFootprintWidth,
        refFootprintDepth,
      );
      if (score < bestScore) {
        bestScore = score;
        best = finalized;
      }
    }
  }

  if (best) return best;

  if (refFootprintWidth && refFootprintWidth > 0) {
    return { w: round2(refFootprintWidth), d: round2(floorAreaM2 / refFootprintWidth) };
  }

  return resolveEnvelopeDimensions(floorAreaM2, coreWidth, floorRoomSets.flat());
}

/** 층 면적·실 면적 합에 맞는 envelope 비율을 탐색한다. */
export function resolveEnvelopeDimensions(
  floorAreaM2: number,
  coreWidth: number,
  rooms: RoomLayout[],
): { w: number; d: number } {
  const nonCore = rooms.filter((room) => !isCoreRoom(room));
  const areas = nonCore.map((room) => room.area_m2).sort((a, b) => b - a);
  const largest = areas[0] ?? 0;
  const second = areas[1] ?? 0;

  if (largest > 0 && second > 0 && coreWidth > 0 && (largest + second) >= floorAreaM2 * 0.45) {
    const depth = (floorAreaM2 - largest - second) / coreWidth;
    if (depth > 5) {
      const width = floorAreaM2 / depth;
      const leftW = largest / depth;
      const rightW = second / depth;
      if (leftW > 0.5 && rightW > 0.5 && leftW + rightW + coreWidth <= width + 0.5) {
        return { w: round2(width), d: round2(depth) };
      }
    }
  }

  for (let ratio = 1.1; ratio <= 4.5; ratio += 0.05) {
    const d = Math.sqrt(floorAreaM2 / ratio);
    const w = floorAreaM2 / d;
    const leftW = (w - coreWidth) / 2;
    if (leftW <= 0.5) continue;
    const sideCapacity = leftW * d;
    if (sideCapacity + 0.5 >= largest && sideCapacity + 0.5 >= second) {
      return { w: round2(w), d: round2(d) };
    }
  }

  const base = Math.sqrt(floorAreaM2 / 1.5);
  return { w: round2(base * 1.5), d: round2(base) };
}

export function tryThreeColumnLayout(
  rooms: RoomLayout[],
  template: CoreTemplate,
  floorAreaM2: number,
  fixedWidth?: number,
  fixedDepth?: number,
): { width: number; depth: number; slices: CoverageSlice[] } | null {
  const coreRoom = findCoreRoom(rooms, template);
  if (!coreRoom) return null;

  const nonCore = rooms.filter((room) => room !== coreRoom);
  const sorted = [...nonCore].sort((a, b) => b.area_m2 - a.area_m2);
  if (sorted.length < 2) return null;

  const rightArea = sorted[0].area_m2;
  const leftArea = sorted[1].area_m2;
  const centerRooms = orderRoomsByAdjacency(sorted.slice(2));
  const coreWidth = Math.max(Number(template.width_m) || Math.sqrt(coreRoom.area_m2), 0.5);

  let width = fixedWidth ?? 0;
  let depth = fixedDepth ?? 0;

  if (fixedWidth && fixedDepth && fixedWidth > 0 && fixedDepth > 0) {
    width = fixedWidth;
    depth = fixedDepth;
  } else {
    depth = (floorAreaM2 - leftArea - rightArea) / coreWidth;
    if (depth <= 5) return null;
    width = floorAreaM2 / depth;
  }

  const leftWidth = leftArea / depth;
  const rightWidth = rightArea / depth;
  if (leftWidth <= 0.2 || rightWidth <= 0.2) return null;

  const hw = width / 2;
  const hd = depth / 2;
  const coreX0 = round2(-hw + leftWidth);
  const coreX1 = round2(coreX0 + coreWidth);
  const coreH = round2(coreRoom.area_m2 / coreWidth);
  const coreY1 = hd;
  const coreY0 = round2(hd - coreH);

  if (leftWidth + rightWidth + coreWidth > width + 0.5) {
    return null;
  }

  const slices: CoverageSlice[] = [
    {
      room: sorted[1],
      x0: -hw,
      x1: coreX0,
      y0: -hd,
      y1: hd,
    },
    {
      room: coreRoom,
      x0: coreX0,
      x1: coreX1,
      y0: coreY0,
      y1: coreY1,
    },
    {
      room: sorted[0],
      x0: coreX1,
      x1: hw,
      y0: -hd,
      y1: hd,
    },
  ];

  const centerPacked = packVerticallyExact(centerRooms, coreX0, coreX1, -hd, coreY0);
  if (!centerPacked) return null;
  slices.push(...centerPacked);

  const check = validateFullCoverage(slices, width, depth);
  return check.ok ? { width, depth, slices } : null;
}

function alignSlicesToCoreTemplate(
  slices: CoverageSlice[],
  template: CoreTemplate,
  coreRoom: RoomLayout,
  width: number,
  depth: number,
): CoverageSlice[] | null {
  if (!template.fixed_across_floors) return slices;

  const target = calculateFixedCoreBounds(template, coreRoom, width, depth);
  if (!target) return slices;

  const coreSlice = slices.find((slice) => slice.room === coreRoom);
  if (!coreSlice) return slices;

  const dx = round2(
    (target.coreX0 + target.coreX1) / 2 - (coreSlice.x0 + coreSlice.x1) / 2,
  );
  const dy = round2(
    (target.coreY0 + target.coreY1) / 2 - (coreSlice.y0 + coreSlice.y1) / 2,
  );
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return slices;

  const hw = width / 2;
  const hd = depth / 2;
  const shifted = slices.map((slice) => ({
    ...slice,
    x0: round2(slice.x0 + dx),
    x1: round2(slice.x1 + dx),
    y0: round2(slice.y0 + dy),
    y1: round2(slice.y1 + dy),
  }));

  for (const slice of shifted) {
    if (
      slice.x0 < -hw - 0.1
      || slice.x1 > hw + 0.1
      || slice.y0 < -hd - 0.1
      || slice.y1 > hd + 0.1
    ) {
      return null;
    }
  }

  const check = validateFullCoverage(shifted, width, depth);
  return check.ok ? shifted : null;
}

function finalizeCoverageLayout(
  layout: { width: number; depth: number; slices: CoverageSlice[] },
  template: CoreTemplate,
  coreRoom: RoomLayout,
): { width: number; depth: number; slices: CoverageSlice[] } | null {
  const baseCheck = validateFullCoverage(layout.slices, layout.width, layout.depth);
  if (!baseCheck.ok) return null;

  const aligned = alignSlicesToCoreTemplate(
    layout.slices,
    template,
    coreRoom,
    layout.width,
    layout.depth,
  );
  if (aligned) {
    return { ...layout, slices: aligned };
  }
  return layout;
}

export function tryLayoutAtEnvelope(
  rooms: RoomLayout[],
  template: CoreTemplate,
  width: number,
  depth: number,
): CoverageSlice[] | null {
  const coreRoom = findCoreRoom(rooms, template);
  if (!coreRoom) return null;

  const bounds = calculateFixedCoreBounds(template, coreRoom, width, depth);
  if (!bounds) return null;

  const { coreX0, coreX1, coreY0, coreY1 } = bounds;
  const nonCore = rooms.filter((room) => room !== coreRoom);
  const zones = buildZonesAroundCore(width, depth, coreX0, coreX1, coreY0, coreY1);
  if (!assignRoomsToZones(zones, nonCore)) return null;

  const slices: CoverageSlice[] = [{
    room: coreRoom,
    x0: coreX0,
    x1: coreX1,
    y0: coreY0,
    y1: coreY1,
  }];

  for (const zone of zones) {
    const packed = packZone(zone);
    if (!packed) return null;
    slices.push(...packed);
  }

  const placedArea = slices.reduce((sum, slice) =>
    sum + (slice.x1 - slice.x0) * (slice.y1 - slice.y0), 0);
  if (Math.abs(placedArea - width * depth) > 2) return null;

  return slices;
}

/**
 * PDF core_template 고정 + floor_plans area_m2 기준으로 층 전체를 빈틈 없이 채운다.
 */
export function buildFullCoverageCoreSlices(
  rooms: RoomLayout[],
  template: CoreTemplate,
  floorAreaM2: number,
  refFootprintWidth?: number,
  refFootprintDepth?: number,
  fixedWidth?: number,
  fixedDepth?: number,
): { width: number; depth: number; slices: CoverageSlice[] } | null {
  if (!rooms.length || floorAreaM2 <= 0) return null;

  const coreRoom = findCoreRoom(rooms, template);
  if (!coreRoom) return null;

  const useFixed = Number(fixedWidth) > 0 && Number(fixedDepth) > 0;
  const width = useFixed ? Number(fixedWidth) : undefined;
  const depth = useFixed ? Number(fixedDepth) : undefined;
  const layoutTemplate = useFixed && refFootprintWidth && refFootprintDepth
    ? scaleCoreTemplateToEnvelope(template, refFootprintWidth, refFootprintDepth, width!, depth!)
    : template;

  if (useFixed) {
    const zoneSlices = tryLayoutAtEnvelope(rooms, layoutTemplate, width!, depth!);
    if (zoneSlices) {
      return finalizeCoverageLayout(
        { width: width!, depth: depth!, slices: zoneSlices },
        layoutTemplate,
        coreRoom,
      );
    }
  }

  const nonCore = rooms.filter((room) => room !== coreRoom);
  if (nonCore.length >= 2) {
    const threeCol = tryThreeColumnLayout(
      rooms,
      layoutTemplate,
      floorAreaM2,
      width,
      depth,
    );
    if (threeCol) {
      return finalizeCoverageLayout(threeCol, layoutTemplate, coreRoom);
    }
  }

  if (useFixed) return null;

  const coreWidth = Math.max(Number(template.width_m) || Math.sqrt(coreRoom.area_m2), 0.5);
  const { w: seedW, d: seedD } = resolveEnvelopeDimensions(floorAreaM2, coreWidth, rooms);

  let best: { width: number; depth: number; slices: CoverageSlice[] } | null = null;

  for (let attempt = 0; attempt < 40; attempt++) {
    const scale = 1 + attempt * 0.03;
    const d = round2(seedD * scale);
    const w = round2(floorAreaM2 / d);
    const tpl = refFootprintWidth && refFootprintDepth
      ? scaleCoreTemplateToEnvelope(template, refFootprintWidth, refFootprintDepth, w, d)
      : template;
    const slices = tryLayoutAtEnvelope(rooms, tpl, w, d);
    if (slices) {
      const layout = finalizeCoverageLayout(
        { width: w, depth: d, slices },
        tpl,
        coreRoom,
      );
      if (layout) {
        best = layout;
        break;
      }
    }
  }

  return best;
}

export function sliceArea(slice: CoverageSlice): number {
  return round2((slice.x1 - slice.x0) * (slice.y1 - slice.y0));
}

export function validateFullCoverage(
  slices: CoverageSlice[],
  width: number,
  depth: number,
): { ok: boolean; placed: number; target: number; overlaps: number } {
  let overlaps = 0;
  for (let i = 0; i < slices.length; i++) {
    for (let j = i + 1; j < slices.length; j++) {
      const a = slices[i];
      const b = slices[j];
      const x = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
      const y = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
      if (x * y > 0.1) overlaps++;
    }
  }
  const placed = slices.reduce((sum, slice) => sum + sliceArea(slice), 0);
  const target = width * depth;
  return {
    ok: overlaps === 0 && Math.abs(placed - target) <= 2,
    placed: round2(placed),
    target: round2(target),
    overlaps,
  };
}
