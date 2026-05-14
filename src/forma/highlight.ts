import { Forma } from 'forma-embedded-view-sdk/auto';

interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

const COLOR_PRESETS: Record<string, Color> = {
  yellow: { r: 255, g: 220, b: 0,   a: 210 },
  red:    { r: 255, g: 60,  b: 60,  a: 210 },
  green:  { r: 60,  g: 220, b: 90,  a: 210 },
  blue:   { r: 60,  g: 150, b: 255, a: 210 },
};

/**
 * 지정한 경로들의 요소를 Forma 뷰어에서 색상으로 강조합니다.
 * 삼각형 메쉬를 가져와 각 삼각형에 동일한 색상을 적용합니다.
 */
export async function highlightElements(
  paths: string[],
  colorName: string = 'yellow',
): Promise<{ succeeded: string[]; failed: string[] }> {
  const color = COLOR_PRESETS[colorName] ?? COLOR_PRESETS.yellow;
  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const path of paths) {
    try {
      const position = await Forma.geometry.getTriangles({ path });
      const numTriangles = position.length / 9;
      const colorArray = new Uint8Array(numTriangles * 4);

      for (let i = 0; i < numTriangles; i++) {
        colorArray[i * 4 + 0] = color.r;
        colorArray[i * 4 + 1] = color.g;
        colorArray[i * 4 + 2] = color.b;
        colorArray[i * 4 + 3] = color.a;
      }

      await Forma.render.updateMesh({
        id: path,
        geometryData: { position, color: colorArray },
      });

      succeeded.push(path);
    } catch (err) {
      console.warn(`[highlight] 실패: ${path}`, err);
      failed.push(path);
    }
  }

  return { succeeded, failed };
}

/** 모든 강조 표시를 제거합니다. */
export async function clearHighlights(): Promise<void> {
  await Forma.render.cleanup();
}
