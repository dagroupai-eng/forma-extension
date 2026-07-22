/**
 * Places 3D building masses in the Forma canvas.
 *
 * Flow:
 * 1. Detect site bounds from site_limit or terrain geometry.
 * 2. Convert building requirements into FloorStack floors and plans.
 * 3. Add the FloorStack to the proposal with the correct transform.
 * 4. Report failure instead of counting temporary overlays as real masses.
 */

import { Forma } from 'forma-embedded-view-sdk/auto';
import type { BuildingRequirements, CoreTemplate, LayoutType, MassLayoutType, RoomLayout } from '../data/building_requirements';
import { classifyRoomUnitType, isExplicitCoreRoom } from './room_classification';
import {
  decideOriginalMassReplacement,
  describeFloorEnvelopeSelection,
  geometrySourceForEnvelopeProvenance,
  selectFloorEnvelopeSource,
  type FloorEnvelopeSelection,
} from './floor_envelope_provenance';
import { validateFloorGeometryContract } from '../layout/geometry_contract';
import {
  buildFullCoverageCoreSlices,
  resolveBuildingEnvelope,
  scaleCoreTemplateToEnvelope,
  sliceArea,
} from './full_coverage_layout';

// State tracking.
/** Element paths added by this extension. */
const _elementPaths = new Set<string>();
/** Unconfirmed elements whose immediate cleanup failed; retained for clearAllMasses retry only. */
const _unconfirmedElementPaths = new Set<string>();
/** Fallback render.geojson IDs. */
const _fallbackIds = new Set<string>();
/** render.geojson IDs created by the mass generation fallback. */
const _massFallbackIds = new Set<string>();
/** render.geojson IDs created by the room layout line overlay. */
const _roomLayoutLineIds = new Set<string>();
/** Proposal element paths created for persistent room layout line geometry. */
const _roomLayoutElementPaths = new Set<string>();
/** Selected original-mass snapshots retained for the current regeneration session. */
const _massSnapshots = new Map<string, MassSnapshot>();

import {
  MassComponentPlanningError,
  resolvePodiumMultiTowerBasement,
  resolvePodiumMultiTowerComponents,
  type ComponentPlacementDiagnostic,
} from './podium_multi_tower';
// Constants.
const DEFAULT_FLOOR_HEIGHT_M = 4.0;
/** Approximate meters per degree of latitude. */
const LAT_M_PER_DEG = 111_320;
const FLOORSTACK_CREATE_TIMEOUT_MS = 45_000;
const BUILDING_PERSIST_TIMEOUT_MS = 20_000;
const BUILDING_INDEX_ATTEMPTS = 30;
const BUILDING_INDEX_POLL_INTERVAL_MS = 500;
const MAX_ROOM_UNITS_PER_FLOOR = 12;
const STRICT_ROOM_AREA_TOLERANCE_RATIO = 0.03;
const STRICT_PARKING_AREA_TOLERANCE_RATIO = 0.02;
const STRICT_ROOM_AREA_TOLERANCE_M2 = 2;
const STRICT_CORE_CENTER_TOLERANCE_M = 0.1;
const STRICT_CORE_SIZE_TOLERANCE_M = 0.1;
const STRICT_CORE_AREA_TOLERANCE_RATIO = 0.02;
// Change this whenever the regeneration diagnostic contract changes. It makes
// it immediately visible when Forma is still running an older extension build.
const FLOORSTACK_REGEN_DIAGNOSTIC_VERSION = 'floorstack-regeneration-diagnostic-2026-07-14.1';

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

// Types.
interface Bounds {
  centerX: number;
  centerY: number;
  siteWidth: number;
  siteHeight: number;
  /** Measured horizontal site area when local metric geometry is available. */
  siteAreaM2: number;
  /** Counter-clockwise rotation of the site's local +X axis in world XY. */
  rotationRad: number;
  baseElevation: number;
  sourcePath: string;
  source: string;
  /** Controls whether per-building terrain sampling may replace baseElevation. */
  elevationPolicy: 'terrain' | 'source_geometry';
  /** true = WGS84 degrees, false = local meters. */
  isGeographic: boolean;
}

export interface OrientedSiteFrame {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotationRad: number;
}

/** Immutable geometry read from the selected Forma mass before regeneration. */
interface MassSnapshotFloor {
  elevationM: number;
  heightM: number;
  outerPolygon: [number, number][];
  holes: [number, number][][];
  areaM2: number;
}

interface MassSnapshot {
  sourcePath: string;
  sourceUrn: string;
  captureMode: 'gross-floor-area-polygons' | 'footprint-fallback';
  worldTransform: number[];
  floors: MassSnapshotFloor[];
  hasSetbacks: boolean;
  hasNonRectangularFootprints: boolean;
  hasHoles: boolean;
}

/** Keeps the original SDK failure visible instead of collapsing it into null. */
interface MassSnapshotCapture {
  snapshot: MassSnapshot | null;
  diagnostics: string[];
}

/** A verified, per-floor rectangular envelope from the original mass. */
interface FloorEnvelope {
  widthM: number;
  depthM: number;
  areaM2: number;
}

function validateSelectedFloorEnvelopeContracts(
  selection: FloorEnvelopeSelection<Map<string, FloorEnvelope>>,
  floorSpecs: FloorSpec[],
): string[] {
  const errors: string[] = [];
  for (const floor of floorSpecs) {
    const envelope = selection.envelopes.get(floor.label);
    if (!envelope) {
      errors.push(`${floor.label}: selected geometry source did not provide an envelope.`);
      continue;
    }
    const halfWidth = envelope.widthM / 2;
    const halfDepth = envelope.depthM / 2;
    const validation = validateFloorGeometryContract({
      schemaVersion: '1.0',
      levelId: floor.label,
      source: geometrySourceForEnvelopeProvenance(selection.provenance),
      coordinateSystem: 'local-meters',
      outerBoundary: [
        [-halfWidth, -halfDepth],
        [halfWidth, -halfDepth],
        [halfWidth, halfDepth],
        [-halfWidth, halfDepth],
      ],
      // Stage 1 validates the authoritative working envelope and provenance.
      // Core/program feasibility remains in the existing strict room validator
      // until fixed program regions are separated from true no-go obstacles.
      rooms: [],
    });
    if (validation.ok === false) {
      errors.push(...validation.violations.map((violation) => `${floor.label} ${violation.code}: ${violation.message}`));
    }
  }
  return errors;
}

async function captureFootprintSnapshot(path: string, diagnostics: string[] = []): Promise<MassSnapshot | null> {
  try {
    const footprint = await Forma.geometry.getFootprint({ path });
    const outerPolygon = extractRingFromFootprint(footprint);
    if (!outerPolygon || outerPolygon.length < 3) {
      diagnostics.push('footprint fallback returned no valid outer polygon.');
      return null;
    }

    let heightM = DEFAULT_FLOOR_HEIGHT_M;
    try {
      const triangles = await Forma.geometry.getTriangles({ path });
      const zRange = zRangeFromArray(triangles as unknown as number[]);
      if (zRange && zRange.maxZ > zRange.minZ) heightM = zRange.maxZ - zRange.minZ;
    } catch (err) {
      diagnostics.push(`footprint fallback could not read triangles: ${describeError(err)}`);
      // Keep the conservative default when the mesh cannot be read.
    }
    let worldTransform: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    try {
      const result = await Forma.elements.getWorldTransform({ path });
      worldTransform = Array.from(result.transform as unknown as number[]);
    } catch (err) {
      diagnostics.push(`footprint fallback could not read world transform: ${describeError(err)}`);
      // Geometry footprint is already proposal-relative in this fallback path.
    }
    const snapshot: MassSnapshot = {
      sourcePath: path,
      sourceUrn: '',
      captureMode: 'footprint-fallback',
      worldTransform,
      floors: [{
        elevationM: 0,
        heightM,
        outerPolygon,
        holes: [],
        areaM2: Math.abs(signedPolygonArea(outerPolygon)),
      }],
      hasSetbacks: false,
      hasNonRectangularFootprints: !isRectangleRing(outerPolygon),
      hasHoles: false,
    };
    _massSnapshots.set(path, snapshot);
    return snapshot;
  } catch (err) {
    diagnostics.push(`footprint fallback failed: ${describeError(err)}`);
    return null;
  }
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
  coreTemplate?: CoreTemplate;
  footprintWidthM?: number;
  footprintDepthM?: number;
  envelopeWidthM?: number;
  envelopeDepthM?: number;
  refFootprintWidthM?: number;
  refFootprintDepthM?: number;
  preserveRoomAreas?: boolean;
}

interface RoomSlice {
  room: RoomLayout;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  polygon?: [number, number][];
  layoutAreaM2?: number;
}

// Coordinate-system detection.
/**
 * Detect whether coordinates are WGS84 degrees or local meters.
 * - WGS84: |centerX| <= 180, |centerY| <= 90, and siteWidth < 1 degree.
 * - Local meters: siteWidth is usually tens to hundreds of meters.
 */
function detectIsGeographic(cx: number, cy: number, width: number): boolean {
  return (
    Math.abs(cx) <= 180 &&
    Math.abs(cy) <= 90 &&
    width < 1.0 // Larger than 1 degree is treated as local meters.
  );
}

/** Convert meters to longitude degrees, adjusted by latitude. */
function mToLon(meters: number, latDeg: number): number {
  const lonMPerDeg = LAT_M_PER_DEG * Math.cos((latDeg * Math.PI) / 180);
  return meters / lonMPerDeg;
}
/** Convert meters to latitude degrees. */
function mToLat(meters: number): number {
  return meters / LAT_M_PER_DEG;
}

// Footprint parsing.
/**
 * Handles both Forma SDK Footprint objects and GeoJSON Polygon-like objects.
 *
 * Forma SDK Footprint: { type: "Polygon"|"LineString", coordinates: [x,y][] }
 *   - coordinates itself can be a ring array. coordinates[0] = [x, y].
 *
 * GeoJSON Polygon:    { type: "Polygon", coordinates: [[[x,y],...]] }
 *   - coordinates[0] can be the first ring = [[x,y],[x,y],...].
 *
 * Avoid assuming f.coordinates[0] is always a polygon ring.
 */
function extractRingFromFootprint(fp: unknown): [number, number][] | null {
  if (!fp || typeof fp !== 'object') return null;
  const f = fp as any;

  if (Array.isArray(f.coordinates) && f.coordinates.length >= 2) {
    // If coordinates[0] is numeric [x, y], this is a Forma SDK footprint ring.
    // If coordinates[0] is [[x, y], ...], this is a GeoJSON polygon ring.
    if (Array.isArray(f.coordinates[0])) {
      if (Array.isArray(f.coordinates[0][0])) {
        // GeoJSON Polygon: coordinates[0] is the first ring.
        return f.coordinates[0] as [number, number][];
      } else {
        // Forma SDK Footprint: coordinates itself is the ring.
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

async function worldTransformElevation(path: string): Promise<number | null> {
  try {
    const { transform } = await Forma.elements.getWorldTransform({ path });
    const values = Array.from(transform as unknown as ArrayLike<number>);
    const z = Number(values[14]);
    return Number.isFinite(z) ? z : null;
  } catch {
    return null;
  }
}

function convexHullFromTriangles(triangles: ArrayLike<number>): [number, number][] | null {
  if (!triangles || triangles.length < 9) return null;

  const unique = new Map<string, [number, number]>();
  for (let index = 0; index + 1 < triangles.length; index += 3) {
    const x = Number(triangles[index]);
    const y = Number(triangles[index + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    unique.set(`${x}:${y}`, [x, y]);
  }
  const points = Array.from(unique.values()).sort(([ax, ay], [bx, by]) => ax - bx || ay - by);
  if (points.length < 3) return null;

  const cross = (origin: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
  const lower: [number, number][] = [];
  for (const point of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: [number, number][] = [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper];
  return hull.length >= 3 ? hull : null;
}

function normalizeHalfTurn(angle: number): number {
  let normalized = angle % Math.PI;
  if (normalized >= Math.PI / 2) normalized -= Math.PI;
  if (normalized < -Math.PI / 2) normalized += Math.PI;
  return Math.abs(normalized) < 1e-12 ? 0 : normalized;
}

/** Deterministic minimum-area frame whose local X follows the longer side. */
export function deriveOrientedSiteFrame(polygon: [number, number][]): OrientedSiteFrame | null {
  const points = normalizeSnapshotRing(polygon);
  if (!points) return null;
  type Candidate = OrientedSiteFrame & { area: number };
  const candidates: Candidate[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index];
    const [bx, by] = points[(index + 1) % points.length];
    const dx = bx - ax;
    const dy = by - ay;
    if (Math.hypot(dx, dy) < 1e-9) continue;

    let angle = Math.atan2(dy, dx);
    let cos = Math.cos(angle);
    let sin = Math.sin(angle);
    let local = points.map(([x, y]) => [x * cos + y * sin, -x * sin + y * cos] as [number, number]);
    let width = Math.max(...local.map(([x]) => x)) - Math.min(...local.map(([x]) => x));
    let height = Math.max(...local.map(([, y]) => y)) - Math.min(...local.map(([, y]) => y));
    if (height > width) angle += Math.PI / 2;

    angle = normalizeHalfTurn(angle);
    cos = Math.cos(angle);
    sin = Math.sin(angle);
    local = points.map(([x, y]) => [x * cos + y * sin, -x * sin + y * cos] as [number, number]);
    const minX = Math.min(...local.map(([x]) => x));
    const maxX = Math.max(...local.map(([x]) => x));
    const minY = Math.min(...local.map(([, y]) => y));
    const maxY = Math.max(...local.map(([, y]) => y));
    width = maxX - minX;
    height = maxY - minY;
    const localCenterX = (minX + maxX) / 2;
    const localCenterY = (minY + maxY) / 2;
    candidates.push({
      centerX: localCenterX * cos - localCenterY * sin,
      centerY: localCenterX * sin + localCenterY * cos,
      width,
      height,
      rotationRad: angle,
      area: width * height,
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const tolerance = Math.max(1, a.area, b.area) * 1e-9;
    if (Math.abs(a.area - b.area) > tolerance) return a.area - b.area;
    if (Math.abs(Math.abs(a.rotationRad) - Math.abs(b.rotationRad)) > 1e-12) {
      return Math.abs(a.rotationRad) - Math.abs(b.rotationRad);
    }
    return a.rotationRad - b.rotationRad;
  });
  const { area: _area, ...frame } = candidates[0];
  return frame;
}

export function siteLocalOffsetToWorld(
  ox: number,
  oy: number,
  width: number,
  height: number,
  rotationRad: number,
): { x: number; y: number } {
  const localX = ox * width;
  const localY = oy * height;
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  return { x: localX * cos - localY * sin, y: localX * sin + localY * cos };
}

// Bounds for a single element path.
/**
 * Calculates bounds from footprint first, then from triangles.
 * Returns null when both methods fail.
 */
async function boundsFromPath(
  path: string,
  sourceLabel: string,
  elevationPolicy: Bounds['elevationPolicy'] = 'terrain',
): Promise<Bounds | null> {
  let zRange: { minZ: number; maxZ: number } | null = null;

  // 1st priority: getFootprint.
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
        const frame = deriveOrientedSiteFrame(ring);
        const cx = frame?.centerX ?? (minX + maxX) / 2, cy = frame?.centerY ?? (minY + maxY) / 2;
        const w = frame?.width ?? maxX - minX, h = frame?.height ?? maxY - minY;
        const transformElevation = zRange ? null : await worldTransformElevation(path);
        return { centerX: cx, centerY: cy, siteWidth: w, siteHeight: h,
                 siteAreaM2: detectIsGeographic(cx, cy, w) ? 0 : Math.abs(signedPolygonArea(ring)),
                 rotationRad: frame?.rotationRad ?? 0,
                 baseElevation: zRange?.minZ ?? transformElevation ?? 0,
                 sourcePath: path,
                 source: `${sourceLabel}(footprint)`, elevationPolicy,
                 isGeographic: detectIsGeographic(cx, cy, w) };
      }
    }
  } catch { /* Try triangles when footprint lookup fails. */ }

  // 2nd priority: getTriangles.
  try {
    const triangles = await Forma.geometry.getTriangles({ path });
    const bbox = bboxFromArray(triangles as unknown as number[]);
    zRange = zRangeFromArray(triangles as unknown as number[]);
    if (bbox) {
      const { minX, maxX, minY, maxY } = bbox;
      if (isFinite(minX)) {
        const hull = convexHullFromTriangles(triangles as unknown as number[]);
        const frame = hull ? deriveOrientedSiteFrame(hull) : null;
        const cx = frame?.centerX ?? (minX + maxX) / 2, cy = frame?.centerY ?? (minY + maxY) / 2;
        const w = frame?.width ?? maxX - minX, h = frame?.height ?? maxY - minY;
        const transformElevation = zRange ? null : await worldTransformElevation(path);
        return { centerX: cx, centerY: cy, siteWidth: w, siteHeight: h,
                 siteAreaM2: detectIsGeographic(cx, cy, w) ? 0 : Math.abs(signedPolygonArea(hull ?? [])) || w * h,
                 rotationRad: frame?.rotationRad ?? 0,
                 baseElevation: zRange?.minZ ?? transformElevation ?? 0,
                 sourcePath: path,
                 source: `${sourceLabel}(${frame ? 'triangles-oriented' : 'triangles-axis-aligned'})`, elevationPolicy,
                 isGeographic: detectIsGeographic(cx, cy, w) };
      }
    }
  } catch { /* ignore */ }

  return null;
}

// Site bounds detection.
/**
 * Gets site bounds using this priority:
 *
 * 1. A selected path verified against the site_limit category.
 * 2. First available site_limit, then terrain element.
 * 3. null, which makes placement fall back to an origin-based default.
 */
interface SiteBoundsOptions {
  targetPath?: string;
  allowSelectedConstraint?: boolean;
}

interface SiteBoundsResolution {
  bounds: Bounds | null;
  failure?: {
    path: string;
    reason: 'unsupported_category' | 'geometry_unreadable' | 'category_lookup_failed';
  };
}

function exactMatchingPath(path: string, candidates: Set<string>): string | null {
  const normalized = path.split('/').filter(Boolean).join('/');
  for (const candidate of candidates) {
    if (candidate.split('/').filter(Boolean).join('/') === normalized) return candidate;
  }
  return null;
}

/** Matches only when the selected path is the category element or its descendant. */
function categoryPathAtOrAbove(path: string, candidates: Set<string>): string | null {
  const normalized = path.split('/').filter(Boolean).join('/');
  for (const candidate of candidates) {
    const normalizedCandidate = candidate.split('/').filter(Boolean).join('/');
    if (normalized === normalizedCandidate || normalized.startsWith(`${normalizedCandidate}/`)) return candidate;
  }
  return null;
}

async function getCategoryPathSet(category: string): Promise<Set<string>> {
  try {
    return new Set(await Forma.geometry.getPathsByCategory({ category }));
  } catch {
    return new Set();
  }
}

interface CategoryPathLookup {
  paths: Set<string>;
  ok: boolean;
}

async function getCategoryPathLookup(category: string): Promise<CategoryPathLookup> {
  try {
    return { paths: new Set(await Forma.geometry.getPathsByCategory({ category })), ok: true };
  } catch {
    return { paths: new Set(), ok: false };
  }
}

async function resolveSiteBounds(options: SiteBoundsOptions = {}): Promise<SiteBoundsResolution> {
  const explicitTargetPath = options.targetPath?.trim();
  const siteLimitPaths = await getCategoryPathSet('site_limit');

  if (explicitTargetPath) {
    const matchedSiteLimit = exactMatchingPath(explicitTargetPath, siteLimitPaths);
    if (matchedSiteLimit) {
      const bounds = await boundsFromPath(matchedSiteLimit, 'target site_limit');
      return bounds
        ? { bounds }
        : { bounds: null, failure: { path: explicitTargetPath, reason: 'geometry_unreadable' } };
    }

    const [terrainLookup, buildingLookup, buildingsLookup, roadLookup] = await Promise.all([
      getCategoryPathLookup('terrain'),
      getCategoryPathLookup('building'),
      getCategoryPathLookup('buildings'),
      getCategoryPathLookup('road'),
    ]);
    if ([terrainLookup, buildingLookup, buildingsLookup, roadLookup].some((lookup) => !lookup.ok)) {
      return { bounds: null, failure: { path: explicitTargetPath, reason: 'category_lookup_failed' } };
    }
    const isExcluded = Boolean(
      categoryPathAtOrAbove(explicitTargetPath, terrainLookup.paths)
      || categoryPathAtOrAbove(explicitTargetPath, buildingLookup.paths)
      || categoryPathAtOrAbove(explicitTargetPath, buildingsLookup.paths)
      || categoryPathAtOrAbove(explicitTargetPath, roadLookup.paths)
    );
    if (isExcluded) {
      return { bounds: null, failure: { path: explicitTargetPath, reason: 'unsupported_category' } };
    }

    // The selected path is the authoritative geometry reference. Never replace
    // its bounds, elevation, or yaw with a related parent/child category path.
    const exactBounds = await boundsFromPath(explicitTargetPath, 'target constraint', 'source_geometry');
    if (exactBounds) return { bounds: exactBounds };
    return { bounds: null, failure: { path: explicitTargetPath, reason: 'geometry_unreadable' } };
  }

  // Step 1: only accept selected paths verified as site limits. A selected
  // building or generic element must never silently become the site bounds.
  try {
    const selectedPaths = await Forma.selection.getSelection();

    if (selectedPaths.length > 0) {
      // Prefer selected paths that match the site_limit category.
      for (const selPath of selectedPaths) {
        const matchedPath = exactMatchingPath(selPath, siteLimitPaths);
        if (matchedPath) {
          const bounds = await boundsFromPath(matchedPath, 'selected site_limit');
          if (bounds) return { bounds };
        }
      }

      if (options.allowSelectedConstraint) {
        const [terrainLookup, buildingLookup, buildingsLookup, roadLookup] = await Promise.all([
          getCategoryPathLookup('terrain'),
          getCategoryPathLookup('building'),
          getCategoryPathLookup('buildings'),
          getCategoryPathLookup('road'),
        ]);
        if ([terrainLookup, buildingLookup, buildingsLookup, roadLookup].some((lookup) => !lookup.ok)) {
          const unresolvedPath = selectedPaths.find((path) => !exactMatchingPath(path, siteLimitPaths)) ?? selectedPaths[0];
          return { bounds: null, failure: { path: unresolvedPath, reason: 'category_lookup_failed' } };
        }
        let unreadableSelectionPath: string | undefined;
        for (const selPath of selectedPaths) {
          // A selected Site Limit was already handled above and keeps its
          // established category fallback behavior when unreadable.
          if (exactMatchingPath(selPath, siteLimitPaths)) continue;
          const isExcluded = Boolean(
            categoryPathAtOrAbove(selPath, terrainLookup.paths)
            || categoryPathAtOrAbove(selPath, buildingLookup.paths)
            || categoryPathAtOrAbove(selPath, buildingsLookup.paths)
            || categoryPathAtOrAbove(selPath, roadLookup.paths)
          );
          if (isExcluded) continue;

          const exactBounds = await boundsFromPath(selPath, 'selected constraint', 'source_geometry');
          if (exactBounds) return { bounds: exactBounds };
          unreadableSelectionPath ??= selPath;
        }
        if (unreadableSelectionPath) {
          return { bounds: null, failure: { path: unreadableSelectionPath, reason: 'geometry_unreadable' } };
        }
      }

    }
  } catch { /* continue to category fallback */ }

  // Step 2: use the first readable element from preferred categories.
  for (const category of ['site_limit', 'terrain']) {
    try {
      const paths = await Forma.geometry.getPathsByCategory({ category });
      if (!paths.length) continue;
      for (const path of paths) {
        const bounds = await boundsFromPath(path, category);
        if (bounds) return { bounds };
      }
    } catch { continue; }
  }

  return { bounds: null };
}

async function meshContainsPoint(path: string, x: number, y: number): Promise<boolean> {
  try {
    const triangles = await Forma.geometry.getTriangles({ path });
    for (let index = 0; index + 8 < triangles.length; index += 9) {
      if (barycentricZAtPoint(
        x, y,
        triangles[index], triangles[index + 1], triangles[index + 2],
        triangles[index + 3], triangles[index + 4], triangles[index + 5],
        triangles[index + 6], triangles[index + 7], triangles[index + 8],
      ) !== null) return true;
    }
  } catch {
    // Unreadable geometry is not a valid elevation reference.
  }
  return false;
}

async function getElevationReferencePath(
  bounds?: Bounds | null,
  queryX = bounds?.centerX ?? 0,
  queryY = bounds?.centerY ?? 0,
): Promise<ElevationReference | null> {
  const accepts = async (path: string): Promise<boolean> =>
    !bounds || bounds.isGeographic || meshContainsPoint(path, queryX, queryY);
  try {
    const selectedPaths = await Forma.selection.getSelection();
    for (const selPath of selectedPaths) {
      try {
        const terrainPaths = await Forma.geometry.getPathsByCategory({ category: 'terrain' });
        const matched = terrainPaths.find((tp) => selPath === tp || selPath.startsWith(tp) || tp.startsWith(selPath));
        if (matched && await accepts(matched)) {
          return { path: matched, source: 'selected terrain' };
        }
      } catch {
        // ignore and continue fallback chain
      }
    }
  } catch {
    // ignore and continue fallback chain
  }

  for (const category of ['terrain']) {
    try {
      const paths = await Forma.geometry.getPathsByCategory({ category });
      for (const path of paths) {
        if (await accepts(path)) return { path, source: category };
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function getSiteBounds(options: SiteBoundsOptions = {}): Promise<Bounds | null> {
  return (await resolveSiteBounds(options)).bounds;
}

function signedPolygonArea(polygon: [number, number][]): number {
  if (polygon.length < 3) return 0;
  let sum = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[(index + 1) % polygon.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function normalizeSnapshotRing(value: unknown): [number, number][] | null {
  if (!Array.isArray(value)) return null;
  const points = value
    .filter((point): point is [number, number] =>
      Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])),
    )
    .map(([x, y]) => [Number(x), Number(y)] as [number, number]);
  if (points.length < 3) return null;
  const withoutClosingPoint = points.length > 3 &&
    points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]
    ? points.slice(0, -1)
    : points;
  return withoutClosingPoint.length >= 3 ? withoutClosingPoint : null;
}

function isRectangleRing(polygon: [number, number][]): boolean {
  if (polygon.length !== 4) return false;
  const xs = [...new Set(polygon.map(([x]) => x.toFixed(6)))];
  const ys = [...new Set(polygon.map(([, y]) => y.toFixed(6)))];
  return xs.length === 2 && ys.length === 2;
}

function snapshotPolygonKey(polygon: [number, number][]): string {
  return polygon.map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`).join('|');
}

/**
 * Captures the selected mass as floor-level outlines before regeneration.
 * Gross-floor-area polygons are element-local, so the original world transform
 * is retained alongside the local coordinates.
 */
async function captureMassSnapshot(path: string): Promise<MassSnapshotCapture> {
  const diagnostics: string[] = [`selected building path=${path}`];
  try {
    const [{ element }, { transform }] = await Promise.all([
      Forma.elements.getByPath({ path }),
      Forma.elements.getWorldTransform({ path }),
    ]);
    diagnostics.push(`element urn=${String(element.urn)}`);
    if (!element.representations?.grossFloorAreaPolygons) {
      diagnostics.push('selected building element does not advertise grossFloorAreaPolygons.');
      return { snapshot: await captureFootprintSnapshot(path, diagnostics), diagnostics };
    }
    const representation = await Forma.elements.representations.grossFloorAreaPolygons({ urn: element.urn });
    const rawFloors = representation?.data ?? [];
    diagnostics.push(`grossFloorAreaPolygons returned ${rawFloors.length} floor record(s).`);
    if (!rawFloors.length) return { snapshot: await captureFootprintSnapshot(path, diagnostics), diagnostics };

    const floors = rawFloors
      .map((entry: any) => {
        const rings = Array.isArray(entry?.grossFloorPolygon) ? entry.grossFloorPolygon : [];
        const outerPolygon = normalizeSnapshotRing(rings[0]);
        if (!outerPolygon) return null;
        const holes = rings.slice(1)
          .map(normalizeSnapshotRing)
          .filter((ring): ring is [number, number][] => Boolean(ring));
        return {
          elevationM: Number(entry?.elevation),
          outerPolygon: signedPolygonArea(outerPolygon) >= 0 ? outerPolygon : [...outerPolygon].reverse(),
          holes,
        };
      })
      .filter((floor): floor is { elevationM: number; outerPolygon: [number, number][]; holes: [number, number][][] } =>
        Number.isFinite(floor.elevationM),
      )
      .sort((a, b) => a.elevationM - b.elevationM);
    if (!floors.length) {
      diagnostics.push('grossFloorAreaPolygons records contained no valid polygon/elevation pairs.');
      return { snapshot: await captureFootprintSnapshot(path, diagnostics), diagnostics };
    }

    const snapshotFloors: MassSnapshotFloor[] = floors.map((floor, index) => {
      const nextElevation = floors[index + 1]?.elevationM;
      const heightM = Number.isFinite(nextElevation)
        ? Math.max(Number(nextElevation) - floor.elevationM, 0.01)
        : DEFAULT_FLOOR_HEIGHT_M;
      const outerArea = Math.abs(signedPolygonArea(floor.outerPolygon));
      const holeArea = floor.holes.reduce((sum, hole) => sum + Math.abs(signedPolygonArea(hole)), 0);
      return { ...floor, heightM, areaM2: Math.max(outerArea - holeArea, 0) };
    });
    const polygonKeys = new Set(snapshotFloors.map((floor) => snapshotPolygonKey(floor.outerPolygon)));

    const snapshot: MassSnapshot = {
      sourcePath: path,
      sourceUrn: String(element.urn),
      captureMode: 'gross-floor-area-polygons',
      worldTransform: Array.from(transform as unknown as number[]),
      floors: snapshotFloors,
      hasSetbacks: polygonKeys.size > 1,
      hasNonRectangularFootprints: snapshotFloors.some((floor) => !isRectangleRing(floor.outerPolygon)),
      hasHoles: snapshotFloors.some((floor) => floor.holes.length > 0),
    };
    _massSnapshots.set(path, snapshot);
    diagnostics.push(`captured ${snapshotFloors.length} valid gross-floor polygon(s).`);
    return { snapshot, diagnostics };
  } catch (err) {
    diagnostics.push(`gross-floor snapshot failed: ${describeError(err)}`);
    return { snapshot: await captureFootprintSnapshot(path, diagnostics), diagnostics };
  }
}

/**
 * Matches the original mass's floor outlines to the PDF floor order.
 *
 * A FloorStack plan can describe a different rectangular plan on every level,
 * but it cannot safely reproduce a hole, an angled outline, or a floor that
 * shifts sideways.  Those cases must remain untouched until a polygon-aware
 * room tiler is available.
 */
function floorEnvelopesFromSnapshot(
  snapshot: MassSnapshot | null,
  floorSpecs: FloorSpec[],
): { envelopes?: Map<string, FloorEnvelope>; error?: string } {
  if (!snapshot) {
    return { error: '층별 MassSnapshot을 읽지 못했습니다. 단일 외곽 경계 상자로 실배치를 추정하지 않고 기존 매스를 유지했습니다.' };
  }
  if (snapshot.captureMode !== 'gross-floor-area-polygons') {
    return { error: '층별 Gross Floor Area polygon을 읽지 못했습니다. 단일 footprint fallback으로는 층별 실배치를 재생성할 수 없어 기존 매스를 유지했습니다.' };
  }
  if (snapshot.hasNonRectangularFootprints || snapshot.hasHoles) {
    return { error: '선택 매스에 비사각형 외곽 또는 홀이 있습니다. 현재 실배치기는 이를 정확히 타일링할 수 없어 기존 매스를 유지했습니다.' };
  }
  if (snapshot.floors.length !== floorSpecs.length) {
    return {
      error:
        `기존 매스의 층별 외곽 수(${snapshot.floors.length})와 PDF 층 수(${floorSpecs.length})가 다릅니다. ` +
        '층을 임의로 대응시키지 않고 기존 매스를 유지했습니다.',
    };
  }

  const envelopes = new Map<string, FloorEnvelope>();
  let referenceCenter: { x: number; y: number } | null = null;
  for (let index = 0; index < floorSpecs.length; index++) {
    const polygon = snapshot.floors[index].outerPolygon;
    const xs = polygon.map(([x]) => x);
    const ys = polygon.map(([, y]) => y);
    const widthM = Math.max(...xs) - Math.min(...xs);
    const depthM = Math.max(...ys) - Math.min(...ys);
    const center = { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 };
    if (!Number.isFinite(widthM) || !Number.isFinite(depthM) || widthM <= 0 || depthM <= 0) {
      return { error: `${floorSpecs[index].label}의 층별 외곽 치수를 읽지 못했습니다. 기존 매스를 유지했습니다.` };
    }
    if (!referenceCenter) referenceCenter = center;
    if (Math.abs(center.x - referenceCenter.x) > 0.01 || Math.abs(center.y - referenceCenter.y) > 0.01) {
      return {
        error:
          '층별 외곽 중심이 서로 다릅니다. 현재 FloorStack 실배치기는 층별 수평 이동을 정확히 보존할 수 없어 기존 매스를 유지했습니다.',
      };
    }
    envelopes.set(floorSpecs[index].label, { widthM, depthM, areaM2: widthM * depthM });
  }

  return { envelopes };
}

/**
 * Uses source-authored room polygons as the geometry authority when an older
 * Basic Building cannot expose a FloorStack/GFA representation.  Every room
 * must be present: partial room sketches are not safe enough to replace a mass.
 */
function floorEnvelopesFromRoomPolygons(
  floorSpecs: FloorSpec[],
): { envelopes?: Map<string, FloorEnvelope>; error?: string } {
  const envelopes = new Map<string, FloorEnvelope>();
  for (const floor of floorSpecs) {
    if (!floorHasCompleteRoomPolygons(floor)) {
      return { error: `${floor.label}: 기존 Basic Building에 층별 외곽이 없으므로, 모든 실의 원본 polygon이 필요합니다.` };
    }
    const rooms = getRoomsWithFill(floor);
    const polygonAreas = rooms.map((room) => polygonAreaM2(sanitizeRoomPolygon(room.polygon)!));
    const declaredArea = rooms.reduce((sum, room) => sum + Number(room.area_m2), 0);
    const polygonArea = polygonAreas.reduce((sum, area) => sum + area, 0);
    const tolerance = Math.max(declaredArea * STRICT_ROOM_AREA_TOLERANCE_RATIO, STRICT_ROOM_AREA_TOLERANCE_M2);
    if (Math.abs(polygonArea - declaredArea) > tolerance) {
      return {
        error:
          `${floor.label}: 실 polygon 면적 합계 ${polygonArea.toFixed(2)}m2가 ` +
          `PDF 실면적 합계 ${declaredArea.toFixed(2)}m2와 일치하지 않습니다.`,
      };
    }
    if (Math.abs(polygonArea - floor.areaM2) > tolerance) {
      return {
        error:
          `${floor.label}: 실 polygon 면적 합계 ${polygonArea.toFixed(2)}m2가 ` +
          `층 면적 ${floor.areaM2.toFixed(2)}m2와 일치하지 않습니다.`,
      };
    }
    const points = rooms.flatMap((room) => sanitizeRoomPolygon(room.polygon)!);
    const bounds = polygonBounds(points);
    const widthM = bounds.maxX - bounds.minX;
    const depthM = bounds.maxY - bounds.minY;
    if (widthM <= 0 || depthM <= 0) {
      return { error: `${floor.label}: 원본 room polygon의 외곽 치수가 유효하지 않습니다.` };
    }
    envelopes.set(floor.label, { widthM, depthM, areaM2: polygonArea });
  }
  return { envelopes };
}

/**
 * Last-resort, but still area-accurate, path for legacy Basic Buildings.
 * It deliberately rebuilds the FloorStack from the PDF's floor program rather
 * than pretending that a missing Basic Building footprint is authoritative.
 */
function floorEnvelopesFromPdfProgram(
  floorSpecs: FloorSpec[],
): { envelopes?: Map<string, FloorEnvelope>; warnings: string[]; error?: string } {
  const envelopes = new Map<string, FloorEnvelope>();
  const warnings: string[] = [];
  for (const floor of floorSpecs) {
    const roomArea = getRoomsWithFill(floor)
      .reduce((sum, room) => sum + Number(room.area_m2), 0);
    const declaredFloorArea = Number(floor.areaM2);
    const programArea = Math.max(declaredFloorArea, roomArea);
    if (!Number.isFinite(programArea) || programArea <= 0) {
      return { warnings, error: `${floor.label}: PDF에 층 면적 또는 실 면적이 없어 새 FloorStack 외곽을 만들 수 없습니다.` };
    }
    const tolerance = Math.max(programArea * STRICT_ROOM_AREA_TOLERANCE_RATIO, STRICT_ROOM_AREA_TOLERANCE_M2);
    if (roomArea > declaredFloorArea + tolerance) {
      warnings.push(
        `${floor.label}: PDF 실면적 합계 ${roomArea.toFixed(2)}m2가 층 면적 ${declaredFloorArea.toFixed(2)}m2보다 커서, ` +
        `실면적 합계로 새 층 외곽을 만들었습니다.`,
      );
    }
    const explicitWidth = Number(floor.footprintWidthM);
    const explicitDepth = Number(floor.footprintDepthM);
    const explicitArea = explicitWidth * explicitDepth;
    const canUseExplicitDimensions = Number.isFinite(explicitArea) && explicitArea > 0 &&
      Math.abs(explicitArea - programArea) <= tolerance;
    const dimensions = canUseExplicitDimensions
      ? { w: explicitWidth, d: explicitDepth }
      : areaToRect(programArea);
    envelopes.set(floor.label, { widthM: dimensions.w, depthM: dimensions.d, areaM2: programArea });
  }
  return { envelopes, warnings };
}

function normalizeElementPath(path: string): string {
  return path.split('/').filter(Boolean).join('/');
}

function pathsAreEquivalentOrAncestor(left: string, right: string): boolean {
  const normalizedLeft = normalizeElementPath(left);
  const normalizedRight = normalizeElementPath(right);
  if (!normalizedLeft || !normalizedRight) return normalizedLeft === normalizedRight;
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}/`)
    || normalizedRight.startsWith(`${normalizedLeft}/`);
}

function pathMatchesAny(path: string, candidates: Set<string>): boolean {
  for (const candidate of candidates) {
    if (pathsAreEquivalentOrAncestor(path, candidate)) return true;
  }
  return false;
}

async function getBuildingLayerPaths(): Promise<string[]> {
  const paths = new Set<string>();
  for (const category of ['building', 'buildings']) {
    try {
      const categoryPaths = await Forma.geometry.getPathsByCategory({ category });
      for (const path of categoryPaths) paths.add(path);
    } catch {
      // Forma SDK/category naming differs between contexts; try the next alias.
    }
  }
  return Array.from(paths);
}

export interface VisibleBuildingMeshEvidence {
  centerX: number;
  centerY: number;
  minZ: number;
  maxZ: number;
  widthM: number;
  depthM: number;
  heightM: number;
  horizontalAreaM2: number;
  triangleCount: number;
  coordinateFrame: 'world' | 'local_transformed';
  closedTriangleBoundaries: boolean;
  nonDegenerateTriangles: number;
}

export type BuildingMeshFailureReason =
  | 'mesh_empty'
  | 'mesh_invalid_coordinates'
  | 'mesh_degenerate'
  | 'mesh_flat'
  | 'height_mismatch'
  | 'elevation_mismatch'
  | 'position_mismatch'
  | 'mesh_unreadable';

interface MeshGeometryAnalysis {
  centerX: number;
  centerY: number;
  minZ: number;
  maxZ: number;
  widthM: number;
  depthM: number;
  heightM: number;
  horizontalAreaM2: number;
  triangleCount: number;
  closedTriangleBoundaries: boolean;
  nonDegenerateTriangles: number;
}

export interface BuildingMeshInspection {
  evidence: VisibleBuildingMeshEvidence | null;
  failureReason: BuildingMeshFailureReason | null;
  triangleCount: number;
  raw: MeshGeometryAnalysis | null;
  transformed: MeshGeometryAnalysis | null;
}

function analyzeBuildingMeshGeometry(triangles: ArrayLike<number>): {
  analysis: MeshGeometryAnalysis | null;
  failureReason: BuildingMeshFailureReason | null;
} {
  const triangleCount = triangles?.length && triangles.length % 9 === 0 ? triangles.length / 9 : 0;
  if (!triangles || triangles.length < 36 || triangles.length % 9 !== 0) {
    return { analysis: null, failureReason: 'mesh_empty' };
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let nonDegenerateTriangles = 0;
  const edgeCounts = new Map<string, number>();
  const vertexKey = (x: number, y: number, z: number): string =>
    [x, y, z]
      .map((value) => (Math.abs(value) < 0.00005 ? 0 : value).toFixed(4))
      .join(',');
  const addEdge = (left: string, right: string): void => {
    const key = left < right ? `${left}|${right}` : `${right}|${left}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  };

  for (let index = 0; index < triangles.length; index += 9) {
    const values = Array.from({ length: 9 }, (_, offset) => Number(triangles[index + offset]));
    if (values.some((value) => !Number.isFinite(value))) {
      return { analysis: null, failureReason: 'mesh_invalid_coordinates' };
    }

    for (let vertex = 0; vertex < 3; vertex += 1) {
      const x = values[vertex * 3];
      const y = values[vertex * 3 + 1];
      const z = values[vertex * 3 + 2];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }

    const abx = values[3] - values[0];
    const aby = values[4] - values[1];
    const abz = values[5] - values[2];
    const acx = values[6] - values[0];
    const acy = values[7] - values[1];
    const acz = values[8] - values[2];
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    if (crossX * crossX + crossY * crossY + crossZ * crossZ > 1e-8) nonDegenerateTriangles += 1;

    const keys = [
      vertexKey(values[0], values[1], values[2]),
      vertexKey(values[3], values[4], values[5]),
      vertexKey(values[6], values[7], values[8]),
    ];
    addEdge(keys[0], keys[1]);
    addEdge(keys[1], keys[2]);
    addEdge(keys[2], keys[0]);
  }

  const widthM = maxX - minX;
  const depthM = maxY - minY;
  const heightM = maxZ - minZ;
  const horizontalAreaM2 = widthM * depthM;
  const closedTriangleBoundaries = edgeCounts.size >= 6
    && Array.from(edgeCounts.values()).every((count) => count >= 2 && count % 2 === 0);
  const analysis: MeshGeometryAnalysis = {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    minZ,
    maxZ,
    widthM,
    depthM,
    heightM,
    horizontalAreaM2,
    triangleCount,
    closedTriangleBoundaries,
    nonDegenerateTriangles,
  };
  if (nonDegenerateTriangles < 4) return { analysis, failureReason: 'mesh_degenerate' };
  if (widthM < 0.5 || depthM < 0.5 || heightM < 0.5 || horizontalAreaM2 < 1) {
    return { analysis, failureReason: 'mesh_flat' };
  }
  return { analysis, failureReason: null };
}

function transformTriangleCoordinates(
  triangles: ArrayLike<number>,
  transform: ArrayLike<number>,
): Float64Array | null {
  const matrix = Array.from(transform ?? []);
  if (matrix.length !== 16 || matrix.some((value) => !Number.isFinite(value))) return null;
  const transformed = new Float64Array(triangles.length);
  for (let index = 0; index + 2 < triangles.length; index += 3) {
    const x = Number(triangles[index]);
    const y = Number(triangles[index + 1]);
    const z = Number(triangles[index + 2]);
    if (![x, y, z].every(Number.isFinite)) return null;
    transformed[index] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    transformed[index + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    transformed[index + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  }
  return transformed;
}

function placementFailureReason(
  analysis: MeshGeometryAnalysis,
  expected: { x: number; y: number; z: number; heightM: number },
): BuildingMeshFailureReason | null {
  const expectedHeight = Number(expected.heightM);
  if (!Number.isFinite(expectedHeight) || expectedHeight <= 0) return 'height_mismatch';
  const heightToleranceM = Math.max(1, expectedHeight * 0.15);
  if (analysis.heightM < Math.max(0.5, expectedHeight * 0.5)
    || Math.abs(analysis.heightM - expectedHeight) > heightToleranceM) return 'height_mismatch';

  const elevationToleranceM = Math.max(1, expectedHeight * 0.1);
  if (Math.abs(analysis.minZ - expected.z) > elevationToleranceM) return 'elevation_mismatch';

  const horizontalToleranceM = Math.max(2, Math.max(analysis.widthM, analysis.depthM) * 0.35);
  if (Math.hypot(analysis.centerX - expected.x, analysis.centerY - expected.y) > horizontalToleranceM) {
    return 'position_mismatch';
  }
  return null;
}

function placementErrorScore(
  analysis: MeshGeometryAnalysis,
  expected: { x: number; y: number; z: number; heightM: number },
): number {
  const heightToleranceM = Math.max(1, expected.heightM * 0.15);
  const elevationToleranceM = Math.max(1, expected.heightM * 0.1);
  const horizontalToleranceM = Math.max(2, Math.max(analysis.widthM, analysis.depthM) * 0.35);
  return Math.abs(analysis.heightM - expected.heightM) / heightToleranceM
    + Math.abs(analysis.minZ - expected.z) / elevationToleranceM
    + Math.hypot(analysis.centerX - expected.x, analysis.centerY - expected.y) / horizontalToleranceM;
}

export function inspectVisibleBuildingMesh(
  triangles: ArrayLike<number>,
  expected: { x: number; y: number; z: number; heightM: number },
  worldTransform?: ArrayLike<number>,
): BuildingMeshInspection {
  const rawResult = analyzeBuildingMeshGeometry(triangles);
  const triangleCount = triangles?.length && triangles.length % 9 === 0 ? triangles.length / 9 : 0;
  if (!rawResult.analysis || rawResult.failureReason) {
    return {
      evidence: null,
      failureReason: rawResult.failureReason ?? 'mesh_unreadable',
      triangleCount,
      raw: rawResult.analysis,
      transformed: null,
    };
  }

  const rawFailure = placementFailureReason(rawResult.analysis, expected);
  if (!rawFailure) {
    return {
      evidence: { ...rawResult.analysis, coordinateFrame: 'world' },
      failureReason: null,
      triangleCount,
      raw: rawResult.analysis,
      transformed: null,
    };
  }

  const transformedTriangles = worldTransform
    ? transformTriangleCoordinates(triangles, worldTransform)
    : null;
  const transformedResult = transformedTriangles
    ? analyzeBuildingMeshGeometry(transformedTriangles)
    : { analysis: null, failureReason: null };
  if (transformedResult.analysis && !transformedResult.failureReason) {
    const transformedFailure = placementFailureReason(transformedResult.analysis, expected);
    if (!transformedFailure) {
      return {
        evidence: { ...transformedResult.analysis, coordinateFrame: 'local_transformed' },
        failureReason: null,
        triangleCount,
        raw: rawResult.analysis,
        transformed: transformedResult.analysis,
      };
    }
    const preferTransformed = placementErrorScore(transformedResult.analysis, expected)
      < placementErrorScore(rawResult.analysis, expected);
    return {
      evidence: null,
      failureReason: preferTransformed ? transformedFailure : rawFailure,
      triangleCount,
      raw: rawResult.analysis,
      transformed: transformedResult.analysis,
    };
  }

  return {
    evidence: null,
    failureReason: rawFailure,
    triangleCount,
    raw: rawResult.analysis,
    transformed: transformedResult.analysis,
  };
}

/**
 * Verifies that SDK geometry is a finite 3D volume at the requested world
 * placement. A footprint or a single triangle is not evidence that Forma has
 * produced a visible building mass.
 */
export function validateVisibleBuildingMesh(
  triangles: ArrayLike<number>,
  expected: { x: number; y: number; z: number; heightM: number },
  worldTransform?: ArrayLike<number>,
): VisibleBuildingMeshEvidence | null {
  return inspectVisibleBuildingMesh(triangles, expected, worldTransform).evidence;
}

async function getVisibleBuildingMeshInspection(
  path: string,
  expected: { x: number; y: number; z: number; heightM: number },
  worldTransform?: ArrayLike<number>,
): Promise<BuildingMeshInspection> {
  try {
    const triangles = await Forma.geometry.getTriangles({ path });
    return inspectVisibleBuildingMesh(triangles, expected, worldTransform);
  } catch {
    return {
      evidence: null,
      failureReason: 'mesh_unreadable',
      triangleCount: 0,
      raw: null,
      transformed: null,
    };
  }
}

async function findExistingMassForFloorPlanRegeneration(): Promise<{ ok: boolean; evidence?: string; path?: string; error?: string }> {
  const confirmedSessionPath = Array.from(_elementPaths).find((path) => !_unconfirmedElementPaths.has(path));
  if (confirmedSessionPath) {
    return { ok: true, evidence: 'generated FloorStack mass in current session', path: confirmedSessionPath };
  }

  const buildingPaths = await getBuildingLayerPaths();

  if (buildingPaths.length > 0) {
    try {
      const selectedPaths = await Forma.selection.getSelection();
      const buildingPathSet = new Set(buildingPaths);
      for (const selectedPath of selectedPaths) {
        if (!pathMatchesAny(selectedPath, buildingPathSet)) continue;
        const matchedPath = buildingPaths.find((path) => pathMatchesAny(selectedPath, new Set([path]))) ?? selectedPath;
        return { ok: true, evidence: 'selected existing building mass', path: matchedPath };
      }
    } catch {
      // Continue with unambiguous building fallback below.
    }

    if (buildingPaths.length === 1) {
      return { ok: true, evidence: 'single existing building mass in proposal', path: buildingPaths[0] };
    }

    if (buildingPaths.length > 1) {
      return {
        ok: false,
        error: `프로젝트에 실제 매스가 ${buildingPaths.length}개 있습니다. 실배치 포함 재생성 대상 매스 1개를 선택한 뒤 다시 실행하세요.`,
      };
    }
  }

  return {
    ok: false,
    error: '실배치 포함 재생성에 사용할 실제 Buildings layer 매스를 찾지 못했습니다. 먼저 매스 생성이 실제 3D 매스를 만들었는지 확인한 뒤 다시 실행하세요.',
  };
}

async function isBuildingLayerElement(path: string): Promise<boolean> {
  const buildingPaths = await getBuildingLayerPaths();
  const normalizedPath = normalizeElementPath(path);
  return buildingPaths.some((candidate) => {
    const normalizedCandidate = normalizeElementPath(candidate);
    return normalizedCandidate === normalizedPath || normalizedCandidate.startsWith(`${normalizedPath}/`);
  });
}

async function isNonVirtualElement(path: string): Promise<boolean> {
  try {
    const normalizedPath = normalizeElementPath(path);
    const virtualPaths = await Forma.geometry.getPathsForVirtualElements();
    return !virtualPaths.some((candidate) => {
      const normalizedCandidate = normalizeElementPath(candidate);
      return normalizedCandidate === normalizedPath || normalizedCandidate.startsWith(`${normalizedPath}/`);
    });
  } catch {
    // Confirmation is deliberately fail-closed: if Forma cannot prove the
    // generated element is non-virtual, it must not be reported as a real mass.
    return false;
  }
}

export function evaluateBuildingPlacementConfirmation(input: {
  inBuildingLayer: boolean;
  hasVisibleVolume: boolean;
  worldTransformValid: boolean;
  nonVirtual: boolean;
}): boolean {
  return input.inBuildingLayer && input.hasVisibleVolume && input.worldTransformValid && input.nonVirtual;
}

function isExpectedPlacementTransform(
  transform: unknown,
  expected: { x: number; y: number; z: number; rotationRad?: number },
): boolean {
  const values = Array.from(transform as ArrayLike<number> ?? []);
  if (values.length !== 16 || values.some((value) => !Number.isFinite(value))) return false;

  // Forma matrices are column-major; the final column is the world translation.
  // Keep a small tolerance for SDK serialization and proposal/world-frame rounding.
  const horizontalToleranceM = 0.05;
  const verticalToleranceM = 0.05;
  const translationValid = Math.abs(values[12] - expected.x) <= horizontalToleranceM
    && Math.abs(values[13] - expected.y) <= horizontalToleranceM
    && Math.abs(values[14] - expected.z) <= verticalToleranceM;
  if (!translationValid || expected.rotationRad === undefined) return translationValid;

  const cos = Math.cos(expected.rotationRad);
  const sin = Math.sin(expected.rotationRad);
  const rotationTolerance = 0.02;
  return Math.abs(values[0] - cos) <= rotationTolerance
    && Math.abs(values[1] - sin) <= rotationTolerance
    && Math.abs(values[4] + sin) <= rotationTolerance
    && Math.abs(values[5] - cos) <= rotationTolerance;
}

async function getWorldTransformEvidence(
  path: string,
  expected: { x: number; y: number; z: number; rotationRad?: number },
): Promise<{ valid: boolean; actualZ: number; transform: number[] } | null> {
  try {
    const { transform } = await Forma.elements.getWorldTransform({ path });
    const values = Array.from(transform as ArrayLike<number> ?? []);
    if (values.length !== 16 || !Number.isFinite(values[14])) return null;
    return {
      valid: isExpectedPlacementTransform(transform, expected),
      actualZ: Number(values[14]),
      transform: values,
    };
  } catch {
    return null;
  }
}

interface BuildingPlacementConfirmationEvidence {
  confirmed: boolean;
  persisted: boolean;
  buildingLayer: boolean;
  visibleVolume: boolean;
  worldTransform: boolean;
  nonVirtual: boolean;
  actualTransformZ: number | null;
  meshFailureReason: BuildingMeshFailureReason | null;
  meshInspection: BuildingMeshInspection | null;
}

async function waitForBuildingLayerElement(
  path: string,
  expected: { x: number; y: number; z: number; rotationRad?: number; heightM: number },
): Promise<BuildingPlacementConfirmationEvidence> {
  try {
    await withTimeout(
      Forma.proposal.awaitProposalPersisted(),
      BUILDING_PERSIST_TIMEOUT_MS,
      'Timed out while waiting for the proposal to persist before building confirmation.',
    );
  } catch {
    return {
      confirmed: false,
      persisted: false,
      buildingLayer: false,
      visibleVolume: false,
      worldTransform: false,
      nonVirtual: false,
      actualTransformZ: null,
      meshFailureReason: 'mesh_unreadable',
      meshInspection: null,
    };
  }

  try {
    await Forma.render.unhideElement({ path });
  } catch {
    // Rendering visibility is still checked indirectly through the volume mesh.
  }

  // Persistence can complete before the geometry/category indexes become readable.
  let lastEvidence: BuildingPlacementConfirmationEvidence = {
    confirmed: false,
    persisted: true,
    buildingLayer: false,
    visibleVolume: false,
    worldTransform: false,
    nonVirtual: false,
    actualTransformZ: null,
    meshFailureReason: 'mesh_unreadable',
    meshInspection: null,
  };
  for (let attempt = 0; attempt < BUILDING_INDEX_ATTEMPTS; attempt += 1) {
    const [inBuildingLayer, transformEvidence, nonVirtual] = await Promise.all([
      isBuildingLayerElement(path),
      getWorldTransformEvidence(path, expected),
      isNonVirtualElement(path),
    ]);
    const meshInspection = await getVisibleBuildingMeshInspection(
      path,
      expected,
      transformEvidence?.transform,
    );
    const visibleMesh = meshInspection.evidence;
    const worldTransformValid = transformEvidence?.valid === true;
    lastEvidence = {
      confirmed: evaluateBuildingPlacementConfirmation({
        inBuildingLayer,
        hasVisibleVolume: Boolean(visibleMesh),
        worldTransformValid,
        nonVirtual,
      }),
      persisted: true,
      buildingLayer: inBuildingLayer,
      visibleVolume: Boolean(visibleMesh),
      worldTransform: worldTransformValid,
      nonVirtual,
      actualTransformZ: transformEvidence?.actualZ ?? null,
      meshFailureReason: meshInspection.failureReason,
      meshInspection,
    };
    if (lastEvidence.confirmed) return lastEvidence;
    await new Promise((resolve) => setTimeout(resolve, BUILDING_INDEX_POLL_INTERVAL_MS));
  }
  return lastEvidence;
}

function summarizeMeshAnalysis(label: string, analysis: MeshGeometryAnalysis | null): string {
  if (!analysis) return `${label}=none`;
  return `${label}[triangles=${analysis.triangleCount}, center=(${analysis.centerX.toFixed(1)},${analysis.centerY.toFixed(1)}), `
    + `z=${analysis.minZ.toFixed(1)}..${analysis.maxZ.toFixed(1)}, size=${analysis.widthM.toFixed(1)}x${analysis.depthM.toFixed(1)}x${analysis.heightM.toFixed(1)}, `
    + `closed=${analysis.closedTriangleBoundaries}]`;
}

function describeBuildingConfirmationFailure(evidence: {
  persisted: boolean;
  buildingLayer: boolean;
  visibleVolume: boolean;
  worldTransform: boolean;
  nonVirtual: boolean;
  meshFailureReason?: BuildingMeshFailureReason | null;
  meshInspection?: BuildingMeshInspection | null;
}): string {
  const meshDetail = evidence.meshInspection
    ? `${evidence.meshFailureReason ?? 'unknown'}; ${summarizeMeshAnalysis('raw', evidence.meshInspection.raw)}; `
      + summarizeMeshAnalysis('world', evidence.meshInspection.transformed)
    : evidence.meshFailureReason ?? 'unknown';
  const failed = [
    !evidence.persisted ? 'proposal persistence' : '',
    !evidence.buildingLayer ? 'Buildings layer registration' : '',
    !evidence.visibleVolume ? `finite visible 3D volume at the requested site position (${meshDetail})` : '',
    !evidence.worldTransform ? 'world transform' : '',
    !evidence.nonVirtual ? 'non-virtual element state' : '',
  ].filter(Boolean);
  return failed.length > 0 ? failed.join(', ') : 'unknown confirmation condition';
}

async function removeUnconfirmedProposalElement(path: string): Promise<boolean> {
  try {
    await Forma.proposal.removeElement({ path });
    _elementPaths.delete(path);
    _unconfirmedElementPaths.delete(path);
    return true;
  } catch {
    // Retain cleanup failures so clearAllMasses can retry without treating them as confirmed.
    _elementPaths.add(path);
    _unconfirmedElementPaths.add(path);
    return false;
  }
}

async function waitForElementInCategories(path: string, categories: string[]): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    for (const category of categories) {
      try {
        const categoryPaths = await Forma.geometry.getPathsByCategory({ category });
        if (pathMatchesAny(path, new Set(categoryPaths))) return true;
      } catch {
        // Try the next category/attempt.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function waitForProposalPath(path: string, categories: string[] = []): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await Forma.elements.getByPath({ path });
      return true;
    } catch {
      // Some generic elements are not indexed for geometry queries immediately.
    }

    if (categories.length > 0 && await waitForElementInCategories(path, categories)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

// Geometry helpers.
function areaToRect(area: number, ratio = 1.5): { w: number; d: number } {
  const d = Math.sqrt(area / ratio);
  return { w: d * ratio, d };
}

function resolveLayoutDimensions(floor: FloorSpec): { w: number; d: number } {
  const ew = Number(floor.envelopeWidthM);
  const ed = Number(floor.envelopeDepthM);
  if (Number.isFinite(ew) && Number.isFinite(ed) && ew > 0 && ed > 0) {
    return { w: ew, d: ed };
  }
  return areaToRect(effectivePlanAreaM2(floor));
}

function coreTemplateArea(template?: CoreTemplate): number {
  const area = Number(template?.width_m) * Number(template?.depth_m);
  return Number.isFinite(area) && area > 0 ? area : 0;
}

function effectivePlanAreaM2(floor: FloorSpec): number {
  return massFootprintAreaM2(floor);
}

function massFootprintAreaM2(floor: FloorSpec): number {
  const declaredArea = Math.max(Number(floor.areaM2) || 0, 1);
  const envelopeArea = Number(floor.envelopeWidthM) * Number(floor.envelopeDepthM);
  if (Number.isFinite(envelopeArea) && envelopeArea > 0) return envelopeArea;

  const explicitArea = Number(floor.footprintWidthM) * Number(floor.footprintDepthM);
  if (Number.isFinite(explicitArea) && explicitArea > 0) {
    const mismatch = Math.abs(explicitArea - declaredArea) / Math.max(declaredArea, 1);
    if (mismatch <= 0.05) return explicitArea;
  }

  return declaredArea;
}

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

  const offsetX = Number(template.offset_x_m);
  const offsetY = Number(template.offset_y_m);
  const rawCenterX = Number(template.center_x_m);
  const rawCenterY = Number(template.center_y_m);
  if (Number.isFinite(rawCenterX) && Number.isFinite(rawCenterY)) {
    const looksLikeLowerLeftOrigin =
      rawCenterX >= 0 &&
      rawCenterY >= 0 &&
      rawCenterX <= width + 0.01 &&
      rawCenterY <= depth + 0.01 &&
      (rawCenterX >= width / 2 - 0.01 || rawCenterY >= depth / 2 - 0.01);
    if (looksLikeLowerLeftOrigin) {
      return { cx: rawCenterX - width / 2, cy: rawCenterY - depth / 2 };
    }
    if (Math.abs(rawCenterX) <= width / 2 + 0.01 && Math.abs(rawCenterY) <= depth / 2 + 0.01) {
      return { cx: rawCenterX, cy: rawCenterY };
    }
  }

  if (template.fixed_across_floors && Number.isFinite(offsetX) && Number.isFinite(offsetY)) {
    const looksLikeLowerLeftOrigin =
      offsetX >= 0 &&
      offsetY >= 0 &&
      offsetX <= width + 0.01 &&
      offsetY <= depth + 0.01 &&
      (offsetX >= width / 2 - 0.01 || offsetY >= depth / 2 - 0.01);
    if (looksLikeLowerLeftOrigin) {
      return { cx: offsetX - width / 2, cy: offsetY - depth / 2 };
    }
    return { cx: offsetX, cy: offsetY };
  }

  if (template.fixed_across_floors) {
    return fromPosition();
  }

  return {
    cx: Number.isFinite(offsetX) ? offsetX : 0,
    cy: Number.isFinite(offsetY) ? offsetY : 0,
  };
}

function resolveFixedCoreBounds(
  template: CoreTemplate,
  width: number,
  depth: number,
  coreWidth: number,
  coreDepth: number,
): { x0: number; x1: number; y0: number; y1: number } {
  const center = resolveCoreCenter(template, width, depth);

  return {
    x0: center.cx - coreWidth / 2,
    x1: center.cx + coreWidth / 2,
    y0: center.cy - coreDepth / 2,
    y1: center.cy + coreDepth / 2,
  };
}

function effectiveRoomAreaForSpec(spec: FloorSpec): number {
  const rooms = Array.isArray(spec.rooms) ? spec.rooms : [];
  if (!rooms.length) return spec.areaM2;

  return rooms.reduce((sum, room) => {
    const area = Number(room.area_m2) || 0;
    return sum + area;
  }, 0);
}

function applyEnvelopeGroup(
  specs: FloorSpec[],
  refFootprintWidth?: number,
  refFootprintDepth?: number,
): void {
  if (!specs.length) return;

  const hasReferenceFootprint =
    Number.isFinite(Number(refFootprintWidth)) &&
    Number.isFinite(Number(refFootprintDepth)) &&
    Number(refFootprintWidth) > 0 &&
    Number(refFootprintDepth) > 0;
  const referenceAspect = hasReferenceFootprint
    ? Number(refFootprintWidth) / Number(refFootprintDepth)
    : 1.5;
  for (const spec of specs) {
    const floorArea = Math.max(effectivePlanAreaM2(spec), 1);
    const explicitW = Number(spec.footprintWidthM);
    const explicitD = Number(spec.footprintDepthM);
    let final: { w: number; d: number };

    if (Number.isFinite(explicitW) && explicitW > 0 && Number.isFinite(explicitD) && explicitD > 0) {
      const product = explicitW * explicitD;
      const mismatch = Math.abs(product - floorArea) / floorArea;
      if (mismatch <= 0.05) {
        final = { w: explicitW, d: explicitD };
      } else {
        const aspect = explicitW / explicitD;
        const d = Math.sqrt(floorArea / aspect);
        final = { w: floorArea / d, d };
      }
    } else {
      const d = Math.sqrt(floorArea / referenceAspect);
      final = { w: floorArea / d, d };
    }

    spec.envelopeWidthM = final.w;
    spec.envelopeDepthM = final.d;
    spec.refFootprintWidthM = refFootprintWidth;
    spec.refFootprintDepthM = refFootprintDepth;
  }
}

function applyCommonEnvelope(specs: FloorSpec[]): void {
  if (!specs.length) return;

  const areas = specs.map((spec) => effectivePlanAreaM2(spec)).filter((area) => Number.isFinite(area) && area > 0);
  if (areas.length !== specs.length) return;
  const minArea = Math.min(...areas);
  const maxArea = Math.max(...areas);
  if ((maxArea - minArea) / Math.max(maxArea, 1) > 0.01) return;

  const maxWidth = Math.max(...specs.map((spec) => Number(spec.envelopeWidthM) || 0));
  const maxDepth = Math.max(...specs.map((spec) => Number(spec.envelopeDepthM) || 0));
  if (!Number.isFinite(maxWidth) || !Number.isFinite(maxDepth) || maxWidth <= 0 || maxDepth <= 0) return;
  const aspect = maxWidth / maxDepth;

  for (const spec of specs) {
    const area = Math.max(effectivePlanAreaM2(spec), 1);
    const depth = Math.sqrt(area / aspect);
    spec.envelopeWidthM = area / depth;
    spec.envelopeDepthM = depth;
  }
}

function expandEnvelopeForFixedCoreCoordinates(specs: FloorSpec[]): void {
  for (const spec of specs) {
    const template = spec.coreTemplate;
    if (!template) continue;

    const templatePolygon = (template as CoreTemplate & { polygon?: [number, number][] }).polygon;
    const polygon = sanitizeRoomPolygon(templatePolygon);
    const bounds = polygon ? polygonBounds(polygon) : null;
    const rawCenterX = Number(template.center_x_m);
    const rawCenterY = Number(template.center_y_m);
    const templateWidth = Number(template.width_m);
    const templateDepth = Number(template.depth_m);
    const hasExplicitCenter = Number.isFinite(rawCenterX) && Number.isFinite(rawCenterY);
    const currentWidth = Number(spec.envelopeWidthM) || 0;
    const currentDepth = Number(spec.envelopeDepthM) || 0;
    const resolvedCenter =
      hasExplicitCenter && currentWidth > 0 && currentDepth > 0
        ? resolveCoreCenter(template, currentWidth, currentDepth)
        : null;
    const requiredCoreWidth =
      hasExplicitCenter && Number.isFinite(templateWidth)
        ? Math.abs(resolvedCenter?.cx ?? rawCenterX) + templateWidth / 2
        : Math.max(Math.abs(bounds?.minX ?? 0), Math.abs(bounds?.maxX ?? 0));
    const requiredCoreDepth =
      hasExplicitCenter && Number.isFinite(templateDepth)
        ? Math.abs(resolvedCenter?.cy ?? rawCenterY) + templateDepth / 2
        : Math.max(Math.abs(bounds?.minY ?? 0), Math.abs(bounds?.maxY ?? 0));
    const minEnvelopeWidth = requiredCoreWidth * 2;
    const minEnvelopeDepth = requiredCoreDepth * 2;
    const area = Math.max(effectivePlanAreaM2(spec), 1);

    if (minEnvelopeWidth * minEnvelopeDepth > area + 0.01) continue;

    const coreWidth = Math.max(Number(templateWidth) || 0, bounds ? bounds.maxX - bounds.minX : 0, 1);
    const coreDepth = Math.max(Number(templateDepth) || 0, bounds ? bounds.maxY - bounds.minY : 0);
    const roomAreasForZoneTargets = spec.rooms
      .filter((room) => normalizeUnitType(room) !== 'CORE')
      .map((room) => Number(room.area_m2) || 0)
      .filter((roomArea) => roomArea >= 100 && roomArea <= 250);
    const targetSmallZoneArea = roomAreasForZoneTargets.length > 0 ? Math.max(...roomAreasForZoneTargets) : 0;
    const desiredTopClearance = Math.max(2, coreDepth * 0.25, targetSmallZoneArea / coreWidth);
    const desiredDepth = Math.min(area / Math.max(minEnvelopeWidth, 1), minEnvelopeDepth + desiredTopClearance);
    const targetDepth = Math.max(minEnvelopeDepth, desiredDepth);
    const targetWidth = area / targetDepth;

    if (targetWidth + 0.01 >= minEnvelopeWidth) {
      spec.envelopeDepthM = targetDepth;
      spec.envelopeWidthM = targetWidth;
    }

    if (
      (minEnvelopeWidth > currentWidth + 0.01 || minEnvelopeDepth > currentDepth + 0.01) &&
      (Number(spec.envelopeWidthM) || 0) + 0.01 < minEnvelopeWidth
    ) {
      spec.envelopeWidthM = minEnvelopeWidth;
      spec.envelopeDepthM = area / minEnvelopeWidth;
    }

    if (targetSmallZoneArea > 0) {
      const maxDepth = area / Math.max(minEnvelopeWidth, 1);
      for (let depth = Number(spec.envelopeDepthM) || currentDepth || minEnvelopeDepth; depth <= maxDepth + 0.001; depth += 0.25) {
        const width = area / depth;
        const coreResult = createCoreSliceForExactLayout(spec, normalizeRoomsForPlanArea(spec, spec.rooms), width, depth);
        if (!coreResult) continue;
        const topArea = Math.max(0, (coreResult.coreSlice.x1 - coreResult.coreSlice.x0) * (depth / 2 - coreResult.coreSlice.y1));
        const bottomArea = Math.max(0, (coreResult.coreSlice.x1 - coreResult.coreSlice.x0) * (coreResult.coreSlice.y0 + depth / 2));
        if (topArea + 0.5 >= targetSmallZoneArea && bottomArea + 0.5 >= targetSmallZoneArea) {
          spec.envelopeDepthM = depth;
          spec.envelopeWidthM = width;
          break;
        }
      }
    }
  }
}

function applySharedCoreTemplate(specs: FloorSpec[]): void {
  const sourceSpec =
    specs.find((spec) =>
      !spec.belowGrade &&
      spec.coreTemplate &&
      Number.isFinite(Number(spec.coreTemplate.center_x_m)) &&
      Number.isFinite(Number(spec.coreTemplate.center_y_m)),
    ) ??
    specs.find((spec) =>
      spec.coreTemplate &&
      Number.isFinite(Number(spec.coreTemplate.center_x_m)) &&
      Number.isFinite(Number(spec.coreTemplate.center_y_m)),
    ) ??
    specs.find((spec) => spec.coreTemplate?.fixed_across_floors) ??
    specs.find((spec) => !spec.belowGrade && spec.coreTemplate) ??
    specs.find((spec) => spec.coreTemplate);

  const shared = sourceSpec?.coreTemplate;
  if (!shared || !sourceSpec) return;

  const sourceDimensions = resolveLayoutDimensions(sourceSpec);
  const sharedCenter = resolveCoreCenter(shared, sourceDimensions.w, sourceDimensions.d);

  for (const spec of specs) {
    const rooms = Array.isArray(spec.rooms) ? spec.rooms : [];
    const hasCoreRoom = rooms.some(isExplicitCoreRoom);
    if (hasCoreRoom || spec.coreTemplate) {
      const current = spec.coreTemplate ?? shared;
      spec.coreTemplate = {
        ...current,
        fixed_across_floors: true,
        center_x_m: sharedCenter.cx,
        center_y_m: sharedCenter.cy,
        offset_x_m: sharedCenter.cx,
        offset_y_m: sharedCenter.cy,
      };
    }
  }
}

function syncCoreRoomsToSharedTemplate(specs: FloorSpec[]): void {
  for (const spec of specs) {
    if (!spec.coreTemplate || !Array.isArray(spec.rooms)) continue;

    spec.rooms = spec.rooms.map((room) =>
      isExplicitCoreRoom(room)
        ? {
            ...room,
            unit_type: 'CORE' as const,
            // Keep the schedule ID (for example F01_CORE). The fixed template
            // supplies geometry, not a replacement identity for every floor.
            name: room.name || spec.coreTemplate?.room_name || 'Core',
            function_id: room.function_id || room.room_id || spec.coreTemplate?.function_id || 'core',
          }
        : room,
    );
  }
}

function normalizeMassLayoutType(value: unknown): MassLayoutType {
  const source = String(value ?? '');
  const raw = source.trim().toUpperCase();
  if (raw === 'COURTYARD_U' || raw === 'COURTYARD-U' || raw === 'COURTYARD U') return 'COURTYARD_U';
  if (raw === 'COURTYARD_O' || raw === 'COURTYARD-O' || raw === 'COURTYARD O') return 'COURTYARD_O';
  if (raw === 'CIRCULAR' || raw === 'CIRCLE' || raw === 'ROUND') return 'CIRCULAR';
  if (raw === 'RING_ATRIUM' || raw === 'RING-ATRIUM' || raw === 'DONUT' || raw === 'DOUGHNUT') return 'RING_ATRIUM';
  if (raw === 'RECTANGLE' || raw === 'RECT') return 'RECTANGLE';
  if (source.includes('\u3137') || /(?:^|[^a-z])u[\s-]?(?:shape|type|shaped)(?:[^a-z]|$)|\bㄷ\s*자|\bㄷ자/i.test(source)) return 'COURTYARD_U';
  if (source.includes('\u3141') || /(?:^|[^a-z])o[\s-]?(?:shape|type|shaped)(?:[^a-z]|$)|closed\s+courtyard|enclosed\s+courtyard/i.test(source)) return 'COURTYARD_O';
  return 'AUTO';
}

function floorOrder(label: string): number {
  const normalized = label.trim().toUpperCase();
  const numericBasement = normalized.match(/^-(\d+)$/);
  if (numericBasement) return -parseInt(numericBasement[1], 10);

  const basementMatch = normalized.match(/^B(\d+)/);
  if (basementMatch) return -parseInt(basementMatch[1], 10);

  const aboveMatch = normalized.match(/^(\d+)F/);
  if (aboveMatch) return parseInt(aboveMatch[1], 10);

  return 0;
}

function isBasementFloorLabel(label: string): boolean {
  return /^B\d+$/i.test(normalizeFloorLabel(label));
}

function normalizeFloorLabel(label: string): string {
  const normalized = label.trim().toUpperCase();
  const numericBasement = normalized.match(/^-(\d+)$/);
  if (numericBasement) return `B${numericBasement[1]}`;
  const above = normalized.match(/^(\d+)$/);
  if (above) return `${above[1]}F`;
  return label;
}

function floorLabelAliases(label: string): string[] {
  const normalized = normalizeFloorLabel(label);
  const aliases = new Set<string>([label, normalized]);
  const basement = normalized.toUpperCase().match(/^B(\d+)$/);
  if (basement) aliases.add(`-${basement[1]}`);
  const above = normalized.toUpperCase().match(/^(\d+)F$/);
  if (above) aliases.add(above[1]);
  return [...aliases];
}

function getFloorRecordValue<T>(record: Record<string, T> | undefined, label: string): T | undefined {
  if (!record) return undefined;
  for (const alias of floorLabelAliases(label)) {
    if (Object.prototype.hasOwnProperty.call(record, alias)) return record[alias];
  }
  return undefined;
}

function sortedFloorEntries(record?: Record<string, number>): Array<[string, number]> {
  return Object.entries(record ?? {})
    .filter(([, area]) => Number.isFinite(area) && area > 0)
    .map(([label, area]) => [normalizeFloorLabel(label), area] as [string, number])
    .sort(([a], [b]) => floorOrder(a) - floorOrder(b));
}

function normalizeUnitType(room: RoomLayout): 'CORE' | 'CORRIDOR' | 'LIVING_UNIT' | 'PARKING' {
  return classifyRoomUnitType(room);
}

function normalizeFunctionId(room: RoomLayout): string {
  const source = room.function_id || room.name;
  const fallback = normalizeUnitType(room).toLowerCase();
  const normalized = source
    .trim()
    .toLowerCase()
    .replace(/[()./\\?]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-|-$/g, '');

  return normalized || fallback;
}

function resolveCoreTemplateForFloor(
  template: CoreTemplate | CoreTemplate[] | undefined,
  label: string,
): CoreTemplate | undefined {
  const templates = Array.isArray(template) ? template : template ? [template] : [];
  if (!templates.length) return undefined;

  const selected = templates.find((item) =>
    !Array.isArray(item.applicable_floors) ||
    item.applicable_floors.length === 0 ||
    item.applicable_floors.includes(label),
  ) ?? templates[0];
  return normalizeCoreTemplateGeometry(selected);
}

function normalizeCoreTemplateGeometry(template: CoreTemplate): CoreTemplate {
  const polygon = (template as CoreTemplate & { polygon?: [number, number][] }).polygon;
  if (!Array.isArray(polygon) || polygon.length < 4) return template;

  const points = polygon
    .filter((point): point is [number, number] => Array.isArray(point) && point.length >= 2)
    .map(([x, y]) => [Number(x), Number(y)] as [number, number])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (points.length < 4) return template;

  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX <= minX || maxY <= minY) return template;

  return {
    ...template,
    width_m: maxX - minX,
    depth_m: maxY - minY,
    center_x_m: (minX + maxX) / 2,
    center_y_m: (minY + maxY) / 2,
    fixed_across_floors: true,
  };
}

function deriveCoreTemplateFromRooms(rooms: RoomLayout[], label: string): CoreTemplate | undefined {
  const coreRoom = rooms.find((room) => normalizeUnitType(room) === 'CORE');
  const polygon = coreRoom?.polygon;
  if (!coreRoom || !Array.isArray(polygon) || polygon.length < 4) return undefined;

  const points = polygon
    .filter((point): point is [number, number] => Array.isArray(point) && point.length >= 2)
    .map(([x, y]) => [Number(x), Number(y)] as [number, number]);
  if (points.length < 4) return undefined;

  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX <= minX || maxY <= minY) return undefined;

  return {
    width_m: maxX - minX,
    depth_m: maxY - minY,
    position: 'center',
    fixed_across_floors: true,
    applicable_floors: [label],
    center_x_m: (minX + maxX) / 2,
    center_y_m: (minY + maxY) / 2,
    room_name: coreRoom.name,
    function_id: coreRoom.function_id,
  };
}

function resolveCoreTemplateForFloorWithRooms(
  template: CoreTemplate | CoreTemplate[] | undefined,
  label: string,
  rooms: RoomLayout[],
): CoreTemplate | undefined {
  return resolveCoreTemplateForFloor(template, label) ?? deriveCoreTemplateFromRooms(rooms, label);
}

function getRoomsWithFill(floor: FloorSpec): RoomLayout[] {
  const rawRooms = Array.isArray(floor.rooms)
    ? floor.rooms
    : floor.rooms && typeof floor.rooms === 'object'
      ? Object.values(floor.rooms as Record<string, RoomLayout>)
      : [];
  const rooms = rawRooms.filter((room) => Number.isFinite(room.area_m2) && room.area_m2 > 0);
  if (!rooms.length) return [];

  return rooms;
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
      name: `통합 기타 (${merged.length}개)`,
      area_m2: mergedArea,
      function_id: 'merged-other',
      unit_type: 'CORRIDOR',
    },
  ];
}

function normalizeRoomsForPlanArea(floor: FloorSpec, rooms: RoomLayout[]): RoomLayout[] {
  const normalized = rooms
    .filter((room) => Number.isFinite(room.area_m2) && room.area_m2 > 0)
    .map((room) =>
      normalizeUnitType(room) === 'CORE'
        ? { ...room, unit_type: 'CORE' as const }
        : room,
    );
  if (floor.preserveRoomAreas) return normalized;

  const floorArea = massFootprintAreaM2(floor);
  const coreArea = normalized
    .filter((room) => normalizeUnitType(room) === 'CORE')
    .reduce((sum, room) => sum + (Number(room.area_m2) || 0), 0);
  const nonCoreRooms = normalized.filter((room) => normalizeUnitType(room) !== 'CORE');
  const nonCoreArea = nonCoreRooms.reduce((sum, room) => sum + (Number(room.area_m2) || 0), 0);
  const targetNonCoreArea = Math.max(floorArea - coreArea, 0);

  if (nonCoreRooms.length === 0 || nonCoreArea <= 0 || targetNonCoreArea <= 0) return normalized;
  if (Math.abs(nonCoreArea - targetNonCoreArea) <= 0.01) return normalized;

  const scale = targetNonCoreArea / nonCoreArea;
  return normalized.map((room) =>
    normalizeUnitType(room) === 'CORE'
      ? room
      : { ...room, area_m2: Math.max((Number(room.area_m2) || 0) * scale, 0.01) },
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeLayoutType(value: unknown): LayoutType {
  const raw = String(value ?? '').trim().toUpperCase();
  if (['L_SHAPE', 'L-SHAPE', 'L SHAPE', 'L'].includes(raw) || raw.includes('\u3131')) return 'L_SHAPE';
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
      const y1 = cursorY + (room.area_m2 / rightStripWidth);
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
    const y1 = rightCursorY + (room.area_m2 / rightStripWidth);
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
    const x0 = bottomCursorX - (room.area_m2 / bottomStripHeight);
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

function buildPlanLikeRoomSlices(
  rooms: RoomLayout[],
  width: number,
  depth: number,
): RoomSlice[] {
  if (!rooms.length || width <= 0 || depth <= 0) return [];

  const totalArea = rooms.reduce((sum, room) => sum + room.area_m2, 0);
  const targetRowCount = estimateTargetRowCount(rooms.length);
  const targetRowArea = totalArea / Math.max(targetRowCount, 1);
  const rows: RoomLayout[][] = [];
  let currentRow: RoomLayout[] = [];
  let currentRowArea = 0;

  for (let index = 0; index < rooms.length; index += 1) {
    const room = rooms[index];
    const remainingRooms = rooms.length - index;
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

  let cursorY = depth / 2;
  const slices: RoomSlice[] = [];
  rows.forEach((row) => {
    const rowArea = row.reduce((sum, room) => sum + room.area_m2, 0);
    const remainingDepth = cursorY - (-depth / 2);
    const idealRowHeight = rowArea / width;
    const rowHeight = Math.min(idealRowHeight, remainingDepth);
    const y1 = cursorY;
    const y0 = y1 - rowHeight;
    let cursorX = -width / 2;

    row.forEach((room) => {
      const x1 = Math.min(cursorX + (room.area_m2 / Math.max(rowHeight, 0.001)), width / 2);
      const slice = { room, x0: cursorX, x1, y0, y1 };
      cursorX = x1;
      slices.push(slice);
    });
    cursorY = y0;
  });

  return slices;
}

function buildSlicesWithFixedCore(
  floor: FloorSpec,
  rooms: RoomLayout[],
  width: number,
  depth: number,
): RoomSlice[] | null {
  const coreTemplate = floor.coreTemplate;
  if (!coreTemplate) return null;

  const coreIndex = rooms.findIndex((room) => normalizeUnitType(room) === 'CORE');
  if (coreIndex < 0) return null;

  const coreRoom = rooms[coreIndex];
  const otherRooms = rooms.filter((_, index) => index !== coreIndex);
  const declaredCoreArea = Number(coreRoom.area_m2) || coreTemplateArea(coreTemplate);
  const templateWidth = Number(coreTemplate.width_m);
  const templateDepth = Number(coreTemplate.depth_m);
  const coreWidth = Math.max(Number.isFinite(templateWidth) && templateWidth > 0 ? templateWidth : Math.sqrt(declaredCoreArea), 0.5);
  const coreDepth = Math.max(
    Number.isFinite(templateDepth) && templateDepth > 0 && Math.abs((coreWidth * templateDepth) - declaredCoreArea) / Math.max(declaredCoreArea, 1) <= 0.05
      ? templateDepth
      : declaredCoreArea / coreWidth,
    0.5,
  );
  const bounds = resolveFixedCoreBounds(coreTemplate, width, depth, coreWidth, coreDepth);

  const coreSlice: RoomSlice = {
    room: { ...coreRoom, area_m2: Number.isFinite(declaredCoreArea) && declaredCoreArea > 0 ? declaredCoreArea : coreWidth * coreDepth, unit_type: 'CORE' },
    x0: bounds.x0,
    x1: bounds.x1,
    y0: bounds.y0,
    y1: bounds.y1,
  };

  if (coreSlice.x1 <= coreSlice.x0 || coreSlice.y1 <= coreSlice.y0) return null;
  if (
    coreSlice.x0 < -width / 2 - 0.01 ||
    coreSlice.x1 > width / 2 + 0.01 ||
    coreSlice.y0 < -depth / 2 - 0.01 ||
    coreSlice.y1 > depth / 2 + 0.01
  ) {
    return null;
  }
  const usableZones = buildZonesAroundCoreSlice(width, depth, coreSlice);
  if (!usableZones.length) return [coreSlice];
  if (!assignRoomsToPackingZones(usableZones, otherRooms)) return null;
  const slices: RoomSlice[] = [coreSlice];
  for (const zone of usableZones) {
    const packed = packZoneWithExactAreas(zone);
    if (!packed) return null;
    slices.push(...packed);
  }

  return slices;
}

function packApproxRoomPiecesInZone(
  zone: PackingZone,
  pieces: Array<{ room: RoomLayout; layoutAreaM2: number }>,
): RoomSlice[] {
  const slices: RoomSlice[] = [];
  if (pieces.length === 0) return slices;

  if (zone.vertical) {
    const width = Math.max(zone.x1 - zone.x0, 0.001);
    let cursorY = zone.y0;
    for (const piece of pieces) {
      const nextY = Math.min(cursorY + piece.layoutAreaM2 / width, zone.y1);
      if (nextY > cursorY + 0.01) {
        slices.push({
          room: piece.room,
          x0: zone.x0,
          x1: zone.x1,
          y0: cursorY,
          y1: nextY,
          layoutAreaM2: piece.layoutAreaM2,
        });
      }
      cursorY = nextY;
      if (cursorY >= zone.y1 - 0.01) break;
    }
    return slices;
  }

  const height = Math.max(zone.y1 - zone.y0, 0.001);
  let cursorX = zone.x0;
  for (const piece of pieces) {
    const nextX = Math.min(cursorX + piece.layoutAreaM2 / height, zone.x1);
    if (nextX > cursorX + 0.01) {
      slices.push({
        room: piece.room,
        x0: cursorX,
        x1: nextX,
        y0: zone.y0,
        y1: zone.y1,
        layoutAreaM2: piece.layoutAreaM2,
      });
    }
    cursorX = nextX;
    if (cursorX >= zone.x1 - 0.01) break;
  }
  return slices;
}

function buildApproxFixedCoreRoomSlices(
  floor: FloorSpec,
  rooms: RoomLayout[],
  width: number,
  depth: number,
): RoomSlice[] | null {
  const coreResult = createCoreSliceForExactLayout(floor, rooms, width, depth);
  if (!coreResult) return null;

  const zones = buildZonesAroundCoreSlice(width, depth, coreResult.coreSlice);
  if (!zones.length) return [coreResult.coreSlice];

  const nonCoreRooms = orderRoomsForCoreLayout(coreResult.nonCoreRooms)
    .filter((room) => Number.isFinite(room.area_m2) && room.area_m2 > 0);
  if (!nonCoreRooms.length) return [coreResult.coreSlice];

  const availableArea = zones.reduce((sum, zone) => sum + zone.area, 0);
  const declaredArea = nonCoreRooms.reduce((sum, room) => sum + room.area_m2, 0);
  if (availableArea <= 0 || declaredArea <= 0) return [coreResult.coreSlice];

  const geometryScale = Math.min(1, availableArea / declaredArea);
  const assignments = new Map<PackingZone, Array<{ room: RoomLayout; layoutAreaM2: number }>>();
  const remainingByZone = new Map<PackingZone, number>();
  for (const zone of zones) {
    assignments.set(zone, []);
    remainingByZone.set(zone, zone.area);
  }

  const chooseZone = () =>
    [...zones].sort((a, b) => (remainingByZone.get(b) ?? 0) - (remainingByZone.get(a) ?? 0))[0];

  for (const room of nonCoreRooms) {
    let remainingRoomArea = Math.max(room.area_m2 * geometryScale, 0);
    let guard = 0;
    while (remainingRoomArea > 0.01 && guard < zones.length + 2) {
      guard += 1;
      const zone = chooseZone();
      const zoneRemaining = Math.max(remainingByZone.get(zone) ?? 0, 0);
      if (zoneRemaining <= 0.01) break;
      const layoutAreaM2 = Math.min(remainingRoomArea, zoneRemaining);
      assignments.get(zone)?.push({ room, layoutAreaM2 });
      remainingByZone.set(zone, zoneRemaining - layoutAreaM2);
      remainingRoomArea -= layoutAreaM2;
    }
  }

  const slices: RoomSlice[] = [coreResult.coreSlice];
  for (const zone of zones) {
    slices.push(...packApproxRoomPiecesInZone(zone, assignments.get(zone) ?? []));
  }

  return slices.length > 1 ? slices : null;
}

interface PackingZone {
  id: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  area: number;
  used: number;
  vertical: boolean;
  rooms: RoomLayout[];
}

type PackedRoomLayout = RoomLayout & {
  __packAnchor?: 'start' | 'end';
  __splitGroupKey?: string;
};

function roomKey(room: RoomLayout): string {
  return room.room_id || room.function_id || room.name;
}

function roomRelationKeys(room: RoomLayout, field: 'required_adjacency' | 'adjacent_to' | 'avoid_adjacency'): Set<string> {
  return new Set((room[field] ?? []).map((value) => String(value).trim()).filter(Boolean));
}

function roomsHavePositiveAdjacency(a: RoomLayout, b: RoomLayout): boolean {
  const aKey = roomKey(a);
  const bKey = roomKey(b);
  return roomRelationKeys(a, 'required_adjacency').has(bKey)
    || roomRelationKeys(a, 'adjacent_to').has(bKey)
    || roomRelationKeys(b, 'required_adjacency').has(aKey)
    || roomRelationKeys(b, 'adjacent_to').has(aKey);
}

function roomsHaveAvoidAdjacency(a: RoomLayout, b: RoomLayout): boolean {
  if (roomsHavePositiveAdjacency(a, b)) return false;
  const aKey = roomKey(a);
  const bKey = roomKey(b);
  return roomRelationKeys(a, 'avoid_adjacency').has(bKey)
    || roomRelationKeys(b, 'avoid_adjacency').has(aKey);
}

function roomAdjacencyDegree(room: RoomLayout): number {
  return (
    (room.required_adjacency?.length ?? 0) * 3 +
    (room.adjacent_to?.length ?? 0) * 2 -
    (room.avoid_adjacency?.length ?? 0)
  );
}

function orderRoomsByLocalAdjacency(rooms: RoomLayout[]): RoomLayout[] {
  if (rooms.length <= 2) return rooms;

  const remaining = new Set(rooms);
  const ordered: RoomLayout[] = [];
  let current = [...remaining].sort((a, b) =>
    roomAdjacencyDegree(b) - roomAdjacencyDegree(a) ||
    Number(b.area_m2 ?? 0) - Number(a.area_m2 ?? 0),
  )[0];

  while (current) {
    ordered.push(current);
    remaining.delete(current);

    current = [...remaining].sort((a, b) => {
      const score = (candidate: RoomLayout) => {
        const positive = ordered.some((placed) => roomsHavePositiveAdjacency(candidate, placed)) ? 1000 : 0;
        const avoid = ordered.some((placed) => roomsHaveAvoidAdjacency(candidate, placed)) ? -1000 : 0;
        const last = ordered[ordered.length - 1];
        const chain = last && roomsHavePositiveAdjacency(candidate, last) ? 500 : 0;
        return positive + chain + avoid + roomAdjacencyDegree(candidate) * 10 + Number(candidate.area_m2 ?? 0) / 100;
      };
      return score(b) - score(a);
    })[0];
  }

  return ordered;
}

function orderRoomsForCoreLayout(rooms: RoomLayout[]): RoomLayout[] {
  const score = (room: RoomLayout): number => {
    let value = room.area_m2 + roomAdjacencyDegree(room) * 250;
    if (room.core_proximity === 'required') value += 10_000;
    else if (room.core_proximity === 'preferred') value += 5_000;
    if ((room.required_adjacency?.length ?? 0) > 0) value += 1_000;
    if (room.facade_required) value += 500;
    return value;
  };

  const sorted = [...rooms].sort((a, b) => score(b) - score(a));
  const placed: RoomLayout[] = [];
  const remaining = new Map(sorted.map((room) => [roomKey(room), room]));

  while (remaining.size > 0) {
    let next: RoomLayout | undefined;
    if (placed.length > 0) {
      next = [...remaining.values()].find((room) => {
        const key = roomKey(room);
        return placed.some((placedRoom) => {
          const placedKey = roomKey(placedRoom);
          return (room.required_adjacency ?? []).includes(placedKey)
            || (room.adjacent_to ?? []).includes(placedKey)
            || (placedRoom.required_adjacency ?? []).includes(key)
            || (placedRoom.adjacent_to ?? []).includes(key);
        });
      });
    }

    if (!next) next = [...remaining.values()].sort((a, b) => score(b) - score(a))[0];
    placed.push(next);
    remaining.delete(roomKey(next));
  }

  return placed;
}

function createCoreSliceForExactLayout(
  floor: FloorSpec,
  rooms: RoomLayout[],
  width: number,
  depth: number,
): { coreSlice: RoomSlice; coreRoom: RoomLayout; nonCoreRooms: RoomLayout[] } | null {
  const coreTemplate = floor.coreTemplate;
  if (!coreTemplate) return null;

  const explicitCoreRoom = rooms.find(isExplicitCoreRoom);
  const templateArea = Math.max(
    Number(coreTemplate.width_m || 0) * Number(coreTemplate.depth_m || 0),
    0,
  );
  const coreRoom: RoomLayout = explicitCoreRoom ?? {
    name: coreTemplate.room_name ?? 'Core',
    area_m2: templateArea || 1,
    function_id: coreTemplate.function_id ?? 'core',
    unit_type: 'CORE',
  };
  const nonCoreRooms = rooms.filter((room) => room !== explicitCoreRoom && !isExplicitCoreRoom(room));

  const declaredCoreArea = Number(coreRoom.area_m2) || templateArea;
  const templateWidth = Number(coreTemplate.width_m);
  const templateDepth = Number(coreTemplate.depth_m);
  const coreWidth = Math.max(Number.isFinite(templateWidth) && templateWidth > 0 ? templateWidth : Math.sqrt(declaredCoreArea), 0.5);
  const coreDepth = Math.max(
    Number.isFinite(templateDepth) && templateDepth > 0 && Math.abs((coreWidth * templateDepth) - declaredCoreArea) / Math.max(declaredCoreArea, 1) <= 0.05
      ? templateDepth
      : declaredCoreArea / coreWidth,
    0.5,
  );

  const bounds = resolveFixedCoreBounds(coreTemplate, width, depth, coreWidth, coreDepth);
  const unclippedX0 = bounds.x0;
  const unclippedX1 = bounds.x1;
  const unclippedY0 = bounds.y0;
  const unclippedY1 = bounds.y1;
  if (
    unclippedX0 < -width / 2 - 0.01 ||
    unclippedX1 > width / 2 + 0.01 ||
    unclippedY0 < -depth / 2 - 0.01 ||
    unclippedY1 > depth / 2 + 0.01
  ) {
    return null;
  }

  const coreSlice: RoomSlice = {
    room: { ...coreRoom, area_m2: Number.isFinite(declaredCoreArea) && declaredCoreArea > 0 ? declaredCoreArea : coreWidth * coreDepth, unit_type: 'CORE' },
    x0: unclippedX0,
    x1: unclippedX1,
    y0: unclippedY0,
    y1: unclippedY1,
  };

  if (coreSlice.x1 <= coreSlice.x0 || coreSlice.y1 <= coreSlice.y0) return null;
  return { coreSlice, coreRoom: coreSlice.room, nonCoreRooms };
}

function buildZonesAroundCoreSlice(width: number, depth: number, core: RoomSlice): PackingZone[] {
  const hw = width / 2;
  const hd = depth / 2;
  const candidates = [
    { id: 'left', x0: -hw, x1: core.x0, y0: -hd, y1: hd, vertical: true },
    { id: 'right', x0: core.x1, x1: hw, y0: -hd, y1: hd, vertical: true },
    { id: 'bottom', x0: core.x0, x1: core.x1, y0: -hd, y1: core.y0, vertical: false },
    { id: 'top', x0: core.x0, x1: core.x1, y0: core.y1, y1: hd, vertical: false },
  ];

  return candidates
    .map((zone) => ({
      ...zone,
      area: Math.max(0, (zone.x1 - zone.x0) * (zone.y1 - zone.y0)),
      used: 0,
      rooms: [] as RoomLayout[],
    }))
    .filter((zone) => zone.area > 1 && zone.x1 > zone.x0 && zone.y1 > zone.y0);
}

function zoneScoreForRoom(zone: PackingZone, room: RoomLayout): number {
  const fillRatio = (zone.used + room.area_m2) / zone.area;
  const positiveAdjacency = zone.rooms.filter((placed) => roomsHavePositiveAdjacency(room, placed)).length;
  const avoidAdjacency = zone.rooms.filter((placed) => roomsHaveAvoidAdjacency(room, placed)).length;
  const facadeZoneBonus = room.facade_required && (zone.id === 'left' || zone.id === 'right') ? 0.35 : 0;
  const coreZoneBonus = room.core_proximity === 'required' ? 0.2 : room.core_proximity === 'preferred' ? 0.1 : 0;
  return (
    positiveAdjacency * 3 -
    avoidAdjacency * 5 -
    Math.abs(0.72 - fillRatio) +
    facadeZoneBonus +
    coreZoneBonus
  );
}

function tryAssignRoomsWithoutSplits(zones: PackingZone[], rooms: RoomLayout[]): boolean {
  const orderedRooms = [...rooms].sort((a, b) => b.area_m2 - a.area_m2 || roomAdjacencyDegree(b) - roomAdjacencyDegree(a));

  const place = (roomIndex: number): boolean => {
    if (roomIndex >= orderedRooms.length) return true;
    const room = orderedRooms[roomIndex];
    const candidates = zones
      .filter((zone) => zone.area - zone.used + 0.5 >= room.area_m2)
      .sort((a, b) => zoneScoreForRoom(b, room) - zoneScoreForRoom(a, room));

    for (const zone of candidates) {
      zone.rooms.push(room);
      zone.used += room.area_m2;
      if (place(roomIndex + 1)) return true;
      zone.used -= room.area_m2;
      zone.rooms.pop();
    }

    return false;
  };

  return place(0);
}

function tryAssignRoomSubsetsWithoutSplits(zones: PackingZone[], rooms: RoomLayout[]): boolean {
  if (rooms.length > 14) return false;

  const roomCount = rooms.length;
  const roomAreas = rooms.map((room) => room.area_m2);
  const areaByMask = new Map<number, number>();
  const areaForMask = (mask: number): number => {
    const cached = areaByMask.get(mask);
    if (cached !== undefined) return cached;
    let area = 0;
    for (let index = 0; index < roomCount; index += 1) {
      if (mask & (1 << index)) area += roomAreas[index];
    }
    areaByMask.set(mask, area);
    return area;
  };

  const orderedZones = [...zones].sort((a, b) => a.area - b.area);
  const allMask = (1 << roomCount) - 1;

  const placeZone = (zoneIndex: number, remainingMask: number): boolean => {
    if (remainingMask === 0) return true;
    if (zoneIndex >= orderedZones.length) return false;

    const zone = orderedZones[zoneIndex];
    const capacity = zone.area - zone.used + 0.5;
    const subsets: number[] = [];
    for (let subset = remainingMask; subset > 0; subset = (subset - 1) & remainingMask) {
      const area = areaForMask(subset);
      if (area <= capacity) subsets.push(subset);
    }

    subsets.sort((a, b) => areaForMask(b) - areaForMask(a));
    subsets.push(0);

    for (const subset of subsets) {
      const assigned: RoomLayout[] = [];
      for (let roomIndex = 0; roomIndex < roomCount; roomIndex += 1) {
        if (subset & (1 << roomIndex)) {
          const room = rooms[roomIndex];
          zone.rooms.push(room);
          zone.used += room.area_m2;
          assigned.push(room);
        }
      }

      if (placeZone(zoneIndex + 1, remainingMask & ~subset)) return true;

      for (const room of assigned.reverse()) {
        zone.rooms.pop();
        zone.used -= room.area_m2;
      }
    }

    return false;
  };

  return placeZone(0, allMask);
}

type SplitZoneChoice = { zone: PackingZone; anchor: 'start' | 'end' };
const SPLIT_AREA_TOLERANCE_M2 = 1.0;

function areZonesAdjacent(a: PackingZone, b: PackingZone): boolean {
  const xOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const yOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const touchesVertically = Math.abs(a.x1 - b.x0) < 0.01 || Math.abs(b.x1 - a.x0) < 0.01;
  const touchesHorizontally = Math.abs(a.y1 - b.y0) < 0.01 || Math.abs(b.y1 - a.y0) < 0.01;
  return (touchesVertically && yOverlap > 0.01) || (touchesHorizontally && xOverlap > 0.01);
}

function isConnectedZoneChoice(choices: SplitZoneChoice[]): boolean {
  if (choices.length <= 1) return true;
  const visited = new Set<PackingZone>();
  const queue = [choices[0].zone];
  visited.add(choices[0].zone);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const choice of choices) {
      if (!visited.has(choice.zone) && areZonesAdjacent(current, choice.zone)) {
        visited.add(choice.zone);
        queue.push(choice.zone);
      }
    }
  }

  return visited.size === choices.length;
}

function buildDynamicSplitOrders(zones: PackingZone[]): SplitZoneChoice[][] {
  const anchors: Array<'start' | 'end'> = ['start', 'end'];
  const orders: SplitZoneChoice[][] = [];

  const addOrder = (choices: SplitZoneChoice[]) => {
    const key = choices.map((choice) => `${choice.zone.id}:${choice.anchor}`).join('|');
    if (choices.length >= 2 && isConnectedZoneChoice(choices) && !orders.some((order) => order.map((choice) => `${choice.zone.id}:${choice.anchor}`).join('|') === key)) {
      orders.push(choices);
    }
  };

  for (const first of zones) {
    for (const second of zones) {
      if (second === first) continue;
      for (const firstAnchor of anchors) {
        for (const secondAnchor of anchors) {
          addOrder([
            { zone: first, anchor: firstAnchor },
            { zone: second, anchor: secondAnchor },
          ]);
        }
      }
    }
  }

  for (const first of zones) {
    for (const second of zones) {
      for (const third of zones) {
        if (new Set([first, second, third]).size !== 3) continue;
        for (const firstAnchor of anchors) {
          for (const secondAnchor of anchors) {
            for (const thirdAnchor of anchors) {
              addOrder([
                { zone: first, anchor: firstAnchor },
                { zone: second, anchor: secondAnchor },
                { zone: third, anchor: thirdAnchor },
              ]);
            }
          }
        }
      }
    }
  }

  return orders;
}

function applySplitRoomToZones(room: RoomLayout, splitZones: SplitZoneChoice[]): RoomLayout[] | null {
  const totalSpare = splitZones.reduce((sum, item) => sum + Math.max(0, item.zone.area - item.zone.used), 0);
  if (totalSpare + SPLIT_AREA_TOLERANCE_M2 < room.area_m2) return null;

  let remainingArea = room.area_m2;
  const splitGroupKey = `split:${roomSliceGroupKey(room)}:${room.area_m2}`;
  const placedPieces: RoomLayout[] = [];

  for (const { zone, anchor } of splitZones) {
    if (remainingArea <= 0.01) break;
    const spare = Math.max(0, zone.area - zone.used);
    if (spare <= 0.5) continue;
    const pieceArea = Math.min(remainingArea, spare);
    const piece = {
      ...room,
      area_m2: pieceArea,
      __packAnchor: anchor,
      __splitGroupKey: splitGroupKey,
    } as PackedRoomLayout;
    zone.rooms.push(piece);
    zone.used += pieceArea;
    placedPieces.push(piece);
    remainingArea -= pieceArea;
  }

  if (remainingArea > 0.01 && remainingArea <= SPLIT_AREA_TOLERANCE_M2 && placedPieces.length >= 2) {
    const lastPiece = placedPieces[placedPieces.length - 1];
    const lastZone = splitZones.find((item) => item.zone.rooms[item.zone.rooms.length - 1] === lastPiece)?.zone;
    if (lastZone) {
      lastPiece.area_m2 += remainingArea;
      lastZone.used += remainingArea;
      remainingArea = 0;
    }
  }

  if (remainingArea > 0.01 || placedPieces.length < 2) {
    for (const piece of placedPieces.reverse()) {
      const zone = splitZones.find((item) => item.zone.rooms[item.zone.rooms.length - 1] === piece)?.zone;
      if (zone) {
        zone.rooms.pop();
        zone.used -= piece.area_m2;
      }
    }
    return null;
  }

  return placedPieces;
}

function packingOrderClass(room: RoomLayout): number {
  const area = Number(room.area_m2) || 0;
  if (area >= 1000) return 2;
  if (area >= 500) return 1;
  return 0;
}

function assignRoomsToPackingZones(zones: PackingZone[], rooms: RoomLayout[]): boolean {
  if (tryAssignRoomsWithoutSplits(zones, rooms)) return true;
  for (const zone of zones) {
    zone.used = 0;
    zone.rooms = [];
  }
  if (tryAssignRoomSubsetsWithoutSplits(zones, rooms)) return true;

  for (const zone of zones) {
    zone.used = 0;
    zone.rooms = [];
  }

  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  const MIN_SPLIT_ROOM_AREA_M2 = 200;
  const splitOrders = [
    [{ id: 'top', anchor: 'start' }, { id: 'left', anchor: 'start' }],
    [{ id: 'top', anchor: 'end' }, { id: 'right', anchor: 'start' }],
    [{ id: 'bottom', anchor: 'start' }, { id: 'left', anchor: 'end' }],
    [{ id: 'bottom', anchor: 'end' }, { id: 'right', anchor: 'end' }],
    [{ id: 'bottom', anchor: 'start' }, { id: 'left', anchor: 'end' }, { id: 'right', anchor: 'end' }],
    [{ id: 'top', anchor: 'start' }, { id: 'left', anchor: 'start' }, { id: 'right', anchor: 'start' }],
    [{ id: 'top', anchor: 'start' }, { id: 'left', anchor: 'start' }, { id: 'bottom', anchor: 'start' }],
    [{ id: 'top', anchor: 'end' }, { id: 'right', anchor: 'start' }, { id: 'bottom', anchor: 'end' }],
  ].map((order) => order
    .map(({ id, anchor }) => {
      const zone = zoneById.get(id);
      return zone ? { zone, anchor: anchor as 'start' | 'end' } : null;
    })
    .filter((item): item is SplitZoneChoice => item !== null))
    .filter((order) => order.length >= 2);
  splitOrders.push(...buildDynamicSplitOrders(zones));

  const splitAwareRooms = [...rooms].sort((a, b) => {
    const aClass = packingOrderClass(a);
    const bClass = packingOrderClass(b);
    if (aClass !== bClass) return aClass - bClass;
    if (aClass < 2) {
      return a.area_m2 - b.area_m2 || roomAdjacencyDegree(b) - roomAdjacencyDegree(a);
    }
    return b.area_m2 - a.area_m2 || roomAdjacencyDegree(b) - roomAdjacencyDegree(a);
  });

  const place = (roomIndex: number): boolean => {
    if (roomIndex >= splitAwareRooms.length) return true;
    const room = splitAwareRooms[roomIndex];
    const singleZoneCandidates = zones
      .filter((zone) => zone.area - zone.used + 0.5 >= room.area_m2)
      .sort((a, b) => zoneScoreForRoom(b, room) - zoneScoreForRoom(a, room));
    const splitCandidates = splitOrders
      .map((order) => ({
        order,
        spare: order.reduce((sum, item) => sum + Math.max(0, item.zone.area - item.zone.used), 0),
      }))
      .filter(() => room.area_m2 >= MIN_SPLIT_ROOM_AREA_M2)
      .filter(({ order }) => room.area_m2 >= 500 || order.length <= 2)
      .filter(({ spare }) => spare + SPLIT_AREA_TOLERANCE_M2 >= room.area_m2)
      .sort((a, b) => a.order.length - b.order.length || a.spare - b.spare)
      .map(({ order }) => order);

    const trySingleZones = (): boolean => {
      for (const zone of singleZoneCandidates) {
        zone.rooms.push(room);
        zone.used += room.area_m2;
        if (place(roomIndex + 1)) return true;
        zone.used -= room.area_m2;
        zone.rooms.pop();
      }
      return false;
    };

    const trySplitZones = (): boolean => {
      for (const splitCandidate of splitCandidates) {
        const pieces = applySplitRoomToZones(room, splitCandidate);
        if (!pieces) continue;
        if (place(roomIndex + 1)) return true;
        for (const piece of pieces.reverse()) {
          const zone = splitCandidate.find((item) => item.zone.rooms[item.zone.rooms.length - 1] === piece)?.zone;
          if (zone) {
            zone.rooms.pop();
            zone.used -= piece.area_m2;
          }
        }
      }
      return false;
    };

    if (room.area_m2 >= 500) {
      if (trySplitZones()) return true;
      if (trySingleZones()) return true;
      return false;
    }

    if (trySingleZones()) return true;
    if (trySplitZones()) return true;
    return false;
  };

  return place(0);
}

function clonePackingZones(zones: PackingZone[]): PackingZone[] {
  return zones.map((zone) => ({
    ...zone,
    used: 0,
    rooms: [],
  }));
}

function buildCoreWrappingSplitOrders(zones: PackingZone[]): SplitZoneChoice[][] {
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  const preferredOrders = [
    [{ id: 'left', anchor: 'end' }, { id: 'bottom', anchor: 'start' }, { id: 'right', anchor: 'end' }],
    [{ id: 'left', anchor: 'start' }, { id: 'top', anchor: 'start' }, { id: 'right', anchor: 'start' }],
    [{ id: 'bottom', anchor: 'start' }, { id: 'left', anchor: 'end' }, { id: 'top', anchor: 'start' }],
    [{ id: 'bottom', anchor: 'end' }, { id: 'right', anchor: 'end' }, { id: 'top', anchor: 'end' }],
    [{ id: 'left', anchor: 'end' }, { id: 'bottom', anchor: 'start' }, { id: 'right', anchor: 'end' }, { id: 'top', anchor: 'end' }],
    [{ id: 'left', anchor: 'start' }, { id: 'top', anchor: 'start' }, { id: 'right', anchor: 'start' }, { id: 'bottom', anchor: 'end' }],
  ].map((order) => order
    .map(({ id, anchor }) => {
      const zone = zoneById.get(id);
      return zone ? { zone, anchor: anchor as 'start' | 'end' } : null;
    })
    .filter((item): item is SplitZoneChoice => item !== null))
    .filter((order) => order.length >= 2);

  const dynamicOrders = buildDynamicSplitOrders(zones)
    .sort((a, b) => b.length - a.length);
  const seen = new Set<string>();
  const result: SplitZoneChoice[][] = [];
  for (const order of [...preferredOrders, ...dynamicOrders]) {
    if (!isConnectedZoneChoice(order)) continue;
    const key = order.map((choice) => `${choice.zone.id}:${choice.anchor}`).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(order);
  }
  return result;
}

function buildCoreWrappingLargeRoomSlices(floor: FloorSpec): { width: number; depth: number; slices: RoomSlice[] } | null {
  if (!floor.coreTemplate) return null;
  const rawRooms = Array.isArray(floor.rooms)
    ? floor.rooms.filter((room) => Number.isFinite(room.area_m2) && room.area_m2 > 0)
    : [];
  const rooms = normalizeRoomsForPlanArea(floor, rawRooms);
  if (!rooms.length) return null;

  const { w, d } = resolveLayoutDimensions(floor);
  const coreResult = createCoreSliceForExactLayout(floor, rooms, w, d);
  if (!coreResult) return null;

  const largeCandidates = coreResult.nonCoreRooms
    .filter((room) => Number.isFinite(room.area_m2) && room.area_m2 > 0)
    .sort((a, b) => {
      const aParking = normalizeUnitType(a) === 'PARKING' ? 1 : 0;
      const bParking = normalizeUnitType(b) === 'PARKING' ? 1 : 0;
      return bParking - aParking || b.area_m2 - a.area_m2;
    });
  const largeRoom = largeCandidates[0];
  if (!largeRoom) return null;

  const nonCoreArea = coreResult.nonCoreRooms.reduce((sum, room) => sum + room.area_m2, 0);
  const isLargeWrappingRoom =
    normalizeUnitType(largeRoom) === 'PARKING' ||
    largeRoom.area_m2 >= Math.max(1000, nonCoreArea * 0.45);
  if (!isLargeWrappingRoom) return null;

  const smallRooms = coreResult.nonCoreRooms
    .filter((room) => room !== largeRoom)
    .sort((a, b) => a.area_m2 - b.area_m2 || roomAdjacencyDegree(b) - roomAdjacencyDegree(a));
  const baseZones = buildZonesAroundCoreSlice(w, d, coreResult.coreSlice);
  if (baseZones.length < 2) return null;

  const totalAvailable = baseZones.reduce((sum, zone) => sum + zone.area, 0);
  if (totalAvailable + SPLIT_AREA_TOLERANCE_M2 < nonCoreArea) return null;

  for (const orderTemplate of buildCoreWrappingSplitOrders(baseZones)) {
    const zones = clonePackingZones(baseZones);
    const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
    const splitOrder = orderTemplate
      .map((choice) => {
        const zone = zoneById.get(choice.zone.id);
        return zone ? { zone, anchor: choice.anchor } : null;
      })
      .filter((choice): choice is SplitZoneChoice => choice !== null);
    if (splitOrder.length < 2) continue;

    const pieces = applySplitRoomToZones(largeRoom, splitOrder);
    if (!pieces) continue;
    if (smallRooms.length > 0 && !tryAssignRoomsWithoutSplits(zones, smallRooms)) continue;

    const slices: RoomSlice[] = [coreResult.coreSlice];
    let failed = false;
    for (const zone of zones) {
      const packed = packZoneWithExactAreas(zone);
      if (!packed) {
        failed = true;
        break;
      }
      slices.push(...packed);
    }
    if (failed) continue;

    const largeSlices = slices.filter((slice) => roomSliceGroupKey(slice.room) === roomSliceGroupKey(largeRoom));
    // The SDK accepts several simple units with the same functionId. Requiring
    // them to merge into one concave polygon discards valid parking layouts
    // that wrap around a fixed core.
    const generatedLargeArea = largeSlices.reduce(
      (sum, slice) => sum + Math.abs((slice.x1 - slice.x0) * (slice.y1 - slice.y0)),
      0,
    );
    if (generatedLargeArea + SPLIT_AREA_TOLERANCE_M2 < largeRoom.area_m2) continue;

    return { width: w, depth: d, slices };
  }

  return null;
}

function sliceRectPolygon(slice: RoomSlice): [number, number][] {
  if (slice.polygon && slice.polygon.length >= 4) return slice.polygon;
  return [
    [slice.x0, slice.y0],
    [slice.x1, slice.y0],
    [slice.x1, slice.y1],
    [slice.x0, slice.y1],
  ];
}

function roomSliceGroupKey(room: RoomLayout): string {
  return room.room_id || room.function_id || room.name;
}

function mergeRectSlicesToPolygon(slices: RoomSlice[]): [number, number][] | null {
  if (slices.length === 0) return null;
  if (slices.length === 1) return sliceRectPolygon(slices[0]);

  const key = ([x, y]: [number, number]) => `${x.toFixed(6)},${y.toFixed(6)}`;
  const xs = [...new Set(slices.flatMap((slice) => [slice.x0, slice.x1]).map((value) => Number(value.toFixed(6))))].sort((a, b) => a - b);
  const ys = [...new Set(slices.flatMap((slice) => [slice.y0, slice.y1]).map((value) => Number(value.toFixed(6))))].sort((a, b) => a - b);
  if (xs.length < 2 || ys.length < 2) return null;

  const covered = new Set<string>();
  for (let xi = 0; xi < xs.length - 1; xi += 1) {
    for (let yi = 0; yi < ys.length - 1; yi += 1) {
      const cx = (xs[xi] + xs[xi + 1]) / 2;
      const cy = (ys[yi] + ys[yi + 1]) / 2;
      if (
        slices.some(
          (slice) =>
            cx > Math.min(slice.x0, slice.x1) - 1e-6 &&
            cx < Math.max(slice.x0, slice.x1) + 1e-6 &&
            cy > Math.min(slice.y0, slice.y1) - 1e-6 &&
            cy < Math.max(slice.y0, slice.y1) + 1e-6,
        )
      ) {
        covered.add(`${xi},${yi}`);
      }
    }
  }

  const edgeCounts = new Map<string, { a: [number, number]; b: [number, number]; count: number }>();
  const addEdge = (a: [number, number], b: [number, number]) => {
    const ak = key(a);
    const bk = key(b);
    const ek = ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
    const existing = edgeCounts.get(ek);
    if (existing) {
      existing.count += 1;
    } else {
      edgeCounts.set(ek, { a, b, count: 1 });
    }
  };

  for (const cellKey of covered) {
    const [xi, yi] = cellKey.split(',').map(Number);
    if (!covered.has(`${xi},${yi - 1}`)) addEdge([xs[xi], ys[yi]], [xs[xi + 1], ys[yi]]);
    if (!covered.has(`${xi + 1},${yi}`)) addEdge([xs[xi + 1], ys[yi]], [xs[xi + 1], ys[yi + 1]]);
    if (!covered.has(`${xi},${yi + 1}`)) addEdge([xs[xi + 1], ys[yi + 1]], [xs[xi], ys[yi + 1]]);
    if (!covered.has(`${xi - 1},${yi}`)) addEdge([xs[xi], ys[yi + 1]], [xs[xi], ys[yi]]);
  }

  const boundaryEdges = [...edgeCounts.values()].filter((edge) => edge.count === 1);
  if (boundaryEdges.length < 4) return null;

  const directedBoundary = (() => {
    const directedEdges: Array<{ a: [number, number]; b: [number, number] }> = [];
    const addDirectedEdge = (a: [number, number], b: [number, number]) => {
      directedEdges.push({ a, b });
    };

    for (const cellKey of covered) {
      const [xi, yi] = cellKey.split(',').map(Number);
      if (!covered.has(`${xi},${yi - 1}`)) addDirectedEdge([xs[xi], ys[yi]], [xs[xi + 1], ys[yi]]);
      if (!covered.has(`${xi + 1},${yi}`)) addDirectedEdge([xs[xi + 1], ys[yi]], [xs[xi + 1], ys[yi + 1]]);
      if (!covered.has(`${xi},${yi + 1}`)) addDirectedEdge([xs[xi + 1], ys[yi + 1]], [xs[xi], ys[yi + 1]]);
      if (!covered.has(`${xi - 1},${yi}`)) addDirectedEdge([xs[xi], ys[yi + 1]], [xs[xi], ys[yi]]);
    }

    const outgoing = new Map<string, [number, number][]>();
    for (const edge of directedEdges) {
      outgoing.set(key(edge.a), [...(outgoing.get(key(edge.a)) ?? []), edge.b]);
    }
    if ([...outgoing.values()].some((points) => points.length !== 1)) return null;

    const start = directedEdges
      .map((edge) => edge.a)
      .sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
    const polygon: [number, number][] = [start];
    let current = start;

    for (let guard = 0; guard < directedEdges.length + 2; guard += 1) {
      const next = outgoing.get(key(current))?.[0];
      if (!next) return null;
      if (key(next) === key(start)) {
        return polygon.length >= 4
          ? polygonSignedArea(polygon) < 0 ? [...polygon].reverse() : polygon
          : null;
      }
      polygon.push(next);
      current = next;
    }

    return null;
  })();
  if (directedBoundary) return directedBoundary;

  const nextByPoint = new Map<string, [number, number][]>();
  for (const edge of boundaryEdges) {
    const ak = key(edge.a);
    const bk = key(edge.b);
    nextByPoint.set(ak, [...(nextByPoint.get(ak) ?? []), edge.b]);
    nextByPoint.set(bk, [...(nextByPoint.get(bk) ?? []), edge.a]);
  }
  if ([...nextByPoint.values()].some((points) => points.length !== 2)) return null;

  const start = boundaryEdges
    .flatMap((edge) => [edge.a, edge.b])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
  const polygon: [number, number][] = [start];
  let current = start;
  let previous: [number, number] | null = null;
  const usedEdges = new Set<string>();
  const normalizedEdgeKey = (a: [number, number], b: [number, number]) => {
    const ak = key(a);
    const bk = key(b);
    return ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
  };

  for (let guard = 0; guard < boundaryEdges.length + 5; guard += 1) {
    const options = nextByPoint.get(key(current)) ?? [];
    const next = options.find((point) => !previous || key(point) !== key(previous));
    if (!next) break;
    usedEdges.add(normalizedEdgeKey(current, next));
    if (key(next) === key(start)) break;
    polygon.push(next);
    previous = current;
    current = next;
  }

  if (usedEdges.size !== boundaryEdges.length) return null;
  if (polygon.length < 4) return null;
  return polygonSignedArea(polygon) < 0 ? [...polygon].reverse() : polygon;
}

function packZoneWithExactAreas(zone: PackingZone): RoomSlice[] | null {
  const slices: RoomSlice[] = [];
  const width = zone.x1 - zone.x0;
  const height = zone.y1 - zone.y0;
  if (width <= 0.01 || height <= 0.01) return [];
  const startRooms = zone.rooms.filter((room) => (room as PackedRoomLayout).__packAnchor === 'start');
  const endRooms = zone.rooms.filter((room) => (room as PackedRoomLayout).__packAnchor === 'end');
  const middleRooms = zone.rooms.filter((room) => !(room as PackedRoomLayout).__packAnchor);

  if (zone.vertical) {
    let topCursorY = zone.y1;
    for (const room of startRooms) {
      const h = room.area_m2 / width;
      const nextY = topCursorY - h;
      if (nextY < zone.y0 - 0.05) return null;
      slices.push({ room, x0: zone.x0, x1: zone.x1, y0: nextY, y1: topCursorY });
      topCursorY = nextY;
    }

    let bottomCursorY = zone.y0;
    for (const room of endRooms) {
      const h = room.area_m2 / width;
      const nextY = bottomCursorY + h;
      if (nextY > topCursorY + 0.05) return null;
      slices.push({ room, x0: zone.x0, x1: zone.x1, y0: bottomCursorY, y1: nextY });
      bottomCursorY = nextY;
    }

    for (const room of middleRooms) {
      const h = room.area_m2 / width;
      const nextY = topCursorY - h;
      if (nextY < bottomCursorY - 0.05) return null;
      slices.push({ room, x0: zone.x0, x1: zone.x1, y0: nextY, y1: topCursorY });
      topCursorY = nextY;
    }
    return slices;
  }

  let leftCursorX = zone.x0;
  for (const room of startRooms) {
    const w = room.area_m2 / height;
    const nextX = leftCursorX + w;
    if (nextX > zone.x1 + 0.05) return null;
    slices.push({ room, x0: leftCursorX, x1: nextX, y0: zone.y0, y1: zone.y1 });
    leftCursorX = nextX;
  }

  let rightCursorX = zone.x1;
  for (const room of endRooms) {
    const w = room.area_m2 / height;
    const nextX = rightCursorX - w;
    if (nextX < leftCursorX - 0.05) return null;
    slices.push({ room, x0: nextX, x1: rightCursorX, y0: zone.y0, y1: zone.y1 });
    rightCursorX = nextX;
  }

  for (const room of middleRooms) {
    const w = room.area_m2 / height;
    const nextX = leftCursorX + w;
    if (nextX > rightCursorX + 0.05) return null;
    slices.push({ room, x0: leftCursorX, x1: nextX, y0: zone.y0, y1: zone.y1 });
    leftCursorX = nextX;
  }
  return slices;
}

function buildFixedCoreExactAreaSlices(floor: FloorSpec): { width: number; depth: number; slices: RoomSlice[] } | null {
  if (!floor.coreTemplate) return null;
  const rawBaseRooms = Array.isArray(floor.rooms)
    ? floor.rooms.filter((room) => Number.isFinite(room.area_m2) && room.area_m2 > 0)
    : [];
  const baseRooms = normalizeRoomsForPlanArea(floor, rawBaseRooms);
  if (!baseRooms.length) return null;

  const { w, d } = resolveLayoutDimensions(floor);
  const coreResult = createCoreSliceForExactLayout(floor, baseRooms, w, d);
  if (!coreResult) return null;

  const zones = buildZonesAroundCoreSlice(w, d, coreResult.coreSlice);
  if (!zones.length) return null;

  if (!assignRoomsToPackingZones(zones, coreResult.nonCoreRooms)) return null;

  const slices: RoomSlice[] = [coreResult.coreSlice];
  for (const zone of zones) {
    const packed = packZoneWithExactAreas(zone);
    if (!packed) return null;
    slices.push(...packed);
  }

  return { width: w, depth: d, slices };
}

function buildRoomSlices(floor: FloorSpec): { width: number; depth: number; slices: RoomSlice[] } | null {
  if (floor.massLayoutType === 'COURTYARD_O') {
    const courtyardSlices = buildCourtyardORoomSlices(floor);
    if (courtyardSlices) return courtyardSlices;
  }

  const fixedCoreExact = buildFixedCoreExactAreaSlices(floor);
  if (fixedCoreExact) return fixedCoreExact;

  const rooms = normalizeRoomsForPlanArea(
    floor,
    simplifyRoomsForPlan(getRoomsWithFill(floor), MAX_ROOM_UNITS_PER_FLOOR),
  );
  if (!rooms.length) return null;

  const { w, d } = resolveLayoutDimensions(floor);
  const requestedRoomArea = rooms.reduce((sum, room) => sum + room.area_m2, 0);
  // Do not silently clip room polygons when the schedule cannot fit. Returning
  // null lets the caller retry with the PDF-program envelope or report a clear
  // envelope error instead of a misleading per-room mismatch.
  if (requestedRoomArea > w * d + STRICT_ROOM_AREA_TOLERANCE_M2) return null;
  const areaSortedRooms = [...rooms].sort((a, b) => b.area_m2 - a.area_m2);
  const sortedRooms = orderRoomsByLocalAdjacency(areaSortedRooms);
  const preferredLayout = normalizeLayoutTypeSafe(floor.layoutType);

  const fixedCoreSlices = buildSlicesWithFixedCore(floor, rooms, w, d);
  if (fixedCoreSlices) {
    return {
      width: w,
      depth: d,
      slices: fixedCoreSlices,
    };
  }

  if (floor.coreTemplate && rooms.some((room) => normalizeUnitType(room) === 'CORE')) {
    const approximateFixedCoreSlices = buildApproxFixedCoreRoomSlices(floor, rooms, w, d);
    if (approximateFixedCoreSlices) {
      return {
        width: w,
        depth: d,
        slices: approximateFixedCoreSlices,
      };
    }
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
    const rowHeight = Math.min(idealRowHeight, remainingDepth);
    if (rowHeight <= 0) return [];
    const y1 = cursorY;
    const y0 = y1 - rowHeight;
    let cursorX = -w / 2;

    const rowSlices: RoomSlice[] = row.map((room) => {
      const x1 = Math.min(cursorX + (room.area_m2 / rowHeight), w / 2);
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

function buildStrictRowRoomSlices(floor: FloorSpec, rooms: RoomLayout[]): { width: number; depth: number; slices: RoomSlice[] } | null {
  const { w, d } = resolveLayoutDimensions(floor);
  const totalArea = rooms.reduce((sum, room) => sum + (Number(room.area_m2) || 0), 0);
  if (!rooms.length || totalArea <= 0 || totalArea > w * d + 0.5) return null;

  const targetRowCount = Math.min(estimateTargetRowCount(rooms.length), rooms.length);
  const rows = Array.from({ length: targetRowCount }, () => ({ rooms: [] as RoomLayout[], area: 0 }));
  const orderedRooms = orderRoomsByLocalAdjacency([...rooms].sort((a, b) => b.area_m2 - a.area_m2));

  for (const room of orderedRooms) {
    const row = rows.reduce((best, candidate) => candidate.area < best.area ? candidate : best, rows[0]);
    row.rooms.push(room);
    row.area += room.area_m2;
  }

  let cursorY = d / 2;
  const slices: RoomSlice[] = [];
  for (const row of rows.filter((candidate) => candidate.rooms.length > 0)) {
    const rowHeight = row.area / w;
    if (rowHeight <= 0.01 || cursorY - rowHeight < -d / 2 - 0.05) return null;

    const y1 = cursorY;
    const y0 = y1 - rowHeight;
    let cursorX = -w / 2;
    for (const [roomIndex, room] of row.rooms.entries()) {
      const isLastRoom = roomIndex === row.rooms.length - 1;
      const x1 = isLastRoom ? w / 2 : cursorX + (room.area_m2 / rowHeight);
      if (x1 - cursorX <= 0.01) return null;
      slices.push({ room, x0: cursorX, x1, y0, y1 });
      cursorX = x1;
    }
    cursorY = y0;
  }

  return slices.length === rooms.length ? { width: w, depth: d, slices } : null;
}

function buildStrictRoomCountPreservingFloorPlan(
  floor: FloorSpec,
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean },
): NonNullable<ReturnType<typeof buildPlanFromRooms>> | null {
  const rooms = simplifyRoomsForPlan(getRoomsWithFill(floor), MAX_ROOM_UNITS_PER_FLOOR);
  if (!rooms.length) return null;

  const { w, d } = resolveLayoutDimensions(floor);
  if (floor.coreTemplate) {
    // Large programs such as parking may need to occupy several connected
    // zones around a fixed core. Try that before the ordinary one-zone packer.
    const coreWrapping = buildCoreWrappingLargeRoomSlices(floor);
    if (coreWrapping) {
      return buildPlanFromRoomSlices(floor, coreWrapping, { ...options, mergeSplitRooms: false });
    }

    const coreResult = createCoreSliceForExactLayout(floor, rooms, w, d);
    if (coreResult) {
      const zones = buildZonesAroundCoreSlice(w, d, coreResult.coreSlice);
      const orderedNonCoreRooms = orderRoomsByLocalAdjacency(coreResult.nonCoreRooms);
      if (zones.length && tryAssignRoomsWithoutSplits(zones, orderedNonCoreRooms)) {
        const slices: RoomSlice[] = [coreResult.coreSlice];
        for (const zone of zones) {
          const packed = packZoneWithExactAreas(zone);
          if (!packed) return null;
          slices.push(...packed);
        }
        if (slices.length === rooms.length) {
          return buildPlanFromRoomSlices(floor, { width: w, depth: d, slices }, options);
        }
      }
    }

    // A row layout treats every room as movable. It is never an acceptable
    // fallback for a floor that declares a fixed core: it can preserve 150m2
    // while silently moving that core into a corner.
    return null;
  }

  const rowSlices = buildStrictRowRoomSlices(floor, rooms);
  return rowSlices ? buildPlanFromRoomSlices(floor, rowSlices, options) : null;
}

export function buildFloorSpecs(building: BuildingRequirements['buildings'][number]): FloorSpec[] {
  const authorizedBasement = new Set(resolveAuthorizedFloorLabels(building, 'basement'));
  const authorizedAbove = new Set(resolveAuthorizedFloorLabels(building, 'above'));
  const misplacedBasementPlanEntries = Object.entries(building.floor_plans ?? {})
    .map(([label, rooms]) => {
      const normalized = normalizeFloorLabel(label);
      const area = Array.isArray(rooms)
        ? rooms.reduce((sum, room) => sum + (Number(room.area_m2) || 0), 0)
        : 0;
      return [normalized, area] as [string, number];
    })
    .filter(([label, area]) => isBasementFloorLabel(label) && area > 0)
    .filter(([label]) => authorizedBasement.size === 0 || authorizedBasement.has(label));
  const misplacedBasementEntries = sortedFloorEntries(building.floor_breakdown)
    .filter(([label]) => isBasementFloorLabel(label))
    .filter(([label]) => authorizedBasement.size === 0 || authorizedBasement.has(label));
  const basementEntryMap = new Map<string, number>(misplacedBasementPlanEntries);
  for (const [label, areaM2] of misplacedBasementEntries) {
    basementEntryMap.set(label, areaM2);
  }
  for (const [label, areaM2] of sortedFloorEntries(building.basement?.floor_breakdown)) {
    basementEntryMap.set(label, areaM2);
  }
  const basementEntries = [...basementEntryMap.entries()]
    .sort(([a], [b]) => floorOrder(a) - floorOrder(b))
    .filter(([label]) => authorizedBasement.size === 0 || authorizedBasement.has(label));
  const basementHeights = building.basement?.floor_heights_m ?? {};
  const floorHeights = building.floor_heights_m ?? {};
  const basementSpecs: FloorSpec[] = [];

  if (basementEntries.length > 0) {
    for (const [label, areaM2] of basementEntries) {
      const rooms =
        getFloorRecordValue(building.basement?.floor_plans, label) ??
        getFloorRecordValue(building.floor_plans, label) ??
        [];
      basementSpecs.push({
        label,
        areaM2,
        heightM: getFloorRecordValue(basementHeights, label) ?? getFloorRecordValue(floorHeights, label) ?? DEFAULT_FLOOR_HEIGHT_M,
        belowGrade: true,
        rooms,
        layoutType: normalizeLayoutTypeSafe(
          getFloorRecordValue(building.basement?.floor_layout_types, label) ??
          getFloorRecordValue(building.floor_layout_types, label),
        ),
        massLayoutType: normalizeMassLayoutType(building.mass_layout_type),
        coreTemplate: resolveCoreTemplateForFloorWithRooms(building.basement?.core_template ?? building.core_template, label, rooms),
        footprintWidthM: building.basement?.footprint_width_m ?? building.footprint_width_m,
        footprintDepthM: building.basement?.footprint_depth_m ?? building.footprint_depth_m,
      });
    }
  } else if (building.basement && building.basement.floors > 0 && building.basement.area_m2 > 0) {
    const areaPerBasementFloor = building.basement.area_m2 / building.basement.floors;
    for (let floor = building.basement.floors; floor >= 1; floor--) {
      const label = `B${floor}`;
      const rooms =
        getFloorRecordValue(building.basement?.floor_plans, label) ??
        getFloorRecordValue(building.floor_plans, label) ??
        [];
      basementSpecs.push({
        label,
        areaM2: areaPerBasementFloor,
        heightM: getFloorRecordValue(basementHeights, label) ?? getFloorRecordValue(floorHeights, label) ?? DEFAULT_FLOOR_HEIGHT_M,
        belowGrade: true,
        rooms,
        layoutType: normalizeLayoutTypeSafe(
          getFloorRecordValue(building.basement?.floor_layout_types, label) ??
          getFloorRecordValue(building.floor_layout_types, label),
        ),
        massLayoutType: normalizeMassLayoutType(building.mass_layout_type),
        coreTemplate: resolveCoreTemplateForFloorWithRooms(building.basement?.core_template ?? building.core_template, label, rooms),
        footprintWidthM: building.basement?.footprint_width_m ?? building.footprint_width_m,
        footprintDepthM: building.basement?.footprint_depth_m ?? building.footprint_depth_m,
      });
    }
  }

  const aboveEntries = sortedFloorEntries(building.floor_breakdown)
    .filter(([label]) => !isBasementFloorLabel(label))
    .filter(([label]) => authorizedAbove.size === 0 || authorizedAbove.has(label));
  const aboveSpecs: FloorSpec[] = [];

  if (aboveEntries.length > 0) {
    for (const [label, areaM2] of aboveEntries) {
      aboveSpecs.push({
        label,
        areaM2,
        heightM: getFloorRecordValue(floorHeights, label) ?? DEFAULT_FLOOR_HEIGHT_M,
        belowGrade: false,
        rooms: getFloorRecordValue(building.floor_plans, label) ?? [],
        layoutType: normalizeLayoutTypeSafe(getFloorRecordValue(building.floor_layout_types, label)),
        massLayoutType: normalizeMassLayoutType(building.mass_layout_type),
        coreTemplate: resolveCoreTemplateForFloorWithRooms(building.core_template, label, getFloorRecordValue(building.floor_plans, label) ?? []),
        footprintWidthM: building.footprint_width_m,
        footprintDepthM: building.footprint_depth_m,
      });
    }
  } else {
    for (let floor = 1; floor <= building.target_floors; floor++) {
      const label = `${floor}F`;
      aboveSpecs.push({
        label,
        areaM2: building.footprint_area,
        heightM: getFloorRecordValue(floorHeights, label) ?? DEFAULT_FLOOR_HEIGHT_M,
        belowGrade: false,
        rooms: getFloorRecordValue(building.floor_plans, label) ?? [],
        layoutType: normalizeLayoutTypeSafe(getFloorRecordValue(building.floor_layout_types, label)),
        massLayoutType: normalizeMassLayoutType(building.mass_layout_type),
        coreTemplate: resolveCoreTemplateForFloorWithRooms(building.core_template, label, getFloorRecordValue(building.floor_plans, label) ?? []),
        footprintWidthM: building.footprint_width_m,
        footprintDepthM: building.footprint_depth_m,
      });
    }
  }

  applyEnvelopeGroup(
    basementSpecs,
    building.basement?.footprint_width_m ?? building.footprint_width_m,
    building.basement?.footprint_depth_m ?? building.footprint_depth_m,
  );
  applyEnvelopeGroup(
    aboveSpecs,
    building.footprint_width_m,
    building.footprint_depth_m,
  );
  expandEnvelopeForFixedCoreCoordinates(basementSpecs);
  expandEnvelopeForFixedCoreCoordinates(aboveSpecs);

  const allSpecs = [...basementSpecs, ...aboveSpecs];
  applyCommonEnvelope(aboveSpecs);
  expandEnvelopeForFixedCoreCoordinates(aboveSpecs);
  applySharedCoreTemplate(allSpecs);
  applyCommonEnvelope(aboveSpecs);
  expandEnvelopeForFixedCoreCoordinates(aboveSpecs);
  applySharedCoreTemplate(allSpecs);
  expandEnvelopeForFixedCoreCoordinates(basementSpecs);
  expandEnvelopeForFixedCoreCoordinates(aboveSpecs);
  applySharedCoreTemplate(allSpecs);
  syncCoreRoomsToSharedTemplate(allSpecs);
  return allSpecs;
}

export function getFloorRoomSlices(
  floor: FloorSpec,
): { width: number; depth: number; slices: RoomSlice[] } | null {
  return buildRoomSlices(floor);
}

/**
 * Pure diagnostic seam for regression tests. It exercises the same generated
 * rectangular plan used by the legacy FloorStack candidates without making a
 * Forma SDK call.
 */
export function getGeneratedRectangularPlanAreaSummary(
  floor: FloorSpec,
): { unitCount: number; totalAreaM2: number; areasByFunctionId: Record<string, number> } | null {
  const plan = buildGeneratedRectangularFloorPlan(floor, {
    includeFunctionIds: true,
    includePrograms: true,
  });
  if (!plan) return null;

  const summary = planUnitAreasByFunctionId(plan);
  return {
    unitCount: plan.units.length,
    totalAreaM2: [...summary.areas.values()].reduce((sum, area) => sum + area, 0),
    areasByFunctionId: Object.fromEntries(summary.areas),
  };
}

function makeLocalRect(areaM2: number): [number, number][] {
  const { w, d } = areaToRect(areaM2);
  return makeLocalRectFromDimensions(w, d);
}

function makeLocalRectFromDimensions(w: number, d: number): [number, number][] {
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

function getCourtyardOGeometry(floor: FloorSpec): {
  w: number;
  d: number;
  innerW: number;
  innerD: number;
} {
  const { w, d } = resolveLayoutDimensions(floor);
  const courtyardRatio = 0.15;
  const innerScale = Math.sqrt(courtyardRatio);
  const minWing = Math.max(Math.min(w, d) * 0.18, 1.8);
  const innerW = clamp(w * innerScale, 1, Math.max(1, w - minWing * 2));
  const innerD = clamp(d * innerScale, 1, Math.max(1, d - minWing * 2));
  return { w, d, innerW, innerD };
}

function buildCourtyardOWingZones(floor: FloorSpec): PackingZone[] {
  const { w, d, innerW, innerD } = getCourtyardOGeometry(floor);
  const x0 = -w / 2;
  const x1 = w / 2;
  const y0 = -d / 2;
  const y1 = d / 2;
  const ix0 = -innerW / 2;
  const ix1 = innerW / 2;
  const iy0 = -innerD / 2;
  const iy1 = innerD / 2;

  return [
    { id: 'south', x0, x1, y0, y1: iy0, area: Math.max(0, w * (iy0 - y0)), used: 0, vertical: false, rooms: [] },
    { id: 'east', x0: ix1, x1, y0: iy0, y1: iy1, area: Math.max(0, (x1 - ix1) * innerD), used: 0, vertical: true, rooms: [] },
    { id: 'north', x0, x1, y0: iy1, y1, area: Math.max(0, w * (y1 - iy1)), used: 0, vertical: false, rooms: [] },
    { id: 'west', x0, x1: ix0, y0: iy0, y1: iy1, area: Math.max(0, (ix0 - x0) * innerD), used: 0, vertical: true, rooms: [] },
  ].filter((zone) => zone.area > 0.01);
}

function courtyardOWingPreference(room: RoomLayout): string | null {
  const raw = [
    (room as any).wing,
    room.name,
    room.function_id,
    room.room_id,
    normalizeUnitType(room),
  ].filter(Boolean).join(' ').toLowerCase();

  if (raw.includes('west') || raw.includes('서') || raw.includes('core') || raw.includes('코어')) return 'west';
  if (raw.includes('east') || raw.includes('동') || raw.includes('retail') || raw.includes('상가')) return 'east';
  if (raw.includes('north') || raw.includes('북') || raw.includes('child') || raw.includes('아동')) return 'north';
  if (raw.includes('south') || raw.includes('남') || raw.includes('lobby') || raw.includes('로비')) return 'south';
  return null;
}

function buildCourtyardOShellRooms(zones: PackingZone[]): RoomLayout[] {
  return zones.map((zone) => ({
    name: `${zone.id[0].toUpperCase()}${zone.id.slice(1)} Wing`,
    area_m2: zone.area,
    function_id: `${zone.id}-wing`,
    unit_type: 'LIVING_UNIT' as const,
  }));
}

function assignRoomsToCourtyardOWings(zones: PackingZone[], rooms: RoomLayout[]): boolean {
  const ordered = [...rooms].sort((a, b) => {
    const aCore = normalizeUnitType(a) === 'CORE' ? 1 : 0;
    const bCore = normalizeUnitType(b) === 'CORE' ? 1 : 0;
    return bCore - aCore || Number(b.area_m2 ?? 0) - Number(a.area_m2 ?? 0);
  });

  for (const room of ordered) {
    const preferred = courtyardOWingPreference(room);
    const candidates = [...zones]
      .filter((zone) => !preferred || zone.id === preferred)
      .sort((a, b) => (a.used / a.area) - (b.used / b.area));
    const fallbackCandidates = [...zones].sort((a, b) => (a.used / a.area) - (b.used / b.area));
    const target = [...candidates, ...fallbackCandidates].find((zone) => zone.used + room.area_m2 <= zone.area + 0.05);
    if (!target) return false;
    target.rooms.push(room);
    target.used += room.area_m2;
  }

  return true;
}

function buildCourtyardORoomSlices(floor: FloorSpec): { width: number; depth: number; slices: RoomSlice[] } | null {
  const { w, d } = getCourtyardOGeometry(floor);
  const zones = buildCourtyardOWingZones(floor);
  if (zones.length !== 4) return null;

  const explicitRooms = normalizeRoomsForPlanArea(
    floor,
    simplifyRoomsForPlan(getRoomsWithFill(floor), MAX_ROOM_UNITS_PER_FLOOR),
  );
  const rooms = explicitRooms.length > 0 ? explicitRooms : buildCourtyardOShellRooms(zones);

  if (!assignRoomsToCourtyardOWings(zones, rooms)) return null;

  const slices = zones.flatMap((zone) => buildZoneSlices(zone.rooms, zone.x0, zone.x1, zone.y0, zone.y1));
  return slices.length ? { width: w, depth: d, slices } : null;
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
    const slices = rooms.map((room) => {
      const nextX = cursorX + (room.area_m2 / height);
      const slice = { room, x0: cursorX, x1: nextX, y0, y1 };
      cursorX = nextX;
      return slice;
    });
    return slices;
  }

  let cursorY = y0;
  const slices = rooms.map((room) => {
    const nextY = cursorY + (room.area_m2 / width);
    const slice = { room, x0, x1, y0: cursorY, y1: nextY };
    cursorY = nextY;
    return slice;
  });
  return slices;
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

function sanitizeRoomPolygon(polygon?: [number, number][]): [number, number][] | null {
  if (!Array.isArray(polygon)) return null;
  const points = polygon
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map(([x, y]) => [Number(x), Number(y)] as [number, number])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));

  if (points.length < 3) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const open = Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6
    ? points.slice(0, -1)
    : points;

  return open.length >= 3 ? open : null;
}

function polygonSignedArea(points: [number, number][]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function polygonAreaM2(points: [number, number][]): number {
  return Math.abs(polygonSignedArea(points));
}

function polygonBounds(points: [number, number][]): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function polygonBoundsOverlapArea(a: [number, number][], b: [number, number][]): number {
  const ab = polygonBounds(a);
  const bb = polygonBounds(b);
  const x = Math.max(0, Math.min(ab.maxX, bb.maxX) - Math.max(ab.minX, bb.minX));
  const y = Math.max(0, Math.min(ab.maxY, bb.maxY) - Math.max(ab.minY, bb.minY));
  return x * y;
}

function pointOnSegment(
  point: [number, number],
  a: [number, number],
  b: [number, number],
): boolean {
  const cross = (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);
  if (Math.abs(cross) > 1e-6) return false;

  const dot = (point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1]);
  if (dot < -1e-6) return false;

  const lengthSq = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return dot <= lengthSq + 1e-6;
}

function pointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
  if (polygon.length < 3) return false;

  for (let i = 0; i < polygon.length; i += 1) {
    if (pointOnSegment(point, polygon[i], polygon[(i + 1) % polygon.length])) {
      return true;
    }
  }

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = ((yi > point[1]) !== (yj > point[1]))
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }

  return inside;
}

function exactPolygonPriority(room: RoomLayout, polygonArea: number): number {
  const unitType = normalizeUnitType(room);
  if (unitType === 'CORE') return 3_000_000 - polygonArea;
  if (unitType === 'CORRIDOR') return 2_000_000 - polygonArea;
  return 1_000_000 - polygonArea;
}

function summarizePolygonAreaMismatches(floors: FloorSpec[]): string[] {
  const messages: string[] = [];
  for (const floor of floors) {
    for (const room of floor.rooms) {
      const polygon = sanitizeRoomPolygon(room.polygon);
      if (!polygon) continue;
      const declaredArea = Number(room.area_m2);
      const polygonArea = polygonAreaM2(polygon);
      if (!Number.isFinite(declaredArea) || declaredArea <= 0 || polygonArea <= 0) continue;
      const diffRatio = Math.abs(polygonArea - declaredArea) / declaredArea;
      if (diffRatio > 0.03) {
        messages.push(
          `${floor.label} ${room.name}: declared ${declaredArea.toFixed(2)}m2, polygon ${polygonArea.toFixed(2)}m2`,
        );
      }
    }
  }
  return messages;
}

function summarizeRoomRelationConflicts(floors: FloorSpec[]): string[] {
  const messages: string[] = [];
  for (const floor of floors) {
    for (const room of floor.rooms) {
      const required = new Set([...(room.required_adjacency ?? []), ...(room.adjacent_to ?? [])].map((value) => String(value).trim()).filter(Boolean));
      const avoid = new Set((room.avoid_adjacency ?? []).map((value) => String(value).trim()).filter(Boolean));
      const conflicts = [...required].filter((key) => avoid.has(key));
      if (conflicts.length > 0) {
        messages.push(`${floor.label} ${room.name}: required and avoid both include ${conflicts.join(', ')}`);
      }
    }
  }
  return messages;
}

function summarizeFloorPlanGenerationFailures(
  floors: FloorSpec[],
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean },
): string[] {
  return floors
    .filter((floor) => getRoomsWithFill(floor).length > 0 && !buildPlanFromRooms(floor, options))
    .map((floor) => {
      const roomCount = getRoomsWithFill(floor).length;
      const area = effectivePlanAreaM2(floor);
      const core = floor.coreTemplate ? 'fixed core' : 'no core';
      return `${floor.label}: room plan generation failed (${roomCount} rooms, ${area.toFixed(2)}m2, ${core}; ${diagnoseRoomPlanFailure(floor)})`;
    });
}

function diagnoseRoomPlanFailure(floor: FloorSpec): string {
  if (!floor.coreTemplate) return 'missing core template';
  const rawBaseRooms = Array.isArray(floor.rooms)
    ? floor.rooms.filter((room) => Number.isFinite(room.area_m2) && room.area_m2 > 0)
    : [];
  const baseRooms = normalizeRoomsForPlanArea(floor, rawBaseRooms);
  if (!baseRooms.length) return 'no positive-area rooms';

  const { w, d } = resolveLayoutDimensions(floor);
  const coreResult = createCoreSliceForExactLayout(floor, baseRooms, w, d);
  if (!coreResult) return `core outside envelope or invalid core (${w.toFixed(2)}m x ${d.toFixed(2)}m)`;

  const zones = buildZonesAroundCoreSlice(w, d, coreResult.coreSlice);
  if (!zones.length) return 'no usable zones around fixed core';

  const testZones = zones.map((zone) => ({ ...zone, used: 0, rooms: [] as RoomLayout[] }));
  if (!assignRoomsToPackingZones(testZones, coreResult.nonCoreRooms)) {
    const capacities = testZones
      .map((zone) => `${zone.id}:${zone.area.toFixed(1)}m2`)
      .join(',');
    const rooms = coreResult.nonCoreRooms
      .map((room) => `${room.name}:${Number(room.area_m2).toFixed(1)}m2`)
      .join(',');
    return `zone assignment failed (zones ${capacities}; rooms ${rooms})`;
  }

  const slices: RoomSlice[] = [coreResult.coreSlice];
  for (const zone of testZones) {
    const packed = packZoneWithExactAreas(zone);
    if (!packed) return `zone packing failed (${zone.id})`;
    slices.push(...packed);
  }

  const grouped = new Map<string, RoomSlice[]>();
  for (const [sliceIndex, slice] of slices.entries()) {
    if (Math.abs(slice.x1 - slice.x0) < 0.01 || Math.abs(slice.y1 - slice.y0) < 0.01) continue;
    const splitGroupKey = (slice.room as PackedRoomLayout).__splitGroupKey;
    const groupKey = splitGroupKey ?? `single:${sliceIndex}:${roomSliceGroupKey(slice.room)}`;
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), slice]);
  }

  for (const [groupKey, groupSlices] of grouped.entries()) {
    if (groupSlices.length <= 1) continue;
    if (!mergeRectSlicesToPolygon(groupSlices)) {
      const area = groupSlices.reduce((sum, slice) => sum + Math.abs((slice.x1 - slice.x0) * (slice.y1 - slice.y0)), 0);
      return `split merge failed (${groupKey}, ${groupSlices.length} pieces, ${area.toFixed(1)}m2)`;
    }
  }

  return 'unknown plan serialization failure';
}

function floorHasCompleteRoomPolygons(floor: FloorSpec): boolean {
  const positiveRooms = floor.rooms.filter((room) => Number.isFinite(room.area_m2) && room.area_m2 > 0);
  return positiveRooms.length > 0 && positiveRooms.every((room) => Boolean(sanitizeRoomPolygon(room.polygon)));
}

function safeFloorToken(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9]/g, '') || 'Floor';
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `F${cleaned}`;
}

function buildPlanFromExactRoomPolygons(
  floor: FloorSpec,
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean },
): NonNullable<ReturnType<typeof buildPlanFromRooms>> | null {
  const positiveRooms = floor.rooms.filter((room) => Number.isFinite(room.area_m2) && room.area_m2 > 0);
  const polygonRooms = floor.rooms
    .map((room) => ({ room, polygon: sanitizeRoomPolygon(room.polygon) }))
    .filter((entry): entry is { room: RoomLayout; polygon: [number, number][] } =>
      Boolean(entry.polygon) && Number.isFinite(entry.room.area_m2) && entry.room.area_m2 > 0,
    );

  if (!polygonRooms.length) return null;
  if (positiveRooms.length !== polygonRooms.length) return null;

  const allPoints = polygonRooms.flatMap(({ polygon }) => polygon);
  const bounds = polygonBounds(allPoints);
  const originX = (bounds.minX + bounds.maxX) / 2;
  const originY = (bounds.minY + bounds.maxY) / 2;
  const envelopeWidth = Math.max(Number(floor.envelopeWidthM) || 0, bounds.maxX - bounds.minX);
  const envelopeDepth = Math.max(Number(floor.envelopeDepthM) || 0, bounds.maxY - bounds.minY);
  const normalizedPolygonRooms = polygonRooms
    .map(({ room, polygon }) => ({
      room,
      polygon: polygon.map(([x, y]) => [x - originX, y - originY] as [number, number]),
      area: polygonAreaM2(polygon),
    }))
    .filter(({ area }) => area > 0.001);

  if (!normalizedPolygonRooms.length) return null;
  const polygonAreaTotal = normalizedPolygonRooms.reduce((sum, entry) => sum + entry.area, 0);
  if (Math.abs(polygonAreaTotal - floor.areaM2) / Math.max(floor.areaM2, 1) > 0.05) return null;

  const vertices: { id: string; x: number; y: number }[] = [];
  const units: {
    polygon: string[];
    program?: 'CORE' | 'CORRIDOR' | 'LIVING_UNIT' | 'PARKING';
    functionId?: string;
    holes: string[][];
  }[] = [];
  const vertexIdsByCoord = new Map<string, string>();
  const safeLabel = safeFloorToken(floor.label);

  const vertexId = (x: number, y: number): string => {
    const key = `${x.toFixed(6)},${y.toFixed(6)}`;
    const existing = vertexIdsByCoord.get(key);
    if (existing) return existing;

    const id = `${safeLabel}_v${vertices.length + 1}`;
    vertexIdsByCoord.set(key, id);
    vertices.push({ id, x, y });
    return id;
  };

  const roundCoord = (value: number): number => parseFloat(value.toFixed(6));
  const uniqueSorted = (values: number[]): number[] =>
    [...new Set(values.map(roundCoord))].sort((a, b) => a - b);
  const gridX = uniqueSorted([
    -envelopeWidth / 2,
    envelopeWidth / 2,
    ...normalizedPolygonRooms.flatMap(({ polygon }) => polygon.map(([x]) => x)),
  ]);
  const gridY = uniqueSorted([
    -envelopeDepth / 2,
    envelopeDepth / 2,
    ...normalizedPolygonRooms.flatMap(({ polygon }) => polygon.map(([, y]) => y)),
  ]);

  if (gridX.length < 2 || gridY.length < 2) return null;
  const between = (value: number, min: number, max: number): boolean =>
    value > min + 1e-6 && value < max - 1e-6;
  const rectPolygonIds = (x0: number, x1: number, y0: number, y1: number): string[] => {
    const minX = roundCoord(Math.min(x0, x1));
    const maxX = roundCoord(Math.max(x0, x1));
    const minY = roundCoord(Math.min(y0, y1));
    const maxY = roundCoord(Math.max(y0, y1));
    const xs = gridX.filter((x) => between(x, minX, maxX));
    const ys = gridY.filter((y) => between(y, minY, maxY));
    return ([
      [minX, minY],
      ...xs.map((x) => [x, minY] as [number, number]),
      [maxX, minY],
      ...ys.map((y) => [maxX, y] as [number, number]),
      [maxX, maxY],
      ...[...xs].reverse().map((x) => [x, maxY] as [number, number]),
      [minX, maxY],
      ...[...ys].reverse().map((y) => [minX, y] as [number, number]),
    ] as [number, number][]).map(([x, y]) => vertexId(x, y));
  };

  const ownerByCell = new Map<string, RoomLayout>();
  for (let xi = 0; xi < gridX.length - 1; xi += 1) {
    const x0 = gridX[xi];
    const x1 = gridX[xi + 1];
    if (x1 - x0 <= 0.01) continue;

    for (let yi = 0; yi < gridY.length - 1; yi += 1) {
      const y0 = gridY[yi];
      const y1 = gridY[yi + 1];
      if (y1 - y0 <= 0.01) continue;

      const center: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
      const containingRooms = normalizedPolygonRooms
        .filter(({ polygon }) => pointInPolygon(center, polygon))
        .sort((a, b) => exactPolygonPriority(b.room, b.area) - exactPolygonPriority(a.room, a.area));
      const owner = containingRooms[0]?.room;
      if (owner) ownerByCell.set(`${xi},${yi}`, owner);
    }
  }

  const used = new Set<string>();
  for (let yi = 0; yi < gridY.length - 1; yi += 1) {
    for (let xi = 0; xi < gridX.length - 1; xi += 1) {
      const startKey = `${xi},${yi}`;
      const owner = ownerByCell.get(startKey);
      if (!owner || used.has(startKey)) continue;

      let widthCells = 1;
      while (
        xi + widthCells < gridX.length - 1 &&
        ownerByCell.get(`${xi + widthCells},${yi}`) === owner &&
        !used.has(`${xi + widthCells},${yi}`)
      ) {
        widthCells += 1;
      }

      let heightCells = 1;
      let canGrow = true;
      while (yi + heightCells < gridY.length - 1 && canGrow) {
        for (let x = xi; x < xi + widthCells; x += 1) {
          const key = `${x},${yi + heightCells}`;
          if (ownerByCell.get(key) !== owner || used.has(key)) {
            canGrow = false;
            break;
          }
        }
        if (canGrow) heightCells += 1;
      }

      for (let x = xi; x < xi + widthCells; x += 1) {
        for (let y = yi; y < yi + heightCells; y += 1) {
          used.add(`${x},${y}`);
        }
      }

      const x0 = gridX[xi];
      const x1 = gridX[xi + widthCells];
      const y0 = gridY[yi];
      const y1 = gridY[yi + heightCells];
      if (x1 - x0 <= 0.01 || y1 - y0 <= 0.01) continue;

      units.push({
        polygon: rectPolygonIds(x0, x1, y0, y1),
        ...(options?.includePrograms === false ? {} : { program: normalizeUnitType(owner) }),
        ...(options?.includeFunctionIds === false ? {} : { functionId: normalizeFunctionId(owner) }),
        holes: [],
      });
    }
  }

  if (!units.length) return null;

  return {
    id: `plan-${safeLabel}`,
    vertices,
    units,
  };
}

function buildPlanFromRooms(
  floor: FloorSpec,
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean; mergeSplitRooms?: boolean },
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

  return buildPlanFromRoomSlices(floor, roomSlices, options);
}

function buildPlanFromRoomSlices(
  floor: FloorSpec,
  roomSlices: { width: number; depth: number; slices: RoomSlice[] },
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean; mergeSplitRooms?: boolean },
): NonNullable<ReturnType<typeof buildPlanFromRooms>> | null {
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

    const id = `${safeFloorToken(floor.label)}_v${vertices.length + 1}`;
    vertexIdsByCoord.set(key, id);
    vertices.push({ id, x, y });
    return id;
  };

  const roundCoord = (value: number): number => parseFloat(value.toFixed(6));
  const rectPolygonIds = (x0: number, x1: number, y0: number, y1: number): string[] => {
    const minX = roundCoord(Math.min(x0, x1));
    const maxX = roundCoord(Math.max(x0, x1));
    const minY = roundCoord(Math.min(y0, y1));
    const maxY = roundCoord(Math.max(y0, y1));
    return ([
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ] as [number, number][]).map(([x, y]) => vertexId(x, y));
  };
  const polygonIds = (polygon: [number, number][]): string[] =>
    polygon.map(([x, y]) => vertexId(roundCoord(x), roundCoord(y)));

  const grouped = new Map<string, RoomSlice[]>();
  for (const [sliceIndex, slice] of roomSlices.slices.entries()) {
    if (Math.abs(slice.x1 - slice.x0) < 0.01 || Math.abs(slice.y1 - slice.y0) < 0.01) continue;
    const splitGroupKey = (slice.room as PackedRoomLayout).__splitGroupKey;
    const groupKey = splitGroupKey ?? `single:${sliceIndex}:${roomSliceGroupKey(slice.room)}`;
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), slice]);
  }

  for (const slices of grouped.values()) {
    const room = slices[0].room;
    const mergedPolygon = options?.mergeSplitRooms === false ? null : mergeRectSlicesToPolygon(slices);
    if (slices.length > 1 && !mergedPolygon) return null;
    const polygons = mergedPolygon ? [mergedPolygon] : slices.map(sliceRectPolygon);
    for (const polygon of polygons) {
      const ids = polygonIds(polygon);
    units.push({
      polygon: ids,
      ...(options?.includePrograms === false ? {} : { program: normalizeUnitType(room) }),
      ...(options?.includeFunctionIds === false ? {} : { functionId: normalizeFunctionId(room) }),
      holes: [],
    });
    }
  }

  if (!units.length) return null;

  return {
    id: `plan-${safeFloorToken(floor.label)}`,
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
  if (slice.polygon && slice.polygon.length >= 4) {
    return slice.polygon.map(([x, y]) => [
      cx + (isGeo ? mToLon(x, cy) : x),
      cy + (isGeo ? mToLat(y) : y),
    ]);
  }

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

function envelopeForFloor(
  floor: FloorSpec,
  bounds: Bounds,
  floorEnvelopes?: ReadonlyMap<string, FloorEnvelope>,
): FloorEnvelope {
  const captured = floorEnvelopes?.get(floor.label);
  if (captured) return captured;
  const widthM = Math.max(bounds.siteWidth, 1);
  const depthM = Math.max(bounds.siteHeight, 1);
  return { widthM, depthM, areaM2: widthM * depthM };
}

function applyExistingEnvelopeToFloorSpecs(
  floorSpecs: FloorSpec[],
  bounds: Bounds,
  floorEnvelopes?: ReadonlyMap<string, FloorEnvelope>,
): FloorSpec[] {

  return floorSpecs.map((floor) => {
    const envelope = envelopeForFloor(floor, bounds, floorEnvelopes);
    const width = envelope.widthM;
    const depth = envelope.depthM;
    const area = envelope.areaM2;
    const explicitRoomArea = getRoomsWithFill(floor)
      .reduce((sum, room) => sum + (Number(room.area_m2) || 0), 0);
    const sourceArea = Math.max(massFootprintAreaM2(floor), explicitRoomArea, 1);
    const areaTolerance = Math.max(sourceArea * 0.05, STRICT_ROOM_AREA_TOLERANCE_M2);
    const canUseExistingEnvelope = explicitRoomArea <= area + areaTolerance;

    if (!canUseExistingEnvelope) {
      return {
        ...floor,
        massLayoutType: 'RECTANGLE' as const,
        preserveRoomAreas: true,
      };
    }

    return {
      ...floor,
      areaM2: area,
      footprintWidthM: width,
      footprintDepthM: depth,
      envelopeWidthM: width,
      envelopeDepthM: depth,
      refFootprintWidthM: width,
      refFootprintDepthM: depth,
      massLayoutType: 'RECTANGLE' as const,
      preserveRoomAreas: true,
    };
  });
}

/**
 * During PDF-program regeneration, the declared room schedule is the geometry
 * authority. If a stale working envelope is smaller than that schedule, rebuild
 * the working rectangle before generating candidates. This is limited to
 * preserveRoomAreas so ordinary mass generation can still retain unassigned area.
 */
function ensureRoomProgramFitsWorkingEnvelope(floor: FloorSpec): FloorSpec {
  if (!floor.preserveRoomAreas) return floor;

  const roomArea = getRoomsWithFill(floor)
    .reduce((sum, room) => sum + Number(room.area_m2), 0);
  const envelopeArea = massFootprintAreaM2(floor);
  const tolerance = Math.max(roomArea * STRICT_ROOM_AREA_TOLERANCE_RATIO, STRICT_ROOM_AREA_TOLERANCE_M2);
  if (!Number.isFinite(roomArea) || roomArea <= envelopeArea + tolerance) return floor;

  const dimensions = areaToRect(roomArea);
  return {
    ...floor,
    areaM2: roomArea,
    footprintWidthM: dimensions.w,
    footprintDepthM: dimensions.d,
    envelopeWidthM: dimensions.w,
    envelopeDepthM: dimensions.d,
    refFootprintWidthM: dimensions.w,
    refFootprintDepthM: dimensions.d,
  };
}

function describeFloorPlanWorkingInput(floor: FloorSpec): string {
  const rooms = getRoomsWithFill(floor);
  const roomArea = rooms.reduce((sum, room) => sum + Number(room.area_m2), 0);
  const { w, d } = resolveLayoutDimensions(floor);
  const core = rooms.find((room) => normalizeUnitType(room) === 'CORE');
  const roomList = rooms
    .slice(0, 8)
    .map((room) => `${room.room_id ?? room.function_id ?? room.name}=${Number(room.area_m2).toFixed(2)}`)
    .join(', ');
  return `[${FLOORSTACK_REGEN_DIAGNOSTIC_VERSION}] ${floor.label}: ` +
    `floorArea=${Number(floor.areaM2).toFixed(2)}m2, roomSum=${roomArea.toFixed(2)}m2 (${rooms.length} rooms), ` +
    `workingEnvelope=${w.toFixed(2)}m x ${d.toFixed(2)}m = ${(w * d).toFixed(2)}m2, ` +
    `preserveRoomAreas=${Boolean(floor.preserveRoomAreas)}, core=${core ? `${core.room_id ?? core.function_id ?? core.name}=${Number(core.area_m2).toFixed(2)}m2` : 'none'}, ` +
    `rooms=[${roomList}${rooms.length > 8 ? ', ...' : ''}]`;
}

function validateExistingEnvelopeProgram(
  floorSpecs: FloorSpec[],
  bounds: Bounds,
  floorEnvelopes?: ReadonlyMap<string, FloorEnvelope>,
): string[] {
  const errors: string[] = [];

  for (const floor of floorSpecs) {
    const availableArea = envelopeForFloor(floor, bounds, floorEnvelopes).areaM2;
    const rooms = getRoomsWithFill(floor).filter((room) => Number(room.area_m2) > 0);
    if (!rooms.length) continue;

    const declaredArea = rooms.reduce((sum, room) => sum + Number(room.area_m2), 0);
    const tolerance = Math.max(declaredArea * 0.03, STRICT_ROOM_AREA_TOLERANCE_M2);
    if (declaredArea > availableArea + tolerance) {
      errors.push(
        `${floor.label}: room schedule requires ${declaredArea.toFixed(2)}m2, ` +
        `but the selected mass envelope provides only ${availableArea.toFixed(2)}m2.`,
      );
    }

    const oversized = rooms
      .filter((room) => Number(room.area_m2) > availableArea + STRICT_ROOM_AREA_TOLERANCE_M2)
      .map((room) => `${room.room_id ?? room.name} ${Number(room.area_m2).toFixed(2)}m2`);
    if (oversized.length > 0) {
      errors.push(
        `${floor.label}: a single room exceeds the selected mass envelope (${oversized.join(', ')}).`,
      );
    }
  }

  return errors;
}

async function buildExistingEnvelopeFloorStack(
  building: BuildingRequirements['buildings'][number],
  bounds: Bounds,
  floorEnvelopes?: ReadonlyMap<string, FloorEnvelope>,
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean },
): Promise<{
  floors: Array<{ polygon: [number, number][]; height: number } | { planId: string; height: number }>;
  plans: NonNullable<ReturnType<typeof buildPlanFromRooms>>[];
  floorSpecs: FloorSpec[];
  roomUnits: number;
  warnings: string[];
}> {
  const sourceFloorSpecs = buildFloorSpecs(building);
  const feasibilityErrors = validateExistingEnvelopeProgram(sourceFloorSpecs, bounds, floorEnvelopes);
  if (feasibilityErrors.length > 0) {
    throw new Error(
      `${building.name}: selected mass cannot contain the PDF room program without changing its footprint. ` +
      feasibilityErrors.slice(0, 4).join(' | '),
    );
  }

  const floorSpecs = applyExistingEnvelopeToFloorSpecs(sourceFloorSpecs, bounds, floorEnvelopes);
  const compatible = await buildCompatibleSingleStack(building, floorSpecs);
  const hasExplicitRooms = countExplicitRoomPlanRooms(building) > 0;

  return {
    floors: compatible.floors,
    plans: compatible.plans,
    floorSpecs,
    roomUnits: hasExplicitRooms ? compatible.roomUnits : 0,
    warnings: compatible.warnings,
  };
}

function countExplicitRoomPlanRooms(building: BuildingRequirements['buildings'][number]): number {
  const countRooms = (plans?: Record<string, RoomLayout[]>): number =>
    Object.values(plans ?? {}).reduce(
      (sum, rooms) =>
        sum +
        (Array.isArray(rooms)
          ? rooms.filter((room) => Number.isFinite(Number(room.area_m2)) && Number(room.area_m2) > 0).length
          : 0),
      0,
    );

  return countRooms(building.floor_plans) + countRooms(building.basement?.floor_plans);
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

  // On sloped terrain, a single sampled point can float the mass above or below the ground.
  // Prefer the upper local value to keep the building base aligned with the terrain surface.
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

/** Returns elevation only when the query point is covered by the supplied mesh. */
export function sampleContainingElevationFromTriangles(
  triangles: ArrayLike<number>,
  x: number,
  y: number,
): number | null {
  let bestContainingZ: number | null = null;
  for (let i = 0; i + 8 < triangles.length; i += 9) {
    const triZ = barycentricZAtPoint(
      x, y,
      triangles[i], triangles[i + 1], triangles[i + 2],
      triangles[i + 3], triangles[i + 4], triangles[i + 5],
      triangles[i + 6], triangles[i + 7], triangles[i + 8],
    );
    if (triZ !== null) {
      bestContainingZ = bestContainingZ === null ? triZ : Math.max(bestContainingZ, triZ);
    }
  }
  return bestContainingZ;
}

async function sampleLocalElevationFromMesh(path: string, x: number, y: number): Promise<number | null> {
  try {
    const triangles = await Forma.geometry.getTriangles({ path });
    if (!triangles || triangles.length < 9) return null;
    // Never borrow Z from a remote mesh tile or neighbouring element.
    return sampleContainingElevationFromTriangles(triangles, x, y);
  } catch {
    return null;
  }
}


// Public interface.
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
  confirmation: {
    buildingLayer: boolean;
    visibleVolume: boolean;
    worldTransform: boolean;
    nonVirtual: boolean;
    actualTransformZ: number;
  };
  debug: {
    siteSourcePath: string;
    elevationSourcePath: string;
    baseElevation: number;
    localMeshElevation: number | null;
  };
  componentId?: string;
  componentType?: string;
  parentComponentId?: string | null;
  startFloor?: string;
  endFloor?: string;
  belowGrade?: boolean;
}

export interface PlaceResult {
  placed: PlacedMassInfo[];
  warnings: string[];
  siteReference: string;
  totalFootprint: number;
  coverageRatio: number;
}

function buildPlansFromFloorSpecs(
  floorSpecs: FloorSpec[],
  building: BuildingRequirements['buildings'][number],
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean },
): {
  floors: Array<{ polygon: [number, number][]; height: number } | { planId: string; height: number }>;
  plans: NonNullable<ReturnType<typeof buildPlanFromRooms>>[];
} {
  const plans: NonNullable<ReturnType<typeof buildPlanFromRooms>>[] = [];
  const floors: Array<{ polygon: [number, number][]; height: number } | { planId: string; height: number }> = [];
  for (const [index, floor] of floorSpecs.entries()) {
    const plan = floorHasCompleteRoomPolygons(floor)
      ? buildPlanFromExactRoomPolygons(floor, options) ?? buildPlanFromRooms(floor, options)
      : buildPlanFromRooms(floor, options);
    if (!plan) {
      const hasExplicitRooms = getRoomsWithFill(floor).length > 0;
      if (hasExplicitRooms) {
        return { floors: [], plans: [] };
      }
      floors.push({ polygon: getLocalFootprintPolygon(building, floor.areaM2), height: floor.heightM });
      continue;
    }

    const uniquePlan = { ...plan, id: `${plan.id}-${index + 1}` };
    plans.push(uniquePlan);
    floors.push({ planId: uniquePlan.id, height: floor.heightM });
  }
  return { floors, plans };
}

function createFloorsAndPlans(
  building: BuildingRequirements['buildings'][number],
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean; forceRectangularEnvelope?: boolean },
): {
  floors: Array<{ polygon: [number, number][]; height: number } | { planId: string; height: number }>;
  plans: NonNullable<ReturnType<typeof buildPlanFromRooms>>[];
  floorSpecs: FloorSpec[];
  basementStack?: {
    floors: Array<{ polygon: [number, number][]; height: number } | { planId: string; height: number }>;
    plans: NonNullable<ReturnType<typeof buildPlanFromRooms>>[];
    floorSpecs: FloorSpec[];
  };
  aboveStack?: {
    floors: Array<{ polygon: [number, number][]; height: number } | { planId: string; height: number }>;
    plans: NonNullable<ReturnType<typeof buildPlanFromRooms>>[];
    floorSpecs: FloorSpec[];
  };
} {
  const floorSpecs = options?.forceRectangularEnvelope
    ? buildFloorSpecs(building).map((floor) => ({ ...floor, massLayoutType: 'RECTANGLE' as const }))
    : buildFloorSpecs(building);
  const footprintBuilding = options?.forceRectangularEnvelope
    ? { ...building, mass_layout_type: 'RECTANGLE' as const }
    : building;
  const basementSpecs = floorSpecs.filter((floor) => floor.belowGrade);
  const aboveSpecs = floorSpecs.filter((floor) => !floor.belowGrade);
  const basementStack = basementSpecs.length
    ? { ...buildPlansFromFloorSpecs(basementSpecs, footprintBuilding, options), floorSpecs: basementSpecs }
    : undefined;
  const aboveStack = aboveSpecs.length
    ? { ...buildPlansFromFloorSpecs(aboveSpecs, footprintBuilding, options), floorSpecs: aboveSpecs }
    : undefined;
  const combined = buildPlansFromFloorSpecs(floorSpecs, footprintBuilding, options);

  return {
    ...combined,
    floorSpecs,
    basementStack,
    aboveStack,
  };
}

function buildSimplifiedCoreFloorPlan(
  floor: FloorSpec,
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean },
): NonNullable<ReturnType<typeof buildPlanFromRooms>> | null {
  if (!floor.coreTemplate) return null;
  const coreRooms = floor.rooms.filter((room) => normalizeUnitType(room) === 'CORE');
  const otherRooms = floor.rooms.filter((room) => normalizeUnitType(room) !== 'CORE');
  const coreArea = Math.max(
    Number(floor.coreTemplate.width_m) * Number(floor.coreTemplate.depth_m),
    coreRooms[0]?.area_m2 ?? 0,
    1,
  );
  const coreRoom = coreRooms[0] ?? {
    name: floor.coreTemplate.room_name ?? 'Core',
    area_m2: coreArea,
    function_id: floor.coreTemplate.function_id ?? 'core',
    unit_type: 'CORE' as const,
  };
  const otherArea = otherRooms.length > 0
    ? otherRooms.reduce((sum, room) => sum + Number(room.area_m2 ?? 0), 0)
    : Math.max(1, floor.areaM2 - coreArea);
  if (otherArea <= 0) return null;

  const simplifiedFloor: FloorSpec = {
    ...floor,
    rooms: [
      coreRoom,
      {
        name: 'Other Rooms',
        area_m2: otherArea,
        function_id: 'other-rooms',
        unit_type: 'LIVING_UNIT',
      },
    ],
  };

  return buildPlanFromRooms(simplifiedFloor, options);
}

function buildGeneratedRectangularFloorPlan(
  floor: FloorSpec,
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean; mergeSplitRooms?: boolean },
): NonNullable<ReturnType<typeof buildPlanFromRooms>> | null {
  return buildPlanFromRooms(
    {
      ...floor,
      massLayoutType: 'RECTANGLE',
      rooms: floor.rooms.map((room) => ({ ...room, polygon: undefined })),
    },
    options,
  );
}

function buildCoreWrappingLargeRoomFloorPlan(
  floor: FloorSpec,
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean; mergeSplitRooms?: boolean },
): NonNullable<ReturnType<typeof buildPlanFromRooms>> | null {
  const rectangularFloor = {
    ...floor,
    massLayoutType: 'RECTANGLE',
    rooms: floor.rooms.map((room) => ({ ...room, polygon: undefined })),
  } as FloorSpec;
  const coreWrappingSlices = buildCoreWrappingLargeRoomSlices(rectangularFloor);
  if (!coreWrappingSlices) return null;

  return buildPlanFromRoomSlices(rectangularFloor, coreWrappingSlices, options);
}

function buildSingleUnitFloorPlan(
  floor: FloorSpec,
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean },
): NonNullable<ReturnType<typeof buildPlanFromRooms>> | null {
  const { w, d } = resolveLayoutDimensions(floor);
  const room: RoomLayout = {
    name: `${floor.label} Floor`,
    area_m2: Math.max(w * d, floor.areaM2, 1),
    function_id: 'floor',
    unit_type: 'LIVING_UNIT',
  };
  const safeLabel = safeFloorToken(floor.label);

  const plan: NonNullable<ReturnType<typeof buildPlanFromRooms>> = {
    id: `plan-${safeLabel}`,
    vertices: [
      { id: `${safeLabel}_v1`, x: -w / 2, y: -d / 2 },
      { id: `${safeLabel}_v2`, x: w / 2, y: -d / 2 },
      { id: `${safeLabel}_v3`, x: w / 2, y: d / 2 },
      { id: `${safeLabel}_v4`, x: -w / 2, y: d / 2 },
    ],
    units: [{
      polygon: [
        `${safeLabel}_v1`,
        `${safeLabel}_v2`,
        `${safeLabel}_v3`,
        `${safeLabel}_v4`,
      ],
      ...(options?.includePrograms === false ? {} : { program: 'LIVING_UNIT' }),
      ...(options?.includeFunctionIds === false ? {} : { functionId: normalizeFunctionId(room) }),
      holes: [],
    }],
  };

  return plan;
}

function buildLooseRoomFloorPlan(
  floor: FloorSpec,
  options?: { includeFunctionIds?: boolean; includePrograms?: boolean },
): NonNullable<ReturnType<typeof buildPlanFromRooms>> | null {
  const rooms = getRoomsWithFill(floor);
  if (!rooms.length) return null;

  return buildPlanFromRooms(
    {
      ...floor,
      layoutType: 'ROW_LAYOUT',
      rooms,
    },
    options,
  );
}

function buildSingleUnitPlanFromFloorObject(
  label: string,
  floor: { polygon?: [number, number][]; height: number } | { planId: string; height: number },
): FloorStackPlan {
  const safeLabel = safeFloorToken(label);
  const polygon = 'polygon' in floor && Array.isArray(floor.polygon) && floor.polygon.length >= 4
    ? floor.polygon.slice(0, 4)
    : makeLocalRect(100);
  const vertices = polygon.map(([x, y], index) => ({
    id: `${safeLabel}_v${index + 1}`,
    x,
    y,
  }));

  return {
    id: `plan-${safeLabel}`,
    vertices,
    units: [{
      polygon: vertices.map((vertex) => vertex.id),
      program: 'LIVING_UNIT',
      holes: [],
    }],
  };
}

// Main functions.
/**
 * Places 3D building masses in Forma from building planning parameters.
 *
 * - Creates actual building elements through FloorStack/proposal APIs.
 * - Adds them to the Buildings layer.
 * - Does not count temporary render.geojson overlays as generated masses.
 */
type FloorStackPlan = NonNullable<ReturnType<typeof buildPlanFromRooms>>;

function stripPlanFunctionIds(plan: FloorStackPlan): FloorStackPlan {
  return {
    ...plan,
    units: plan.units.map(({ functionId: _functionId, ...unit }) => unit),
  };
}

function planUnitPolygonArea(plan: FloorStackPlan, unit: FloorStackPlan['units'][number]): number | null {
  const verticesById = new Map(
    plan.vertices.map((vertex) => [vertex.id, [Number(vertex.x), Number(vertex.y)] as [number, number]]),
  );
  const polygon = unit.polygon
    .map((vertexId) => verticesById.get(vertexId))
    .filter((point): point is [number, number] =>
      Boolean(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]),
    );
  if (polygon.length !== unit.polygon.length || polygon.length < 3) return null;
  return polygonAreaM2(polygon);
}

function planUnitAreaSummary(plan: FloorStackPlan): { totalArea: number; invalidUnits: number } {
  return plan.units.reduce(
    (summary, unit) => {
      const area = planUnitPolygonArea(plan, unit);
      if (area === null || !Number.isFinite(area) || area <= 0) {
        return { ...summary, invalidUnits: summary.invalidUnits + 1 };
      }
      return { ...summary, totalArea: summary.totalArea + area };
    },
    { totalArea: 0, invalidUnits: 0 },
  );
}

function planUnitAreasByFunctionId(plan: FloorStackPlan): {
  areas: Map<string, number>;
  missingFunctionIds: number;
  invalidUnits: number;
} {
  const areas = new Map<string, number>();
  let missingFunctionIds = 0;
  let invalidUnits = 0;

  for (const unit of plan.units) {
    const area = planUnitPolygonArea(plan, unit);
    if (area === null || !Number.isFinite(area) || area <= 0) {
      invalidUnits += 1;
      continue;
    }

    const functionId = String(unit.functionId ?? '').trim().toLowerCase();
    if (!functionId) {
      missingFunctionIds += 1;
      continue;
    }

    areas.set(functionId, (areas.get(functionId) ?? 0) + area);
  }

  return { areas, missingFunctionIds, invalidUnits };
}

function expectedRoomAreasByFunctionId(rooms: RoomLayout[]): Map<string, { area: number; label: string; unitType: ReturnType<typeof normalizeUnitType> }> {
  const expected = new Map<string, { area: number; label: string; unitType: ReturnType<typeof normalizeUnitType> }>();

  for (const room of rooms) {
    const area = Number(room.area_m2) || 0;
    if (!Number.isFinite(area) || area <= 0) continue;

    const key = normalizeFunctionId(room);
    const previous = expected.get(key);
    const label = room.room_id
      ? `${room.room_id} ${room.name}`
      : room.name;
    expected.set(key, {
      area: (previous?.area ?? 0) + area,
      label: previous?.label ?? label,
      unitType: previous?.unitType ?? normalizeUnitType(room),
    });
  }

  return expected;
}

function roomAreaTolerance(expectedArea: number, unitType: ReturnType<typeof normalizeUnitType>): number {
  const ratio = unitType === 'PARKING'
    ? STRICT_PARKING_AREA_TOLERANCE_RATIO
    : STRICT_ROOM_AREA_TOLERANCE_RATIO;
  return Math.max(expectedArea * ratio, STRICT_ROOM_AREA_TOLERANCE_M2);
}

function validateStrictRoomAreaPreservation(
  floor: FloorSpec,
  plan: FloorStackPlan,
  validationPlan: FloorStackPlan = plan,
): { ok: boolean; error?: string } {
  const sourceRooms = getRoomsWithFill(floor);
  if (!sourceRooms.length) return { ok: true };

  const expectedTotalArea = sourceRooms.reduce((sum, room) => sum + (Number(room.area_m2) || 0), 0);
  if (!Number.isFinite(expectedTotalArea) || expectedTotalArea <= 0) return { ok: true };

  const expectedUnitCount = simplifyRoomsForPlan(sourceRooms, MAX_ROOM_UNITS_PER_FLOOR).length;
  if (expectedUnitCount > 1 && plan.units.length < expectedUnitCount) {
    return {
      ok: false,
      error:
        `strict room-area validation failed: expected at least ${expectedUnitCount} room units, ` +
        `but candidate produced ${plan.units.length}.`,
    };
  }

  const {
    areas: generatedByFunctionId,
    missingFunctionIds,
    invalidUnits,
  } = planUnitAreasByFunctionId(validationPlan);
  if (invalidUnits > 0) {
    return {
      ok: false,
      error: `strict room-area validation failed: ${invalidUnits} plan unit polygon(s) were invalid.`,
    };
  }
  if (missingFunctionIds > 0) {
    return {
      ok: false,
      error:
        `strict room-area validation failed: ${missingFunctionIds} plan unit(s) had no room functionId, ` +
        'so per-room area could not be verified.',
    };
  }

  const expectedByFunctionId = expectedRoomAreasByFunctionId(sourceRooms);
  const mismatches: string[] = [];
  for (const [functionId, expected] of expectedByFunctionId) {
    const generatedArea = generatedByFunctionId.get(functionId) ?? 0;
    const diff = Math.abs(generatedArea - expected.area);
    const tolerance = roomAreaTolerance(expected.area, expected.unitType);
    if (diff > tolerance) {
      const diffPct = expected.area > 0 ? (diff / expected.area) * 100 : 0;
      mismatches.push(
        `${expected.label}: declared ${expected.area.toFixed(2)}m2, ` +
        `generated ${generatedArea.toFixed(2)}m2, difference ${diffPct.toFixed(1)}%`,
      );
    }
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      error:
        'strict per-room area validation failed: ' +
        mismatches.slice(0, 4).join(' | ') +
        (mismatches.length > 4 ? ` | and ${mismatches.length - 4} more` : ''),
    };
  }

  const { totalArea } = planUnitAreaSummary(validationPlan);

  const diff = Math.abs(totalArea - expectedTotalArea);
  const tolerance = Math.max(expectedTotalArea * STRICT_ROOM_AREA_TOLERANCE_RATIO, STRICT_ROOM_AREA_TOLERANCE_M2);
  if (diff > tolerance) {
    const diffPct = (diff / expectedTotalArea) * 100;
    return {
      ok: false,
      error:
        `strict room-area validation failed: declared ${expectedTotalArea.toFixed(2)}m2, ` +
        `generated ${totalArea.toFixed(2)}m2, difference ${diffPct.toFixed(1)}%.`,
    };
  }

  return { ok: true };
}

function coreRoomForValidation(floor: FloorSpec): RoomLayout | null {
  const explicit = getRoomsWithFill(floor).find(isExplicitCoreRoom);
  if (explicit) return explicit;
  if (!floor.coreTemplate) return null;

  const templateArea = coreTemplateArea(floor.coreTemplate);
  return {
    name: floor.coreTemplate.room_name ?? 'Core',
    area_m2: templateArea || 1,
    function_id: floor.coreTemplate.function_id ?? 'core',
    unit_type: 'CORE',
  };
}

function expectedCoreBoundsForFloor(floor: FloorSpec): {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  area: number;
} | null {
  if (!floor.coreTemplate) return null;
  const coreRoom = coreRoomForValidation(floor);
  if (!coreRoom) return null;

  const declaredCoreArea = Number(coreRoom.area_m2) || coreTemplateArea(floor.coreTemplate);
  const templateWidth = Number(floor.coreTemplate.width_m);
  const templateDepth = Number(floor.coreTemplate.depth_m);
  const coreWidth = Math.max(
    Number.isFinite(templateWidth) && templateWidth > 0 ? templateWidth : Math.sqrt(declaredCoreArea),
    0.5,
  );
  const coreDepth = Math.max(
    Number.isFinite(templateDepth) &&
      templateDepth > 0 &&
      Math.abs((coreWidth * templateDepth) - declaredCoreArea) / Math.max(declaredCoreArea, 1) <= 0.05
      ? templateDepth
      : declaredCoreArea / coreWidth,
    0.5,
  );
  const { w, d } = resolveLayoutDimensions(floor);
  const bounds = resolveFixedCoreBounds(floor.coreTemplate, w, d, coreWidth, coreDepth);
  return {
    ...bounds,
    area: Math.max(declaredCoreArea, coreWidth * coreDepth),
  };
}

function coreFunctionIdsForFloor(floor: FloorSpec): Set<string> {
  const ids = new Set<string>();
  const coreRoom = coreRoomForValidation(floor);
  if (coreRoom) ids.add(normalizeFunctionId(coreRoom));
  if (floor.coreTemplate?.function_id) {
    ids.add(normalizeFunctionId({
      name: floor.coreTemplate.function_id,
      function_id: floor.coreTemplate.function_id,
      area_m2: 1,
      unit_type: 'CORE',
    }));
  }
  ids.add('core');
  return ids;
}

function planUnitPolygon(plan: FloorStackPlan, unit: FloorStackPlan['units'][number]): [number, number][] | null {
  const verticesById = new Map(
    plan.vertices.map((vertex) => [vertex.id, [Number(vertex.x), Number(vertex.y)] as [number, number]]),
  );
  const polygon = unit.polygon
    .map((vertexId) => verticesById.get(vertexId))
    .filter((point): point is [number, number] =>
      Boolean(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]),
    );
  return polygon.length === unit.polygon.length && polygon.length >= 3 ? polygon : null;
}

function validateFixedCorePosition(
  floor: FloorSpec,
  validationPlan: FloorStackPlan,
): { ok: boolean; error?: string } {
  const expected = expectedCoreBoundsForFloor(floor);
  if (!expected) return { ok: true };

  const coreIds = coreFunctionIdsForFloor(floor);
  const corePolygons = validationPlan.units
    .filter((unit) => coreIds.has(String(unit.functionId ?? '').trim().toLowerCase()))
    .map((unit) => planUnitPolygon(validationPlan, unit))
    .filter((polygon): polygon is [number, number][] => Boolean(polygon));

  if (!corePolygons.length) {
    return {
      ok: false,
      error: `${floor.label}: fixed core validation failed: no CORE unit was generated.`,
    };
  }

  const allCorePoints = corePolygons.flat();
  const actual = polygonBounds(allCorePoints);
  const actualArea = corePolygons.reduce((sum, polygon) => sum + polygonAreaM2(polygon), 0);
  const actualCx = (actual.minX + actual.maxX) / 2;
  const actualCy = (actual.minY + actual.maxY) / 2;
  const expectedCx = (expected.x0 + expected.x1) / 2;
  const expectedCy = (expected.y0 + expected.y1) / 2;
  const actualWidth = actual.maxX - actual.minX;
  const actualDepth = actual.maxY - actual.minY;
  const expectedWidth = expected.x1 - expected.x0;
  const expectedDepth = expected.y1 - expected.y0;
  const areaTolerance = Math.max(expected.area * STRICT_CORE_AREA_TOLERANCE_RATIO, STRICT_ROOM_AREA_TOLERANCE_M2);

  const centerDrift = Math.hypot(actualCx - expectedCx, actualCy - expectedCy);
  const widthDrift = Math.abs(actualWidth - expectedWidth);
  const depthDrift = Math.abs(actualDepth - expectedDepth);
  const areaDrift = Math.abs(actualArea - expected.area);

  if (
    centerDrift > STRICT_CORE_CENTER_TOLERANCE_M ||
    widthDrift > STRICT_CORE_SIZE_TOLERANCE_M ||
    depthDrift > STRICT_CORE_SIZE_TOLERANCE_M ||
    areaDrift > areaTolerance
  ) {
    return {
      ok: false,
      error:
        `${floor.label}: fixed core validation failed: expected center ` +
        `(${expectedCx.toFixed(2)}, ${expectedCy.toFixed(2)}) ${expectedWidth.toFixed(2)}x${expectedDepth.toFixed(2)}m, ` +
        `generated center (${actualCx.toFixed(2)}, ${actualCy.toFixed(2)}) ${actualWidth.toFixed(2)}x${actualDepth.toFixed(2)}m.`,
    };
  }

  return { ok: true };
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

function forcePlanFunctionId(plan: FloorStackPlan, functionId: string): FloorStackPlan {
  return {
    ...plan,
    units: plan.units.map((unit) => ({ ...unit, functionId })),
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
  const elevationRef = skipSiteContext ? null : await getElevationReferencePath(bounds);
  const centerX = bounds?.centerX ?? 0;
  const centerY = bounds?.centerY ?? 0;
  const baseElevation = bounds?.baseElevation ?? 0;
  const elevationPath = elevationRef?.path ?? '';
  const localMeshElevation = !skipSiteContext && !bounds?.isGeographic && elevationPath
    ? await sampleLocalElevationFromMesh(elevationPath, centerX, centerY)
    : null;
  const placementZ = localMeshElevation ?? baseElevation;
  const { urn } = await withTimeout(
    Forma.elements.floorStack.createFromFloors(request),
    FLOORSTACK_CREATE_TIMEOUT_MS,
    `${name}: FloorStack creation response timed out.`,
  );
  const { path } = await withTimeout(
    Forma.proposal.addElement({
      urn,
      name,
      transform: makePlacementTransform(centerX, centerY, placementZ + zOffsetM, bounds?.rotationRad ?? 0),
    }),
    FLOORSTACK_CREATE_TIMEOUT_MS,
    `${name}: Proposal addElement response timed out.`,
  );

  const expectedPlacement = {
    x: centerX,
    y: centerY,
    z: placementZ + zOffsetM,
    rotationRad: bounds?.rotationRad ?? 0,
    heightM: request.floors.reduce((sum, floor) => sum + Number(floor.height || 0), 0),
  };
  const confirmation = await waitForBuildingLayerElement(path, expectedPlacement);
  if (!confirmation.confirmed) {
    await removeUnconfirmedProposalElement(path);
    throw new Error(`proposal.addElement returned a path, but confirmation failed: ${describeBuildingConfirmationFailure(confirmation)}.`);
  }

  _unconfirmedElementPaths.delete(path);
  _elementPaths.add(path);
  return { urn, path, centerX, centerY, placementZ: placementZ + zOffsetM };
}

async function addFloorStackAtBounds(
  name: string,
  request: Parameters<typeof Forma.elements.floorStack.createFromFloors>[0],
  bounds: Bounds,
): Promise<{ urn: string; path: string; centerX: number; centerY: number; placementZ: number }> {
  const placementZ = bounds.baseElevation;
  const { urn } = await withTimeout(
    Forma.elements.floorStack.createFromFloors(request),
    FLOORSTACK_CREATE_TIMEOUT_MS,
    `${name}: FloorStack creation timed out.`,
  );
  const { path } = await withTimeout(
    Forma.proposal.addElement({
      urn,
      name,
      transform: makePlacementTransform(bounds.centerX, bounds.centerY, placementZ, bounds.rotationRad),
    }),
    FLOORSTACK_CREATE_TIMEOUT_MS,
    `${name}: Proposal addElement timed out.`,
  );

  const confirmation = await waitForBuildingLayerElement(path, {
    x: bounds.centerX,
    y: bounds.centerY,
    z: placementZ,
    rotationRad: bounds.rotationRad,
    heightM: request.floors.reduce((sum, floor) => sum + Number(floor.height || 0), 0),
  });
  if (!confirmation.confirmed) {
    await removeUnconfirmedProposalElement(path);
    throw new Error(`proposal.addElement returned a path, but confirmation failed: ${describeBuildingConfirmationFailure(confirmation)}.`);
  }

  _unconfirmedElementPaths.delete(path);
  _elementPaths.add(path);
  return { urn, path, centerX: bounds.centerX, centerY: bounds.centerY, placementZ };
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

function planVariantsForSaving(plan: FloorStackPlan): Array<{ name: string; plan: FloorStackPlan }> {
  return [
    {
      name: 'all units as LIVING_UNIT',
      plan: stripPlanFunctionIds(forcePlanProgram(plan, 'LIVING_UNIT')),
    },
    {
      name: 'program only from PDF',
      plan: stripPlanFunctionIds(plan),
    },
    {
      name: 'program + functionId from PDF',
      plan,
    },
  ];
}

export function makePlacementTransform(x = 0, y = 0, z = 0, rotationRad = 0): number[] {
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  return [
    cos, sin, 0, 0,
    -sin, cos, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ];
}

function floorZOffsets(floorSpecs: FloorSpec[]): Map<string, number> {
  const offsets = new Map<string, number>();
  const basement = floorSpecs.filter((floor) => floor.belowGrade);
  const above = floorSpecs.filter((floor) => !floor.belowGrade);
  const basementDepth = basement.reduce((sum, floor) => sum + floor.heightM, 0);

  let z = -basementDepth;
  for (const floor of basement) {
    offsets.set(floor.label, z);
    z += floor.heightM;
  }

  z = 0;
  for (const floor of above) {
    offsets.set(floor.label, z);
    z += floor.heightM;
  }

  return offsets;
}

async function addDetailedFloorsIndividually(
  buildingName: string,
  floorSpecs: FloorSpec[],
): Promise<{
  placedPaths: string[];
  attempts: Array<{ name: string; ok: boolean; error?: string }>;
  roomUnits: number;
  successfulAttempt?: string;
}> {
  const offsets = floorZOffsets(floorSpecs);
  const placedPaths: string[] = [];
  const attempts: Array<{ name: string; ok: boolean; error?: string }> = [];
  let roomUnits = 0;
  let successfulAttempt: string | undefined;

  for (const floor of floorSpecs) {
    const basePlan = buildPlanFromRooms(floor, {
      includeFunctionIds: true,
      includePrograms: true,
    });

    if (!basePlan || basePlan.units.length === 0) {
      attempts.push({
        name: `${floor.label}: floor plan generation`,
        ok: false,
        error: 'No valid room units were generated for this floor.',
      });
      break;
    }

    let floorPlaced = false;
    for (const variant of planVariantsForSaving(basePlan)) {
      try {
        const added = await addFloorStackAtSiteCenter(
          `${buildingName} - ${floor.label} detailed floor plan`,
          {
            floors: [{ planId: variant.plan.id, height: floor.heightM }],
            plans: [variant.plan],
          },
          offsets.get(floor.label) ?? 0,
        );
        attempts.push({ name: `${floor.label}: ${variant.name}`, ok: true });
        placedPaths.push(added.path);
        roomUnits += variant.plan.units.length;
        successfulAttempt = variant.name;
        floorPlaced = true;
        break;
      } catch (err) {
        attempts.push({ name: `${floor.label}: ${variant.name}`, ok: false, error: String(err) });
      }
    }

    if (!floorPlaced) {
      const loosePlan = buildLooseRoomFloorPlan(floor, {
        includeFunctionIds: false,
        includePrograms: true,
      });

      if (loosePlan) {
        const looseVariant = stripPlanFunctionIds(forcePlanProgram(loosePlan, 'LIVING_UNIT'));
        try {
          const added = await addFloorStackAtSiteCenter(
            `${buildingName} - ${floor.label} room plan`,
            {
              floors: [{ planId: looseVariant.id, height: floor.heightM }],
              plans: [looseVariant],
            },
            offsets.get(floor.label) ?? 0,
          );
          attempts.push({ name: `${floor.label}: loose row room plan`, ok: true });
          placedPaths.push(added.path);
          roomUnits += looseVariant.units.length;
          successfulAttempt = 'loose row room plan';
          floorPlaced = true;
        } catch (err) {
          attempts.push({ name: `${floor.label}: loose row room plan`, ok: false, error: String(err) });
        }
      }
    }

    if (!floorPlaced) break;
  }

  return { placedPaths, attempts, roomUnits, successfulAttempt };
}

async function removePartialFloorStackElements(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      await Forma.proposal.removeElement({ path });
      _elementPaths.delete(path);
    } catch {
      // Best-effort cleanup only. The main result should still report the original creation failure.
    }
  }
}

async function removeProposalElementPath(path: string): Promise<boolean> {
  try {
    await Forma.proposal.removeElement({ path });
    _elementPaths.delete(path);
    _roomLayoutElementPaths.delete(path);
    return true;
  } catch {
    return false;
  }
}

async function clearRoomLayoutArtifacts(): Promise<number> {
  let removedCount = 0;

  for (const path of Array.from(_roomLayoutElementPaths)) {
    if (await removeProposalElementPath(path)) removedCount += 1;
  }
  _roomLayoutElementPaths.clear();

  for (const id of Array.from(_roomLayoutLineIds)) {
    try {
      await Forma.render.geojson.remove({ id });
      removedCount += 1;
    } catch {
      // Already removed or not owned by the current render session.
    }
  }
  _roomLayoutLineIds.clear();

  return removedCount;
}

async function validateSingleFloorPlan(
  floor: FloorSpec,
  plan: FloorStackPlan,
  validationPlan: FloorStackPlan = plan,
): Promise<{ ok: boolean; error?: string }> {
  const strictArea = validateStrictRoomAreaPreservation(floor, plan, validationPlan);
  if (!strictArea.ok) return strictArea;
  const strictCore = validateFixedCorePosition(floor, validationPlan);
  if (!strictCore.ok) return strictCore;

  try {
    await withTimeout(
      Forma.elements.floorStack.createFromFloors({
        floors: [{ planId: plan.id, height: floor.heightM }],
        plans: [plan],
      }),
      FLOORSTACK_CREATE_TIMEOUT_MS,
      `${floor.label}: FloorStack plan validation timed out.`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function buildCompatibleSingleStack(
  building: BuildingRequirements['buildings'][number],
  floorSpecs: FloorSpec[],
): Promise<{
  floors: Array<{ polygon: [number, number][]; height: number } | { planId: string; height: number }>;
  plans: FloorStackPlan[];
  roomUnits: number;
  warnings: string[];
}> {
  floorSpecs = floorSpecs.map(ensureRoomProgramFitsWorkingEnvelope);
  const floors: Array<{ polygon: [number, number][]; height: number } | { planId: string; height: number }> = [];
  const plans: FloorStackPlan[] = [];
  const warnings: string[] = [];
  let roomUnits = 0;

  for (const floor of floorSpecs) {
    const candidates: Array<{ name: string; plan: FloorStackPlan | null; validationPlan?: FloorStackPlan | null }> = [];
    if (floorHasCompleteRoomPolygons(floor)) {
      const exactPolygonPlan = buildPlanFromExactRoomPolygons(floor, {
        includeFunctionIds: true,
        includePrograms: true,
      });
      if (exactPolygonPlan) {
        candidates.push({
          name: 'source-authored exact room polygon plan',
          plan: stripPlanFunctionIds(exactPolygonPlan),
          validationPlan: exactPolygonPlan,
        });
      }
    }
    const strictRoomCountPlan = buildStrictRoomCountPreservingFloorPlan(floor, {
      includeFunctionIds: true,
      includePrograms: true,
    });
    if (strictRoomCountPlan) {
      candidates.push({
        name: 'strict room-count preserving room plan LIVING_UNIT',
        plan: stripPlanFunctionIds(forcePlanProgram(strictRoomCountPlan, 'LIVING_UNIT')),
        validationPlan: strictRoomCountPlan,
      });
    }

    const coreWrappingLargeRoomPlan = buildCoreWrappingLargeRoomFloorPlan(floor, {
      includeFunctionIds: true,
      includePrograms: true,
    });
    const coreWrappingSplitPiecesPlan = buildCoreWrappingLargeRoomFloorPlan(floor, {
      includeFunctionIds: true,
      includePrograms: true,
      mergeSplitRooms: false,
    });
    if (coreWrappingSplitPiecesPlan) {
      candidates.push({
        name: 'mass-footprint core-wrapping split pieces LIVING_UNIT',
        plan: stripPlanFunctionIds(forcePlanProgram(coreWrappingSplitPiecesPlan, 'LIVING_UNIT')),
        validationPlan: forcePlanProgram(coreWrappingSplitPiecesPlan, 'LIVING_UNIT'),
      });
    }
    if (coreWrappingLargeRoomPlan) {
      candidates.push({
        name: 'mass-footprint core-wrapping large room plan LIVING_UNIT',
        plan: stripPlanFunctionIds(forcePlanProgram(coreWrappingLargeRoomPlan, 'LIVING_UNIT')),
        validationPlan: forcePlanProgram(coreWrappingLargeRoomPlan, 'LIVING_UNIT'),
      });
      candidates.push({
        name: 'mass-footprint core-wrapping large room plan LIVING_UNIT + commercial',
        plan: forcePlanFunctionId(forcePlanProgram(coreWrappingLargeRoomPlan, 'LIVING_UNIT'), 'commercial'),
        validationPlan: forcePlanProgram(coreWrappingLargeRoomPlan, 'LIVING_UNIT'),
      });
    }

    const generatedRectangularSplitPieces = buildGeneratedRectangularFloorPlan(floor, {
      includeFunctionIds: true,
      includePrograms: true,
      mergeSplitRooms: false,
    });
    if (generatedRectangularSplitPieces) {
      candidates.push({
        name: 'mass-footprint room plan split pieces LIVING_UNIT',
        plan: stripPlanFunctionIds(forcePlanProgram(generatedRectangularSplitPieces, 'LIVING_UNIT')),
        validationPlan: forcePlanProgram(generatedRectangularSplitPieces, 'LIVING_UNIT'),
      });
      candidates.push({
        name: 'mass-footprint room plan split pieces LIVING_UNIT + commercial',
        plan: forcePlanFunctionId(forcePlanProgram(generatedRectangularSplitPieces, 'LIVING_UNIT'), 'commercial'),
        validationPlan: forcePlanProgram(generatedRectangularSplitPieces, 'LIVING_UNIT'),
      });
    }

    const generatedRectangular = buildGeneratedRectangularFloorPlan(floor, {
      includeFunctionIds: true,
      includePrograms: true,
    });
    if (generatedRectangular) {
      candidates.push({
        name: 'mass-footprint room plan LIVING_UNIT + commercial',
        plan: forcePlanFunctionId(forcePlanProgram(generatedRectangular, 'LIVING_UNIT'), 'commercial'),
        validationPlan: forcePlanProgram(generatedRectangular, 'LIVING_UNIT'),
      });
      candidates.push({
        name: 'mass-footprint room plan LIVING_UNIT',
        plan: stripPlanFunctionIds(forcePlanProgram(generatedRectangular, 'LIVING_UNIT')),
        validationPlan: forcePlanProgram(generatedRectangular, 'LIVING_UNIT'),
      });
    }

    const simplifiedCorePlan = buildSimplifiedCoreFloorPlan(floor, {
      includeFunctionIds: true,
      includePrograms: true,
    });
    if (simplifiedCorePlan) {
      candidates.push({
        name: 'mass-footprint simplified core plan LIVING_UNIT',
        plan: stripPlanFunctionIds(forcePlanProgram(simplifiedCorePlan, 'LIVING_UNIT')),
        validationPlan: forcePlanProgram(simplifiedCorePlan, 'LIVING_UNIT'),
      });
    }

    const loosePlan = buildLooseRoomFloorPlan(floor, {
      includeFunctionIds: true,
      includePrograms: true,
    });
    if (loosePlan) {
      candidates.push({
        name: 'loose row room plan LIVING_UNIT',
        plan: stripPlanFunctionIds(forcePlanProgram(loosePlan, 'LIVING_UNIT')),
        validationPlan: forcePlanProgram(loosePlan, 'LIVING_UNIT'),
      });
    }

    const singleUnit = buildSingleUnitFloorPlan(floor, {
      includeFunctionIds: false,
      includePrograms: true,
    });
    if (singleUnit) {
      candidates.push({
        name: 'single validated floor shell',
        plan: stripPlanFunctionIds(forcePlanProgram(singleUnit, 'LIVING_UNIT')),
        validationPlan: forcePlanProgram(singleUnit, 'LIVING_UNIT'),
      });
    }

    let accepted: { name: string; plan: FloorStackPlan } | null = null;
    const rejected: string[] = [];
    const candidateDiagnostics: string[] = [];
    for (const candidate of candidates) {
      if (!candidate.plan) continue;
      const validationPlan = candidate.validationPlan ?? candidate.plan;
      const result = await validateSingleFloorPlan(floor, candidate.plan, validationPlan);
      if (result.ok) {
        accepted = { name: candidate.name, plan: candidate.plan };
        break;
      }
      rejected.push(`${candidate.name}: ${result.error ?? 'rejected'}`);
      const planSummary = planUnitAreaSummary(validationPlan);
      const generated = planUnitAreasByFunctionId(validationPlan).areas;
      const roomAreas = getRoomsWithFill(floor)
        .slice(0, 12)
        .map((room) => {
          const id = normalizeFunctionId(room);
          return `${room.room_id ?? id}:${Number(room.area_m2).toFixed(2)}→${(generated.get(id) ?? 0).toFixed(2)}`;
        })
        .join(', ');
      candidateDiagnostics.push(
        `${candidate.name} [units=${validationPlan.units.length}, total=${planSummary.totalArea.toFixed(2)}m2, ` +
        `invalid=${planSummary.invalidUnits}, roomAreas=${roomAreas}]`,
      );
    }

    if (accepted) {
      floors.push({ planId: accepted.plan.id, height: floor.heightM });
      plans.push(accepted.plan);
      if (accepted.name.startsWith('mass-footprint simplified core plan')) {
        roomUnits += accepted.plan.units.length;
        warnings.push(`${building.name} ${floor.label}: detailed room plan could not be kept inside the mass footprint, used ${accepted.name}.`);
      } else if (accepted.name.startsWith('single validated floor shell')) {
        warnings.push(`${building.name} ${floor.label}: room plans were rejected by FloorStack validation, used a single floor shell.`);
      } else if (accepted.name.startsWith('loose row room plan')) {
        roomUnits += accepted.plan.units.length;
        warnings.push(`${building.name} ${floor.label}: strict room plan was rejected by FloorStack validation, used ${accepted.name}.`);
      } else if (accepted.name.startsWith('strict room-count preserving room plan')) {
        roomUnits += accepted.plan.units.length;
      } else {
        roomUnits += accepted.plan.units.length;
      }
    } else {
      const { w, d } = resolveLayoutDimensions(floor);
      if (getRoomsWithFill(floor).length > 0) {
        throw new Error(
          `${building.name} ${floor.label}: strict room-area validation rejected all FloorStack room-plan variants. ` +
          rejected.slice(0, 4).join(' | ') +
          ` | input=${describeFloorPlanWorkingInput(floor)} | candidateAreas=${candidateDiagnostics.slice(0, 6).join(' || ')}`,
        );
      }
      floors.push({ polygon: makeLocalRectFromDimensions(w, d), height: floor.heightM });
      warnings.push(
        `${building.name} ${floor.label}: all FloorStack room-plan variants were rejected, kept the existing-envelope floor shell for this floor. ` +
        rejected.slice(0, 2).join(' | '),
      );
    }
  }

  return {
    floors,
    plans,
    roomUnits,
    warnings,
  };
}

function lineFeaturesWithAbsoluteZ(features: any[], zOffset: number): any[] {
  return features.map((feature) => {
    const elevation = Number(feature?.properties?.elevation ?? 0);
    const z = zOffset + (Number.isFinite(elevation) ? elevation : 0);
    const geometry = feature?.geometry;
    if (!geometry || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) {
      return feature;
    }
    return {
      ...feature,
      properties: {
        ...feature.properties,
        elevation_m: z,
      },
      geometry: {
        ...geometry,
        coordinates: geometry.coordinates.map((coordinate: any) => [
          Number(coordinate?.[0] ?? 0),
          Number(coordinate?.[1] ?? 0),
        ]),
      },
    };
  });
}

function roundCoord(value: any): number {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 1000) / 1000;
}

function sanitizeLineFeatureForPersistentElement(feature: any, index: number): any {
  const geometry = feature?.geometry;
  const coordinates = Array.isArray(geometry?.coordinates)
    ? geometry.coordinates
        .filter((coordinate: any) => Array.isArray(coordinate) && coordinate.length >= 2)
        .map((coordinate: any) => [roundCoord(coordinate[0]), roundCoord(coordinate[1])])
    : [];
  const props = feature?.properties ?? {};
  const elevationM = Number(props.elevation_m);
  const fallbackElevation = Number(props.elevation);
  return {
    type: 'Feature' as const,
    id: `room_line_${index}`,
    properties: {
      name: String(props.name ?? `Room line ${index + 1}`).slice(0, 120),
      floor_label: String(props.floor_label ?? ''),
      room_name: String(props.room_name ?? ''),
      unit_type: String(props.unit_type ?? ''),
      room_area_m2: Number(props.room_area_m2) || 0,
      layout_area_m2: Number(props.layout_area_m2) || 0,
      elevation_m: Number.isFinite(elevationM)
        ? elevationM
        : Number.isFinite(fallbackElevation)
          ? fallbackElevation
          : 0,
    },
    geometry: {
      type: 'LineString' as const,
      coordinates,
    },
  };
}

function groupRoomLineFeaturesByElevation(features: any[]): Array<{
  key: string;
  floorLabel: string;
  elevationM: number;
  features: any[];
}> {
  const groups = new Map<string, { key: string; floorLabel: string; elevationM: number; features: any[] }>();

  features.forEach((feature) => {
    const floorLabel = String(feature?.properties?.floor_label ?? 'floor');
    const elevationM = Number(feature?.properties?.elevation_m ?? 0);
    const roundedElevation = Number.isFinite(elevationM) ? roundCoord(elevationM) : 0;
    const key = `${floorLabel}|${roundedElevation}`;
    const existing = groups.get(key);
    if (existing) {
      existing.features.push(feature);
      return;
    }
    groups.set(key, {
      key,
      floorLabel,
      elevationM: roundedElevation,
      features: [feature],
    });
  });

  return Array.from(groups.values()).sort((a, b) => a.elevationM - b.elevationM);
}

function makeSingleFeatureGeoJson(feature: any): any {
  return {
    type: 'FeatureCollection' as const,
    features: [feature],
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as any).cause;
    const causeText = cause ? `; cause=${describeError(cause)}` : '';
    return `${err.name}: ${err.message}${causeText}`;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function createPersistentRoomLineHierarchy(buildingName: string, features: any[]): Promise<{ urn: string }> {
  const elements: Record<string, any> = {
    root: {
      id: 'root',
      properties: {
        category: 'generic',
        name: `${buildingName} room layout lines`,
        elementProvider: 'forma-chat-app',
      },
      children: features.map((_, index) => ({
        id: `line${index}`,
        key: `line${index}`,
      })),
    },
  };

  features.forEach((feature, index) => {
    elements[`line${index}`] = {
      id: `line${index}`,
      properties: {
        category: 'generic',
        name: String(feature?.properties?.name ?? `Room line ${index + 1}`).slice(0, 120),
        elementProvider: 'forma-chat-app',
        geometry: {
          type: 'Inline',
          format: 'GeoJSON',
          geoJson: makeSingleFeatureGeoJson(feature),
        },
      },
    };
  });

  const { urn } = await Forma.integrateElements.createElementHierarchy({
    data: {
      rootElement: 'root',
      elements,
    },
  });
  return { urn };
}

async function addPersistentRoomLayoutLineElement(
  buildingName: string,
  features: any[],
  zOffset: number,
): Promise<{ path: string; paths?: string[]; urn?: string; mode: 'persistent' | 'temporary'; error?: string }> {
  const persistentFeatures = lineFeaturesWithAbsoluteZ(features, zOffset)
    .map((feature, index) => sanitizeLineFeatureForPersistentElement(feature, index))
    .filter((feature) => feature.geometry.coordinates.length >= 2);
  if (!persistentFeatures.length) {
    throw new Error('No valid room-line features remained after persistent geometry sanitization.');
  }

  const groups = groupRoomLineFeaturesByElevation(persistentFeatures);
  const createdPaths: string[] = [];
  const createdUrns: string[] = [];
  let persistentError: unknown;
  try {
    for (const group of groups) {
      const elementName = groups.length > 1
        ? `${buildingName} room layout lines ${group.floorLabel}`
        : `${buildingName} room layout lines`;
      const geoJson = {
        type: 'FeatureCollection' as const,
        features: group.features,
      };
      try {
        const { urn } = await Forma.integrateElements.createElementV2({
          properties: {
            category: 'generic',
            name: elementName,
            elementProvider: 'forma-chat-app',
            geometry: {
              type: 'Inline',
              format: 'GeoJSON',
              geoJson,
            },
          },
        });
        const { path } = await Forma.proposal.addElement({
          urn,
          name: elementName,
          transform: makeTranslationTransform(0, 0, group.elevationM),
        });
        const confirmed = await waitForProposalPath(path, ['generic']);
        if (!confirmed) {
          throw new Error(`${group.floorLabel}: proposal.addElement returned a path, but the persistent room-line element could not be confirmed in the generic layer.`);
        }
        createdPaths.push(path);
        createdUrns.push(urn);
      } catch (singleError) {
        try {
          const { urn } = await createPersistentRoomLineHierarchy(elementName, group.features);
          const { path } = await Forma.proposal.addElement({
            urn,
            name: elementName,
            transform: makeTranslationTransform(0, 0, group.elevationM),
          });
          const confirmed = await waitForProposalPath(path, ['generic']);
          if (!confirmed) {
            throw new Error(`${group.floorLabel}: proposal.addElement returned a path, but the persistent room-line hierarchy could not be confirmed in the proposal.`);
          }
          createdPaths.push(path);
          createdUrns.push(urn);
        } catch (hierarchyError) {
          throw new Error(
            `${group.floorLabel}: single FeatureCollection failed: ${describeError(singleError)}; hierarchy fallback failed: ${describeError(hierarchyError)}`,
          );
        }
      }
    }

    for (const path of createdPaths) _roomLayoutElementPaths.add(path);
    return { path: createdPaths[0], paths: createdPaths, urn: createdUrns[0], mode: 'persistent' };
  } catch (err) {
    persistentError = err;
    for (const path of createdPaths) {
      try {
        await Forma.proposal.removeElement({ path });
      } catch {
        // Leave cleanup best-effort; this branch is reported as failed.
      }
    }
  }

  try {
    const overlayGeoJson = {
      type: 'FeatureCollection' as const,
      features: features
        .map((feature, index) => sanitizeLineFeatureForPersistentElement(feature, index))
        .filter((feature) => feature.geometry.coordinates.length >= 2),
    };
    const { id } = await Forma.render.geojson.add({
      geojson: overlayGeoJson,
      transform: makeTranslationTransform(0, 0, zOffset),
    });
    _roomLayoutLineIds.add(id);
    return { path: id, mode: 'temporary', error: describeError(persistentError) };
  } catch (overlayError) {
    throw new Error(`persistent room-line element failed: ${describeError(persistentError)}; temporary overlay failed: ${describeError(overlayError)}`);
  }
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
    aboveFloors: number;
    basementFloors: number;
    totalFloors: number;
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
    aboveFloors: number;
    basementFloors: number;
    totalFloors: number;
    roomUnits: number;
  }> = [];
  const failed: Array<{ name: string; attempts: Array<{ name: string; ok: boolean; error?: string }> }> = [];
  const warnings: string[] = [];
  warnings.push(`FloorStack regeneration diagnostic version: ${FLOORSTACK_REGEN_DIAGNOSTIC_VERSION}`);
  let oldMassRemovalFailed = false;

  const existingMass = await findExistingMassForFloorPlanRegeneration();
  if (!existingMass.ok) {
    const error = existingMass.error ?? 'No existing mass was found.';
    warnings.push(error);
    return {
      status: 'failed',
      placed,
      failed: requirements.buildings.map((building) => ({
        name: building.name,
        attempts: [{ name: 'existing mass check', ok: false, error }],
      })),
      warnings,
    };
  }

  if (!existingMass.path) {
    const error = '실배치 포함 재생성에 사용할 기존 매스 path를 찾지 못했습니다.';
    warnings.push(error);
    return {
      status: 'failed',
      placed,
      failed: requirements.buildings.map((building) => ({
        name: building.name,
        attempts: [{ name: 'existing mass path check', ok: false, error }],
      })),
      warnings,
    };
  }

  const bounds = await boundsFromPath(existingMass.path, 'existing building mass');

  if (!bounds) {
    const error = '기존 매스의 footprint를 읽지 못했습니다. 새 FloorStack 매스를 기존 외곽에 맞춰 재생성할 수 없습니다.';
    warnings.push(error);
    return {
      status: 'failed',
      placed,
      failed: requirements.buildings.map((building) => ({
        name: building.name,
        attempts: [{ name: 'existing mass footprint check', ok: false, error }],
      })),
      warnings,
    };
  }

  const massSnapshotCapture = await captureMassSnapshot(existingMass.path);
  const massSnapshot = massSnapshotCapture.snapshot;
  const massSnapshotDiagnostic = massSnapshotCapture.diagnostics.join(' | ');
  if (massSnapshot) {
    warnings.push(
      `MassSnapshot captured (${massSnapshot.captureMode}) from ${massSnapshot.sourcePath}: ${massSnapshot.floors.length} floor outline(s), ` +
      `setbacks=${massSnapshot.hasSetbacks}, nonRectangular=${massSnapshot.hasNonRectangularFootprints}, holes=${massSnapshot.hasHoles}.`,
    );
  } else {
    warnings.push('층별 MassSnapshot을 읽지 못했습니다. 실별 면적을 단일 외곽 경계 상자로 추정하지 않으며, 정확한 층별 외곽을 얻을 수 없으면 기존 매스를 유지합니다.');
  }
  warnings.push(`MassSnapshot diagnostic: ${massSnapshotDiagnostic}`);

  warnings.push('기존 매스에 사후 Floor Plans를 주입하는 SDK 경로가 안정적이지 않아, 새 FloorStack 매스를 만들 때 plans.units를 함께 포함하는 방식으로 재생성합니다.');

  const removedArtifacts = await clearRoomLayoutArtifacts();
  if (removedArtifacts > 0) {
    warnings.push(`이전 실구획 line/overlay artifact ${removedArtifacts}개를 제거했습니다.`);
  }

  const originalMassPath = existingMass.path;
  let allPlacedMayAutoDeleteOriginal = true;
  let usedConceptualGeometry = false;
  let usedNonPreservingGeometry = false;

  for (const building of requirements.buildings) {
    const results: Array<{ name: string; ok: boolean; error?: string }> = [];

    const explicitRoomCount = countExplicitRoomPlanRooms(building);
    if (explicitRoomCount === 0) {
      const error = 'PDF 원문에 명시된 실별 area_m2가 없어 FloorStack plans.units 실배치를 생성하지 않았습니다.';
      results.push({ name: 'explicit room area check', ok: false, error });
      warnings.push(`${building.name}: ${error}`);
      failed.push({ name: building.name, attempts: results });
      continue;
    }

    const sourceFloorSpecs = buildFloorSpecs(building);
    const snapshotEnvelopeResult = floorEnvelopesFromSnapshot(massSnapshot, sourceFloorSpecs);
    const sourcePolygonEnvelopeResult = snapshotEnvelopeResult.envelopes
      ? undefined
      : floorEnvelopesFromRoomPolygons(sourceFloorSpecs);
    const pdfProgramEnvelopeResult = snapshotEnvelopeResult.envelopes || sourcePolygonEnvelopeResult?.envelopes
      ? undefined
      : floorEnvelopesFromPdfProgram(sourceFloorSpecs);
    const floorEnvelopeSelectionResult = selectFloorEnvelopeSource({
      existingGfa: snapshotEnvelopeResult,
      sourceRoomPolygons: sourcePolygonEnvelopeResult,
      pdfProgram: pdfProgramEnvelopeResult,
    });
    if (floorEnvelopeSelectionResult.ok === false) {
      const error = `${floorEnvelopeSelectionResult.error} Diagnostic: ${massSnapshotDiagnostic}`;
      results.push({ name: 'Floor geometry authority selection', ok: false, error });
      for (const warning of floorEnvelopeSelectionResult.warnings) warnings.push(`${building.name}: ${warning}`);
      warnings.push(`${building.name}: ${error}`);
      failed.push({ name: building.name, attempts: results });
      continue;
    }
    const floorEnvelopeSelection = floorEnvelopeSelectionResult.selection;
    const geometryContractErrors = validateSelectedFloorEnvelopeContracts(floorEnvelopeSelection, sourceFloorSpecs);
    if (geometryContractErrors.length > 0) {
      const error = `Floor geometry contract validation failed: ${geometryContractErrors.join(' | ')}`;
      results.push({ name: 'Floor geometry contract validation', ok: false, error });
      warnings.push(`${building.name}: ${error}`);
      failed.push({ name: building.name, attempts: results });
      continue;
    }
    warnings.push(`${building.name}: Floor geometry authority: ${describeFloorEnvelopeSelection(floorEnvelopeSelection)}.`);
    warnings.push(`${building.name}: Working rectangular envelope contract schema=1.0 validated for ${sourceFloorSpecs.length} floor(s); this does not validate arbitrary source polygon topology.`);
    for (const warning of floorEnvelopeSelection.warnings) warnings.push(`${building.name}: ${warning}`);

    if (floorEnvelopeSelection.provenance === 'source_room_polygons') {
      warnings.push(
        `${building.name}: 입력된 원본 room polygon을 새 FloorStack의 정확한 형상 기준으로 사용합니다. ` +
        `이 polygon이 선택된 기존 매스와 동일하다는 증거는 없으므로 기존 매스를 자동 삭제하지 않습니다.`,
      );
    }
    const usingPdfProgramRebuild = floorEnvelopeSelection.provenance === 'pdf_program_rectangle';
    if (usingPdfProgramRebuild) {
      warnings.push(
        `${building.name}: 기존 Basic Building은 층별 외곽을 제공하지 않으므로, PDF의 층별 면적·실면적을 기준으로 새 FloorStack을 생성합니다. ` +
        '새 외곽은 프로그램 면적을 만족하는 개념 설계용 사각형이며 기존 외곽과 동일하다고 보장할 수 없어 기존 매스를 자동 삭제하지 않습니다.',
      );
    }

    try {
      const floorStack = await buildExistingEnvelopeFloorStack(building, bounds, floorEnvelopeSelection.envelopes, {
        includeFunctionIds: false,
        includePrograms: true,
      });
      const { floorSpecs, plans, floors, roomUnits } = floorStack;
      const aboveFloors = floorSpecs.filter((floor) => !floor.belowGrade).length;
      const basementFloors = floorSpecs.filter((floor) => floor.belowGrade).length;
      const relationConflicts = summarizeRoomRelationConflicts(floorSpecs);

      if (relationConflicts.length > 0) {
        warnings.push(
          `${building.name}: room adjacency data has conflicting required/avoid constraints. Required adjacency is prioritized. ` +
          relationConflicts.slice(0, 8).join(' | ') +
          (relationConflicts.length > 8 ? ` | and ${relationConflicts.length - 8} more` : ''),
        );
      }

      for (const warning of floorStack.warnings) warnings.push(warning);

      if (plans.length === 0 || roomUnits === 0) {
        const error = 'FloorStack plans.units가 생성되지 않았습니다. 기존 매스는 삭제하지 않았습니다.';
        results.push({ name: 'FloorStack plans.units generation', ok: false, error });
        failed.push({ name: building.name, attempts: results });
        continue;
      }

      results.push({ name: 'FloorStack plans.units generation', ok: true });
      const added = await addFloorStackAtBounds(
        `${building.name} - floor plans regenerated`,
        {
          floors,
          plans,
        },
        bounds,
      );
      results.push({ name: 'FloorStack building element creation', ok: true });
      allPlacedMayAutoDeleteOriginal = allPlacedMayAutoDeleteOriginal && floorEnvelopeSelection.authority.mayAutoDeleteOriginal;
      usedConceptualGeometry = usedConceptualGeometry || floorEnvelopeSelection.authority.mode === 'conceptual';
      usedNonPreservingGeometry = usedNonPreservingGeometry || !floorEnvelopeSelection.authority.preservesExistingMassShape;

      placed.push({
        name: building.name,
        path: added.path,
        successfulAttempt: floorEnvelopeSelection.provenance === 'pdf_program_rectangle'
          ? 'conceptual PDF-program rectangle FloorStack with embedded floor plan units (existing shape unavailable)'
          : floorEnvelopeSelection.provenance === 'source_room_polygons'
          ? 'source-authored room-polygon FloorStack with embedded floor plan units (existing-shape equivalence unverified)'
          : floorStack.warnings.length > 0
          ? 'regenerated FloorStack mass with embedded floor plan units (partially simplified)'
          : 'regenerated FloorStack mass with embedded floor plan units',
        floors: floorSpecs.length,
        aboveFloors,
        basementFloors,
        totalFloors: floorSpecs.length,
        roomUnits,
      });
    } catch (err) {
      const errorText = describeError(err);
      const failedFloor = sourceFloorSpecs.find((floor) => errorText.includes(` ${floor.label}:`));
      if (failedFloor) {
        const workingFloor = ensureRoomProgramFitsWorkingEnvelope(failedFloor);
        warnings.push(`${building.name} FloorStack input diagnostic: ${describeFloorPlanWorkingInput(workingFloor)}`);
      } else {
        warnings.push(`${building.name} FloorStack input diagnostic: ${FLOORSTACK_REGEN_DIAGNOSTIC_VERSION}; failing floor label was not found in the returned error.`);
      }
      results.push({ name: 'FloorStack mass regeneration with plans.units', ok: false, error: errorText });
      const attemptErrors = results
        .filter((result) => !result.ok)
        .slice(0, 8)
        .map((result) => `${result.name}: ${result.error || 'no error detail returned'}`);
      if (attemptErrors.length > 0) {
        warnings.push(`${building.name} FloorStack regeneration failed: ${attemptErrors.join(' | ')}`);
      }
      failed.push({ name: building.name, attempts: results });
    }
  }

  const hasDegradedFloorPlans = warnings.some((warning) =>
    warning.includes('detailed room plan was rejected') ||
    warning.includes('all room-plan variants were rejected') ||
    warning.includes('single floor shell') ||
    warning.includes('strict room plan was rejected') ||
    warning.includes('자동 단순화'),
  );

  const replacementDecision = decideOriginalMassReplacement({
    placedCount: placed.length,
    failedCount: failed.length,
    hasDegradedFloorPlans,
    allPlacedMayAutoDeleteOriginal,
    originalMassPath,
    replacementPaths: placed.map((item) => item.path),
  });

  if (replacementDecision.action === 'delete') {
      const removed = await removeProposalElementPath(replacementDecision.path);
      if (removed) {
        warnings.push('새 FloorStack 생성 확인 후 기존 매스를 삭제했습니다.');
      } else {
        oldMassRemovalFailed = true;
        warnings.push('새 FloorStack은 생성됐지만 기존 매스 삭제에 실패했습니다. 기존 매스를 선택해 수동 삭제하거나 다시 실행하세요.');
      }
  } else if (replacementDecision.action === 'retain-same-path') {
    warnings.push('기존 매스와 새 FloorStack path가 동일하게 보고되어 별도 삭제를 수행하지 않았습니다.');
  } else if (placed.length > 0 && failed.length > 0) {
    warnings.push('일부 건물이 실패했으므로 기존 매스는 자동 삭제하지 않았습니다.');
  } else if (placed.length > 0 && hasDegradedFloorPlans) {
    warnings.push('실배치가 단순화되었거나 strict 검증을 통과하지 못한 층이 있어 기존 매스는 자동 삭제하지 않았습니다.');
  } else if (placed.length > 0 && usedConceptualGeometry) {
    warnings.push('개념 설계용 PDF 프로그램 외곽으로 새 FloorStack을 만들었으므로 기존 Basic Building은 자동 삭제하지 않았습니다. 면적·위치·층수를 확인하세요.');
  } else if (placed.length > 0 && usedNonPreservingGeometry) {
    warnings.push('새 형상의 출처가 기존 매스와 동일하다고 증명되지 않아 기존 매스를 자동 삭제하지 않았습니다. 새 FloorStack을 확인한 뒤 교체 여부를 결정하세요.');
  } else if (placed.length > 0 && !allPlacedMayAutoDeleteOriginal) {
    warnings.push('기존 형상 보존 가능 여부와 관계없이 자동 교체는 수행하지 않았습니다. 새 FloorStack을 확인한 뒤 기존 매스 삭제 여부를 직접 결정하세요.');
  }

  if (failed.length > 0) {
    warnings.push('일부 건물은 FloorStack plans.units 포함 재생성에 실패했습니다. 실패한 건물의 기존 매스는 삭제하지 않았습니다.');
  } else {
    warnings.push('실배치는 선 오버레이가 아니라 새 FloorStack 생성 요청의 plans.units에 포함되어 저장되었습니다.');
  }

  return {
    status: placed.length > 0 && failed.length === 0 && !hasDegradedFloorPlans && !oldMassRemovalFailed
      ? 'success'
      : placed.length > 0
        ? 'partial'
        : 'failed',
    placed,
    failed,
    warnings,
  };
}

export async function placeBuildingMasses(
  requirements: BuildingRequirements,
  options?: { targetPath?: string },
): Promise<PlaceResult> {
  const warnings: string[] = [];
  const placed: PlacedMassInfo[] = [];
  const componentErrors: ComponentPlacementDiagnostic[] = [];

  // 0-A. Check edit permission before creating proposal elements.
  let canEdit = false;
  try {
    canEdit = await Forma.getCanEdit();
    if (!canEdit) {
      warnings.push('Forma 편집 권한(Collaborator 이상)이 없어 proposal 요소를 생성할 수 없습니다.');
    }
  } catch { /* Treat permission lookup failure as non-blocking. */ }

  // 1. Detect site bounds.
  const explicitTargetPath = options?.targetPath?.trim();
  const boundsResolution = await resolveSiteBounds({ targetPath: explicitTargetPath, allowSelectedConstraint: true });
  const bounds = boundsResolution.bounds;
  if (boundsResolution.failure) {
    const targetDescription = explicitTargetPath ? '지정한 Constraint' : '선택한 Constraint';
    const { path, reason } = boundsResolution.failure;
    const warning = reason === 'unsupported_category'
      ? `${targetDescription}(${path})는 terrain/building/buildings/road category 또는 그 하위 path이므로 ` +
        'Constraint 배치 기준으로 사용할 수 없습니다. 다른 Constraint 또는 Site Limit을 선택해 주세요.'
      : reason === 'category_lookup_failed'
        ? `${targetDescription}(${path})의 제외 category를 확인하는 SDK 조회가 실패해 안전하게 배치를 중단했습니다. ` +
          'category 상태를 확인한 뒤 다시 시도해 주세요.'
      : `${targetDescription}(${path})에서 읽을 수 있는 footprint/triangles를 찾지 못했거나 SDK geometry 조회가 실패했습니다. ` +
        '안전하지 않은 Site Limits 또는 terrain 자동 대체 없이 배치를 중단했습니다.';
    return {
      placed,
      warnings: [...warnings, warning],
      siteReference: reason === 'unsupported_category'
        ? `지원하지 않는 ${targetDescription}: ${path}`
        : reason === 'category_lookup_failed'
          ? `카테고리 확인 실패로 중단한 ${targetDescription}: ${path}`
        : `읽을 수 없는 ${targetDescription}: ${path}`,
      totalFootprint: 0,
      coverageRatio: 0,
    };
  }
  const sourceGeometryElevation = bounds?.elevationPolicy === 'source_geometry';
  const elevationRef = sourceGeometryElevation ? null : await getElevationReferencePath(bounds);

  let originX: number, originY: number, siteW: number, siteH: number, baseElevation: number;
  let siteRotationRad = 0;
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
    siteRotationRad = bounds.rotationRad;
    siteSourcePath = bounds.sourcePath;
    elevationSourcePath = sourceGeometryElevation ? bounds.sourcePath : (elevationRef?.path ?? bounds.sourcePath);
    isGeo   = bounds.isGeographic;

    const unit = isGeo ? 'deg' : 'm';
    const precision = isGeo ? 6 : 1;
    siteReference = `${bounds.source} (${siteW.toFixed(precision)}${unit} x ${siteH.toFixed(precision)}${unit}, ` +
                    `center X=${originX.toFixed(precision)}, Y=${originY.toFixed(precision)}, ` +
                    `base elevation Z=${baseElevation.toFixed(1)}m, ` +
                    `Z source=${sourceGeometryElevation ? bounds.source : (elevationRef?.source ?? bounds.source)}, ` +
                    `coordinate=${isGeo ? 'geographic' : 'local'})`;
  } else {
    originX = 0; originY = 0; siteW = 173; siteH = 173; baseElevation = 0; siteSourcePath = ''; elevationSourcePath = ''; isGeo = false;
    siteReference = '기본값(원점 기준 173m x 173m) - Forma에서 Site Limits를 먼저 설정하세요.';
    warnings.push('대지(site_limit/terrain) 요소를 찾을 수 없어 원점 기준으로 배치합니다. Forma LIMITS 패널에서 Site Limits를 설정한 뒤 다시 배치해보세요.');
  }

  // 2. Process each building.
  for (let i = 0; i < requirements.buildings.length; i++) {
    const building = requirements.buildings[i];
    const color = MASS_COLORS[i % MASS_COLORS.length];

    // Offset from the site center using the position hint.
    const [ox, oy] = POSITION_OFFSETS[building.position_hint] ?? [0, 0];
    const worldOffset = siteLocalOffsetToWorld(ox, oy, siteW, siteH, siteRotationRad);
    const cx = originX + worldOffset.x;
    const cy = originY + worldOffset.y;

    if ((building.mass_components?.length ?? 0) > 0) {
      let componentPlans;
      let basementPlan;
      try {
        // Resolve the complete component graph and optional basement before
        // the first SDK write so invalid floor metadata cannot leave a partial mass.
        componentPlans = resolvePodiumMultiTowerComponents(building, requirements.mass_generation_settings);
        basementPlan = resolvePodiumMultiTowerBasement(building);
      } catch (error) {
        if (error instanceof MassComponentPlanningError) {
          componentErrors.push(error.diagnostic);
          warnings.push(`PODIUM_MULTI_TOWER validation failed: ${JSON.stringify(error.diagnostic)}`);
        } else {
          warnings.push(`${building.name}: component mass planning failed: ${String(error)}`);
        }
        continue;
      }

      const buildingElevationRef = sourceGeometryElevation
        ? null
        : (!isGeo ? await getElevationReferencePath(bounds, cx, cy) : elevationRef);
      const buildingElevationSourcePath = sourceGeometryElevation
        ? siteSourcePath
        : (buildingElevationRef?.path ?? '');
      const localMeshElevationM = !sourceGeometryElevation && !isGeo && buildingElevationSourcePath
        ? (await sampleLocalElevationFromMesh(buildingElevationSourcePath, cx, cy)) ?? null
        : null;
      const localPlacementZ = localMeshElevationM ?? baseElevation;

      if (!canEdit) {
        warnings.push(`${building.name}: component geometry passed validation, but no FloorStack was written because the proposal is not editable.`);
        continue;
      }

      if (basementPlan) {
        const basementZ = localPlacementZ + basementPlan.baseElevationM;
        const basementName = `${building.name} / ${basementPlan.componentId}`;
        try {
          const floors = basementPlan.floorHeightsM.map((height, floorIndex) => ({
            polygon: basementPlan.localFloorStackPolygons[floorIndex],
            height,
          }));
          const { urn } = await Forma.elements.floorStack.createFromFloors({ floors });
          const { path } = await Forma.proposal.addElement({
            urn,
            name: basementName,
            transform: makePlacementTransform(cx, cy, basementZ, siteRotationRad),
          });
          const confirmation = await waitForBuildingLayerElement(path, {
            x: cx,
            y: cy,
            z: basementZ,
            rotationRad: siteRotationRad,
            heightM: basementPlan.totalHeightM,
          });
          if (!confirmation.confirmed) {
            const removed = await removeUnconfirmedProposalElement(path);
            warnings.push(
              `${basementName}: proposal.addElement returned a path, but confirmation failed: ${describeBuildingConfirmationFailure(confirmation)}. `
              + `${removed ? 'It was removed' : 'Immediate cleanup failed; it will be retried by clearAllMasses'}.`,
            );
            continue;
          }
          _unconfirmedElementPaths.delete(path);
          _elementPaths.add(path);
          placed.push({
            name: basementName,
            geojsonId: path,
            centerX: cx,
            centerY: cy,
            placementZ: basementZ,
            widthM: basementPlan.widthM,
            depthM: basementPlan.depthM,
            heightM: basementPlan.totalHeightM,
            floors: 0,
            basementFloors: basementPlan.floorCount,
            footprintArea: basementPlan.footprintAreaM2,
            totalFloorArea: basementPlan.totalFloorAreaM2,
            floorDetails: basementPlan.floorLabels.map((label, floorIndex) =>
              `${label}: ${basementPlan.floorAreasM2[floorIndex]}m2 / ${basementPlan.floorHeightsM[floorIndex]}m`),
            roomUnitCount: 0,
            color: MASS_COLORS[i % MASS_COLORS.length],
            method: 'building_element',
            confirmation: {
              buildingLayer: confirmation.buildingLayer,
              visibleVolume: confirmation.visibleVolume,
              worldTransform: confirmation.worldTransform,
              nonVirtual: confirmation.nonVirtual,
              actualTransformZ: confirmation.actualTransformZ ?? basementZ,
            },
            debug: {
              siteSourcePath,
              elevationSourcePath: buildingElevationSourcePath,
              baseElevation,
              localMeshElevation: localMeshElevationM,
            },
            componentId: basementPlan.componentId,
            componentType: basementPlan.componentType,
            parentComponentId: null,
            startFloor: basementPlan.floorLabels[0],
            endFloor: basementPlan.floorLabels[basementPlan.floorLabels.length - 1],
            belowGrade: true,
          });
        } catch (error) {
          warnings.push(`${basementName} FloorStack 생성 실패: ${String(error)}`);
          continue;
        }
      }

      for (const [componentIndex, component] of componentPlans.entries()) {
        const localOffset = isGeo
          ? { x: mToLon(component.centerXM, cy), y: mToLat(component.centerYM) }
          : siteLocalOffsetToWorld(component.centerXM, component.centerYM, 1, 1, siteRotationRad);
        const componentX = cx + localOffset.x;
        const componentY = cy + localOffset.y;
        const componentZ = localPlacementZ + component.baseElevationM;
        const componentName = `${building.name} / ${component.componentId}`;
        try {
          const floors = component.floorHeightsM.map((height) => ({
            polygon: component.localFloorStackPolygon,
            height,
          }));
          const { urn } = await Forma.elements.floorStack.createFromFloors({ floors });
          const { path } = await Forma.proposal.addElement({
            urn,
            name: componentName,
            transform: makePlacementTransform(componentX, componentY, componentZ, siteRotationRad),
          });
          const confirmation = await waitForBuildingLayerElement(path, {
            x: componentX,
            y: componentY,
            z: componentZ,
            rotationRad: siteRotationRad,
            heightM: component.totalHeightM,
          });
          if (!confirmation.confirmed) {
            const removed = await removeUnconfirmedProposalElement(path);
            warnings.push(
              `${componentName}: proposal.addElement returned a path, but confirmation failed: ${describeBuildingConfirmationFailure(confirmation)}. `
              + `${removed ? 'It was removed' : 'Immediate cleanup failed; it will be retried by clearAllMasses'}.`,
            );
            continue;
          }
          _unconfirmedElementPaths.delete(path);
          _elementPaths.add(path);
          placed.push({
            name: componentName,
            geojsonId: path,
            centerX: componentX,
            centerY: componentY,
            placementZ: componentZ,
            widthM: component.widthM,
            depthM: component.depthM,
            heightM: component.totalHeightM,
            floors: component.floorCount,
            basementFloors: 0,
            footprintArea: component.requestedAreaM2,
            totalFloorArea: component.requestedAreaM2 * component.floorCount,
            floorDetails: component.floorLabels.map((label, floorIndex) =>
              `${label}: ${component.requestedAreaM2}m2 / ${component.floorHeightsM[floorIndex]}m`),
            roomUnitCount: 0,
            color: MASS_COLORS[(i + componentIndex) % MASS_COLORS.length],
            method: 'building_element',
            confirmation: {
              buildingLayer: confirmation.buildingLayer,
              visibleVolume: confirmation.visibleVolume,
              worldTransform: confirmation.worldTransform,
              nonVirtual: confirmation.nonVirtual,
              actualTransformZ: confirmation.actualTransformZ ?? componentZ,
            },
            debug: {
              siteSourcePath,
              elevationSourcePath: buildingElevationSourcePath,
              baseElevation,
              localMeshElevation: localMeshElevationM,
            },
            componentId: component.componentId,
            componentType: component.componentType,
            parentComponentId: component.parentComponentId,
            startFloor: component.startFloor,
            endFloor: component.endFloor,
            belowGrade: false,
          });
        } catch (error) {
          warnings.push(`${componentName} FloorStack 생성 실패: ${String(error)}`);
        }
      }
      continue;
    }

    const floorSpecs = buildFloorSpecs(building);
    const aboveGradeSpecs = floorSpecs.filter((floor) => !floor.belowGrade);
    const basementDepthM = floorSpecs
      .filter((floor) => floor.belowGrade)
      .reduce((sum, floor) => sum + floor.heightM, 0);
    const heightM = floorSpecs.reduce((sum, floor) => sum + floor.heightM, 0);
    const footprintArea = aboveGradeSpecs[0]?.areaM2 ?? building.footprint_area;
    const totalFloorArea = floorSpecs.reduce((sum, floor) => sum + floor.areaM2, 0);
    const { w: footprintWM, d: footprintDM } = areaToRect(footprintArea);
    const buildingElevationRef = sourceGeometryElevation
      ? null
      : (!isGeo ? await getElevationReferencePath(bounds, cx, cy) : elevationRef);
    const buildingElevationSourcePath = sourceGeometryElevation
      ? siteSourcePath
      : (buildingElevationRef?.path ?? '');
    const localMeshElevationM = !sourceGeometryElevation && !isGeo && buildingElevationSourcePath
      ? (await sampleLocalElevationFromMesh(buildingElevationSourcePath, cx, cy)) ?? null
      : null;
    if (!sourceGeometryElevation && !isGeo && !buildingElevationRef && elevationRef) {
      warnings.push(
        `${building.name}: 배치 지점이 terrain mesh 범위 밖이어서 관련 없는 지형 높이를 사용하지 않고 ` +
        `선택된 대지의 기준 높이 Z=${baseElevation.toFixed(1)}m를 사용합니다.`,
      );
    }
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

    // Method 1: create a FloorStack building and add it to the proposal.
    let addedAsBuilding = false;
    if (canEdit) {
      try {
        // Mass placement must create a robust visible solid. Detailed room-plan
        // units belong to the separate floor-plan recreation workflow and can
        // yield a persisted container before Forma produces a renderable volume.
        const massFloors = floorSpecs.map((floor) => ({
          polygon: getLocalFootprintPolygon(building, floor.areaM2),
          height: floor.heightM,
        }));

        const { urn } = await Forma.elements.floorStack.createFromFloors({
          floors: massFloors,
        });

        const { path } = await Forma.proposal.addElement({
          urn,
          name: building.name,
          transform: makePlacementTransform(cx, cy, localPlacementZ - basementDepthM, siteRotationRad),
        });

        const confirmation = await waitForBuildingLayerElement(path, {
          x: cx,
          y: cy,
          z: localPlacementZ - basementDepthM,
          rotationRad: siteRotationRad,
          heightM,
        });
        if (!confirmation.confirmed) {
          const removed = await removeUnconfirmedProposalElement(path);
          warnings.push(
            `${building.name}: proposal.addElement returned a path, but confirmation failed: ${describeBuildingConfirmationFailure(confirmation)}. ` +
            `${removed ? 'It was removed' : 'Immediate cleanup failed; it will be retried by clearAllMasses'} and was not counted as a generated building.`,
          );
          continue;
        }
        _unconfirmedElementPaths.delete(path);
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
          floorDetails: floorSpecs.map((floor) => `${floor.label}: ${floor.areaM2}m2 / ${floor.heightM}m`),
          roomUnitCount: floorSpecs.reduce((sum, floor) => sum + simplifyRoomsForPlan(getRoomsWithFill(floor), MAX_ROOM_UNITS_PER_FLOOR).length, 0),
          color,
          method: 'building_element',
          confirmation: {
            buildingLayer: confirmation.buildingLayer,
            visibleVolume: confirmation.visibleVolume,
            worldTransform: confirmation.worldTransform,
            nonVirtual: confirmation.nonVirtual,
            actualTransformZ: confirmation.actualTransformZ ?? (localPlacementZ - basementDepthM),
          },
          debug: {
            siteSourcePath,
            elevationSourcePath: buildingElevationSourcePath,
            baseElevation,
            localMeshElevation: localMeshElevationM,
          },
        });
      } catch (err) {
        warnings.push(`${building.name} FloorStack 생성 실패: ${String(err)}`);
      }
    }

    // Do not create a render.geojson fallback for mass generation. A temporary overlay is not
    // an actual Forma building mass and would make downstream room-layout placement ambiguous.
    if (!addedAsBuilding) {
      warnings.push(`${building.name}: no actual Buildings layer mass was generated. Temporary 2D/overlay mass fallback is disabled.`);
    }
  }

  // 3. Calculate coverage.
  // Elevated child components do not add ground-level building coverage.
  const totalFootprint = placed
    .filter((mass) => mass.parentComponentId == null && mass.belowGrade !== true)
    .reduce((sum, mass) => sum + mass.footprintArea, 0);
  const declaredSiteArea = Number(requirements.site_limits.total_site_area) || 0;
  const siteArea = declaredSiteArea > 0 ? declaredSiteArea : (bounds?.siteAreaM2 ?? 0);
  const coverageRatio = siteArea > 0 ? parseFloat((totalFootprint / siteArea).toFixed(4)) : 0;

  return {
    placed,
    warnings,
    siteReference,
    totalFootprint,
    coverageRatio,
    ...(componentErrors.length > 0 ? { componentErrors } : {}),
  };
}

/**
 * Removes all masses and temporary artifacts placed by this extension.
 * - Buildings layer elements: proposal.removeElement
 * - Fallback overlays: render.geojson.remove
 */
export async function clearAllMasses(): Promise<{ removedCount: number }> {
  let removedCount = 0;

  // Remove Buildings layer elements.
  for (const path of Array.from(_elementPaths)) {
    try {
      await Forma.proposal.removeElement({ path });
      _elementPaths.delete(path);
      _unconfirmedElementPaths.delete(path);
      removedCount++;
    } catch { /* Keep the path so a later clearAllMasses call can retry. */ }
  }
  removedCount += await clearRoomLayoutArtifacts();
  _massFallbackIds.clear();

  // Remove fallback render.geojson overlays.
  for (const id of _fallbackIds) {
    try {
      await Forma.render.geojson.remove({ id });
      removedCount++;
    } catch { /* Already removed. */ }
  }
  _fallbackIds.clear();

  return { removedCount };
}

export function resolveAuthorizedFloorLabels(
  building: BuildingRequirements['buildings'][number],
  scope: 'above' | 'basement',
): string[] {
  const breakdown = scope === 'basement' ? building.basement?.floor_breakdown : building.floor_breakdown;
  const plans = scope === 'basement' ? building.basement?.floor_plans : building.floor_plans;
  const breakdownLabels = Object.keys(breakdown ?? {}).filter((label) => Number(breakdown?.[label]) > 0);
  const planLabels = Object.keys(plans ?? {}).filter(
    (label) => Array.isArray(plans?.[label]) && (plans?.[label]?.length ?? 0) > 0,
  );

  let labels = breakdownLabels.length > 0 && planLabels.length > 0
    ? breakdownLabels.filter((label) => planLabels.includes(label))
    : breakdownLabels.length > 0
      ? breakdownLabels
      : planLabels;

  if (scope === 'above' && building.target_floors > 0) {
    labels = labels.filter((label) => {
      const match = label.match(/^(\d+)F$/i);
      return !match || parseInt(match[1], 10) <= building.target_floors;
    });
  }

  if (scope === 'basement' && (building.basement?.floors ?? 0) > 0) {
    const maxBasement = building.basement!.floors;
    labels = labels.filter((label) => {
      const match = label.match(/^B(\d+)$/i);
      return !match || parseInt(match[1], 10) <= maxBasement;
    });
  }

  return labels.sort((a, b) => floorOrder(a) - floorOrder(b));
}

export function canonicalizeRequirementsForFloorStack(
  requirements: BuildingRequirements,
): BuildingRequirements {
  return requirements;
}

function getFirstFloorPlanSource(building: BuildingRequirements['buildings'][number]): {
  label: string;
  rooms: RoomLayout[];
  belowGrade: boolean;
} | null {
  const basementLabels = resolveAuthorizedFloorLabels(building, 'basement');
  for (const label of basementLabels) {
    const rooms = building.basement?.floor_plans?.[label] ?? [];
    if (rooms.length > 0) return { label, rooms, belowGrade: true };
  }

  const aboveLabels = resolveAuthorizedFloorLabels(building, 'above');
  for (const label of aboveLabels) {
    const rooms = building.floor_plans?.[label] ?? [];
    if (rooms.length > 0) return { label, rooms, belowGrade: false };
  }

  return null;
}

export async function testGenericRoomProgramCompatibility(): Promise<{
  status: 'success' | 'failed';
  successfulProgram?: string;
  attempts: Array<{ name: string; ok: boolean; error?: string }>;
  note?: string;
}> {
  const result = await testFloorStackPlanUnits();
  return {
    status: result.status,
    successfulProgram: result.status === 'success' ? 'LIVING_UNIT' : undefined,
    attempts: result.attempts,
    note: 'Checks whether basic FloorStack plan units can be created in the current Forma project.',
  };
}

export async function testMinimalFloorPlanRecreation(
  requirements: BuildingRequirements,
): Promise<{
  status: 'success' | 'failed';
  sourceFloor?: string;
  roomCount?: number;
  result?: Awaited<ReturnType<typeof recreateBuildingsWithFloorPlans>>;
  message?: string;
}> {
  const building = requirements.buildings?.[0];
  if (!building) return { status: 'failed', message: 'No building was supplied.' };

  const source = getFirstFloorPlanSource(building);
  if (!source) return { status: 'failed', message: 'No floor plan rooms were found.' };

  const minimalBuilding = {
    ...building,
    target_floors: source.belowGrade ? 0 : 1,
    floor_breakdown: source.belowGrade ? {} : { [source.label]: source.rooms.slice(0, 3).reduce((sum, room) => sum + Number(room.area_m2 ?? 0), 0) },
    floor_plans: source.belowGrade ? {} : { [source.label]: source.rooms.slice(0, 3) },
    basement: source.belowGrade
      ? {
          ...(building.basement ?? { floors: 1, area_m2: 0, use: 'Basement' }),
          floors: 1,
          floor_breakdown: { [source.label]: source.rooms.slice(0, 3).reduce((sum, room) => sum + Number(room.area_m2 ?? 0), 0) },
          floor_plans: { [source.label]: source.rooms.slice(0, 3) },
        }
      : undefined,
  };

  const result = await recreateBuildingsWithFloorPlans({ ...requirements, buildings: [minimalBuilding] });
  return {
    status: result.status === 'failed' ? 'failed' : 'success',
    sourceFloor: source.label,
    roomCount: Math.min(source.rooms.length, 3),
    result,
  };
}

export async function testProgressiveFloorPlanRecreation(
  requirements: BuildingRequirements,
): Promise<{ status: 'success' | 'partial' | 'failed'; summary: string }> {
  const result = await recreateBuildingsWithFloorPlans(requirements);
  return {
    status: result.status,
    summary: result.status === 'success'
      ? 'Full building recreation succeeded during progressive diagnostic.'
      : 'Full building recreation was rejected during progressive diagnostic.',
  };
}

export async function testCombinedFloorPlanRecreation(
  requirements: BuildingRequirements,
): Promise<{ status: 'success' | 'partial' | 'failed'; summary: string }> {
  const result = await recreateBuildingsWithFloorPlans(requirements);
  return {
    status: result.status,
    summary: result.status === 'success'
      ? 'Combined floor recreation succeeded.'
      : 'Combined floor recreation was rejected by Forma.',
  };
}

export async function testFloorPlanUnitCompatibility(
  requirements: BuildingRequirements,
  floorLabel = '1F',
): Promise<{
  status: 'success' | 'partial' | 'failed';
  building?: string;
  floor: string;
  attempts: Array<{ name: string; unitCount: number; ok: boolean; error?: string; path?: string }>;
  summary: string;
}> {
  const building = requirements.buildings?.[0];
  const attempts: Array<{ name: string; unitCount: number; ok: boolean; error?: string; path?: string }> = [];
  if (!building) {
    return { status: 'failed', floor: floorLabel, attempts, summary: 'No building was supplied.' };
  }

  const floorSpecs = buildFloorSpecs(building);
  const targetFloor =
    floorSpecs.find((floor) => floor.label === floorLabel) ??
    floorSpecs.find((floor) => !floor.belowGrade) ??
    floorSpecs[0];
  if (!targetFloor) {
    return { status: 'failed', building: building.name, floor: floorLabel, attempts, summary: 'No floor specs were available.' };
  }

  const runAttempt = async (name: string, floor: FloorSpec): Promise<void> => {
    const plan = buildPlanFromRooms(floor, { includeFunctionIds: false, includePrograms: true });
    if (!plan) {
      attempts.push({ name, unitCount: 0, ok: false, error: 'plan generation returned null' });
      return;
    }
    const livingPlan = stripPlanFunctionIds(forcePlanProgram(plan, 'LIVING_UNIT'));
    try {
      const added = await addFloorStackAtSiteCenter(
        `${building.name} - ${targetFloor.label} compatibility - ${name}`,
        {
          floors: [{ planId: livingPlan.id, height: targetFloor.heightM }],
          plans: [livingPlan],
        },
      );
      attempts.push({ name, unitCount: livingPlan.units.length, ok: true, path: added.path });
    } catch (err) {
      attempts.push({ name, unitCount: livingPlan.units.length, ok: false, error: String(err) });
    }
  };

  await runAttempt('single unit', {
    ...targetFloor,
    rooms: [{
      name: `${targetFloor.label} Floor`,
      area_m2: Math.max(targetFloor.areaM2, 1),
      function_id: 'floor',
      unit_type: 'LIVING_UNIT',
    }],
    coreTemplate: undefined,
  });

  const simplifiedCorePlan = buildSimplifiedCoreFloorPlan(targetFloor, { includeFunctionIds: false, includePrograms: true });
  if (simplifiedCorePlan) {
    try {
      const livingPlan = stripPlanFunctionIds(forcePlanProgram(simplifiedCorePlan, 'LIVING_UNIT'));
      const added = await addFloorStackAtSiteCenter(
        `${building.name} - ${targetFloor.label} compatibility - core plus other`,
        {
          floors: [{ planId: livingPlan.id, height: targetFloor.heightM }],
          plans: [livingPlan],
        },
      );
      attempts.push({ name: 'core + other', unitCount: livingPlan.units.length, ok: true, path: added.path });
    } catch (err) {
      attempts.push({ name: 'core + other', unitCount: simplifiedCorePlan.units.length, ok: false, error: String(err) });
    }
  } else {
    attempts.push({ name: 'core + other', unitCount: 0, ok: false, error: 'core template or core room was not available' });
  }

  const rooms = getRoomsWithFill(targetFloor);
  const coreRoom = rooms.find((room) => normalizeUnitType(room) === 'CORE');
  const nonCoreRooms = rooms.filter((room) => normalizeUnitType(room) !== 'CORE');
  const leadingRooms = coreRoom ? [coreRoom, ...nonCoreRooms] : nonCoreRooms;
  for (let count = 1; count <= Math.min(leadingRooms.length, 8); count += 1) {
    await runAttempt(`first ${count} room(s)`, {
      ...targetFloor,
      rooms: leadingRooms.slice(0, count),
    });
  }

  await runAttempt('full floor rooms', targetFloor);

  const firstFailed = attempts.find((attempt) => !attempt.ok);
  const successCount = attempts.filter((attempt) => attempt.ok).length;
  return {
    status: successCount === attempts.length ? 'success' : successCount > 0 ? 'partial' : 'failed',
    building: building.name,
    floor: targetFloor.label,
    attempts,
    summary: firstFailed
      ? `First rejected attempt: ${firstFailed.name} (${firstFailed.error ?? 'no error detail'})`
      : 'All compatibility attempts were accepted.',
  };
}

export async function testCircularFloorStackMass(): Promise<{
  status: 'success' | 'failed';
  successfulAttempt?: string;
  path?: string;
  attempts: Array<{ name: string; ok: boolean; error?: string }>;
  note?: string;
}> {
  const radius = 12;
  const polygon = Array.from({ length: 24 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 24;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius] as [number, number];
  });
  const attempts: Array<{ name: string; ok: boolean; error?: string }> = [];
  try {
    const added = await addFloorStackAtSiteCenter('solid circular mass test', {
      floors: [{ polygon, height: 3 }],
    });
    attempts.push({ name: 'solid circular mass (24-gon)', ok: true });
    return { status: 'success', successfulAttempt: attempts[0].name, path: added.path, attempts };
  } catch (err) {
    attempts.push({ name: 'solid circular mass (24-gon)', ok: false, error: String(err) });
    return { status: 'failed', attempts };
  }
}

export async function testRingAtriumFloorStackMass(): Promise<{
  status: 'failed';
  attempts: Array<{ name: string; ok: boolean; error?: string }>;
  note: string;
}> {
  return {
    status: 'failed',
    attempts: [{ name: 'ring atrium mass', ok: false, error: 'Ring atrium FloorStack creation is not supported by the current fallback implementation.' }],
    note: 'This project path currently supports solid FloorStack polygons only.',
  };
}

/** Return Buildings element paths placed by the current session. */
export function getPlacedElementPaths(): string[] {
  return Array.from(_elementPaths).filter((path) => !_unconfirmedElementPaths.has(path));
}
