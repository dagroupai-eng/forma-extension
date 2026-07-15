import Anthropic from '@anthropic-ai/sdk';
import { FORMA_TOOLS } from './tools';
import { executeFormaTool } from '../forma/executor';
import {
  extractJsonObject,
  extractJsonObjectCandidates,
  extractRoomScheduleRequirementsFromText,
  extractRequirementsFromDocument,
  parseRequirementsJson,
  repairMalformedJson,
} from '../utils/requirements_extract';

const CHAT_MODEL = 'claude-sonnet-4-6';
const STRUCTURED_EXTRACTION_MODEL = 'claude-opus-4-8';

const SYSTEM_PROMPT = [
  'You are an Autodesk Forma planning assistant.',
  'Use Forma tools to inspect geometry, selection, and create building masses.',
  'When a PDF or structured document is attached, extract building requirements carefully.',
  'Preserve exact floor heights, floor areas, basement data, and room layouts when they are available.',
  'If the user provides a levels/zones JSON schema for floor-plan recreation, preserve exact polygon coordinates and use them as the floor-plan source of truth.',
  'Explain results clearly and summarize warnings when tools return them.',
].join('\n');

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export type ProgressCallback = (text: string) => void;

export interface RunAgentOptions {
  apiKey?: string;
}

const DIRECT_RECREATE_MARKERS = [
  'recreate_buildings_with_floor_plans',
  'floor plan recreation',
  'direct floor plan recreate',
  'floorstack recreation',
  'floorstack 재생성',
  '실배치 재생성',
  'forma room-unit save retry',
];

const DIRECT_ZONE_PACKAGE_MARKERS = [
  'prepare_zone_import_package',
  'zone import package',
  'zone json package',
  'zone json',
  'zone package',
  'zone package 준비',
  'zone json 준비',
  'exact polygon 보존',
  '코어 좌표 보존',
];

const DIRECT_CIRCULAR_TEST_MARKERS = [
  'test_circular_floorstack_mass',
  'circular mass test',
];

const DIRECT_RING_ATRIUM_TEST_MARKERS = [
  'test_ring_atrium_floorstack_mass',
  'ring atrium mass test',
  'donut mass test',
];

export async function runAgent(
  userMessage: string,
  history: Message[],
  onProgress: ProgressCallback,
  options?: RunAgentOptions,
): Promise<string> {
  const apiKey = options?.apiKey?.trim() || import.meta.env.VITE_ANTHROPIC_API_KEY;

  if (!apiKey || apiKey.startsWith('sk-ant-PLACEHOLDER')) {
    return 'Anthropic API key is not configured. Add VITE_ANTHROPIC_API_KEY or enter a key in the app before running the assistant.';
  }

  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
  });

  const directInstructionText = extractDirectInstructionText(userMessage);
  const directInstructionLower = directInstructionText.toLowerCase();

  const embeddedJson = extractJsonObject(userMessage);
  if (embeddedJson) {
    try {
      const parsed = JSON.parse(embeddedJson);
      if (getLevelsPayload(parsed)) {
        return await runDirectFloorPlanRecreate(client, userMessage, onProgress);
      }
      if (Array.isArray(parsed?.buildings) || Array.isArray(parsed?.requirements?.buildings)) {
        if (hasEmbeddedFloorPlans(parsed)) {
          return await runDirectFloorPlanRecreate(client, userMessage, onProgress);
        }
        return await runDirectMassPlacement(userMessage, onProgress);
      }
    } catch {
      // Keep going. We may still handle the message via a direct marker or the normal tool loop.
    }
  }

  const roomSchedulePayload = extractRoomScheduleRequirementsFromText(userMessage);
  if (roomSchedulePayload) {
    onProgress('Parsing room schedule table and regenerating the FloorStack with embedded floor plans...');
    const result = await executeFormaTool('recreate_buildings_with_floor_plans', roomSchedulePayload);
    return formatToolResponse('recreate_buildings_with_floor_plans', result);
  }

  if (DIRECT_RECREATE_MARKERS.some((marker) => directInstructionLower.includes(marker.toLowerCase()))) {
    return await runDirectFloorPlanRecreate(client, userMessage, onProgress);
  }

  if (DIRECT_ZONE_PACKAGE_MARKERS.some((marker) => directInstructionLower.includes(marker.toLowerCase()))) {
    return await runDirectZonePackagePrepare(client, userMessage, onProgress);
  }

  if (DIRECT_CIRCULAR_TEST_MARKERS.some((marker) => directInstructionLower.includes(marker.toLowerCase()))) {
    return await runDirectCircularMassTest(onProgress);
  }

  if (DIRECT_RING_ATRIUM_TEST_MARKERS.some((marker) => directInstructionLower.includes(marker.toLowerCase()))) {
    return await runDirectRingAtriumMassTest(onProgress);
  }

  const messages: Anthropic.MessageParam[] = [
    ...history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    { role: 'user', content: userMessage },
  ];

  const maxIterations = 15;
  const verifiedMassPlacementRequired = requiresVerifiedMassPlacement(userMessage);
  let massPlacementToolExecuted = false;

  for (let i = 0; i < maxIterations; i += 1) {
    const response = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: FORMA_TOOLS,
      messages,
      ...(i === 0 && verifiedMassPlacementRequired
        ? { tool_choice: { type: 'tool' as const, name: 'place_building_masses' } }
        : {}),
    });

    if (response.stop_reason === 'end_turn') {
      if (verifiedMassPlacementRequired && !massPlacementToolExecuted) {
        return [
          '매스 생성에 실패했습니다.',
          '',
          '- 실제 생성된 건물 수: 0',
          '- 매스 생성 요청이었지만 place_building_masses 도구가 실행되지 않아 실제 배치를 확인할 수 없습니다.',
        ].join('\n');
      }
      const textBlock = response.content.find((b) => b.type === 'text');
      return textBlock?.type === 'text' ? textBlock.text : 'The response could not be processed.';
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      const toolNames = toolUseBlocks
        .map((b) => (b.type === 'tool_use' ? TOOL_LABELS[b.name] || b.name : ''))
        .join(', ');

      onProgress('Running ' + toolNames + '...');

      const toolResultContents: Anthropic.ToolResultBlockParam[] = [];
      let deterministicMassPlacementResponse: string | null = null;

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        try {
          if (block.name === 'place_building_masses' && !hasValidMassPlacementInput(block.input)) {
            const invalidInputResult = {
              status: 'failed',
              massesPlaced: 0,
              error: 'place_building_masses 입력에 buildings, levels 또는 project_name이 없어 빈 payload 실행을 차단했습니다.',
            };
            deterministicMassPlacementResponse = formatToolResponse('place_building_masses', invalidInputResult);
            toolResultContents.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(invalidInputResult),
              is_error: true,
            });
            continue;
          }
          if (block.name === 'place_building_masses') massPlacementToolExecuted = true;
          const result = await executeFormaTool(block.name, block.input as Record<string, any>);
          const deterministicResponse = getDeterministicToolResponse(block.name, result);
          if (deterministicResponse !== null) deterministicMassPlacementResponse = deterministicResponse;
          toolResultContents.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (error) {
          if (block.name === 'place_building_masses') {
            massPlacementToolExecuted = true;
            deterministicMassPlacementResponse = formatToolResponse('place_building_masses', {
              status: 'failed',
              massesPlaced: 0,
              warnings: [`place_building_masses 실행 오류: ${String(error)}`],
            });
          }
          toolResultContents.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: String(error) }),
            is_error: true,
          });
        }
      }

      // Never let a later LLM turn rewrite a verified placement failure as a
      // success, including when Claude emitted multiple tool calls in one batch.
      if (deterministicMassPlacementResponse !== null) return deterministicMassPlacementResponse;

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResultContents });
    }
  }

  return 'The processing limit was exceeded. Please try a more specific request.';
}

function extractDirectInstructionText(message: string): string {
  const documentEndMarker = '--- document content end ---';
  const documentEnd = message.indexOf(documentEndMarker);
  if (documentEnd !== -1) {
    return message.slice(documentEnd + documentEndMarker.length).trim();
  }
  return message;
}

/** True only for an explicit command to create/place a real building mass. */
export function requiresVerifiedMassPlacement(message: string): boolean {
  const instruction = extractDirectInstructionText(message).trim().toLowerCase();
  if (!instruction) return false;

  const mentionsMass = /(?:매스|건물\s*매스|building\s+mass(?:es)?|\bmass(?:es)?\b)/i.test(instruction);
  const mentionsPlacementAction = /(?:생성|배치|만들|추가|올려|create|place|generate|add)/i.test(instruction);
  if (!mentionsMass || !mentionsPlacementAction) return false;

  const explicitlyNegated = /(?:생성|배치|만들|추가|올리)(?:하)?(?:지\s*마|지\s*말|면\s*안\s*돼)|(?:do\s+not|don't|without)\s+(?:create|place|generate|add)/i.test(instruction);
  const asksAboutPastFailure = /(?:왜|원인|이유).*(?:생성|배치)|(?:생성|배치).*(?:되지\s*않|안\s*됐|못\s*했|실패|왜|원인|이유)/i.test(instruction);
  if (explicitlyNegated || asksAboutPastFailure) return false;

  const asksForExplanation = /(?:어떻게|방법|원리|왜|무엇|설명|알려\s*줘|how\b|why\b|what\b|explain)/i.test(instruction);
  const explicitKoreanCommand = /(?:생성|배치|만들|추가|올려|진행|실행|적용)(?:을|를)?\s*(?:해\s*줘|해주세요|해\s*주세요|하라|바랍니다|진행해|실행해|시작해|해$)/i.test(instruction)
    || /(?:생성해|배치해|만들어|추가해|올려)(?:\s*줘|\s*주세요|줄래|주시겠어요|$)/i.test(instruction);
  const explicitEnglishCommand = /^(?:please\s+)?(?:create|place|generate|add)\b/i.test(instruction)
    || /\b(?:please|can you|could you|would you|go ahead(?: and)?)\b[^.!?]*(?:create|place|generate|add)\b/i.test(instruction);

  if (asksForExplanation && !explicitKoreanCommand && !explicitEnglishCommand) return false;
  return explicitKoreanCommand || explicitEnglishCommand;
}

export function hasValidMassPlacementInput(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const data = input as Record<string, any>;
  const requirements = data.requirements && typeof data.requirements === 'object'
    ? data.requirements as Record<string, any>
    : null;
  const project = data.project && typeof data.project === 'object'
    ? data.project as Record<string, any>
    : null;
  const requirementsProject = requirements?.project && typeof requirements.project === 'object'
    ? requirements.project as Record<string, any>
    : null;
  return (Array.isArray(requirements?.buildings) && requirements.buildings.length > 0)
    || (Array.isArray(data.buildings) && data.buildings.length > 0)
    || (Array.isArray(data.levels) && data.levels.length > 0)
    || (Array.isArray(requirements?.levels) && requirements.levels.length > 0)
    || (Array.isArray(project?.levels) && project.levels.length > 0)
    || (Array.isArray(requirementsProject?.levels) && requirementsProject.levels.length > 0)
    || (typeof data.project_name === 'string' && data.project_name.trim().length > 0);
}

async function runDirectFloorPlanRecreate(
  client: Anthropic,
  userMessage: string,
  onProgress: ProgressCallback,
): Promise<string> {
  const embeddedJson = extractJsonObject(userMessage);
  if (embeddedJson) {
    const directPayload = parseRequirementsJson(embeddedJson);
    if (directPayload) {
      const levelsPayload = getLevelsPayload(directPayload);
      if (levelsPayload) {
        onProgress('Converting the provided levels/zones JSON into a Forma floor plan...');
        const result = await executeFormaTool(
          'recreate_buildings_with_floor_plans',
          levelsPayload,
        );
        return formatToolResponse('recreate_buildings_with_floor_plans', result);
      }
      if (hasEmbeddedFloorPlans(directPayload)) {
        onProgress('Pasted JSON으로 Forma 실배치 재생성을 실행하는 중...');
        const sanitized = stripFloorPlansFromInferredAreaSource(userMessage, directPayload);
        const result = await executeFormaTool('recreate_buildings_with_floor_plans', sanitized.payload);
        return formatToolResponse(
          'recreate_buildings_with_floor_plans',
          addToolWarnings(result, [...sanitized.warnings, ...inferredAreaWarnings(userMessage, sanitized.payload)]),
        );
      }
    }
  }

  const directFromDocument = extractRequirementsFromDocument(userMessage);
  if (directFromDocument) {
    onProgress('PDF에 포함된 건축 요구사항 JSON을 직접 파싱하는 중...');
    const sanitized = stripFloorPlansFromInferredAreaSource(userMessage, directFromDocument);
    const result = await executeFormaTool('recreate_buildings_with_floor_plans', sanitized.payload);
    return formatToolResponse(
      'recreate_buildings_with_floor_plans',
      addToolWarnings(result, [...sanitized.warnings, ...inferredAreaWarnings(userMessage, sanitized.payload)]),
    );
  }

  onProgress('Extracting floor-plan JSON from the PDF content...');

  const extractionResponse = await client.messages.create({
    model: STRUCTURED_EXTRACTION_MODEL,
    max_tokens: 16000,
    system: [
      'You extract structured building requirements from a PDF-based user message.',
      'Return JSON only. No markdown and no explanation.',
      'Output minified JSON on a single line or with minimal whitespace to avoid truncation.',
      'The JSON root must be:',
      '{',
      '  "requirements": {',
      '    "project_name": "string",',
      '    "location": "string",',
      '    "site_limits": {},',
      '    "buildings": [',
      '      {',
      '        "name": "string",',
      '        "target_floor_area": 0,',
      '        "target_floors": 0,',
      '        "footprint_area": 0,',
      '        "footprint_width_m": 0,',
      '        "footprint_depth_m": 0,',
      '        "mass_layout_type": "AUTO",',
      '        "position_hint": "center",',
      '        "floor_breakdown": {},',
      '        "floor_heights_m": {},',
      '        "floor_layout_types": {},',
      '        "floor_plans": {',
      '          "1F": [',
      '            {',
      '              "name": "string",',
      '              "room_id": "string",',
      '              "unit_type": "LIVING_UNIT",',
      '              "group": "string",',
      '              "facade_required": false,',
      '              "core_proximity": "neutral",',
      '              "daylight_priority": "medium",',
      '              "noise_level": "low",',
      '              "required_adjacency": [],',
      '              "avoid_adjacency": []',
      '            }',
      '          ]',
      '        },',
      '        "core_template": {},',
      '        "basement": {',
      '          "floors": 0,',
      '          "area_m2": 0,',
      '          "use": "string",',
      '          "floor_breakdown": {},',
      '          "floor_heights_m": {},',
      '          "floor_layout_types": {},',
      '          "floor_plans": {}',
      '        }',
      '      }',
      '    ]',
      '  }',
      '}',
      'Rules:',
      '- Return valid JSON only.',
      '- Use at least one building.',
      '- Keep floor keys like B3, B2, B1, 1F, 2F.',
      '- Each room object must contain name and area_m2 only when the source document explicitly gives that room area.',
      '- Never invent, infer, proportionally distribute, average, round, or recalculate room area_m2 values.',
      '- Do not derive room area_m2 from floor totals, adjacency, room count, diagrams, common standards, or your own assumptions.',
      '- If a room name or relationship is present but its explicit area is absent, omit that room from floor_plans instead of assigning an estimated area_m2.',
      '- If all rooms on a floor lack explicit room areas, omit that floor from floor_plans; keep floor_breakdown if the floor total is explicitly stated.',
      '- Never change, round, or recalculate area_m2 values that are explicitly stated in the source document.',
      '- Never change floor_breakdown, footprint_area, or floor_heights_m values from the source.',
      '- Never add floors beyond target_floors or beyond the floors listed in floor_breakdown / floor_plans.',
      '- Preserve core_template center_x_m, center_y_m, width_m, depth_m, and fixed_across_floors exactly.',
      '- If the document contains a separate common core definition such as "3_core_definition" or "코어 JSON 정의", use it only to fix the core coordinate/center across floors. Do not let it override per-floor CORE room area_m2 from the room inventory.',
      '- For a common core polygon, populate requirements.buildings[].core_template with width_m, depth_m, center_x_m, center_y_m, fixed_across_floors=true, room_name, and function_id. Example polygon [[20,20],[32,20],[32,32.5],[20,32.5]] means width_m=12, depth_m=12.5, center_x_m=26, center_y_m=26.25. Treat this as the fixed coordinate reference, not a command to force every CORE room area to 150.',
      '- If per-floor CORE rows have different explicit area_m2 values, preserve those inventory values exactly while keeping the core center/coordinate fixed.',
      '- If footprint_width_m and footprint_depth_m are stated in the document, include them in the building object.',
      '- Extract room_id for each room if the document provides IDs (e.g. F01_L01, F03_R02).',
      '- Extract group (Research/Collaboration/Business/Admin/Support/Infra) from the document if present.',
      '- Extract facade_required (true/false) from the document if stated.',
      '- Extract core_proximity (required/preferred/neutral) from the document if stated.',
      '- Extract daylight_priority (high/medium/low) from the document if stated.',
      '- Extract noise_level (low/medium/medium-high/high) from the document if stated.',
      '- Extract required_adjacency as an array of room_id strings from the document if stated.',
      '- Extract avoid_adjacency as an array of room_id strings from the document if stated.',
      '- Omit optional fields when unknown instead of inventing values.',
      '- POLYGON RULE: Only preserve polygon coordinates if they are EXPLICITLY stated in the document AND the polygon area mathematically matches area_m2 (within 5%). Do NOT generate polygon coordinates yourself.',
      '- If the source includes corridor_polygons, preserve them under each floor entry and do not drop them.',
      '- If a consistent core is described, populate requirements.buildings[].core_template.',
      '- Use unit_type only when confident: CORE, CORRIDOR, LIVING_UNIT, PARKING.',
      '- If too many tiny rooms exist on one floor, merge some of them into one "Other" room.',
      '- If the document explicitly mentions L-shape or ㄱ자, use floor_layout_types.',
      '- Use mass_layout_type = "COURTYARD_U" only when the source explicitly says U-shape, U-shaped courtyard, ㄷ자, or ㄷ자형. Do not infer U-shape from the generic word courtyard.',
      '- If it mentions O-shape or closed courtyard, use mass_layout_type = "COURTYARD_O".',
      '- If it mentions circular or round, use mass_layout_type = "CIRCULAR".',
      '- If it mentions ring atrium or donut, use mass_layout_type = "RING_ATRIUM".',
    ].join('\n'),
    messages: [{ role: 'user', content: userMessage }],
  });

  const textBlock = extractionResponse.content.find((b) => b.type === 'text');
  const raw = textBlock?.type === 'text' ? textBlock.text.trim() : '';
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    throw new Error('Failed to extract recreation JSON from the PDF content.');
  }

  let payload = parseRequirementsJson(jsonText);
  if (!payload) {
    onProgress('로컬 JSON 복구에 실패해 Claude로 JSON 구조를 수정하는 중...');
    const repaired = await repairRequirementsJson(client, repairMalformedJson(jsonText), 'Invalid JSON syntax', onProgress);
    payload = parseRequirementsJson(repaired);
    if (!payload) {
      const repairedAgain = await repairRequirementsJson(client, repaired, 'Still invalid after first repair', onProgress);
      payload = parseRequirementsJson(repairedAgain);
    }
  }

  if (!payload) {
    throw new Error('Failed to parse recreation JSON after local and Claude repair attempts.');
  }

  onProgress('Running Forma floor-plan recreation...');
  const sanitized = stripFloorPlansFromInferredAreaSource(userMessage, payload);
  const result = await executeFormaTool('recreate_buildings_with_floor_plans', sanitized.payload);
  return formatToolResponse(
    'recreate_buildings_with_floor_plans',
    addToolWarnings(result, [...sanitized.warnings, ...inferredAreaWarnings(userMessage, sanitized.payload)]),
  );
}

async function runDirectZonePackagePrepare(
  client: Anthropic,
  userMessage: string,
  onProgress: ProgressCallback,
): Promise<string> {
  const parseDirectZonePayload = (text: string): Record<string, any> | null => {
    for (const candidate of extractJsonObjectCandidates(text)) {
      const parsed = parseRequirementsJson(candidate);
      if (!parsed || typeof parsed !== 'object') continue;
      const payload = getLevelsPayload(parsed);
      if (payload) return payload;
    }
    return null;
  };

  let directPayload = parseDirectZonePayload(userMessage);

  if (!directPayload) {
    onProgress('PDF에서 levels/zones JSON을 추출하는 중...');

    const extractionResponse = await client.messages.create({
      model: STRUCTURED_EXTRACTION_MODEL,
      max_tokens: 5000,
      system: [
        'You extract a levels/zones JSON schema from a PDF-based user message.',
        'Return JSON only. No markdown and no explanation.',
        'The JSON root must be:',
        '{',
        '  "site_id": "string",',
        '  "project_name": "string",',
        '  "coordinate_system": "string",',
        '  "levels": [',
        '    {',
        '      "level": 0,',
        '      "elevation_m": 0,',
        '      "floor_name": "string",',
        '      "zones": [',
        '        {',
        '          "zone_id": "string",',
        '          "name": "string",',
        '          "polygon": [[0,0],[1,0],[1,1],[0,1]],',
        '          "area_m2": 0,',
        '          "use_type": "string",',
        '          "color": "#9B9B9B",',
        '          "height_m": 0,',
        '          "is_consistent_across_floors": false',
        '        }',
        '      ]',
        '    }',
        '  ]',
        '}',
        'Rules:',
        '- Return valid JSON only.',
        '- Preserve exact polygon coordinates when they are present in the source.',
        '- Preserve consistent core coordinates and set is_consistent_across_floors = true when justified.',
        '- Do not invent extra floors that are not in the source.',
      ].join('\n'),
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = extractionResponse.content.find((b) => b.type === 'text');
    const raw = textBlock?.type === 'text' ? textBlock.text.trim() : '';
    const jsonText = extractJsonObject(raw);
    if (!jsonText) {
      throw new Error('PDF에서 Zone package JSON을 추출하지 못했습니다.');
    }

    const extractedPayload = parseDirectZonePayload(jsonText);
    if (!extractedPayload) {
      throw new Error('PDF에서 추출한 Zone JSON 파싱에 실패했습니다.');
    }
    directPayload = extractedPayload;
  }

  onProgress('Zone import package를 준비하는 중...');
  const result = await executeFormaTool('prepare_zone_import_package', directPayload);
  return formatToolResponse('prepare_zone_import_package', result);
}

async function runDirectMassPlacement(
  userMessage: string,
  onProgress: ProgressCallback,
): Promise<string> {
  const embeddedJson = extractJsonObject(userMessage);
  if (!embeddedJson) {
    throw new Error('건물 매스 생성용 JSON을 찾지 못했습니다.');
  }

  let payload: Record<string, any>;
  try {
    payload = JSON.parse(embeddedJson);
  } catch (error) {
    throw new Error('입력된 건물 JSON 파싱에 실패했습니다: ' + String(error));
  }

  onProgress('JSON을 기준으로 Forma 매스를 배치하는 중...');
  const result = await executeFormaTool(
    'place_building_masses',
    Array.isArray(payload?.requirements?.buildings) ? payload : { requirements: payload },
  );
  return formatToolResponse('place_building_masses', result);
}

async function runDirectCircularMassTest(
  onProgress: ProgressCallback,
): Promise<string> {
  onProgress('Running the circular FloorStack mass test...');
  const result = await executeFormaTool('test_circular_floorstack_mass', {});
  return formatToolResponse('test_circular_floorstack_mass', result);
}

async function runDirectRingAtriumMassTest(
  onProgress: ProgressCallback,
): Promise<string> {
  onProgress('Running the ring atrium FloorStack mass test...');
  const result = await executeFormaTool('test_ring_atrium_floorstack_mass', {});
  return formatToolResponse('test_ring_atrium_floorstack_mass', result);
}

async function repairRequirementsJson(
  client: Anthropic,
  brokenJson: string,
  parseError: string,
  onProgress: ProgressCallback,
): Promise<string> {
  onProgress('Repairing malformed JSON...');

  const response = await client.messages.create({
    model: STRUCTURED_EXTRACTION_MODEL,
    max_tokens: 16000,
    system:
      'You repair malformed JSON. Return valid minified JSON only. No markdown, no explanation. Preserve the original structure and values as much as possible. The output must be a single valid JSON object. Do not truncate the result.',
    messages: [
      {
        role: 'user',
        content:
          'The following JSON failed to parse.\nParse error:\n' +
          parseError +
          '\n\nMalformed JSON:\n' +
          brokenJson,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock?.type === 'text' ? textBlock.text.trim() : '';
  const repaired = extractJsonObject(raw) ?? extractJsonObject(repairMalformedJson(raw));
  if (!repaired) {
    throw new Error('Failed to repair the malformed JSON.');
  }

  return repairMalformedJson(repaired);
}

function unwrapProjectPlanningPayload(payload: any): Record<string, any> | null {
  const project = payload?.project;
  if (
    !project ||
    typeof project !== 'object' ||
    (!Array.isArray(project.levels) && !Array.isArray(project.rooms))
  ) {
    return null;
  }

  return {
    ...project,
    project: { name: project.name },
    project_name: project.name,
    coordinateSystem: project.coordinateSystem,
    coreFixed: project.coreFixed,
    levels: project.levels,
    rooms: project.rooms,
  };
}

function getLevelsPayload(payload: any): Record<string, any> | null {
  if (Array.isArray(payload?.levels)) return payload;
  if (Array.isArray(payload?.requirements?.levels)) return { requirements: payload.requirements };

  const projectPayload = unwrapProjectPlanningPayload(payload);
  if (projectPayload) return projectPayload;

  const requirementsProjectPayload = unwrapProjectPlanningPayload(payload?.requirements);
  if (requirementsProjectPayload) return { requirements: requirementsProjectPayload };

  return null;
}

function hasEmbeddedFloorPlans(payload: any): boolean {
  const buildings = Array.isArray(payload?.requirements?.buildings)
    ? payload.requirements.buildings
    : Array.isArray(payload?.buildings)
      ? payload.buildings
      : [];

  return buildings.some((building: any) => {
    const hasAbove = building?.floor_plans && Object.keys(building.floor_plans).length > 0;
    const hasBasement = building?.basement?.floor_plans && Object.keys(building.basement.floor_plans).length > 0;
    return Boolean(hasAbove || hasBasement);
  });
}

function inferredAreaWarnings(sourceText: string, payload: any): string[] {
  if (!hasEmbeddedFloorPlans(payload)) return [];
  const hasAreaValues = /"area_m2"\s*:\s*\d/i.test(JSON.stringify(payload));
  if (!hasAreaValues) return [];

  const hasInferenceSignal =
    /AI\s*추론|추론|inferred|assumed|estimated|estimate|standard\s+area|typical\s+area/i.test(sourceText);
  if (!hasInferenceSignal) return [];

  return [
    '입력 문서에 AI 추론/추정 표현과 room area_m2가 함께 포함되어 있습니다. PDF 원문에 없는 실면적이면 생성 매스 면적도 추정값을 기반으로 달라질 수 있습니다.',
  ];
}

function hasInferredAreaSignal(sourceText: string): boolean {
  return /AI\s*추론|추론|inferred|assumed|estimated|estimate|standard\s+area|typical\s+area/i.test(sourceText);
}

function hasExplicitRoomAreas(payload: any): boolean {
  if (!hasEmbeddedFloorPlans(payload)) return false;
  const root = payload?.requirements ?? payload;
  const buildings = Array.isArray(root?.buildings) ? root.buildings : [];

  return buildings.some((building: any) => {
    const aboveFloors = building?.floor_plans && typeof building.floor_plans === 'object'
      ? Object.values(building.floor_plans)
      : [];
    const basementFloors = building?.basement?.floor_plans && typeof building.basement.floor_plans === 'object'
      ? Object.values(building.basement.floor_plans)
      : [];
    const roomLists = [...aboveFloors, ...basementFloors].filter(Array.isArray) as any[][];
    return roomLists.some((rooms) =>
      rooms.some((room) => Number(room?.area_m2) > 0),
    );
  });
}

function stripFloorPlansFromInferredAreaSource(sourceText: string, payload: any): { payload: any; warnings: string[] } {
  if (!hasEmbeddedFloorPlans(payload) || !hasInferredAreaSignal(sourceText)) {
    return { payload, warnings: [] };
  }

  if (hasExplicitRoomAreas(payload)) {
    return {
      payload,
      warnings: [
        '입력 문서에 AI 추론/추정 표현이 포함되어 있지만, JSON에 명시된 room area_m2가 있어서 floor_plans는 유지했습니다. 원문 면적이 맞는지 PDF와 대조해 확인하세요.',
      ],
    };
  }

  const cloned = JSON.parse(JSON.stringify(payload));
  const root = cloned?.requirements ?? cloned;
  const buildings = Array.isArray(root?.buildings) ? root.buildings : [];
  for (const building of buildings) {
    if (building && typeof building === 'object') {
      building.floor_plans = {};
      if (building.basement && typeof building.basement === 'object') {
        building.basement.floor_plans = {};
      }
    }
  }

  return {
    payload: cloned,
    warnings: [
      '입력 문서에 AI 추론/추정으로 보이는 실면적이 포함되어 있어 floor_plans를 실배치 입력에서 제외했습니다. PDF 원문에 명시된 실별 면적만 포함된 문서로 다시 실행해야 실 unit이 생성됩니다.',
    ],
  };
}

function blockedFloorPlanResult(payload: any, warnings: string[]): unknown {
  const root = payload?.requirements ?? payload;
  const buildings = Array.isArray(root?.buildings) ? root.buildings : [];
  const failed = buildings.length > 0
    ? buildings.map((building: any) => ({
        name: building?.name ?? 'unknown',
        attempts: [{
          name: 'explicit room area check',
          ok: false,
          error: warnings[0] ?? 'PDF 원문에 명시된 실별 면적이 없어 Floor Plans 실배치를 적용하지 않았습니다.',
        }],
      }))
    : [{
        name: 'unknown',
        attempts: [{
          name: 'explicit room area check',
          ok: false,
          error: warnings[0] ?? 'PDF 원문에 명시된 실별 면적이 없어 Floor Plans 실배치를 적용하지 않았습니다.',
        }],
      }];

  return {
    status: 'failed',
    placed: [],
    failed,
    warnings,
  };
}

function addToolWarnings(result: unknown, warnings: string[]): unknown {
  if (!warnings.length || !result || typeof result !== 'object') return result;
  const data = result as Record<string, any>;
  return {
    ...data,
    warnings: [
      ...(Array.isArray(data.warnings) ? data.warnings : []),
      ...warnings,
    ],
  };
}

export function getDeterministicToolResponse(toolName: string, result: unknown): string | null {
  return toolName === 'place_building_masses' ? formatToolResponse(toolName, result) : null;
}

export function formatToolResponse(toolName: string, result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return String(result);

  const data = result as Record<string, any>;

  if (toolName === 'place_building_masses') {
    const placed = Array.isArray(data.summary) ? data.summary : [];
    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
    const temporaryOverlays = Number(data.temporaryOverlays ?? 0);
    const rawMassesPlaced = Number(data.massesPlaced ?? placed.length);
    const reportedMassesPlaced = Number.isFinite(rawMassesPlaced) ? Math.max(0, rawMassesPlaced) : 0;
    const strictlyConfirmed = placed.filter((item) =>
      item?.layerConfirmed === true
      && item?.visibleVolumeConfirmed === true
      && item?.worldTransformConfirmed === true
      && item?.nonVirtualConfirmed === true,
    );
    const massesPlaced = Math.min(reportedMassesPlaced, strictlyConfirmed.length);
    const placementSucceeded = data.status === 'success'
      && massesPlaced > 0
      && massesPlaced === reportedMassesPlaced;
    const lines = [
      placementSucceeded
        ? '매스 생성이 완료되었습니다.'
        : '매스 생성에 실패했습니다.',
      '',
      `- 실제 생성된 건물 수: ${massesPlaced}`,
    ];
    if (data.status === 'not_found' && data.message) lines.push(`- 실패 원인: ${String(data.message)}`);
    else if (data.error) lines.push(`- 실패 원인: ${String(data.error)}`);
    else if (!placementSucceeded && data.message) lines.push(`- 실패 원인: ${String(data.message)}`);
    if (temporaryOverlays > 0) lines.push(`- 임시 오버레이 수: ${temporaryOverlays}`);
    if (data.siteReference) lines.push(`- 기준 대지: ${data.siteReference}`);
    if (data.actualCoverageRatio && data.status === 'success') lines.push(`- 건폐율: ${data.actualCoverageRatio}`);
    if (placed.length > 0) {
      lines.push('', '생성 결과:');
      for (const item of placed) {
        lines.push(`- ${item.name}: ${item.dimensions}, 높이 ${item.height}, 바닥면적 ${item.footprint}`);
        if (item.elementPath !== undefined) lines.push(`  - elementPath: ${String(item.elementPath)}`);
        if (item.placementZ !== undefined) lines.push(`  - placementZ: ${String(item.placementZ)}`);
        if (item.actualTransformZ !== undefined) lines.push(`  - actualTransformZ: ${String(item.actualTransformZ)}`);
        if (item.layerConfirmed !== undefined) lines.push(`  - layerConfirmed: ${String(item.layerConfirmed)}`);
        if (item.visibleVolumeConfirmed !== undefined) lines.push(`  - visibleVolumeConfirmed: ${String(item.visibleVolumeConfirmed)}`);
        if (item.worldTransformConfirmed !== undefined) lines.push(`  - worldTransformConfirmed: ${String(item.worldTransformConfirmed)}`);
        if (item.nonVirtualConfirmed !== undefined) lines.push(`  - nonVirtualConfirmed: ${String(item.nonVirtualConfirmed)}`);
      }
    }
    if (data.status === 'success' && (massesPlaced === 0 || massesPlaced !== reportedMassesPlaced)) {
      lines.push('', '주의사항:', '- 도구가 success를 반환했지만 실제 생성된 건물이 확인되지 않아 실패로 처리했습니다.');
    }
    if (warnings.length > 0) {
      if (!(data.status === 'success' && (massesPlaced === 0 || massesPlaced !== reportedMassesPlaced))) lines.push('', '주의사항:');
      for (const warning of warnings) lines.push(`- ${warning}`);
    }
    return lines.join('\n');
  }

  if (toolName === 'recreate_buildings_with_floor_plans') {
    const placed = Array.isArray(data.placed) ? data.placed : [];
    const failed = Array.isArray(data.failed) ? data.failed : [];
    const lines = [
      data.status === 'success'
        ? '실배치 포함 FloorStack 매스 재생성이 완료되었습니다.'
        : data.status === 'partial'
          ? '실배치 포함 FloorStack 매스 재생성이 일부 완료되었습니다.'
          : '실배치 포함 FloorStack 매스 재생성에 실패했습니다.',
      '',
      '- 성공한 건물 수: ' + placed.length,
      '- 실패한 건물 수: ' + failed.length,
    ];
    if (placed.length > 0) {
      lines.push('', '성공 결과:');
      for (const item of placed) {
        const aboveFloors = Number(item.aboveFloors ?? item.floors ?? 0);
        const basementFloors = Number(item.basementFloors ?? 0);
        const totalFloors = Number(item.totalFloors ?? aboveFloors + basementFloors);
        const floorSummary = basementFloors > 0
          ? '지하 ' + basementFloors + '층 + 지상 ' + aboveFloors + '층 (총 ' + totalFloors + '개 층)'
          : '지상 ' + aboveFloors + '층';
        const attemptLabel = String(item.successfulAttempt ?? '');
        lines.push('- ' + item.name + ': ' + floorSummary + ', ' + item.roomUnits + '개 FloorStack plan unit, 방식 ' + attemptLabel);
      }
    }
    if (failed.length > 0) {
      lines.push('', '실패 요약:');
      for (const item of failed) {
        const firstFailure = Array.isArray(item.attempts) ? item.attempts.find((attempt: any) => !attempt.ok) : null;
        const detail = firstFailure?.error ? ' - ' + firstFailure.error : '';
        lines.push('- ' + item.name + ': ' + (firstFailure?.name ?? 'unknown') + ' 단계 실패' + detail);
      }
    }
    if (data.minimal_test?.status === 'success') {
      lines.push('', '진단: 최소 테스트는 성공했습니다. (' + data.minimal_test.sourceFloor + ', ' + data.minimal_test.roomCount + '개 실)');
    }
    if (data.progressive_test?.summary) {
      lines.push('- 단계별 진단: ' + data.progressive_test.summary);
    }
    if (data.combined_test?.summary) {
      lines.push('- 다층 조합 진단: ' + data.combined_test.summary);
    }
    if (Array.isArray(data.warnings) && data.warnings.length > 0) {
      lines.push('', '주의사항:');
      for (const warning of data.warnings) lines.push('- ' + warning);
    }
    return lines.join('\n');
  }

  if (toolName === 'prepare_zone_import_package') {
    const lines = [
      data.status === 'success' ? 'Zone package 준비가 완료되었습니다.' : 'Zone package 준비에 실패했습니다.',
    ];
    if (data.project_name) lines.push('- 프로젝트: ' + data.project_name);
    if (typeof data.level_count === 'number') lines.push('- 층 수: ' + data.level_count);
    if (typeof data.zone_count === 'number') lines.push('- 구역 수: ' + data.zone_count);
    if (Array.isArray(data.consistent_core_levels) && data.consistent_core_levels.length > 0) {
      lines.push('- 고정 코어 층: ' + data.consistent_core_levels.join(', '));
    }
    lines.push('- 이 결과는 검토용 Zone package 요약입니다. 실제 매스/실배치 재생성과는 별도 경로입니다.');
    return lines.join('\n');
  }

  if (toolName === 'test_floor_plan_unit_compatibility') {
    const attempts = Array.isArray(data.attempts) ? data.attempts : [];
    const lines = [
      data.status === 'success'
        ? '실배치 호환성 진단이 완료되었습니다.'
        : data.status === 'partial'
          ? '실배치 호환성 진단이 일부 성공했습니다.'
          : '실배치 호환성 진단에 실패했습니다.',
      '',
      '- 건물: ' + (data.building ?? '-'),
      '- 진단 층: ' + (data.floor ?? '-'),
      '- 요약: ' + (data.summary ?? '-'),
    ];
    if (attempts.length > 0) {
      lines.push('', '단계별 결과:');
      for (const attempt of attempts) {
        lines.push('- ' + attempt.name + ': ' + (attempt.ok ? '성공' : '실패') + ' (' + (attempt.unitCount ?? 0) + ' units)' + (attempt.error ? ' - ' + attempt.error : ''));
      }
    }
    return lines.join('\n');
  }

  if (toolName === 'test_circular_floorstack_mass' || toolName === 'test_ring_atrium_floorstack_mass') {
    const lines = [
      data.status === 'success' ? '테스트가 성공했습니다.' : '테스트가 실패했습니다.',
    ];
    if (data.successfulAttempt) lines.push(`- 성공 방식: ${data.successfulAttempt}`);
    if (data.note) lines.push(`- 참고: ${data.note}`);
    return lines.join('\n');
  }

  return fallbackJsonSummary(data);
}

function fallbackJsonSummary(data: Record<string, any>): string {
  if (data.message) return String(data.message);
  return JSON.stringify(data, null, 2);
}

const TOOL_LABELS: Record<string, string> = {
  get_elements_by_category: 'list elements',
  get_element_mesh_info: 'inspect mesh',
  get_multiple_elements_mesh_info: 'inspect multiple meshes',
  get_current_selection: 'read selection',
  highlight_elements: 'highlight elements',
  clear_highlights: 'clear highlights',
  parse_building_requirements: 'parse requirements',
  place_building_masses: 'place masses',
  clear_building_masses: 'clear masses',
  debug_site_bounds: 'debug site bounds',
  recreate_buildings_with_floor_plans: 'recreate floor plans',
  prepare_zone_import_package: 'prepare zone package',
  test_floorstack_plan_units: 'test floorstack plans',
  test_floor_plan_unit_compatibility: 'test floor plan compatibility',
  test_circular_floorstack_mass: 'test circular mass',
  test_ring_atrium_floorstack_mass: 'test ring atrium mass',
};
