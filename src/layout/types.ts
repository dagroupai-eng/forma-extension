import type { FloorGeometryContract, Point2 } from './geometry_contract';

export type LayoutRoomKind = 'CORE' | 'CORRIDOR' | 'PARKING' | 'LIVING_UNIT';
export type ConstraintStrength = 'hard' | 'soft';
export type LayoutRelationType = 'adjacent' | 'separate';
export type LayoutShapePreference =
  | 'RECTANGLE'
  | 'L_SHAPE'
  | 'U_SHAPE'
  | 'COMPACT_RECTANGLE'
  | 'LONG_RECTANGLE_AVOID'
  | 'CORE';

export interface LayoutAspectRatio {
  min: number;
  max: number;
}

export interface FixedRoomPlacement {
  polygon: Point2[];
  source: 'source-room-polygon' | 'user-lock';
}

export interface LayoutRoom {
  id: string;
  name: string;
  targetAreaM2: number;
  minAreaM2: number;
  maxAreaM2: number;
  kind: LayoutRoomKind;
  group?: string;
  facadeRequired: boolean;
  daylightPriority: 'high' | 'medium' | 'low';
  coreProximity: 'required' | 'preferred' | 'neutral';
  noiseLevel?: 'low' | 'medium' | 'medium-high' | 'high';
  aspectRatio?: LayoutAspectRatio;
  shapePreference?: LayoutShapePreference;
  placementHint?: string;
  zoneHint?: string;
  edgePreference?: string;
  fixedPlacement?: FixedRoomPlacement;
}

export interface LayoutRelation {
  roomA: string;
  roomB: string;
  type: LayoutRelationType;
  strength: ConstraintStrength;
  weight: number;
}

export interface LayoutWeights {
  areaAccuracy: number;
  requiredAdjacency: number;
  preferredAdjacency: number;
  separation: number;
  facadeContact: number;
  daylight: number;
  coreProximity: number;
  aspectRatio: number;
  compactness: number;
}

export type LayoutFloorGeometry = Omit<
  FloorGeometryContract,
  'rooms' | 'reservedCirculationAreaM2' | 'roomDemandAreaM2'
>;

export interface LayoutProblem {
  schemaVersion: '1.0';
  problemId: string;
  buildingId?: string;
  levelId: string;
  seed: number;
  geometry: LayoutFloorGeometry;
  reservedCirculationAreaM2: number;
  programAreaM2: number;
  rooms: LayoutRoom[];
  relations: LayoutRelation[];
  weights: LayoutWeights;
}

export interface LayoutPlacement {
  roomId: string;
  polygon: Point2[];
  areaM2: number;
  locked: boolean;
}

export interface LayoutMetricSet {
  areaErrorM2: number;
  overlapAreaM2: number;
  outsideAreaM2: number;
  requiredAdjacencySatisfied: number;
  requiredAdjacencyTotal: number;
  facadeRequirementsSatisfied: number;
  facadeRequirementsTotal: number;
  preferredAdjacencySatisfied: number;
  preferredAdjacencyTotal: number;
  separationSatisfied: number;
  separationTotal: number;
  daylightScore: number;
  coreProximityScore: number;
  aspectRatioScore: number;
  compactnessScore: number;
}

export type LayoutScoreBreakdown = Record<keyof LayoutWeights, number>;

export interface LayoutSolutionViolation {
  code: string;
  roomId?: string;
  message: string;
}

/** Solver-independent output contract. Stage 2 defines it but does not solve it. */
export interface LayoutSolution {
  schemaVersion: '1.0';
  problemId: string;
  solutionId: string;
  seed: number;
  status: 'feasible' | 'infeasible' | 'partial';
  placements: LayoutPlacement[];
  metrics: LayoutMetricSet;
  scoreBreakdown: LayoutScoreBreakdown;
  score: number;
  violations: LayoutSolutionViolation[];
}
