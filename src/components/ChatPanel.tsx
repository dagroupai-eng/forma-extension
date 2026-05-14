import { useState, useRef, useEffect } from 'preact/hooks';
import { runAgent } from '../claude/agent';
import type { Message } from '../claude/agent';
import { parsePdfFile, readTextFile, isSupportedFile, formatFileSize } from '../utils/pdf_parser';
import type { ParsedDocument } from '../utils/pdf_parser';

const EXAMPLE_QUERIES = [
  '건물 요소가 몇 개야?',
  '건물 전체 면적을 합산해줘',
  '선택한 요소를 파란색으로 강조해줘',
  '경주도서관 매스를 캔버스에 배치해줘',
];

const PDF_MASS_PROMPT = '이 문서의 나온 매스 내용을 기반으로 내가 선택한 site limits에 매스를 배치해주세요.';

const PDF_FLOOR_PLAN_RECREATE_PROMPT = `첨부한 PDF의 층별 실면적 내용을 기반으로 FloorStackApi.createFromFloors({ floors, plans })를 사용해 실배치가 포함된 새 건물을 재생성해주세요.
기존 매스나 기존 건물은 삭제하지 말고, 먼저 test_floorstack_plan_units로 이 프로젝트가 plans.units 생성을 허용하는지 확인한 다음 recreate_buildings_with_floor_plans를 실행해주세요.
PDF에서 floor_breakdown, floor_heights_m, floor_plans를 정확히 추출하고, 각 실은 name, area_m2, function_id, unit_type으로 구성해주세요.`;

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [attachedDoc, setAttachedDoc] = useState<ParsedDocument | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, progressText, attachedDoc]);

  // ─── 파일 선택 처리 ───────────────────────────────────────
  const handleFileSelect = async (file: File) => {
    if (!isSupportedFile(file)) {
      alert('PDF 또는 TXT 파일만 업로드할 수 있습니다.');
      return;
    }

    setIsParsing(true);
    setParseProgress(`📄 ${file.name} 파싱 중...`);

    try {
      let doc: ParsedDocument;

      if (file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt')) {
        doc = await readTextFile(file);
      } else {
        doc = await parsePdfFile(file, (current, total) => {
          setParseProgress(`📄 ${file.name} 파싱 중... (${current}/${total} 페이지)`);
        });
      }

      setAttachedDoc(doc);
    } catch (err) {
      alert(`파일 파싱 실패: ${String(err)}`);
    } finally {
      setIsParsing(false);
      setParseProgress('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onFileInputChange = (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) handleFileSelect(file);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file) handleFileSelect(file);
  };

  const removeAttachment = () => {
    setAttachedDoc(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ─── 메시지 전송 ─────────────────────────────────────────
  const sendMessage = async (text?: string) => {
    const userText = (text ?? input).trim();
    if ((!userText && !attachedDoc) || isLoading) return;

    // 문서가 첨부된 경우 메시지에 문서 내용 포함
    let fullMessage = userText;
    let displayMessage = userText;

    if (attachedDoc) {
      const docHeader = `[첨부 문서: ${attachedDoc.fileName} (${attachedDoc.pageCount}페이지)]`;

      // Claude에게 보낼 전체 메시지 (문서 텍스트 포함)
      const docBody = `\n\n---문서 내용 시작---\n${attachedDoc.text}\n---문서 내용 끝---\n\n`;
      fullMessage = `${docHeader}${docBody}${userText || '위 문서를 분석하고 건축 파라미터를 추출해줘. 가능하다면 Forma 캔버스에 3D 매스도 배치해줘.'}`;

      // 채팅창에 표시할 메시지 (축약)
      displayMessage = userText
        ? `${userText}\n\n📎 ${attachedDoc.fileName}`
        : `📎 ${attachedDoc.fileName} 분석 요청`;
    }

    setInput('');
    setAttachedDoc(null);
    setIsLoading(true);
    setProgressText('');

    const currentHistory = [...messages];
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: displayMessage },
    ]);

    try {
      const response = await runAgent(fullMessage, currentHistory, (progress) => {
        setProgressText(progress);
      });
      setMessages((prev) => [...prev, { role: 'assistant', content: response }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `오류가 발생했습니다: ${String(err)}` },
      ]);
    } finally {
      setIsLoading(false);
      setProgressText('');
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearConversation = () => {
    setMessages([]);
    setAttachedDoc(null);
  };

  const canSend = (input.trim().length > 0 || attachedDoc !== null) && !isLoading && !isParsing;
  const canRunPdfMassPrompt = attachedDoc !== null && !isLoading && !isParsing;

  // ─── 렌더링 ───────────────────────────────────────────────
  return (
    <div
      class="chat-wrapper"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {/* 숨겨진 파일 입력 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.txt"
        style={{ display: 'none' }}
        onChange={onFileInputChange}
      />

      {/* 헤더 */}
      <div class="chat-header">
        <div class="chat-header-left">
          <span class="chat-header-icon">✦</span>
          <span class="chat-header-title">Forma AI 어시스턴트</span>
        </div>
        {messages.length > 0 && (
          <button class="clear-btn" onClick={clearConversation} title="대화 초기화">
            ↺
          </button>
        )}
      </div>

      {/* 메시지 목록 */}
      <div class="messages-container">
        {messages.length === 0 && !isLoading && !isParsing && (
          <div class="empty-state">
            <p class="empty-title">무엇이든 물어보세요</p>
            <p class="empty-subtitle">
              Forma 프로젝트 데이터를 AI가 분석합니다
              <br />
              📎 PDF 첨부로 건축 보고서도 분석 가능합니다
            </p>
            <div class="example-list">
              <button
                class="example-btn primary"
                onClick={() => canRunPdfMassPrompt ? sendMessage(PDF_MASS_PROMPT) : fileInputRef.current?.click()}
                disabled={isLoading || isParsing}
              >
                첨부한 PDF 기반 매스 생성
              </button>
              <button
                class="example-btn primary"
                onClick={() => canRunPdfMassPrompt ? sendMessage(PDF_FLOOR_PLAN_RECREATE_PROMPT) : fileInputRef.current?.click()}
                disabled={isLoading || isParsing}
              >
                PDF 기반 실배치 건물 재생성
              </button>
              {EXAMPLE_QUERIES.map((q) => (
                <button key={q} class="example-btn" onClick={() => sendMessage(q)}>
                  {q}
                </button>
              ))}
            </div>
            <button class="upload-hint-btn" onClick={() => fileInputRef.current?.click()}>
              📎 PDF / TXT 파일 첨부
            </button>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div key={idx} class={`message-row ${msg.role}`}>
            <div class="message-label">{msg.role === 'user' ? '나' : 'AI'}</div>
            <div class="message-bubble">
              <MessageContent content={msg.content} />
            </div>
          </div>
        ))}

        {/* PDF 파싱 중 표시 */}
        {isParsing && (
          <div class="parse-progress">
            <span class="parse-spinner">⟳</span>
            <span>{parseProgress}</span>
          </div>
        )}

        {/* AI 응답 대기 중 */}
        {isLoading && (
          <div class="message-row assistant">
            <div class="message-label">AI</div>
            <div class="message-bubble loading-bubble">
              <span class="loading-text">{progressText || '생각 중'}</span>
              <span class="dots">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* 첨부 파일 미리보기 */}
      {attachedDoc && (
        <div class="attachment-preview">
          <div class="attachment-info">
            <span class="attachment-icon">📄</span>
            <div class="attachment-details">
              <span class="attachment-name">{attachedDoc.fileName}</span>
              <span class="attachment-meta">
                {attachedDoc.pageCount}페이지 · {formatFileSize(attachedDoc.fileSize)}
              </span>
            </div>
          <button
            class="attachment-action-btn"
            onClick={() => sendMessage(PDF_FLOOR_PLAN_RECREATE_PROMPT)}
            disabled={!canRunPdfMassPrompt}
          >
            실배치 재생성
          </button>
          </div>
          <div class="attachment-actions">
          <button
            class="attachment-action-btn"
            onClick={() => sendMessage(PDF_MASS_PROMPT)}
            disabled={!canRunPdfMassPrompt}
          >
            매스 생성
          </button>
          </div>
          <button class="attachment-remove" onClick={removeAttachment} title="첨부 제거">
            ✕
          </button>
        </div>
      )}

      {/* 입력 영역 */}
      <div class="input-area">
        <button
          class="attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={isLoading || isParsing}
          title="PDF / TXT 파일 첨부"
        >
          📎
        </button>
        <textarea
          ref={textareaRef}
          class="chat-input"
          value={input}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          placeholder={
            attachedDoc
              ? `${attachedDoc.fileName} 에 대해 질문하세요... (Enter: 전송)`
              : '메시지 입력... (Enter: 전송, Shift+Enter: 줄바꿈)'
          }
          rows={2}
          disabled={isLoading || isParsing}
        />
        <button class="send-btn" onClick={() => sendMessage()} disabled={!canSend}>
          ↑
        </button>
      </div>
    </div>
  );
}

/** 텍스트를 줄바꿈 처리해서 렌더링 */
function MessageContent({ content }: { content: string }) {
  return (
    <span>
      {content.split('\n').map((line, i, arr) => (
        <>
          {line}
          {i < arr.length - 1 && <br />}
        </>
      ))}
    </span>
  );
}
