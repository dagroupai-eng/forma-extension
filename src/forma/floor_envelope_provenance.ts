import { geometryAuthorityPolicy, type GeometryAuthorityPolicy, type GeometryAuthoritySource } from '../layout/geometry_contract';

export type FloorEnvelopeProvenance =
  | 'existing_gfa_exact'
  | 'source_room_polygons'
  | 'pdf_program_rectangle';

export interface EnvelopeCandidate<T> {
  envelopes?: T;
  error?: string;
  warnings?: string[];
}

export interface FloorEnvelopeSelection<T> {
  envelopes: T;
  provenance: FloorEnvelopeProvenance;
  authority: GeometryAuthorityPolicy;
  warnings: string[];
}

export type FloorEnvelopeSelectionResult<T> =
  | { ok: true; selection: FloorEnvelopeSelection<T> }
  | { ok: false; error: string; warnings: string[] };

export function geometrySourceForEnvelopeProvenance(provenance: FloorEnvelopeProvenance): GeometryAuthoritySource {
  if (provenance === 'existing_gfa_exact') return 'existing-gfa';
  if (provenance === 'source_room_polygons') return 'source-room-polygons';
  return 'pdf-program';
}

export function selectFloorEnvelopeSource<T>(candidates: {
  existingGfa: EnvelopeCandidate<T>;
  sourceRoomPolygons?: EnvelopeCandidate<T>;
  pdfProgram?: EnvelopeCandidate<T>;
}): FloorEnvelopeSelectionResult<T> {
  const ordered: Array<{ provenance: FloorEnvelopeProvenance; candidate?: EnvelopeCandidate<T> }> = [
    { provenance: 'existing_gfa_exact', candidate: candidates.existingGfa },
    { provenance: 'source_room_polygons', candidate: candidates.sourceRoomPolygons },
    { provenance: 'pdf_program_rectangle', candidate: candidates.pdfProgram },
  ];
  for (const item of ordered) {
    if (item.candidate?.envelopes !== undefined) {
      return {
        ok: true,
        selection: {
          envelopes: item.candidate.envelopes,
          provenance: item.provenance,
          authority: geometryAuthorityPolicy(geometrySourceForEnvelopeProvenance(item.provenance)),
          warnings: item.candidate.warnings ?? [],
        },
      };
    }
  }

  const errors = ordered.map((item) => item.candidate?.error).filter((value): value is string => Boolean(value));
  const warnings = ordered.flatMap((item) => item.candidate?.warnings ?? []);
  return {
    ok: false,
    error: errors.join(' | ') || 'No usable floor geometry source was available.',
    warnings,
  };
}

export function describeFloorEnvelopeSelection<T>(selection: FloorEnvelopeSelection<T>): string {
  return `envelopeSource=${selection.provenance}, mode=${selection.authority.mode}, ` +
    `preservesExistingMassShape=${selection.authority.preservesExistingMassShape}, ` +
    `autoDeleteOriginal=${selection.authority.mayAutoDeleteOriginal}`;
}

export interface OriginalMassReplacementDecisionInput {
  placedCount: number;
  failedCount: number;
  hasDegradedFloorPlans: boolean;
  allPlacedMayAutoDeleteOriginal: boolean;
  originalMassPath?: string;
  replacementPaths: string[];
}

export type OriginalMassReplacementDecision =
  | { action: 'delete'; path: string }
  | { action: 'retain'; reason: 'nothing-placed' | 'failed-buildings' | 'degraded-floor-plans' | 'unverified-geometry' | 'missing-original-path' }
  | { action: 'retain-same-path'; path: string };

export function decideOriginalMassReplacement(
  input: OriginalMassReplacementDecisionInput,
): OriginalMassReplacementDecision {
  if (input.placedCount <= 0) return { action: 'retain', reason: 'nothing-placed' };
  if (input.failedCount > 0) return { action: 'retain', reason: 'failed-buildings' };
  if (input.hasDegradedFloorPlans) return { action: 'retain', reason: 'degraded-floor-plans' };
  if (!input.allPlacedMayAutoDeleteOriginal) return { action: 'retain', reason: 'unverified-geometry' };
  if (!input.originalMassPath) return { action: 'retain', reason: 'missing-original-path' };
  if (input.replacementPaths.includes(input.originalMassPath)) return { action: 'retain-same-path', path: input.originalMassPath };
  return { action: 'delete', path: input.originalMassPath };
}
