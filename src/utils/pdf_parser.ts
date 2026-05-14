/**
 * 브라우저에서 PDF 파일을 텍스트로 파싱하는 유틸리티.
 * PDF.js (pdfjs-dist) 를 사용하여 각 페이지의 텍스트를 추출합니다.
 */

import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Web Worker 경로 설정 (Vite ?url 임포트로 번들러가 자동 처리)
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export interface ParsedDocument {
  fileName: string;
  fileSize: number;       // bytes
  pageCount: number;
  text: string;           // 전체 텍스트 (줄바꿈 포함)
  extractedAt: string;    // ISO timestamp
}

/**
 * File 객체에서 PDF 텍스트를 추출합니다.
 * @param file  브라우저 File 객체 (input[type=file] 또는 drag-and-drop)
 * @param onProgress  페이지 진행 콜백 (currentPage, totalPages)
 */
export async function parsePdfFile(
  file: File,
  onProgress?: (current: number, total: number) => void,
): Promise<ParsedDocument> {
  const arrayBuffer = await file.arrayBuffer();

  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    // 한국어 등 CMap 지원
    useSystemFonts: true,
  });

  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;
  const pageTexts: string[] = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    onProgress?.(pageNum, totalPages);

    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // 텍스트 아이템 결합: 공백이 있는 경우 공백 추가
    let pageText = '';
    let lastY: number | null = null;

    for (const item of content.items) {
      if ('str' in item) {
        const textItem = item as { str: string; transform: number[] };
        const currentY = textItem.transform[5];

        // Y 좌표가 바뀌면 줄바꿈 (한국 PDF 특성상 행 구분에 효과적)
        if (lastY !== null && Math.abs(currentY - lastY) > 2) {
          pageText += '\n';
        } else if (pageText.length > 0 && !pageText.endsWith(' ') && textItem.str.length > 0) {
          pageText += ' ';
        }

        pageText += textItem.str;
        lastY = currentY;
      }
    }

    pageTexts.push(pageText.trim());
    page.cleanup();
  }

  await pdf.destroy();

  return {
    fileName: file.name,
    fileSize: file.size,
    pageCount: totalPages,
    text: pageTexts.join('\n\n'),
    extractedAt: new Date().toISOString(),
  };
}

/** 파일 크기를 읽기 쉬운 형식으로 변환 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 지원하는 파일 타입인지 확인 */
export function isSupportedFile(file: File): boolean {
  return (
    file.type === 'application/pdf' ||
    file.name.toLowerCase().endsWith('.pdf') ||
    file.type === 'text/plain' ||
    file.name.toLowerCase().endsWith('.txt')
  );
}

/** 텍스트 파일 읽기 (PDF가 아닌 경우) */
export async function readTextFile(file: File): Promise<ParsedDocument> {
  const text = await file.text();
  return {
    fileName: file.name,
    fileSize: file.size,
    pageCount: 1,
    text,
    extractedAt: new Date().toISOString(),
  };
}
