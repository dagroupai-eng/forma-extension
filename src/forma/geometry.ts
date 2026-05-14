/**
 * 삼각형 메쉬 배열(Float32Array)에서 표면적을 계산합니다.
 * 각 삼각형은 9개의 float 값으로 구성 (꼭지점 3개 × xyz).
 * 외적(Cross Product)의 크기를 이용해 삼각형 넓이를 합산합니다.
 */
export function calculateSurfaceArea(triangles: Float32Array): number {
  let totalArea = 0;

  for (let i = 0; i < triangles.length; i += 9) {
    const ax = triangles[i],     ay = triangles[i + 1], az = triangles[i + 2];
    const bx = triangles[i + 3], by = triangles[i + 4], bz = triangles[i + 5];
    const cx = triangles[i + 6], cy = triangles[i + 7], cz = triangles[i + 8];

    // 벡터 AB, AC
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;

    // 외적 AB × AC
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;

    // 삼각형 넓이 = |외적| / 2
    totalArea += Math.sqrt(crossX ** 2 + crossY ** 2 + crossZ ** 2) / 2;
  }

  return totalArea; // 단위: m²
}

/** 소수점 둘째 자리로 반올림 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
