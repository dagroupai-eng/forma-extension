/**
 * Forma 캔버스에 3D 건물 매스를 배치하는 핵심 모듈.
 *
 * 흐름:
 * 1. site_limit / terrain 에서 대지 경계 좌표 파악 (WGS84 vs 로컬 미터 자동 판별)
 * 2. 건축 파라미터 → Floor Stack building 생성
 * 3. Forma.proposal.addElement(transform) → 씬에 올바른 위치로 추가
 * 4. 실패 시 render.geojson 임시 오버레이로 폴백
 */

import { Forma } from 'forma-embedded-view-sdk/auto';
import type { BuildingRequirements, LayoutType, MassLayoutType, RoomLayout } from '../data/building_requirements';

// ── 상태 추적 ───────────────────────────────────────────────
/** geoData.upload + proposal.updateElements 로 추가된 요소 paths */
const _elementPaths = new Set<string>();
/** 폴백 render.geojson IDs */
const _fallbackIds = new Set<string>();

// ── 상수 ────────────────────────────────────────────────────
const DEFAULT_FLOOR_HEIGHT_M = 4.0;
/** 1도 위도 ≈ 111,320m */
const LAT_M_PER_DEG = 111_320;
const FLOORSTACK_CREATE_TIMEOUT_MS = 45_000;
const MAX_ROOM_UNITS_PER_FLOOR = 12;

const POSITION_OFFSETS: Record<string, [number, number]> = {
  center:    [ 0.00,  0.00],
  north:     [ 0.00,  0.25],
  south:     [ 0.00, -0.25],
  east:      [ 0.25,  0.00],
  west:      [-0.25,  0.00],
  northeast: [ 0.22,  0.22],
  northwest: [-0.22,  0.22],
  southeast: [ 0.22, -0.22],
  southwest: [-0.22, -0.22],
};

const MASS_COLORS = ['#4A90D9', '#F5A623', '#7ED321', '#D0021B'];

// ── 내부 타입 ───────────────────────────────────────────────
interface Bounds {
  centerX: number;
  centerY: number;
  siteWidth: number;
  siteHeight: number;
  baseElevation: number;
  sourcePath: string;
  source: string;
  /** true = WGS84 경위도(°), false = 로컬 미터(m) */
  isGeographic: boolean;
}

interface ElevationReference {
  path: string;
  source: string;
}

interface FloorSpec {
  label: string;
  areaM2: number;
  heightM: number;
  belowGrade: boolean;
  rooms: RoomLayout[];
  layoutType: LayoutType;
  massLayoutType: MassLayoutType;
}

interface RoomSlice {
  room: RoomLayout;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

// ── 좌표계 판별 ─────────────────────────────────────────────
/**
 * 좌표계가 WGS84(경위도)인지 로컬 미터인지 판별합니다.
 * - WGS84:  |centerX| ≤ 180°, |centerY| ≤ 90°, siteWidth < 1° (= 수 km 이내)
 * - 로컬:  siteWidth가 수십~수백 미터 범위
 */
function detectIsGeographic(cx: number, cy: number, width: number): boolean {
  return (
    Math.abs(cx) <= 180 &&
    Math.abs(cy) <= 90 &&
    width < 1.0 // 1도 이상이면 로컬 미터로 간주
  );
}

/** 미터 → 경도 차이(°) 변환 (위도에 따른 보정 포함) */
function mToLon(meters: number, latDeg: number): number {
  const lonMPerDeg = LAT_M_PER_DEG * Math.cos((latDeg * Math.PI) / 180);
  return meters / lonMPerDeg;
}
/** 미터 → 위도 차이(°) 변환 */
function mToLat(meters: number): number {
  return meters / LAT_M_PER_DEG;
}

// ── footprint 파싱 ──────────────────────────────────────────
/**
 * Forma SDK의 Footprint 타입과 GeoJSON Polygon 양쪽 모두를 처리합니다.
 *
 * Forma SDK Footprint: { type: "Polygon"|"LineString", coordinates: [x,y][] }
 *   → coordinates 자체가 포인트 배열(평면). coordinates[0] = [x, y] (숫자 쌍)
 *
 * GeoJSON Polygon:    { type: "Polygon", coordinates: [[[x,y],...]] }
 *   → coordinates[0] = 첫 번째 링 = [[x,y],[x,y],...]
 *
 * 이전 코드: `f.coordinates[0]` 를 무조건 반환 → Forma Footprint이면 점 1개만 반환(버그)
 */
function extractRingFromFootprint(fp: unknown): [number, number][] | null {
  if (!fp || typeof fp !== 'object') return null;
  const f = fp as any;

  if (Array.isArray(f.coordinates) && f.coordinates.length >= 2) {
    // coordinates[0]이 숫자 쌍 [x, y]이면 → Forma SDK Footprint (평면 배열)
    // coordinates[0]이 배열 [[x,y],...]이면 → GeoJSON Polygon 링
    if (Array.isArray(f.coordinates[0])) {
      if (Array.isArray(f.coordinates[0][0])) {
        // GeoJSON Polygon: coordinates[0] = 첫 번째 링
        return f.coordinates[0] as [number, number][];
      } else {
        // Forma SDK Footprint: coordinates 자체가 링
        return f.coordinates as [number, number][];
      }
    }
  }

  // GeoJSON Feature: { geometry: { coordinates: [...] } }
  if (Array.isArray(f.geometry?.coordinates?.[0])) {
    const ring = f.geometry.coordinates[0];
    return (Array.isArray(ring?.[0]) ? ring : f.geometry.coordinates) as [number, number][];
  }

  if (Array.isArray(f.polygon?.coordinates?.[0])) return f.polygon.coordinates[0] as [number, number][];
  if (Array.isArray(f) && Array.isArray((f as any)[0])) return f as [number, number][];
  return null;
}

function bboxFromArray(arr: ArrayLike<number>): { minX: number; maxX: number; minY: number; maxY: number } | null {
  if (!arr || arr.length < 9) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i], y = arr[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

function zRangeFromArray(arr: ArrayLike<number>): { minZ: number; maxZ: number } | null {
  if (!arr || arr.length < 9) return null;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 2; i < arr.length; i += 3) {
    const z = arr[i];
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  if (!isFinite(minZ) || !isFinite(maxZ)) return null;
  return { minZ, maxZ };
}

// ── 단일 path → Bounds 계산 ────────────────────────────────
/**
 * path 하나를 받아 footprint → triangles 순으로 Bounds를 계산합니다.
 * 둘 다 실패하면 null을 반환합니다.
 */
async function boundsFromPath(path: string, sourceLabel: string): Promise<Bounds | null> {
  let zRange: { minZ: number; maxZ: number } | null = null;

  // 1순위: getFootprint
  try {
    const fp = await Forma.geometry.getFootprint({ path });
    const ring = extractRingFromFootprint(fp);
    if (ring && ring.length >= 3) {
      try {
        const triangles = await Forma.geometry.getTriangles({ path });
        zRange = zRangeFromArray(triangles as unknown as number[]);
      } catch {
        zRange = null;
      }

      const xs = ring.map(([x]) => x), ys = ring.map(([, y]) => y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      if (isFinite(minX)) {
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const w = maxX - minX, h = maxY - minY;
        return { centerX: cx, centerY: cy, siteWidth: w, siteHeight: h,
                 baseElevation: zRange?.maxZ ?? 0,
                 sourcePath: path,
                 source: `${sourceLabel}(footprint)`, isGeographic: detectIsGeographic(cx, cy, w) };
      }
    }
  } catch { /* footprint 실패 → triangles 시도 */ }

  // 2순위: getTriangles
  try {
    const triangles = await Forma.geometry.getTriangles({ path });
    const bbox = bboxFromArray(triangles as unknown as number[]);
    zRange = zRangeFromArray(triangles as unknown as number[]);
    if (bbox) {
      const { minX, maxX, minY, maxY } = bbox;
      if (isFinite(minX)) {
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const w = maxX - minX, h = maxY - minY;
        return { centerX: cx, centerY: cy, siteWidth: w, siteHeight: h,
                 baseElevation: zRange?.maxZ ?? 0,
                 sourcePath: path,
                 source: `${sourceLabel}(triangles)`, isGeographic: detectIsGeographic(cx, cy, w) };
      }
    }
  } catch { /* 실패 */ }

  return null;
}

// ── 대지 경계 감지 ─────────────────────────────────────────
/**
 * 대지 경계(Bounds)를 아래 우선순위로 가져옵니다.
 *
 * 1. 사용자가 뷰어에서 **선택(클릭)한 요소** 중 site_limit 카테고리에 속하는 path
 * 2. 선택이 없거나 해당 없으면, 뷰어 내 site_limit → terrain → generic 카테고리의 첫 번째 path
 * 3. 모두 실패 시 null 반환 → 원점 기준 기본값 사용
 */
async function getSiteBounds(): Promise<Bounds | null> {
  // ── STEP 1: 현재 사용자 선택에서 site_limit 탐색 ──────────
  try {
    const selectedPaths = await Forma.selection.getSelection();

    if (selectedPaths.length > 0) {
      // 0) 사용자가 "이미 Site Limits를 선택했다"는 전제 하에
      // 카테고리 매칭이 실패하더라도, 선택된 path로 bounds 계산을 먼저 시도한다.
      // (Forma에서 selection path와 category path가 1:1로 일치하지 않는 경우가 있어 폴백을 유발했음)
      for (const selPath of selectedPaths) {
        const direct = await boundsFromPath(selPath, '선택된 요소');
        if (direct) return direct;
      }

      // site_limit 카테고리의 모든 path 목록을 가져와 Set으로 만들기
      const siteLimitPaths = new Set<string>();
      try {
        const allSiteLimitPaths = await Forma.geometry.getPathsByCategory({ category: 'site_limit' });
        for (const p of allSiteLimitPaths) siteLimitPaths.add(p);
      } catch { /* 카테고리 조회 실패 무시 */ }

      // 선택된 path 중 site_limit에 속하는 것을 순서대로 시도
      for (const selPath of selectedPaths) {
        // 정확히 일치하거나 선택 path가 site_limit path의 하위 경로인 경우
        const matched = siteLimitPaths.has(selPath)
          || Array.from(siteLimitPaths).some((slp) => selPath.startsWith(slp) || slp.startsWith(selPath));

        if (matched) {
          const bounds = await boundsFromPath(selPath, '선택된 site_limit');
          if (bounds) return bounds;
        }
      }

      // site_limit Set이 비어 있어도, 선택된 path에 "site_limit"이 포함된 경우 직접 시도
      for (const selPath of selectedPaths) {
        if (selPath.includes('site_limit')) {
          const bounds = await boundsFromPath(selPath, '선택된 site_limit(경로 추론)');
          if (bounds) return bounds;
        }
      }
    }
  } catch { /* selection API 실패 → 폴백으로 진행 */ }

  // ── STEP 2: 카테고리 전체에서 첫 번째 요소 사용 (폴백) ────
  for (const category of ['site_limit', 'terrain', 'generic']) {
    try {
      const paths = await Forma.geometry.getPathsByCategory({ category });
      if (!paths.length) continue;
      const bounds = await boundsFromPath(paths[0], category);
      if (bounds) return bounds;
    } catch { continue; }
  }

  return null;
}

async function getElevationReferencePath(): Promise<ElevationReference | null> {
  try {
    const selectedPaths = await Forma.selection.getSelection();
    for (const selPath of selectedPaths) {
      try {
        const terrainPaths = await Forma.geometry.getPathsByCategory({ category: 'terrain' });
        const matched = terrainPaths.find((tp) => selPath === tp || selPath.startsWith(tp) || tp.startsWith(selPath));
        if (matched) {
          return { path: matched, source: '선택된 terrain' };
        }
      } catch {
        // ignore and continue fallback chain
      }
    }
  } catch {
    // ignore and continue fallback chain
  }

  for (const category of ['terrain', 'generic', 'site_limit']) {
    try {
      const paths = await Forma.geometry.getPathsByCategory({ category });
      if (paths.length > 0) {
        return { path: paths[0], source: category };
      }
    } catch {
      continue;
    }
  }

  return null;
}

// ── 지오메트리 헬퍼 ─────────────────────────────────────────
function areaToRect(area: number, ratio = 1.5): { w: number; d: number } {
  const d = Math.sqrt(area / ratio);
  return { w: d * ratio, d };
}

function normalizeMassLayoutType(value: unknown): MassLayoutType {
  const source = String(value ?? '');
  const raw = source.trim().toUpperCase();
  if (raw === 'COURTYARD_U' || raw === 'COURTYARD-U' || raw === 'COURTYARD U') return 'COURTYARD_U';
  if (raw === 'RECTANGLE' || raw === 'RECT') return 'RECTANGLE';
  if (source.includes('\u3137') || /courtyard|u[\s-]?shape|u[\s-]?type/i.test(source)) return 'COURTYARD_U';
  return 'AUTO';
}

function floorOrder(label: string): number {
  const normalized = label.trim().toUpperCase();
  const basementMatch = normalized.match(/^B(\d+)/);
  if (basementMatch) return -parseInt(basementMatch[1], 10);

  const aboveMatch = normalized.match(/^(\d+)F/);
  if (aboveMatch) return parseInt(aboveMatch[1], 10);

  return 0;
}

function sortedFloorEntries(record?: Record<string, number>): Array<[string, number]> {
  return Object.entries(record ?? {})
    .filter(([, area]) => Number.isFinite(area) && area > 0)
    .sort(([a], [b]) => floorOrder(a) - floorOrder(b));
}

function normalizeUnitType(room: RoomLayout): 'CORE' | 'CORRIDOR' | 'LIVING_UNIT' | 'PARKING' {
  const raw = `${room.unit_type ?? ''} ${room.name}`.toLowerCase();
  if (raw.includes('parking') || raw.includes('주차')) return 'PARKING';
  if (raw.includes('corridor') || raw.includes('복도')) return 'CORRIDOR';
  if (
    raw.includes('core') ||
    raw.includes('코어') ||
    raw.includes('기계') ||
    raw.includes('전기') ||
    raw.includes('발전') ||
    raw.includes('ups') ||
    raw.includes('배터리')
  ) return 'CORE';
  return 'LIVING_UNIT';
}

function normalizeFunctionId(room: RoomLayout): string {
  const source = room.function_id || room.name;
  const fallback = normalizeUnitType(room).toLowerCase();
  const normalized = source
    .trim()
    .toLowerCase()
    .replace(/[()㎡,./\\]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-|-$/g, '');

  return normalized || fallback;
}

function getRoomsWithFill(floor: FloorSpec): RoomLayout[] {
  const rawRooms = Array.isArray(floor.rooms)
    ? floor.rooms
    : floor.rooms && typeof floor.rooms === 'object'
      ? Object.values(floor.rooms as Record<string, RoomLayout>)
      : [];
  const rooms = rawRooms.filter((room) => Number.isFinite(room.area_m2) && room.area_m2 > 0);
  if (!rooms.length) return [];

  const roomArea = rooms.reduce((sum, room) => sum + room.area_m2, 0);
  const fillArea = Math.max(0, floor.areaM2 - roomArea);
  return fillArea > 1
    ? [...rooms, { name: '공용/기타', area_m2: fillArea, function_id: 'common-other', unit_type: 'CORRIDOR' }]
    : rooms;
}

function estimateTargetRowCount(roomCount: number): number {
  if (roomCount <= 1) return 1;
  if (roomCount <= 3) return 2;
  if (roomCount <= 6) return 3;
  return Math.max(3, Math.ceil(Math.sqrt(roomCount)));
}

function simplifyRoomsForPlan(rooms: RoomLayout[], maxUnits: number): RoomLayout[] {
  if (rooms.length <= maxUnits) return rooms;

  const sorted = [...rooms].sort((a, b) => b.area_m2 - a.area_m2);
  const kept = sorted.slice(0, maxUnits - 1);
  const merged = sorted.slice(maxUnits - 1);
  const mergedArea = merged.reduce((sum, room) => sum + room.area_m2, 0);

  return [
    ...kept,
    {
      name: `통합 기타 (${merged.length}실)`,
      area_m2: mergedArea,
      function_id: 'merged-other',
      unit_type: 'CORRIDOR',
    },
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeLayoutType(value: unknown): LayoutType {
  const raw = String(value ?? '').trim().toUpperCase();
  if (['L_SHAPE', 'L-SHAPE', 'L SHAPE', 'ㄱ', 'ㄱ자', 'ㄱ자형', 'L'].includes(raw)) return 'L_SHAPE';
  if (['EDGE_STRIP', 'EDGE-STRIP', 'EDGE STRIP'].includes(raw)) return 'EDGE_STRIP';
  if (['ROW_LAYOUT', 'ROW-LAYOUT', 'ROW LAYOUT'].includes(raw)) return 'ROW_LAYOUT';
  return 'AUTO';
}

function buildDominantRoomSlices(
  rooms: RoomLayout[],
  width: number,
  depth: number,
  preferLShape = false,
): RoomSlice[] | null {
  if (rooms.length < 3) return null;

  const [primary, ...secondary] = rooms;
  const totalArea = rooms.reduce((sum, room) => sum + room.area_m2, 0);
  if (primary.area_m2 / totalArea < 0.45) return null;

  const secondaryArea = totalArea - primary.area_m2;
  if (secondaryArea <= 0) return null;

  const rightStripWidth = secondaryArea / depth;
  const bottomStripHeight = secondaryArea / width;
  const useRightStrip = rightStripWidth <= width * 0.42;
  const useBottomStrip = bottomStripHeight <= depth * 0.42;

  if (!useRightStrip && !useBottomStrip) return null;

  if (preferLShape && useRightStrip && useBottomStrip) {
    const xSplit = width / 2 - rightStripWidth;
    const ySplit = -depth / 2 + bottomStripHeight;
    const rightTopArea = secondaryArea * 0.55;
    const bottomRightArea = secondaryArea - rightTopArea;
    const rightTopHeight = rightTopArea / rightStripWidth;
    const bottomRightWidth = bottomRightArea / bottomStripHeight;

    if (
      rightTopHeight > depth * 0.18 &&
      bottomRightWidth > width * 0.12 &&
      rightTopHeight < depth &&
      bottomRightWidth < width
    ) {
      return [
        {
          room: primary,
          x0: -width / 2,
          x1: xSplit,
          y0: -depth / 2,
          y1: depth / 2,
        },
        {
          room: secondary[0],
          x0: xSplit,
          x1: width / 2,
          y0: ySplit,
          y1: depth / 2,
        },
        {
          room: secondary[1] ?? secondary[0],
          x0: width / 2 - bottomRightWidth,
          x1: width / 2,
          y0: -depth / 2,
          y1: ySplit,
        },
        ...secondary.slice(2).map((room) => ({
          room,
          x0: xSplit,
          x1: width / 2 - bottomRightWidth,
          y0: -depth / 2,
          y1: ySplit,
        })),
      ];
    }
  }

  if (useRightStrip && (!useBottomStrip || rightStripWidth / width <= bottomStripHeight / depth)) {
    const xSplit = width / 2 - rightStripWidth;
    let cursorY = -depth / 2;
    const secondarySlices = secondary.map((room, index) => {
      const y1 = index === secondary.length - 1
        ? depth / 2
        : cursorY + (room.area_m2 / rightStripWidth);
      const slice = {
        room,
        x0: xSplit,
        x1: width / 2,
        y0: cursorY,
        y1,
      };
      cursorY = y1;
      return slice;
    });

    return [
      {
        room: primary,
        x0: -width / 2,
        x1: xSplit,
        y0: -depth / 2,
        y1: depth / 2,
      },
      ...secondarySlices,
    ];
  }

  let cursorX = width / 2;
  const ySplit = -depth / 2 + bottomStripHeight;
  const secondarySlices = secondary.map((room, index) => {
    const x0 = index === secondary.length - 1
      ? -width / 2
      : cursorX - (room.area_m2 / bottomStripHeight);
    const slice = {
      room,
      x0,
      x1: cursorX,
      y0: -depth / 2,
      y1: ySplit,
    };
    cursorX = x0;
    return slice;
  });

  return [
    {
      room: primary,
      x0: -width / 2,
      x1: width / 2,
      y0: ySplit,
      y1: depth / 2,
    },
    ...secondarySlices,
  ];
}

function normalizeLayoutTypeSafe(value: unknown): LayoutType {
  const source = String(value ?? '');
  const raw = source.trim().toUpperCase();
  if (raw === 'L_SHAPE' || raw === 'L-SHAPE' || raw === 'L SHAPE') return 'L_SHAPE';
  if (source.includes('\u3131')) return 'L_SHAPE';
  if (raw === 'EDGE_STRIP' || raw === 'EDGE-STRIP' || raw === 'EDGE STRIP') return 'EDGE_STRIP';
  if (raw === 'ROW_LAYOUT' || raw === 'ROW-LAYOUT' || raw === 'ROW LAYOUT') return 'ROW_LAYOUT';
  return 'AUTO';
}

function buildLShapeRoomSlices(
  rooms: RoomLayout[],
  width: number,
  depth: number,
): RoomSlice[] | null {
  if (rooms.length < 3) return null;

  const [primary, ...secondary] = rooms;
  const totalArea = rooms.reduce((sum, room) => sum + room.area_m2, 0);
  if (primary.area_m2 / totalArea < 0.45) return null;

  const secondaryArea = totalArea - primary.area_m2;
  if (secondaryArea <= 0) return null;

  const rightStripWidth = secondaryArea / depth;
  const bottomStripHeight = secondaryArea / width;
  if (rightStripWidth > width * 0.42 || bottomStripHeight > depth * 0.42) return null;

  const xSplit = width / 2 - rightStripWidth;
  const ySplit = -depth / 2 + bottomStripHeight;
  const rightColumnRooms: RoomLayout[] = [];
  const bottomRowRooms: RoomLayout[] = [];
  let rightColumnArea = 0;
  let bottomRowArea = 0;

  secondary.forEach((room, index) => {
    const sendToRight = index === 0 || rightColumnArea <= bottomRowArea;
    if (sendToRight) {
      rightColumnRooms.push(room);
      rightColumnArea += room.area_m2;
    } else {
      bottomRowRooms.push(room);
      bottomRowArea += room.area_m2;
    }
  });

  if (!rightColumnRooms.length || !bottomRowRooms.length) return null;

  let rightCursorY = ySplit;
  const rightSlices = rightColumnRooms.map((room, index) => {
    const y1 = index === rightColumnRooms.length - 1
      ? depth / 2
      : rightCursorY + (room.area_m2 / rightStripWidth);
    const slice = {
      room,
      x0: xSplit,
      x1: width / 2,
      y0: rightCursorY,
      y1,
    };
    rightCursorY = y1;
    return slice;
  });

  let bottomCursorX = width / 2;
  const bottomSlices = bottomRowRooms.map((room, index) => {
    const x0 = index === bottomRowRooms.length - 1
      ? xSplit
      : bottomCursorX - (room.area_m2 / bottomStripHeight);
    const slice = {
      room,
      x0,
      x1: bottomCursorX,
      y0: -depth / 2,
      y1: ySplit,
    };
    bottomCursorX = x0;
    return slice;
  });

  return [
    {
      room: primary,
      x0: -width / 2,
      x1: xSplit,
      y0: -depth / 2,
      y1: depth / 2,
    },
    ...rightSlices,
    ...bottomSlices,
  ];
}

function buildRoomSlices(floor: FloorSpec): { width: number; depth: number; slices: RoomSlice[] } | null {
  const rooms = simplifyRoomsForPlan(getRoomsWithFill(floor), MAX_ROOM_UNITS_PER_FLOOR);
  if (!rooms.length) return null;

  const { w, d } = areaToRect(floor.areaM2);
  const sortedRooms = [...rooms].sort((a, b) => b.area_m2 - a.area_m2);
  const preferredLayout = normalizeLayoutTypeSafe(floor.layoutType);

  if (preferredLayout === 'L_SHAPE') {
    const lShapeSlices = buildLShapeRoomSlices(sortedRooms, w, d);
    if (lShapeSlices) {
      return {
        width: w,
        depth: d,
        slices: lShapeSlices,
      };
    }
  }

  if (preferredLayout === 'EDGE_STRIP' || preferredLayout === 'AUTO') {
    const dominantSlices = buildDominantRoomSlices(sortedRooms, w, d, false);
    if (dominantSlices) {
      return {
        width: w,
        depth: d,
        slices: dominantSlices,
      };
    }
  }

  if (preferredLayout === 'EDGE_STRIP') {
    return null;
  }

  const totalArea = sortedRooms.reduce((sum, room) => sum + room.area_m2, 0);
  const targetRowCount = estimateTargetRowCount(sortedRooms.length);
  const targetRowArea = totalArea / targetRowCount;
  const rows: RoomLayout[][] = [];

  let currentRow: RoomLayout[] = [];
  let currentRowArea = 0;

  for (let i = 0; i < sortedRooms.length; i++) {
    const room = sortedRooms[i];
    const remainingRooms = sortedRooms.length - i;
    const shouldWrap =
      currentRow.length > 0 &&
      rows.length < targetRowCount - 1 &&
      (
        currentRowArea >= targetRowArea * 0.85 ||
        currentRowArea + room.area_m2 > targetRowArea * 1.35 ||
        currentRow.length >= 3
      ) &&
      remainingRooms > 1;

    if (shouldWrap) {
      rows.push(currentRow);
      currentRow = [];
      currentRowArea = 0;
    }

    currentRow.push(room);
    currentRowArea += room.area_m2;
  }

  if (currentRow.length > 0) rows.push(currentRow);

  let cursorY = d / 2;
  const slices = rows.flatMap((row, rowIndex) => {
    const rowArea = row.reduce((sum, room) => sum + room.area_m2, 0);
    const remainingDepth = cursorY - (-d / 2);
    const idealRowHeight = rowArea / w;
    const rowHeight = rowIndex === rows.length - 1
      ? remainingDepth
      : clamp(idealRowHeight, d * 0.18, Math.min(d * 0.62, remainingDepth));
    const y1 = cursorY;
    const y0 = y1 - rowHeight;
    let cursorX = -w / 2;

    const rowSlices = row.map((room, roomIndex) => {
      const x1 = roomIndex === row.length - 1
        ? w / 2
        : cursorX + (room.area_m2 / rowHeight);
      const slice = { room, x0: cursorX, x1, y0, y1 };
      cursorX = x1;
      return slice;
    });

    cursorY = y0;
    return rowSlices;
  });

  return {
    width: w,
    depth: d,
    slices,
  };
}

function buildFloorSpecs(building: BuildingRequirements['buildings'][number]): FloorSpec[] {
  const basementEntries = sortedFloorEntries(building.basement?.floor_breakdown);
  const basementHeights = building.basement?.floor_heights_m ?? {};
  const basementSpecs: FloorSpec[] = [];

  if (basementEntries.length > 0) {
    for (const [label, areaM2] of basementEntries) {
      basementSpecs.push({
        label,
        areaM2,
        heightM: basementHeights[label] ?? DEFAULT_FLOOR_HEIGHT_M,
        belowGrade: true,
        rooms: building.basement?.floor_plans?.[label] ?? [],
        layoutType: normalizeLayoutTypeSafe(building.basement?.floor_layout_types?.[label]),
        massLayoutType: normalizeMassLayoutType(building.mass_layout_type),
      });
    }
  } else if (building.basement && building.basement.floors > 0 && building.basement.area_m2 > 0) {
    const areaPerBasementFloor = building.basement.area_m2 / building.basement.floors;
    for (let floor = building.basement.floors; floor >= 1; floor--) {
      const label = `B${floor}`;
      basementSpecs.push({
        label,
        areaM2: areaPerBasementFloor,
        heightM: basementHeights[label] ?? DEFAULT_FLOOR_HEIGHT_M,
        belowGrade: true,
        rooms: building.basement?.floor_plans?.[label] ?? [],
        layoutType: normalizeLayoutTypeSafe(building.basement?.floor_layout_types?.[label]),
        massLayoutType: normalizeMassLayoutType(building.mass_layout_type),
      });
    }
  }

  const aboveEntries = sortedFloorEntries(building.floor_breakdown);
  const floorHeights = building.floor_heights_m ?? {};
  const aboveSpecs: FloorSpec[] = [];

  if (aboveEntries.length > 0) {
    for (const [label, areaM2] of aboveEntries) {
      aboveSpecs.push({
        label,
        areaM2,
        heightM: floorHeights[label] ?? DEFAULT_FLOOR_HEIGHT_M,
        belowGrade: false,
        rooms: building.floor_plans?.[label] ?? [],
        layoutType: normalizeLayoutTypeSafe(building.floor_layout_types?.[label]),
        massLayoutType: normalizeMassLayoutType(building.mass_layout_type),
      });
    }
  } else {
    for (let floor = 1; floor <= building.target_floors; floor++) {
      const label = `${floor}F`;
      aboveSpecs.push({
        label,
        areaM2: building.footprint_area,
        heightM: floorHeights[label] ?? DEFAULT_FLOOR_HEIGHT_M,
        belowGrade: false,
        rooms: building.floor_plans?.[label] ?? [],
        layoutType: normalizeLayoutTypeSafe(building.floor_layout_types?.[label]),
        massLayoutType: normalizeMassLayoutType(building.mass_layout_type),
      });
    }
  }

  return [...basementSpecs, ...aboveSpecs];
}

function makeLocalRect(areaM2: number): [number, number][] {
  const { w, d } = areaToRect(areaM2);
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
    [-w / 2, -d / 2],
  ];
}

function getCourtyardUGeometry(areaM2: number): {
  w: number;
  d: number;
  innerHalfWidth: number;
  courtyardBottomY: number;
} {
  const wingRatio = 0.22;
  const courtyardDepthRatio = 0.58;
  const builtFillRatio = 1 - ((1 - wingRatio * 2) * courtyardDepthRatio);
  const outerArea = areaM2 / builtFillRatio;
  const { w, d } = areaToRect(outerArea);
  const innerHalfWidth = (w * (1 - wingRatio * 2)) / 2;
  const courtyardBottomY = d / 2 - d * courtyardDepthRatio;

  return { w, d, innerHalfWidth, courtyardBottomY };
}

function makeLocalCourtyardU(areaM2: number): [number, number][] {
  const { w, d, innerHalfWidth, courtyardBottomY } = getCourtyardUGeometry(areaM2);
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [innerHalfWidth, d / 2],
    [innerHalfWidth, courtyardBottomY],
    [-innerHalfWidth, courtyardBottomY],
    [-innerHalfWidth, d / 2],
    [-w / 2, d / 2],
    [-w / 2, -d / 2],
  ];
}

function getLocalFootprintPolygon(
  building: BuildingRequirements['buildings'][number],
  areaM2: number,
): [number, number][] {
  const layout = normalizeMassLayoutType(building.mass_layout_type);
  if (layout === 'COURTYARD_U') return makeLocalCourtyardU(areaM2);
  return makeLocalRect(areaM2);
}

function buildZoneSlices(
  rooms: RoomLayout[],
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): RoomSlice[] {
  if (!rooms.length) return [];

  const width = x1 - x0;
  const height = y1 - y0;
  const totalArea = rooms.reduce((sum, room) => sum + room.area_m2, 0);

  if (rooms.length === 1) {
    return [{ room: rooms[0], x0, x1, y0, y1 }];
  }

  if (width >= height) {
    let cursorX = x0;
    return rooms.map((room, index) => {
      const nextX = index === rooms.length - 1
        ? x1
        : cursorX + ((room.area_m2 / totalArea) * width);
      const slice = { room, x0: cursorX, x1: nextX, y0, y1 };
      cursorX = nextX;
      return slice;
    });
  }

  let cursorY = y0;
  return rooms.map((room, index) => {
    const nextY = index === rooms.length - 1
      ? y1
      : cursorY + ((room.area_m2 / totalArea) * height);
    const slice = { room, x0, x1, y0: cursorY, y1: nextY };
    cursorY = nextY;
    return slice;
  });
}

function buildCourtyardURoomSlices(floor: FloorSpec): { width: number; depth: number; slices: RoomSlice[] } | null {
  const rooms = simplifyRoomsForPlan(getRoomsWithFill(floor), MAX_ROOM_UNITS_PER_FLOOR);
  if (!rooms.length) return null;

  const sortedRooms = [...rooms].sort((a, b) => b.area_m2 - a.area_m2);
  const { w, d, innerHalfWidth, courtyardBottomY } = getCourtyardUGeometry(floor.areaM2);
  const zones = [
    { key: 'left', x0: -w / 2, x1: -innerHalfWidth, y0: -d / 2, y1: d / 2 },
    { key: 'bottom', x0: -innerHalfWidth, x1: innerHalfWidth, y0: -d / 2, y1: courtyardBottomY },
    { key: 'right', x0: innerHalfWidth, x1: w / 2, y0: -d / 2, y1: d / 2 },
  ];

  const zoneState = zones.map((zone) => ({
    ...zone,
    area: Math.max(0, (zone.x1 - zone.x0) * (zone.y1 - zone.y0)),
    assignedArea: 0,
    rooms: [] as RoomLayout[],
  }));

  sortedRooms.forEach((room, index) => {
    const preferredZone = index === 0
      ? zoneState.find((zone) => zone.key === 'bottom') ?? zoneState[0]
      : [...zoneState].sort((a, b) => (a.assignedArea / a.area) - (b.assignedArea / b.area))[0];
    preferredZone.rooms.push(room);
    preferredZone.assignedArea += room.area_m2;
  });

  const slices = zoneState.flatMap((zone) => buildZoneSlices(zone.rooms, zone.x0, zone.x1, zone.y0, zone.y1));
  return {
    width: w,
    depth: d,
    slices,
  };
}

function buildPlanFromRooms(
  floor: FloorSpec,
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean },
): {
  id: string;
  vertices: { id: string; x: number; y: number }[];
  units: {
    polygon: string[];
    program?: 'CORE' | 'CORRIDOR' | 'LIVING_UNIT' | 'PARKING';
    functionId?: string;
    holes: string[][];
  }[];
} | null {
  const roomSlices = floor.massLayoutType === 'COURTYARD_U'
    ? buildCourtyardURoomSlices(floor)
    : buildRoomSlices(floor);
  if (!roomSlices) return null;

  const vertices: { id: string; x: number; y: number }[] = [];
  const units: {
    polygon: string[];
    program?: 'CORE' | 'CORRIDOR' | 'LIVING_UNIT' | 'PARKING';
    functionId?: string;
    holes: string[][];
  }[] = [];
  const vertexIdsByCoord = new Map<string, string>();

  const vertexId = (x: number, y: number): string => {
    const key = `${x.toFixed(6)},${y.toFixed(6)}`;
    const existing = vertexIdsByCoord.get(key);
    if (existing) return existing;

    const id = `${floor.label.replace(/[^A-Za-z0-9]/g, '')}_v${vertices.length + 1}`;
    vertexIdsByCoord.set(key, id);
    vertices.push({ id, x, y });
    return id;
  };

  roomSlices.slices.forEach(({ room, x0, x1, y0, y1 }) => {
    const ids = [
      vertexId(x0, y0),
      vertexId(x1, y0),
      vertexId(x1, y1),
      vertexId(x0, y1),
    ];

    units.push({
      polygon: ids,
      ...(options?.includePrograms === false ? {} : { program: normalizeUnitType(room) }),
      ...(options?.includeFunctionIds === false ? {} : { functionId: normalizeFunctionId(room) }),
      holes: [],
    });
  });

  return {
    id: `plan-${floor.label.replace(/[^A-Za-z0-9]/g, '')}`,
    vertices,
    units,
  };
}

function makeRect(cx: number, cy: number, hw: number, hd: number): [number, number][] {
  return [
    [cx - hw, cy - hd],
    [cx + hw, cy - hd],
    [cx + hw, cy + hd],
    [cx - hw, cy + hd],
    [cx - hw, cy - hd],
  ];
}

function makeWorldRectFromLocalSlice(
  cx: number,
  cy: number,
  slice: RoomSlice,
  isGeo: boolean,
): [number, number][] {
  const x0 = isGeo ? mToLon(slice.x0, cy) : slice.x0;
  const x1 = isGeo ? mToLon(slice.x1, cy) : slice.x1;
  const y0 = isGeo ? mToLat(slice.y0) : slice.y0;
  const y1 = isGeo ? mToLat(slice.y1) : slice.y1;

  return [
    [cx + x0, cy + y0],
    [cx + x1, cy + y0],
    [cx + x1, cy + y1],
    [cx + x0, cy + y1],
    [cx + x0, cy + y0],
  ];
}

function makeTranslationTransform(x = 0, y = 0, z = 0): [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ];
}

async function sampleTerrainElevation(
  cx: number,
  cy: number,
  widthM: number,
  depthM: number,
): Promise<number | null> {
  const sampleOffsets: Array<[number, number]> = [
    [0, 0],
    [-0.35, -0.35],
    [0.35, -0.35],
    [0.35, 0.35],
    [-0.35, 0.35],
  ];

  const samples = await Promise.all(
    sampleOffsets.map(async ([ox, oy]) => {
      try {
        return await Forma.terrain.getElevationAt({
          x: cx + ox * widthM,
          y: cy + oy * depthM,
        });
      } catch {
        return null;
      }
    }),
  );

  const valid = samples.filter((z): z is number => typeof z === 'number' && Number.isFinite(z));
  if (valid.length === 0) return null;

  // 경사진 지형에서는 너무 낮은 점을 따라가면 매스가 묻힐 수 있으므로
  // 샘플 중 상단값을 사용해 건물 바닥을 지표면 위로 맞춥니다.
  return Math.max(...valid);
}

function barycentricZAtPoint(
  px: number,
  py: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): number | null {
  const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(denom) < 1e-9) return null;

  const w1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denom;
  const w2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denom;
  const w3 = 1 - w1 - w2;

  const epsilon = 1e-5;
  if (w1 < -epsilon || w2 < -epsilon || w3 < -epsilon) return null;
  return w1 * az + w2 * bz + w3 * cz;
}

async function sampleLocalElevationFromMesh(path: string, x: number, y: number): Promise<number | null> {
  try {
    const triangles = await Forma.geometry.getTriangles({ path });
    if (!triangles || triangles.length < 9) return null;

    let bestContainingZ: number | null = null;
    let closestVertexZ: number | null = null;
    let closestVertexDist2 = Infinity;

    for (let i = 0; i < triangles.length; i += 9) {
      const ax = triangles[i];
      const ay = triangles[i + 1];
      const az = triangles[i + 2];
      const bx = triangles[i + 3];
      const by = triangles[i + 4];
      const bz = triangles[i + 5];
      const cx = triangles[i + 6];
      const cy = triangles[i + 7];
      const cz = triangles[i + 8];

      const triZ = barycentricZAtPoint(x, y, ax, ay, az, bx, by, bz, cx, cy, cz);
      if (triZ !== null) {
        bestContainingZ = bestContainingZ === null ? triZ : Math.max(bestContainingZ, triZ);
      }

      const vertices: Array<[number, number, number]> = [
        [ax, ay, az],
        [bx, by, bz],
        [cx, cy, cz],
      ];

      for (const [vx, vy, vz] of vertices) {
        const dx = vx - x;
        const dy = vy - y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < closestVertexDist2) {
          closestVertexDist2 = dist2;
          closestVertexZ = vz;
        }
      }
    }

    return bestContainingZ ?? closestVertexZ;
  } catch {
    return null;
  }
}


// ── 공개 인터페이스 타입 ────────────────────────────────────
export interface PlacedMassInfo {
  name: string;
  geojsonId: string;
  centerX: number;
  centerY: number;
  placementZ: number;
  widthM: number;
  depthM: number;
  heightM: number;
  floors: number;
  basementFloors: number;
  footprintArea: number;
  totalFloorArea: number;
  floorDetails: string[];
  roomUnitCount: number;
  color: string;
  method: 'building_element' | 'render_fallback';
  debug: {
    siteSourcePath: string;
    elevationSourcePath: string;
    baseElevation: number;
    localMeshElevation: number | null;
  };
}

export interface PlaceResult {
  placed: PlacedMassInfo[];
  warnings: string[];
  siteReference: string;
  totalFootprint: number;
  coverageRatio: number;
}

function createFloorsAndPlans(
  building: BuildingRequirements['buildings'][number],
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean },
): {
  floors: Array<{ polygon: [number, number][]; height: number } | { planId: string; height: number }>;
  plans: NonNullable<ReturnType<typeof buildPlanFromRooms>>[];
  floorSpecs: FloorSpec[];
} {
  const floorSpecs = buildFloorSpecs(building);
  const plans = floorSpecs
    .map((floor) => buildPlanFromRooms(floor, options))
    .filter((plan): plan is NonNullable<ReturnType<typeof buildPlanFromRooms>> => plan !== null);
  const planByFloorLabel = new Map(plans.map((plan) => [plan.id.replace(/^plan-/, ''), plan.id]));
  const floors = floorSpecs.map((floor) => {
    const planId = planByFloorLabel.get(floor.label.replace(/[^A-Za-z0-9]/g, ''));
    return planId
      ? { planId, height: floor.heightM }
      : { polygon: getLocalFootprintPolygon(building, floor.areaM2), height: floor.heightM };
  });

  return { floors, plans, floorSpecs };
}

// ── 메인 함수 ───────────────────────────────────────────────
/**
 * 건축 기획 파라미터를 기반으로 Forma에 3D 건물 매스를 배치합니다.
 *
 * - geoData.upload({ dataType: "buildings" }) 로 실제 Building 요소 생성
 * - proposal.updateElements({ type: "add" }) 로 Buildings 레이어에 추가
 * - 실패 시 render.geojson 오버레이로 폴백
 */
type FloorStackPlan = NonNullable<ReturnType<typeof buildPlanFromRooms>>;

function stripPlanFunctionIds(plan: FloorStackPlan): FloorStackPlan {
  return {
    ...plan,
    units: plan.units.map(({ functionId: _functionId, ...unit }) => unit),
  };
}

function forcePlanProgram(
  plan: FloorStackPlan,
  program: 'CORE' | 'CORRIDOR' | 'LIVING_UNIT' | 'PARKING',
): FloorStackPlan {
  return {
    ...plan,
    units: plan.units.map((unit) => ({ ...unit, program })),
  };
}

function removePlanPrograms(plan: FloorStackPlan): FloorStackPlan {
  return {
    ...plan,
    units: plan.units.map(({ program: _program, ...unit }) => unit),
  };
}

async function addFloorStackAtSiteCenter(
  name: string,
  request: Parameters<typeof Forma.elements.floorStack.createFromFloors>[0],
  zOffsetM = 0,
  options?: { skipSiteContext?: boolean },
): Promise<{ urn: string; path: string; centerX: number; centerY: number; placementZ: number }> {
  const skipSiteContext = options?.skipSiteContext ?? false;
  const bounds = skipSiteContext ? null : await getSiteBounds();
  const elevationRef = skipSiteContext ? null : await getElevationReferencePath();
  const centerX = bounds?.centerX ?? 0;
  const centerY = bounds?.centerY ?? 0;
  const baseElevation = bounds?.baseElevation ?? 0;
  const elevationPath = elevationRef?.path ?? bounds?.sourcePath ?? '';
  const localMeshElevation = !skipSiteContext && !bounds?.isGeographic && elevationPath
    ? await sampleLocalElevationFromMesh(elevationPath, centerX, centerY)
    : null;
  const placementZ = localMeshElevation ?? baseElevation;
  const { urn } = await withTimeout(
    Forma.elements.floorStack.createFromFloors(request),
    FLOORSTACK_CREATE_TIMEOUT_MS,
    `${name}: FloorStack 생성 응답이 지연되고 있습니다.`,
  );
  const { path } = await withTimeout(
    Forma.proposal.addElement({
      urn,
      name,
      transform: makeTranslationTransform(centerX, centerY, placementZ + zOffsetM),
    }),
    FLOORSTACK_CREATE_TIMEOUT_MS,
    `${name}: Proposal 추가 응답이 지연되고 있습니다.`,
  );

  _elementPaths.add(path);
  return { urn, path, centerX, centerY, placementZ: placementZ + zOffsetM };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function testFloorStackPlanUnits(): Promise<{
  status: 'success' | 'failed';
  successfulAttempt?: string;
  path?: string;
  attempts: Array<{ name: string; ok: boolean; error?: string }>;
}> {
  const splitPlan: FloorStackPlan = {
    id: 'plan-test-split',
    vertices: [
      { id: 'v1', x: -10, y: -5 },
      { id: 'v2', x: 0, y: -5 },
      { id: 'v3', x: 10, y: -5 },
      { id: 'v4', x: 10, y: 5 },
      { id: 'v5', x: 0, y: 5 },
      { id: 'v6', x: -10, y: 5 },
    ],
    units: [
      {
        polygon: ['v1', 'v2', 'v5', 'v6'],
        program: 'LIVING_UNIT',
        functionId: 'commercial',
        holes: [],
      },
      {
        polygon: ['v2', 'v3', 'v4', 'v5'],
        program: 'LIVING_UNIT',
        functionId: 'commercial',
        holes: [],
      },
    ],
  };
  const basePlan: FloorStackPlan = {
    id: 'plan-test',
    vertices: [
      { id: 'v1', x: -5, y: -5 },
      { id: 'v2', x: 5, y: -5 },
      { id: 'v3', x: 5, y: 5 },
      { id: 'v4', x: -5, y: 5 },
    ],
    units: [{
      polygon: ['v1', 'v2', 'v3', 'v4'],
      program: 'LIVING_UNIT',
      functionId: 'commercial',
      holes: [],
    }],
  };

  const attempts = [
    {
      name: 'two adjacent units with shared vertices',
      floors: [{ planId: 'plan-test-split', height: 3 }],
      plans: [splitPlan],
    },
    {
      name: 'program=LIVING_UNIT + functionId=commercial',
      floors: [{ planId: 'plan-test', height: 3 }],
      plans: [basePlan],
    },
    {
      name: 'program=LIVING_UNIT only',
      floors: [{ planId: 'plan-test', height: 3 }],
      plans: [stripPlanFunctionIds(basePlan)],
    },
    {
      name: 'polygon units only',
      floors: [{ planId: 'plan-test', height: 3 }],
      plans: [removePlanPrograms(stripPlanFunctionIds(basePlan))],
    },
  ];

  const results: Array<{ name: string; ok: boolean; error?: string }> = [];

  for (const attempt of attempts) {
    try {
      const added = await addFloorStackAtSiteCenter(
        `FloorStack plan units test (${attempt.name})`,
        {
          floors: attempt.floors,
          plans: attempt.plans,
        },
        0,
        { skipSiteContext: true },
      );
      results.push({ name: attempt.name, ok: true });
      return {
        status: 'success',
        successfulAttempt: attempt.name,
        path: added.path,
        attempts: results,
      };
    } catch (err) {
      results.push({ name: attempt.name, ok: false, error: String(err) });
    }
  }

  return { status: 'failed', attempts: results };
}

export async function recreateBuildingsWithFloorPlans(
  requirements: BuildingRequirements,
): Promise<{
  status: 'success' | 'partial' | 'failed';
  placed: Array<{
    name: string;
    path: string;
    successfulAttempt: string;
    floors: number;
    roomUnits: number;
  }>;
  failed: Array<{ name: string; attempts: Array<{ name: string; ok: boolean; error?: string }> }>;
  warnings: string[];
}> {
  const placed: Array<{
    name: string;
    path: string;
    successfulAttempt: string;
    floors: number;
    roomUnits: number;
  }> = [];
  const failed: Array<{ name: string; attempts: Array<{ name: string; ok: boolean; error?: string }> }> = [];
  const warnings: string[] = [];

  const canEdit = await Forma.getCanEdit().catch(() => false);
  if (!canEdit) {
    return {
      status: 'failed',
      placed,
      failed,
      warnings: ['Forma project is not editable from the current session.'],
    };
  }

  for (const building of requirements.buildings) {
    const { floors, plans, floorSpecs } = createFloorsAndPlans(building, {
      includeFunctionIds: true,
      includePrograms: true,
    });
    const simplifiedFloors = floorSpecs
      .map((floor) => {
        const originalRooms = getRoomsWithFill(floor);
        const simplifiedRooms = simplifyRoomsForPlan(originalRooms, MAX_ROOM_UNITS_PER_FLOOR);
        return originalRooms.length > simplifiedRooms.length
          ? `${floor.label}(${originalRooms.length}실→${simplifiedRooms.length}실)`
          : null;
      })
      .filter((label): label is string => label !== null);
    const roomUnits = plans.reduce((sum, plan) => sum + plan.units.length, 0);
    const basementDepthM = floorSpecs
      .filter((floor) => floor.belowGrade)
      .reduce((sum, floor) => sum + floor.heightM, 0);

    if (simplifiedFloors.length > 0) {
      warnings.push(
        `${building.name}: ${simplifiedFloors.join(', ')} 층은 Forma 생성 안정성을 위해 자동 단순화했습니다.`,
      );
    }

    if (plans.length === 0 || roomUnits === 0) {
      failed.push({
        name: building.name,
        attempts: [{
          name: 'floor plans from PDF',
          ok: false,
          error: 'No floor_plans/rooms were supplied for this building.',
        }],
      });
      continue;
    }

    const attempts = [
      {
        name: 'program + functionId from PDF',
        plans,
      },
      {
        name: 'program only from PDF',
        plans: plans.map(stripPlanFunctionIds),
      },
      {
        name: 'all units as LIVING_UNIT',
        plans: plans.map((plan) => stripPlanFunctionIds(forcePlanProgram(plan, 'LIVING_UNIT'))),
      },
      {
        name: 'polygon units only',
        plans: plans.map((plan) => removePlanPrograms(stripPlanFunctionIds(plan))),
      },
    ];

    const results: Array<{ name: string; ok: boolean; error?: string }> = [];

    for (const attempt of attempts) {
      try {
        const added = await addFloorStackAtSiteCenter(
          `${building.name} - floor plans`,
          { floors, plans: attempt.plans },
          -basementDepthM,
        );
        results.push({ name: attempt.name, ok: true });
        placed.push({
          name: building.name,
          path: added.path,
          successfulAttempt: attempt.name,
          floors: floorSpecs.length,
          roomUnits,
        });
        break;
      } catch (err) {
        results.push({ name: attempt.name, ok: false, error: String(err) });
      }
    }

    if (!results.some((result) => result.ok)) {
      failed.push({ name: building.name, attempts: results });
    }
  }

  if (failed.length > 0) {
    warnings.push('Existing buildings were not deleted. The tool only adds successfully recreated FloorStack buildings.');
  }

  return {
    status: placed.length > 0 && failed.length === 0 ? 'success' : placed.length > 0 ? 'partial' : 'failed',
    placed,
    failed,
    warnings,
  };
}

export async function placeBuildingMasses(
  requirements: BuildingRequirements,
): Promise<PlaceResult> {
  const warnings: string[] = [];
  const placed: PlacedMassInfo[] = [];

  // 0-A. 편집 권한 확인 — Proposal element 생성에 필요
  let canEdit = false;
  try {
    canEdit = await Forma.getCanEdit();
    if (!canEdit) {
      warnings.push('ℹ️ Forma 편집 권한(Collaborator 이상)이 없어 proposal 요소를 생성할 수 없습니다. 임시 오버레이로 표시합니다.');
    }
  } catch { /* 권한 조회 실패 시 canEdit=false 유지 */ }

  // 1. 대지 경계 파악
  const bounds = await getSiteBounds();
  const elevationRef = await getElevationReferencePath();

  let originX: number, originY: number, siteW: number, siteH: number, baseElevation: number;
  let siteSourcePath = '';
  let elevationSourcePath = '';
  let isGeo: boolean;
  let siteReference: string;

  if (bounds) {
    originX = bounds.centerX;
    originY = bounds.centerY;
    siteW   = bounds.siteWidth;
    siteH   = bounds.siteHeight;
    baseElevation = bounds.baseElevation;
    siteSourcePath = bounds.sourcePath;
    elevationSourcePath = elevationRef?.path ?? bounds.sourcePath;
    isGeo   = bounds.isGeographic;

    const unit = isGeo ? '°' : 'm';
    const precision = isGeo ? 6 : 1;
    siteReference = `${bounds.source} (${siteW.toFixed(precision)}${unit} × ${siteH.toFixed(precision)}${unit}, ` +
                    `중심 X=${originX.toFixed(precision)}, Y=${originY.toFixed(precision)}, ` +
                    `기준고도 Z=${baseElevation.toFixed(1)}m, ` +
                    `Z소스=${elevationRef?.source ?? bounds.source}, ` +
                    `좌표계=${isGeo ? 'WGS84 경위도' : '로컬 미터'})`;
  } else {
    originX = 0; originY = 0; siteW = 173; siteH = 173; baseElevation = 0; siteSourcePath = ''; elevationSourcePath = ''; isGeo = false;
    siteReference = '기본값 (원점 기준 173m × 173m) — Forma에서 Site Limits를 먼저 설정하세요.';
    warnings.push('대지(site_limit/terrain) 요소를 찾을 수 없어 원점 기준으로 배치합니다. ' +
                  'Forma LIMITS 패널에서 Site Limits를 설정 후 재배치하세요.');
  }

  // 2. 각 동 처리
  for (let i = 0; i < requirements.buildings.length; i++) {
    const building = requirements.buildings[i];
    const color = MASS_COLORS[i % MASS_COLORS.length];

    // 위치 힌트 → 대지 중심 기준 오프셋
    const [ox, oy] = POSITION_OFFSETS[building.position_hint] ?? [0, 0];
    const cx = originX + ox * siteW;
    const cy = originY + oy * siteH;

    const floorSpecs = buildFloorSpecs(building);
    const aboveGradeSpecs = floorSpecs.filter((floor) => !floor.belowGrade);
    const basementDepthM = floorSpecs
      .filter((floor) => floor.belowGrade)
      .reduce((sum, floor) => sum + floor.heightM, 0);
    const heightM = floorSpecs.reduce((sum, floor) => sum + floor.heightM, 0);
    const footprintArea = aboveGradeSpecs[0]?.areaM2 ?? building.footprint_area;
    const totalFloorArea = floorSpecs.reduce((sum, floor) => sum + floor.areaM2, 0);
    const { w: footprintWM, d: footprintDM } = areaToRect(footprintArea);
    const localMeshElevationM = !isGeo && elevationSourcePath
      ? (await sampleLocalElevationFromMesh(elevationSourcePath, cx, cy)) ?? null
      : null;
    const localPlacementZ = localMeshElevationM ?? baseElevation;
    let cumulativeElevation = -basementDepthM;
    const floorFeatures = floorSpecs.flatMap((floor) => {
      const { w: floorW, d: floorD } = areaToRect(floor.areaM2);
      let hw: number;
      let hd: number;

      if (isGeo) {
        hw = mToLon(floorW / 2, cy);
        hd = mToLat(floorD / 2);
      } else {
        hw = floorW / 2;
        hd = floorD / 2;
      }

      const elevation = cumulativeElevation;
      cumulativeElevation += floor.heightM;
      const roomSlices = buildRoomSlices(floor);

      if (roomSlices) {
        return roomSlices.slices.map((slice) => ({
          type: 'Feature' as const,
          properties: {
            height: floor.heightM,
            elevation,
            name: `${floor.label} ${slice.room.name}`,
            building_name: building.name,
            floor_label: floor.label,
            room_name: slice.room.name,
            function_id: normalizeFunctionId(slice.room),
            unit_type: normalizeUnitType(slice.room),
            below_grade: floor.belowGrade,
            room_area_m2: slice.room.area_m2,
            floor_area_m2: floor.areaM2,
            fill: color,
            'fill-opacity': floor.belowGrade ? 0.42 : 0.72,
            stroke: '#ffffff',
            'stroke-width': 1,
          },
          geometry: {
            type: 'Polygon' as const,
            coordinates: [makeWorldRectFromLocalSlice(cx, cy, slice, isGeo)],
          },
        }));
      }

      return [{
        type: 'Feature' as const,
        properties: {
          height: floor.heightM,
          elevation,
          name: `${building.name} ${floor.label}`,
          floor_label: floor.label,
          below_grade: floor.belowGrade,
          floor_area_m2: floor.areaM2,
          fill: color,
          'fill-opacity': floor.belowGrade ? 0.35 : 0.65,
          stroke: '#ffffff',
          'stroke-width': 2,
        },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [makeRect(cx, cy, hw, hd)],
        },
      }];
    });

    const renderGeoJson = {
      type: 'FeatureCollection' as const,
      features: floorFeatures,
    };

    // ── 방법 1: Floor Stack building → proposal.addElement ─────
    let addedAsBuilding = false;
    if (canEdit) {
      try {
        const { floors, plans } = createFloorsAndPlans(building);

        const { urn } = await Forma.elements.floorStack.createFromFloors({
          floors,
          ...(plans.length > 0 ? { plans } : {}),
        });

        const { path } = await Forma.proposal.addElement({
          urn,
          name: building.name,
          transform: makeTranslationTransform(cx, cy, localPlacementZ - basementDepthM),
        });

        _elementPaths.add(path);
        addedAsBuilding = true;
        placed.push({
          name: building.name,
          geojsonId: path,
          centerX: cx,
          centerY: cy,
          placementZ: localPlacementZ,
          widthM: parseFloat(footprintWM.toFixed(1)),
          depthM: parseFloat(footprintDM.toFixed(1)),
          heightM,
          floors: building.target_floors,
          basementFloors: floorSpecs.filter((floor) => floor.belowGrade).length,
          footprintArea,
          totalFloorArea,
          floorDetails: floorSpecs.map((floor) => `${floor.label}: ${floor.areaM2}㎡ / ${floor.heightM}m`),
          roomUnitCount: floorSpecs.reduce((sum, floor) => sum + simplifyRoomsForPlan(getRoomsWithFill(floor), MAX_ROOM_UNITS_PER_FLOOR).length, 0),
          color,
          method: 'building_element',
          debug: {
            siteSourcePath,
            elevationSourcePath,
            baseElevation,
            localMeshElevation: localMeshElevationM,
          },
        });
      } catch (err) {
        warnings.push(`⚠️ ${building.name} Floor Stack 생성 실패 (임시 오버레이로 폴백): ${String(err)}`);
      }
    }

    // ── 방법 2: render.geojson 폴백 (편집 권한 없거나 geoData 실패 시) ──
    if (!addedAsBuilding) {
      try {
        const { id } = await Forma.render.geojson.add({
          geojson: renderGeoJson,
          transform: makeTranslationTransform(0, 0, localPlacementZ),
        });
        _fallbackIds.add(id);
        placed.push({
          name: building.name,
          geojsonId: id,
          centerX: cx,
          centerY: cy,
          placementZ: localPlacementZ,
          widthM: parseFloat(footprintWM.toFixed(1)),
          depthM: parseFloat(footprintDM.toFixed(1)),
          heightM,
          floors: building.target_floors,
          basementFloors: floorSpecs.filter((floor) => floor.belowGrade).length,
          footprintArea,
          totalFloorArea,
          floorDetails: floorSpecs.map((floor) => `${floor.label}: ${floor.areaM2}㎡ / ${floor.heightM}m`),
          roomUnitCount: floorSpecs.reduce((sum, floor) => sum + simplifyRoomsForPlan(getRoomsWithFill(floor), MAX_ROOM_UNITS_PER_FLOOR).length, 0),
          color,
          method: 'render_fallback',
          debug: {
            siteSourcePath,
            elevationSourcePath,
            baseElevation,
            localMeshElevation: localMeshElevationM,
          },
        });
        warnings.push(`ℹ️ ${building.name}: 임시 오버레이로 표시됨. 실배치는 오버레이 사각형으로 시각화되지만 Forma Floor Plan units로 저장되지는 않습니다. 저장하려면 프로젝트 편집 권한이 필요합니다.`);
      } catch (err2) {
        warnings.push(`❌ ${building.name} 배치 완전 실패: ${String(err2)}`);
      }
    }
  }

  // 3. 건폐율 계산
  const totalFootprint = placed.reduce((s, m) => s + m.footprintArea, 0);
  const siteArea = requirements.site_limits.total_site_area;
  const coverageRatio = siteArea > 0 ? parseFloat((totalFootprint / siteArea).toFixed(4)) : 0;

  return { placed, warnings, siteReference, totalFootprint, coverageRatio };
}

/**
 * 이 Extension이 배치한 모든 매스를 씬에서 제거합니다.
 * - Buildings 레이어 요소: proposal.updateElements (remove)
 * - 폴백 오버레이: render.geojson.remove
 */
export async function clearAllMasses(): Promise<{ removedCount: number }> {
  let removedCount = 0;

  // Buildings 레이어 요소 제거 (proposal.removeElement 사용)
  for (const path of _elementPaths) {
    try {
      await Forma.proposal.removeElement({ path });
      removedCount++;
    } catch { /* 이미 제거됨 */ }
  }
  _elementPaths.clear();

  // 폴백 render.geojson 오버레이 제거
  for (const id of _fallbackIds) {
    try {
      await Forma.render.geojson.remove({ id });
      removedCount++;
    } catch { /* 이미 제거됨 */ }
  }
  _fallbackIds.clear();

  return { removedCount };
}

/** 현재 배치된 Buildings 요소 paths 반환 */
export function getPlacedElementPaths(): string[] {
  return Array.from(_elementPaths);
}
