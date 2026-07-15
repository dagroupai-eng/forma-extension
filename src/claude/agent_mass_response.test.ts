import { describe, expect, it, vi } from 'vitest';

vi.mock('forma-embedded-view-sdk/auto', () => ({ Forma: {} }));

import {
  formatToolResponse,
  getDeterministicToolResponse,
  hasValidMassPlacementInput,
  requiresVerifiedMassPlacement,
} from './agent';
import { executeFormaTool } from '../forma/executor';

describe('formatToolResponse for place_building_masses', () => {
  it('reports success and the verified number of created masses', () => {
    const response = formatToolResponse('place_building_masses', {
      status: 'success',
      massesPlaced: 1,
      summary: [{
        layerConfirmed: true,
        visibleVolumeConfirmed: true,
        worldTransformConfirmed: true,
        nonVirtualConfirmed: true,
      }],
    });

    expect(response).toContain('매스 생성이 완료되었습니다.');
    expect(response).toContain('실제 생성된 건물 수: 1');
  });

  it('treats a Buildings path without confirmed visible volume as a failure', () => {
    const response = formatToolResponse('place_building_masses', {
      status: 'success',
      massesPlaced: 1,
      summary: [{
        name: 'Invisible container',
        layerConfirmed: true,
        visibleVolumeConfirmed: false,
        worldTransformConfirmed: true,
        nonVirtualConfirmed: true,
      }],
    });

    expect(response).toContain('매스 생성에 실패했습니다.');
    expect(response).toContain('실제 생성된 건물 수: 0');
    expect(response).not.toContain('매스 생성이 완료되었습니다.');
  });

  it('reports failure without claiming successful completion when no mass was created', () => {
    const response = formatToolResponse('place_building_masses', {
      status: 'failed',
      massesPlaced: 0,
    });

    expect(response).toContain('매스 생성에 실패했습니다.');
    expect(response).toContain('실제 생성된 건물 수: 0');
    expect(response).not.toContain('매스 생성이 완료되었습니다.');
  });

  it('includes the reported reason when the placement target is not found', () => {
    const response = formatToolResponse('place_building_masses', {
      status: 'not_found',
      message: '선택된 Constraint를 찾을 수 없습니다.',
    });

    expect(response).toContain('선택된 Constraint를 찾을 수 없습니다.');
    expect(response).not.toContain('매스 생성이 완료되었습니다.');
  });

  it('includes the reported error when placement throws an error', () => {
    const response = formatToolResponse('place_building_masses', {
      error: 'Buildings 레이어 등록에 실패했습니다.',
    });

    expect(response).toContain('Buildings 레이어 등록에 실패했습니다.');
    expect(response).not.toContain('매스 생성이 완료되었습니다.');
  });
});

describe('getDeterministicToolResponse', () => {
  it('returns a deterministic response for mass placement', () => {
    expect(getDeterministicToolResponse('place_building_masses', {
      status: 'success',
      massesPlaced: 1,
      summary: [{
        layerConfirmed: true,
        visibleVolumeConfirmed: true,
        worldTransformConfirmed: true,
        nonVirtualConfirmed: true,
      }],
    })).toEqual(expect.any(String));
  });

  it('returns null for tools that do not require a deterministic placement response', () => {
    expect(getDeterministicToolResponse('get_current_selection', {
      status: 'success',
    })).toBeNull();
  });
});

describe('requiresVerifiedMassPlacement', () => {
  it.each([
    '매스를 생성해줘',
    '선택한 Constraint에 매스를 배치해줘',
  ])('recognizes the Korean imperative placement request: %s', (request) => {
    expect(requiresVerifiedMassPlacement(request)).toBe(true);
  });

  it.each([
    '매스가 무엇인지 설명해줘',
    '매스 배치 방식이 어떻게 동작하는지 알려줘',
    '매스를 배치하지 마세요',
    '매스 배치 방법을 설명해줘',
    '왜 매스가 배치됐나요?',
  ])('does not treat an explanatory question as a placement command: %s', (request) => {
    expect(requiresVerifiedMassPlacement(request)).toBe(false);
  });
});

describe('hasValidMassPlacementInput', () => {
  it('rejects an empty placement payload', () => {
    expect(hasValidMassPlacementInput({})).toBe(false);
  });

  it('accepts requirements containing at least one building', () => {
    expect(hasValidMassPlacementInput({
      requirements: {
        buildings: [{ name: 'Library' }],
      },
    })).toBe(true);
  });

  it('accepts a project name that can resolve stored requirements', () => {
    expect(hasValidMassPlacementInput({
      project_name: 'Gyeongju Library',
    })).toBe(true);
  });
});

describe('place_building_masses executor input guard', () => {
  it('does not mutate the proposal with the built-in sample when the payload is empty', async () => {
    await expect(executeFormaTool('place_building_masses', {})).resolves.toMatchObject({
      status: 'failed',
      massesPlaced: 0,
    });
  });
});
