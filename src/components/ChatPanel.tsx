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
const APP_BUILD_LABEL = import.meta.env.DEV ? 'dev-local' : 'prod-build';

const EXAMPLE_QUERIES = [
  '현재 프로젝트의 건물 요소가 몇 개인지 알려줘.',
  '선택한 건물의 전체 표면적을 계산해줘.',
  '현재 선택한 요소를 강조 표시해줘.',
  '현재 Site Limits 안에 샘플 라이브러리 매스를 배치해줘.',
];

const PDF_MASS_PROMPT =
  '첨부한 문서를 바탕으로 건물 매스 파라미터를 추출해서 현재 선택한 Site Limits 안에 매스를 배치해주세요. 문서에 여러 건물이 설명되어 있으면 하나로 합치지 말고 각각 분리된 매스로 생성해주세요. 모든 응답은 한국어로 작성해주세요.';

const PDF_RECREATE_PROMPT = `recreate_buildings_with_floor_plans

첨부한 PDF 내용을 바탕으로 기존 매스를 새 FloorStack 매스로 재생성하고, 생성 요청 안에 floor_plans 실배치를 함께 포함해주세요.
기존 매스 위에 임시 선 오버레이만 만들지 마세요.
새 FloorStack 매스가 실제 Buildings layer에 생성된 것을 확인한 뒤 기존 매스를 삭제/교체하세요.
매스 생성 기능으로 만들어진 기존 외곽과 위치를 기준으로 core 위치를 고정하고, 나머지 실은 plans.units로 생성해주세요.
core, corridor, parking만 최소 분류하고 일반 실은 억지로 unit/program으로 분류하지 마세요.`;

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
      alert('Anthropic API 키를 입력해주세요.');
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
      alert('PDF 또는 TXT 파일만 지원됩니다.');
      return;
    }

    setIsParsing(true);
    setParseProgress(`${file.name} 파일을 분석하는 중...`);

    try {
      const doc =
        file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt')
          ? await readTextFile(file)
          : await parsePdfFile(file, (current, total) => {
              setParseProgress(`${file.name} 파일을 분석하는 중... (${current}/${total} 페이지)`);
            });

      setAttachedDoc(doc);
    } catch (err) {
      alert(`파일 분석에 실패했습니다: ${String(err)}`);
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
    const rawUserText = (text ?? input).trim();
    const shouldDefaultToRecreate = attachedDoc !== null && !rawUserText;
    const userText = shouldDefaultToRecreate ? PDF_RECREATE_PROMPT : rawUserText;

    if ((!userText && !attachedDoc) || isLoading) return;
    if (!hasApiKey) {
      setShowApiKeyForm(true);
      return;
    }

    let fullMessage = userText;
    let displayMessage = userText;

    if (attachedDoc) {
      const docHeader = `[Attached document: ${attachedDoc.fileName} (${attachedDoc.pageCount} pages)]`;
      const docBody = `\n\n--- document content start ---\n${attachedDoc.text}\n--- document content end ---\n\n`;
      fullMessage = `${docHeader}${docBody}${userText || '첨부 문서를 분석하고 관련 건축 또는 실배치 데이터를 추출해주세요. 모든 응답은 한국어로 작성해주세요.'}`;
      displayMessage = shouldDefaultToRecreate
        ? `실배치 재생성\n\n첨부 파일: ${attachedDoc.fileName}`
        : userText
          ? `${userText}\n\n첨부 파일: ${attachedDoc.fileName}`
          : `첨부 파일 분석: ${attachedDoc.fileName}`;
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
          <span class="chat-header-build">{APP_BUILD_LABEL}</span>
        </div>
        <div class="chat-header-right">
          {hasApiKey && (
            <button class="clear-btn" onClick={() => setShowApiKeyForm((prev) => !prev)} title="API 키 설정">
              Key
            </button>
          )}
          {messages.length > 0 && (
            <button class="clear-btn" onClick={clearConversation} title="대화 지우기">
              x
            </button>
          )}
        </div>
      </div>

      {showApiKeyForm && (
        <div class="api-key-panel">
          <div class="api-key-title">Anthropic API 키 입력</div>
          <div class="api-key-subtitle">
            키는 현재 PC의 브라우저 로컬 스토리지에만 저장됩니다.
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
                  저장한 키 삭제
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <div class="messages-container">
        {messages.length === 0 && !isLoading && !isParsing && !showApiKeyForm && (
          <div class="empty-state">
            <p class="empty-title">Forma AI에게 요청해보세요</p>
            <p class="empty-subtitle">
              모델 분석, PDF 기반 매스 생성, 실배치 재생성을 지원합니다.
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
                onClick={() => (canRunPdfPrompt ? sendMessage(PDF_RECREATE_PROMPT) : fileInputRef.current?.click())}
                disabled={isLoading || isParsing}
              >
                실배치 재생성
              </button>
              {EXAMPLE_QUERIES.map((q) => (
                <button key={q} class="example-btn" onClick={() => sendMessage(q)}>
                  {q}
                </button>
              ))}
            </div>
            <button class="upload-hint-btn" onClick={() => fileInputRef.current?.click()}>
              PDF / TXT 첨부
            </button>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div key={idx} class={`message-row ${msg.role}`}>
            <div class="message-label">{msg.role === 'user' ? 'User' : 'AI'}</div>
            <div class="message-bubble">
              <MessageContent content={msg.content} />
            </div>
          </div>
        ))}

        {isParsing && (
          <div class="parse-progress">
            <span class="parse-spinner">...</span>
            <span>{parseProgress}</span>
          </div>
        )}

        {isLoading && (
          <div class="message-row assistant">
            <div class="message-label">AI</div>
            <div class="message-bubble loading-bubble">
              <span class="loading-text">{progressText || '작업 중...'}</span>
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
            <span class="attachment-icon">file</span>
            <div class="attachment-details">
              <span class="attachment-name">{attachedDoc.fileName}</span>
              <span class="attachment-meta">
                {attachedDoc.pageCount} 페이지 | {formatFileSize(attachedDoc.fileSize)}
              </span>
            </div>
            <button
              class="attachment-action-btn"
              onClick={() => sendMessage(PDF_RECREATE_PROMPT)}
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
            x
          </button>
        </div>
      )}

      <div class="input-area">
        <button
          class="attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={isLoading || isParsing || !hasApiKey}
          title="PDF 또는 TXT 첨부"
        >
          +
        </button>
        <textarea
          ref={textareaRef}
          class="chat-input"
          value={input}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          placeholder={
            !hasApiKey
              ? '먼저 API 키를 입력해주세요.'
              : attachedDoc
                ? `${attachedDoc.fileName}에 대한 요청을 입력해주세요...`
                : '메시지를 입력하세요... (Enter 전송, Shift+Enter 줄바꿈)'
          }
          rows={2}
          disabled={isLoading || isParsing || !hasApiKey}
        />
        <button class="send-btn" onClick={() => sendMessage()} disabled={!canSend}>
          전송
        </button>
      </div>
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  return (
    <span>
      {content.split('\n').map((line, i, arr) => (
        <span key={`${i}-${line}`}>
          {line}
          {i < arr.length - 1 && <br />}
        </span>
      ))}
    </span>
  );
}
