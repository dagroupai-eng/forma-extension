/**
 * PDF/TXT 본문에 포함된 requirements JSON을 직접 추출합니다.
 * Claude 재추출 없이 PDF에 적힌 area_m2·floor_plans 수치를 그대로 사용합니다.
 */

function cleanDocumentText(text: string): string {
  return text
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '\n')
    .replace(/\uFFFD/g, ' ')
    .replace(/\r\n/g, '\n');
}

/** 채팅 메시지에서 PDF 본문만 추출 */
export function extractDocumentBody(text: string): string {
  const start = text.indexOf('--- document content start ---');
  const end = text.indexOf('--- document content end ---');
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start + '--- document content start ---'.length, end).trim();
  }
  return text.trim();
}

/** PDF 텍스트 추출 시 끊긴 JSON 문자열·하이픈 줄바꿈·공백 분리 숫자를 복구 */
export function repairPdfJsonText(text: string): string {
  let s = cleanDocumentText(text)
    .replace(/\u0000/g, ' ')
    .replace(/"([^"]*?)-\s*\n\s*([^"]*?)"/g, '"$1-$2"')
    .replace(/,\s*([}\]])/g, '$1');

  // dAI+ PDF: "50 0" → "50.0", "0 5" → "0.5"
  s = s.replace(/([:\s\[,])(\d+)\s+(\d)(?=[,\s}\]\]]|$)/g, '$1$2.$3');
  // "1 450" → "1450"
  s = s.replace(/([:\s\[,])(\d)\s+(\d{3})(?=[,\s}\]\]]|$)/g, '$1$2$3');
  // "12 0" in dimensions
  s = s.replace(/([:\s\[,])(\d{1,2})\s+(\d)(?=\s*(?:m|㎡|F|B|\d))/g, '$1$2.$3');

  return s;
}

/** 열린 괄호를 닫아 잘린 JSON을 복구 */
function closeOpenBrackets(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.length && stack[stack.length - 1] === c) stack.pop();
    }
  }

  let result = text;
  if (inString) result += '"';
  while (stack.length) result += stack.pop();
  return result;
}

/**
 * LLM/PDF에서 흔한 JSON 구문 오류를 로컬에서 복구한다.
 * Claude repair 호출 전에 적용하면 대용량 JSON 파싱 성공률이 올라간다.
 */
export function repairMalformedJson(text: string): string {
  let s = cleanDocumentText(text).replace(/^\uFEFF/, '').trim();
  s = s.replace(/,\s*([}\]])/g, '$1');
  s = s.replace(/\/\/[^\n]*/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  return closeOpenBrackets(s);
}

/** 잘린 JSON을 뒤에서 잘라가며 파싱 가능한 후보를 생성 */
function truncatedJsonCandidates(text: string): string[] {
  const base = repairMalformedJson(text);
  const candidates = [base];
  let searchFrom = base.length;

  for (let attempt = 0; attempt < 12; attempt++) {
    const cut = base.lastIndexOf('},', searchFrom - 1);
    if (cut < Math.floor(base.length * 0.35)) break;
    candidates.push(closeOpenBrackets(base.slice(0, cut + 1)));
    searchFrom = cut;
  }

  return candidates;
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tryParseLooseObject(text: string): unknown | null {
  try {
    return Function('"use strict"; return (' + text + ');')();
  } catch {
    return null;
  }
}

/** 여러 복구 전략을 순서대로 시도해 JSON 객체를 파싱한다. */
export function parseRequirementsJson(text: string): Record<string, any> | null {
  const initialCandidates = [
    text,
    repairMalformedJson(text),
    repairPdfJsonText(text),
    repairMalformedJson(repairPdfJsonText(text)),
    ...truncatedJsonCandidates(text),
  ];

  const seen = new Set<string>();
  for (const candidate of initialCandidates) {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);

    const parsed =
      tryParseJson(trimmed) ??
      tryParseLooseObject(trimmed);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, any>;
    }
  }

  return null;
}

export function extractJsonObject(text: string): string | null {
  const cleaned = cleanDocumentText(text);
  const fence = '```json';
  const fenceStart = cleaned.toLowerCase().indexOf(fence);
  if (fenceStart !== -1) {
    const contentStart = fenceStart + fence.length;
    const fenceEnd = cleaned.indexOf('```', contentStart);
    if (fenceEnd !== -1) return cleaned.slice(contentStart, fenceEnd).trim();
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  return cleaned.slice(firstBrace, lastBrace + 1);
}

export function extractJsonObjectCandidates(text: string): string[] {
  const cleaned = cleanDocumentText(text);
  const candidates: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  const fenceRegex = /```json\s*([\s\S]*?)```/gi;
  for (const match of cleaned.matchAll(fenceRegex)) {
    addCandidate(match[1]);
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (c === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) {
        addCandidate(cleaned.slice(start, i + 1));
        start = -1;
      }
    }
  }

  const broad = extractJsonObject(cleaned);
  if (broad) addCandidate(broad);

  return candidates.sort((a, b) => {
    const aScore = Number(a.includes('"levels"')) + Number(a.includes('"zones"'));
    const bScore = Number(b.includes('"levels"')) + Number(b.includes('"zones"'));
    return bScore - aScore || b.length - a.length;
  });
}

function unwrapProjectPlanningPayload(parsed: Record<string, any>): Record<string, any> | null {
  const project = parsed?.project;
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

function normalizeRequirementsRoot(parsed: Record<string, any>): Record<string, any> | null {
  if (parsed?.requirements?.buildings) return { requirements: parsed.requirements };
  if (parsed?.requirements?.project) {
    const unwrappedRequirements = unwrapProjectPlanningPayload(parsed.requirements);
    if (unwrappedRequirements) return { requirements: unwrappedRequirements };
  }
  if (Array.isArray(parsed?.buildings)) return { requirements: parsed };
  if (Array.isArray(parsed?.levels)) return parsed;
  const unwrappedProject = unwrapProjectPlanningPayload(parsed);
  if (unwrappedProject) return unwrappedProject;
  return null;
}

/**
 * 문서 본문에서 requirements / levels JSON을 찾아 파싱합니다.
 * 성공 시 recreate_buildings_with_floor_plans / place_building_masses 입력으로 사용할 수 있습니다.
 */
export function extractRequirementsFromDocument(text: string): Record<string, any> | null {
  const body = extractDocumentBody(text);
  const candidates = [
    extractJsonObject(body),
    extractJsonObject(repairPdfJsonText(body)),
    extractJsonObject(text),
    extractJsonObject(repairPdfJsonText(text)),
  ].filter((value): value is string => Boolean(value));

  for (const jsonText of candidates) {
    const parsed = parseRequirementsJson(jsonText);
    if (!parsed || typeof parsed !== 'object') continue;

    const normalized = normalizeRequirementsRoot(parsed);
    if (normalized) return normalized;
  }

  return null;
}

export function documentHasStructuredRequirements(text: string): boolean {
  return extractRequirementsFromDocument(text) !== null;
}

function normalizeRoomScheduleFloor(label: string): string {
  return String(label ?? '').trim().toUpperCase();
}

function floorOrderValue(label: string): number {
  const normalized = normalizeRoomScheduleFloor(label);
  const basement = normalized.match(/^B(\d+)$/);
  if (basement) return -Number(basement[1]);
  const above = normalized.match(/^(\d+)F$/);
  if (above) return Number(above[1]);
  return 0;
}

function parseAreaNumber(value: string): number {
  return Number(String(value).replace(/,/g, ''));
}

function roomUnitType(roomId: string, group: string): 'CORE' | 'CORRIDOR' | 'PARKING' | 'LIVING_UNIT' {
  const raw = `${roomId} ${group}`.toUpperCase();
  if (raw.includes('CORE')) return 'CORE';
  if (raw.includes('_P') || raw.includes('PARKING')) return 'PARKING';
  if (raw.includes('SUPPORT')) return 'CORRIDOR';
  return 'LIVING_UNIT';
}

function displayRoomName(rawName: string): string {
  const split = rawName.split(
    /\s+(?=(?:Parking|Mechanical|Electrical|Generator|Storage|Core|Public|Child|Senior|HVAC|Small|Exhibition|Multi-purpose|Theater|Community|Youth|Office|Meeting|Open|Residential|For-Sale|Private|Sky|Rooftop|Transition)\b)/,
  );
  return (split[0] || rawName).trim();
}

function extractCoreTemplateFromText(text: string): Record<string, any> | undefined {
  const center = text.match(/코어\s*중심\s*고정좌표\s*X\s*=\s*([\d.]+)\s*,\s*Y\s*=\s*([\d.]+)/);
  const size = text.match(/코어\s*면적\s*[\d,.]+\s*㎡[^\n\r]*?약\s*([\d.]+)m\s*[×x]\s*([\d.]+)m/);
  if (!center) return undefined;

  return {
    width_m: size ? Number(size[1]) : 12.25,
    depth_m: size ? Number(size[2]) : 12.25,
    position: 'center',
    fixed_across_floors: true,
    center_x_m: Number(center[1]),
    center_y_m: Number(center[2]),
    room_name: 'Core',
    function_id: 'core',
  };
}

function extractFootprintDimensionsFromText(text: string): { footprint_width_m?: number; footprint_depth_m?: number } {
  const match =
    text.match(/([\d.]+)\s*m\s*\(X\)\s*[×x]\s*([\d.]+)\s*m\s*\(Y\)/) ??
    text.match(/가로\s*약?\s*([\d.]+)\s*m\s*[×x]\s*세로\s*약?\s*([\d.]+)\s*m/);
  if (!match) return {};
  return {
    footprint_width_m: Number(match[1]),
    footprint_depth_m: Number(match[2]),
  };
}

export function extractRoomScheduleRequirementsFromText(text: string): Record<string, any> | null {
  const body = extractDocumentBody(text);
  if (!/(실\s*ID|실ID|room\s*id)/i.test(body) || !/(면적|area)/i.test(body)) return null;

  const floorPlans: Record<string, any[]> = {};
  const floorBreakdown: Record<string, number> = {};
  const basementFloorPlans: Record<string, any[]> = {};
  const basementBreakdown: Record<string, number> = {};
  const roomRow =
    /^(B\d+|\d{1,2}F)\s+([A-Z]\d{0,2}_[A-Z]+[A-Z0-9]*|B\d+_[A-Z]+[A-Z0-9]*)\s+(.+?)\s+(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s+(Infra|Public|Support|Core|Office|Residential)\b/i;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/\s+/g, ' ');
    const match = line.match(roomRow);
    if (!match) continue;

    const floor = normalizeRoomScheduleFloor(match[1]);
    const roomId = match[2];
    const area = parseAreaNumber(match[4]);
    const group = match[5];
    if (!Number.isFinite(area) || area <= 0) continue;

    const room = {
      name: displayRoomName(match[3]),
      room_id: roomId,
      function_id: roomId.toLowerCase(),
      area_m2: area,
      group,
      unit_type: roomUnitType(roomId, group),
    };

    const isBasement = /^B\d+$/i.test(floor);
    const plans = isBasement ? basementFloorPlans : floorPlans;
    const breakdown = isBasement ? basementBreakdown : floorBreakdown;
    plans[floor] = [...(plans[floor] ?? []), room];
    breakdown[floor] = Number(((breakdown[floor] ?? 0) + area).toFixed(2));
  }

  const aboveFloors = Object.keys(floorPlans).sort((a, b) => floorOrderValue(a) - floorOrderValue(b));
  const basementFloors = Object.keys(basementFloorPlans).sort((a, b) => floorOrderValue(a) - floorOrderValue(b));
  if (aboveFloors.length + basementFloors.length === 0) return null;

  const footprint = extractFootprintDimensionsFromText(body);
  const footprintArea = footprint.footprint_width_m && footprint.footprint_depth_m
    ? Number((footprint.footprint_width_m * footprint.footprint_depth_m).toFixed(2))
    : Math.max(...Object.values(floorBreakdown), 1);
  const totalAboveArea = Object.values(floorBreakdown).reduce((sum, area) => sum + area, 0);
  const totalBasementArea = Object.values(basementBreakdown).reduce((sum, area) => sum + area, 0);
  const maxAboveFloor = aboveFloors.reduce((max, floor) => Math.max(max, floorOrderValue(floor)), 0);
  const coreTemplate = extractCoreTemplateFromText(body);

  return {
    requirements: {
      project_name: 'Room Schedule',
      location: '',
      site_limits: {
        total_site_area: 0,
        max_building_coverage_ratio: 1,
        max_floor_area_ratio: 10,
        max_height_floors: maxAboveFloor,
      },
      buildings: [{
        name: 'Main Building',
        target_floor_area: Number(totalAboveArea.toFixed(2)),
        target_floors: maxAboveFloor,
        footprint_area: footprintArea,
        ...footprint,
        mass_layout_type: 'AUTO',
        position_hint: 'center',
        floor_breakdown: floorBreakdown,
        floor_plans: floorPlans,
        ...(coreTemplate ? { core_template: coreTemplate } : {}),
        ...(basementFloors.length > 0
          ? {
              basement: {
                floors: basementFloors.length,
                area_m2: Number(totalBasementArea.toFixed(2)),
                use: 'Basement',
                floor_breakdown: basementBreakdown,
                floor_plans: basementFloorPlans,
              },
            }
          : {}),
      }],
    },
  };
}
