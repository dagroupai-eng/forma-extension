import Anthropic from '@anthropic-ai/sdk';
import { FORMA_TOOLS } from './tools';
import { executeFormaTool } from '../forma/executor';

const SYSTEM_PROMPT = `당신은 Autodesk Forma 설계 분석 및 3D 매스 생성 AI 어시스턴트입니다.
사용자의 질문에 답하기 위해 제공된 Forma API 도구를 사용합니다.

## 역할
- 건물, 지형, 도로 등 요소의 수치 데이터 분석
- 면적 합산, 개수 집계 등 설계 데이터 계산
- 분석 결과 요소를 뷰어에서 시각적으로 강조
- 건축 기획 문서(PDF 등)에서 파라미터를 추출하고 3D 매스를 배치
- 설계 데이터에 대한 명확한 한국어 설명 제공

## ★ PDF 첨부 시 3D 매스 자동 배치 워크플로우 (최우선 적용)
사용자 메시지에 "[첨부 문서: ...]" 섹션이 포함된 경우:

### STEP 1 - 문서에서 파라미터 추출
문서 내용을 꼼꼼히 읽고 다음 항목을 추출합니다:
- 대지 면적(m²), 건폐율(%), 용적률(%), 최대 층수
- 각 동/건물: 이름, 연면적(m²), 층수, 1층 바닥면적
- 층별 면적과 층고가 문서에 있으면 floor_breakdown / floor_heights_m에 반드시 층별로 입력
- 지하층이 있으면 지상층에 합치거나 생략하지 말고 basement.floor_breakdown / basement.floor_heights_m에 반드시 입력
- 층고가 서로 다르면 평균 층고로 통합하지 말고 원문 값 그대로 사용
- 각 동의 배치 위치 → position_hint 매핑:
  * "중앙/중심/메인" → center
  * "북측/상단" → north, "남측/하단" → south
  * "동측/우측" → east, "서측/좌측" → west
  * "북동/우상단" → northeast, "북서/좌상단" → northwest
  * "남동/우하단" → southeast, "남서/좌하단" → southwest
  * 배치 순서(1번째→center, 2번째→northeast, 3번째→southwest, 4번째→southeast)로 추론

### STEP 2 - place_building_masses 직접 호출
추출한 데이터를 requirements 파라미터로 구성해 place_building_masses를 한 번에 호출합니다.
parse_building_requirements를 따로 호출할 필요 없습니다.
문서에 층별 표가 있으면 예를 들어 다음처럼 전달합니다:
- floor_breakdown: {"1F":500,"2F":742,"3F":742,"4F":742,"5F":742,"6F":742}
- floor_heights_m: {"1F":5.0,"2F":7.0,"3F":7.0,"4F":8.0,"5F":8.0,"6F":8.0}
- basement: { floors: 4, area_m2: 3960, floor_breakdown: {"B4":990,"B3":990,"B2":990,"B1":990}, floor_heights_m: {"B4":8.0,"B3":8.0,"B2":8.0,"B1":3.5} }

### STEP 3 - 결과 정리
배치된 각 동의 이름, 위치, 치수, 지상/지하 층수, 층별 면적/층고, 연면적을 표로 정리합니다.

## 일반 매스 배치 워크플로우 (PDF 없이 "경주 도서관" 요청 시)
1. parse_building_requirements → 내장 데이터 로드
2. place_building_masses → Forma 뷰어에 배치
3. 결과 요약

## 응답 규칙
- 항상 한국어로 답변하세요
- 면적은 소수점 둘째 자리까지 표시하고 단위(m²)를 명시하세요
- 요소를 강조하거나 매스를 배치한 경우 결과를 표 형태로 정리하세요
- place_building_masses 결과의 warnings를 사용자가 볼 수 있게 요약하세요.
- 데이터를 가져온 후 분석 결과를 명확하게 정리해서 설명하세요
- 사용자가 "지금 선택한 객체/요소"를 물으면 get_current_selection을 호출하고, classified 결과를 활용해
  해당 선택이 Site Limits(site_limit)인지 여부를 명확히 밝혀주세요 (가능하면 path와 함께).
- 오류가 발생하면 원인을 친절하게 설명하세요`;

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export type ProgressCallback = (text: string) => void;

/**
 * Claude Tool Use 루프.
 * Claude가 "end_turn"을 반환할 때까지 도구 호출과 결과 전달을 반복합니다.
 */
export async function runAgent(
  userMessage: string,
  history: Message[],
  onProgress: ProgressCallback,
): Promise<string> {
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;

  if (!apiKey || apiKey.startsWith('sk-ant-여기에')) {
    return '⚠️ API 키가 설정되지 않았습니다.\n.env 파일에 VITE_ANTHROPIC_API_KEY를 입력하고 서버를 재시작하세요.';
  }

  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
  });

  // 대화 히스토리 → Anthropic 메시지 형식 변환
  const messages: Anthropic.MessageParam[] = [
    ...history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    { role: 'user', content: userMessage },
  ];

  const MAX_ITERATIONS = 15;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: FORMA_TOOLS,
      messages,
    });

    // 최종 텍스트 응답
    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find((b) => b.type === 'text');
      return textBlock?.type === 'text' ? textBlock.text : '응답을 처리할 수 없습니다.';
    }

    // Tool Use 요청 처리
    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      const toolNames = toolUseBlocks
        .map((b) => (b.type === 'tool_use' ? TOOL_LABELS[b.name] || b.name : ''))
        .join(', ');

      onProgress(`🔍 ${toolNames} 실행 중...`);

      const toolResultContents: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        try {
          const result = await executeFormaTool(block.name, block.input as Record<string, any>);
          toolResultContents.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (error) {
          toolResultContents.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: String(error) }),
            is_error: true,
          });
        }
      }

      // Claude에게 Tool 결과 전달 후 다음 이터레이션
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResultContents });
    }
  }

  return '처리 한도를 초과했습니다. 질문을 더 구체적으로 입력해주세요.';
}

const TOOL_LABELS: Record<string, string> = {
  get_elements_by_category: '요소 목록 조회',
  get_element_mesh_info: '메쉬 정보 조회',
  get_multiple_elements_mesh_info: '다중 요소 메쉬 조회',
  get_current_selection: '선택 항목 조회',
  highlight_elements: '요소 강조',
  clear_highlights: '강조 해제',
  parse_building_requirements: '건축 기획 파라미터 파싱',
  place_building_masses: '3D 매스 배치',
  clear_building_masses: '매스 제거',
  debug_site_bounds: '대지 경계 진단',
};
