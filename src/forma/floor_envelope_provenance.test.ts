import { describe, expect, it } from 'vitest';
import {
  decideOriginalMassReplacement,
  describeFloorEnvelopeSelection,
  selectFloorEnvelopeSource,
} from './floor_envelope_provenance';

describe('selectFloorEnvelopeSource', () => {
  it('prioritizes existing GFA while retaining the original pending confirmation', () => {
    const result = selectFloorEnvelopeSource({
      existingGfa: { envelopes: 'gfa' },
      sourceRoomPolygons: { envelopes: 'rooms' },
      pdfProgram: { envelopes: 'pdf' },
    });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.selection.provenance).toBe('existing_gfa_exact');
    expect(result.selection.authority.preservesExistingMassShape).toBe(true);
    expect(result.selection.authority.mayAutoDeleteOriginal).toBe(false);
  });

  it('uses authored room polygons without claiming equivalence to the old mass', () => {
    const result = selectFloorEnvelopeSource({
      existingGfa: { error: 'no GFA' },
      sourceRoomPolygons: { envelopes: 'rooms' },
      pdfProgram: { envelopes: 'pdf' },
    });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.selection.provenance).toBe('source_room_polygons');
    expect(result.selection.authority.preservesExistingMassShape).toBe(false);
    expect(result.selection.authority.mayAutoDeleteOriginal).toBe(false);
  });

  it('marks PDF-derived rectangles as conceptual and non-replaceable', () => {
    const result = selectFloorEnvelopeSource({
      existingGfa: { error: 'no GFA' },
      sourceRoomPolygons: { error: 'no room polygons' },
      pdfProgram: { envelopes: 'pdf', warnings: ['program-only'] },
    });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.selection.provenance).toBe('pdf_program_rectangle');
    expect(result.selection.authority.mode).toBe('conceptual');
    expect(result.selection.authority.mayAutoDeleteOriginal).toBe(false);
    expect(result.selection.warnings).toEqual(['program-only']);
    expect(describeFloorEnvelopeSelection(result.selection)).toContain('autoDeleteOriginal=false');
  });

  it('returns all source errors when no geometry source is usable', () => {
    const result = selectFloorEnvelopeSource({
      existingGfa: { error: 'no GFA' },
      sourceRoomPolygons: { error: 'no room polygons' },
      pdfProgram: { error: 'no program area', warnings: ['missing area'] },
    });

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.error).toContain('no GFA');
    expect(result.error).toContain('no room polygons');
    expect(result.error).toContain('no program area');
    expect(result.warnings).toEqual(['missing area']);
  });
});

describe('decideOriginalMassReplacement', () => {
  const eligible = {
    placedCount: 1,
    failedCount: 0,
    hasDegradedFloorPlans: false,
    allPlacedMayAutoDeleteOriginal: true,
    originalMassPath: 'old/path',
    replacementPaths: ['new/path'],
  };

  it('allows deletion only for a complete, verified replacement', () => {
    expect(decideOriginalMassReplacement(eligible)).toEqual({ action: 'delete', path: 'old/path' });
  });

  it('retains the old mass for unverified room-polygon or PDF geometry', () => {
    expect(decideOriginalMassReplacement({ ...eligible, allPlacedMayAutoDeleteOriginal: false })).toEqual({
      action: 'retain',
      reason: 'unverified-geometry',
    });
  });

  it('retains the old mass when any building failed or any plan was degraded', () => {
    expect(decideOriginalMassReplacement({ ...eligible, failedCount: 1 })).toMatchObject({ action: 'retain' });
    expect(decideOriginalMassReplacement({ ...eligible, hasDegradedFloorPlans: true })).toMatchObject({ action: 'retain' });
  });

  it('does not delete when the replacement reports the same path', () => {
    expect(decideOriginalMassReplacement({ ...eligible, replacementPaths: ['old/path'] })).toEqual({
      action: 'retain-same-path',
      path: 'old/path',
    });
  });
});
