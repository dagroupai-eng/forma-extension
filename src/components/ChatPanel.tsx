import { useEffect, useRef, useState } from 'preact/hooks';
import { runAgent } from '../claude/agent';
import type { Message } from '../claude/agent';
import {
  formatFileSize,
  isSupportedFile,
  parsePdfFile,
  readTextFile,
} from '../utils/pdf_parser';
import type { ParsedDocument } from '../utils/pdf_parser';

const API_KEY_STORAGE_KEY = 'forma-chat-app.anthropic-api-key';

const EXAMPLE_QUERIES = [
  '건물 요소가 몇 개인지 알려줘',
  '건물 전체 면적을 계산해줘',
  '지금 선택한 요소를 강조해줘',
  '경주 도서관 매스를 배치해줘',
];

const PDF_MASS_PROMPT =
  '이 문서에 나온 매스 내용을 기반으로 현재 선택한 site limits에 매스를 배치해주세요.';

const PDF_FLOOR_PLAN_RECREATE_DIRECT_PROMPT = `첨부한 PDF의 층별 실면적 내용을 기반으로 FloorStackApi.createFromFloors({ floors, plans })를 사용해 실배치가 포함된 새 건물을 재생성해주세요.
test_floorstack_plan_units는 사용하지 말고 바로 recreate_buildings_with_floor_plans를 실행해주세요.
기존 매스나 기존 건물은 삭제하지 말아주세요.
PDF에서 floor_breakdown, floor_heights_m, floor_plans를 정확히 추출하고, 각 실은 name, area_m2, function_id, unit_type으로 구성해주세요.
층별 실 수가 너무 많으면 Forma 생성 안정성을 위해 일부 작은 실은 통합 기타로 단순화해도 됩니다.
실행이 실패하면 어느 단계에서 실패했는지와 실패 이유를 반드시 텍스트로 알려주세요.`;

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [savedApiKey, setSavedApiKey] = useState('');
  const [showApiKeyForm, setShowApiKeyForm] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [attachedDoc, setAttachedDoc] = useState<ParsedDocument | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasApiKey = savedApiKey.trim().length > 0;
  const canSend = (input.trim().length > 0 || attachedDoc !== null) && !isLoading && !isParsing && hasApiKey;
  const canRunPdfPrompt = attachedDoc !== null && !isLoading && !isParsing && hasApiKey;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, progressText, attachedDoc]);

  useEffect(() => {
    const stored = window.localStorage.getItem(API_KEY_STORAGE_KEY)?.trim() ?? '';
    if (stored) {
      setSavedApiKey(stored);
      setApiKeyInput(stored);
      setShowApiKeyForm(false);
    }
  }, []);

  const saveApiKey = () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      alert('Anthropic API Key를 입력해주세요.');
      return;
    }

    window.localStorage.setItem(API_KEY_STORAGE_KEY, trimmed);
    setSavedApiKey(trimmed);
    setShowApiKeyForm(false);
  };

  const clearApiKey = () => {
    window.localStorage.removeItem(API_KEY_STORAGE_KEY);
    setSavedApiKey('');
    setApiKeyInput('');
    setShowApiKeyForm(true);
    setMessages([]);
    setAttachedDoc(null);
  };

  const handleFileSelect = async (file: File) => {
    if (!isSupportedFile(file)) {
      alert('PDF 또는 TXT 파일만 업로드할 수 있습니다.');
      return;
    }

    setIsParsing(true);
    setParseProgress(`📄 ${file.name} 파싱 중...`);

    try {
      const doc =
        file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt')
          ? await readTextFile(file)
          : await parsePdfFile(file, (current, total) => {
              setParseProgress(`📄 ${file.name} 파싱 중... (${current}/${total} 페이지)`);
            });

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

  const sendMessage = async (text?: string) => {
    const userText = (text ?? input).trim();
    if ((!userText && !attachedDoc) || isLoading) return;
    if (!hasApiKey) {
      setShowApiKeyForm(true);
      return;
    }

    let fullMessage = userText;
    let displayMessage = userText;

    if (attachedDoc) {
      const docHeader = `[첨부 문서: ${attachedDoc.fileName} (${attachedDoc.pageCount}페이지)]`;
      const docBody = `\n\n---문서 내용 시작---\n${attachedDoc.text}\n---문서 내용 끝---\n\n`;
      fullMessage = `${docHeader}${docBody}${userText || '이 문서를 분석하고 건물 파라미터를 추출해주세요. 가능하면 Forma 캔버스에 3D 매스도 배치해주세요.'}`;
      displayMessage = userText
        ? `${userText}\n\n📎 ${attachedDoc.fileName}`
        : `📎 ${attachedDoc.fileName} 분석 요청`;
    }

    setInput('');
    setAttachedDoc(null);
    setIsLoading(true);
    setProgressText('');

    const currentHistory = [...messages];
    setMessages((prev) => [...prev, { role: 'user', content: displayMessage }]);

    try {
      const response = await runAgent(
        fullMessage,
        currentHistory,
        (progress) => setProgressText(progress),
        { apiKey: savedApiKey },
      );
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

  return (
    <div class="chat-wrapper" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.txt"
        style={{ display: 'none' }}
        onChange={onFileInputChange}
      />

      <div class="chat-header">
        <div class="chat-header-left">
          <span class="chat-header-icon">AI</span>
          <span class="chat-header-title">Forma AI Assistant</span>
        </div>
        <div class="chat-header-right">
          {hasApiKey && (
            <button class="clear-btn" onClick={() => setShowApiKeyForm((prev) => !prev)} title="API Key 설정">
              Key
            </button>
          )}
          {messages.length > 0 && (
            <button class="clear-btn" onClick={clearConversation} title="대화 초기화">
              ×
            </button>
          )}
        </div>
      </div>

      {showApiKeyForm && (
        <div class="api-key-panel">
          <div class="api-key-title">Anthropic API Key 입력</div>
          <div class="api-key-subtitle">
            채팅을 시작하기 전에 API Key를 입력해주세요. 입력한 키는 현재 브라우저에만 저장됩니다.
          </div>
          <input
            class="api-key-input"
            type="password"
            value={apiKeyInput}
            onInput={(e) => setApiKeyInput((e.target as HTMLInputElement).value)}
            placeholder="sk-ant-..."
            disabled={isLoading}
          />
          <div class="api-key-actions">
            <button class="api-key-btn primary" onClick={saveApiKey} disabled={!apiKeyInput.trim() || isLoading}>
              저장하고 시작
            </button>
            {hasApiKey && (
              <>
                <button class="api-key-btn" onClick={() => setShowApiKeyForm(false)} disabled={isLoading}>
                  닫기
                </button>
                <button class="api-key-btn danger" onClick={clearApiKey} disabled={isLoading}>
                  저장된 키 삭제
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <div class="messages-container">
        {messages.length === 0 && !isLoading && !isParsing && !showApiKeyForm && (
          <div class="empty-state">
            <p class="empty-title">무엇이든 물어보세요</p>
            <p class="empty-subtitle">
              Forma 프로젝트 데이터를 AI가 분석합니다.
              <br />
              PDF 첨부로 건축 보고서도 분석할 수 있습니다.
            </p>
            <div class="example-list">
              <button
                class="example-btn primary"
                onClick={() => (canRunPdfPrompt ? sendMessage(PDF_MASS_PROMPT) : fileInputRef.current?.click())}
                disabled={isLoading || isParsing}
              >
                첨부한 PDF 기반 매스 생성
              </button>
              <button
                class="example-btn primary"
                onClick={() =>
                  canRunPdfPrompt ? sendMessage(PDF_FLOOR_PLAN_RECREATE_DIRECT_PROMPT) : fileInputRef.current?.click()
                }
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

        {isParsing && (
          <div class="parse-progress">
            <span class="parse-spinner">⟳</span>
            <span>{parseProgress}</span>
          </div>
        )}

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
              onClick={() => sendMessage(PDF_FLOOR_PLAN_RECREATE_DIRECT_PROMPT)}
              disabled={!canRunPdfPrompt}
            >
              실배치 재생성
            </button>
          </div>
          <div class="attachment-actions">
            <button class="attachment-action-btn" onClick={() => sendMessage(PDF_MASS_PROMPT)} disabled={!canRunPdfPrompt}>
              매스 생성
            </button>
          </div>
          <button class="attachment-remove" onClick={removeAttachment} title="첨부 제거">
            ×
          </button>
        </div>
      )}

      <div class="input-area">
        <button
          class="attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={isLoading || isParsing || !hasApiKey}
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
            !hasApiKey
              ? '먼저 API Key를 입력해주세요.'
              : attachedDoc
                ? `${attachedDoc.fileName}에 대해 질문해보세요...`
                : '메시지 입력... (Enter: 전송, Shift+Enter: 줄바꿈)'
          }
          rows={2}
          disabled={isLoading || isParsing || !hasApiKey}
        />
        <button class="send-btn" onClick={() => sendMessage()} disabled={!canSend}>
          →
        </button>
      </div>
    </div>
  );
}

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
