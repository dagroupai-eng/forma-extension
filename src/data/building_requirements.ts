/**
 * 건축 기획 문서에서 추출한 기하학적 파라미터 데이터.
 * 원본: 경주시 복합문화도서관_Text 보고서.pdf
 *
 * parse_building_requirements MCP Tool이 이 데이터를 반환합니다.
 * Claude는 이 JSON을 기반으로 Forma 캔버스에 3D 매스를 생성합니다.
 */

export interface FloorBreakdown {
  [floor: string]: number;
}

export interface FloorHeights {
  [floor: string]: number;
}

export type LayoutType = 'AUTO' | 'ROW_LAYOUT' | 'EDGE_STRIP' | 'L_SHAPE';
export type MassLayoutType = 'AUTO' | 'RECTANGLE' | 'COURTYARD_U';

export interface BasementInfo {
  floors: number;
  area_m2: number;
  use: string;
  floor_breakdown?: FloorBreakdown;
  floor_heights_m?: FloorHeights;
  floor_plans?: Record<string, RoomLayout[]>;
  floor_layout_types?: Record<string, LayoutType>;
}

export interface RoomLayout {
  name: string;
  area_m2: number;
  function_id?: string;
  unit_type?: 'CORE' | 'CORRIDOR' | 'LIVING_UNIT' | 'PARKING';
}

export interface BuildingMass {
  name: string;
  target_floor_area: number;
  target_floors: number;
  footprint_area: number;
  mass_layout_type?: MassLayoutType;
  position_hint: 'center' | 'northeast' | 'northwest' | 'southeast' | 'southwest' | string;
  floor_breakdown: FloorBreakdown;
  floor_heights_m?: FloorHeights;
  floor_plans?: Record<string, RoomLayout[]>;
  floor_layout_types?: Record<string, LayoutType>;
  basement?: BasementInfo;
}

export interface SiteLimits {
  total_site_area: number;
  max_building_coverage_ratio: number;
  max_floor_area_ratio: number;
  max_height_floors: number;
}

export interface ParkingRequirements {
  required_parking_spots: number;
  location_hint: string;
}

export interface BuildingRequirements {
  project: {
    name: string;
    location: string;
    total_floor_area_m2: number;
  };
  site_limits: SiteLimits;
  buildings: BuildingMass[];
  parking: ParkingRequirements;
  derived_metrics: {
    total_footprint_area: number;
    actual_coverage_ratio: number;
    actual_floor_area_ratio: number;
    remaining_buildable_area: number;
  };
}

/**
 * 문서에서 파싱한 완성된 건축 파라미터.
 *
 * footprint_area 산정 기준:
 * - A동: 1F 실제 면적 900㎡ (로비 800 + 통합데스크 100)
 * - B동: 1F 실제 면적 1,400㎡ (열람실 1,000 + 서고 400)
 * - C동: 선언 총계 2,400㎡ ÷ 3층 = 800㎡ (문서 층별 합계 오류로 총계 기준)
 * - D동: 1F 실제 면적 600㎡ (어린이 열람실 400 + 유아가족존 200)
 */
export const GYEONGJU_LIBRARY_REQUIREMENTS: BuildingRequirements = {
  project: {
    name: '경주시 복합문화도서관 GLAM 융합거점',
    location: '경상북도 경주시 황성공원 일원',
    total_floor_area_m2: 11100,
  },
  site_limits: {
    total_site_area: 30000,
    max_building_coverage_ratio: 0.20,
    max_floor_area_ratio: 1.00,
    max_height_floors: 3,
  },
  buildings: [
    {
      name: 'A동 융합허브',
      target_floor_area: 2200,
      target_floors: 3,
      footprint_area: 900,
      position_hint: 'center',
      floor_breakdown: {
        '1F': 900,   // 메인 로비, 커뮤니티라운지(800), 통합데스크(100)
        '2F': 700,   // 북카페&라이브러리샵(300), 융합전시공간(400)
        '3F': 600,   // 미디어존(200), 메이커스페이스(400)
      },
    },
    {
      name: 'B동 도서관',
      target_floor_area: 4500,
      target_floors: 3,
      footprint_area: 1400,
      position_hint: 'northeast',
      floor_breakdown: {
        '1F': 1400,  // 일반열람실(1,000), 개방형 보존서고(400)
        '2F': 1500,  // 일반열람실(1,200), 연속간행물존(300)
        '3F': 1600,  // 디지털자료실(500), 사무실(250), 자료정리실(200), 회의실 등(650)
      },
    },
    {
      name: 'C동 문화교육관',
      target_floor_area: 2400,
      target_floors: 3,
      footprint_area: 800,
      position_hint: 'southwest',
      floor_breakdown: {
        '1F': 1000,  // 다목적 전시홀(800), 전시지원공간(200)
        '2F': 1000,  // 경주기록실(600), 도서관 역사전시실(300), 휴게공간(100)
        '3F': 400,   // 다목적홀(350), 강의실(270), 동아리실(180) [※문서 층합 오류 조정]
      },
    },
    {
      name: 'D동 어린이관',
      target_floor_area: 1500,
      target_floors: 3,
      footprint_area: 600,
      position_hint: 'southeast',
      floor_breakdown: {
        '1F': 600,   // 어린이 열람실(400), 유아동반 가족존(200)
        '2F': 500,   // 어린이 체험공간(300), 프로그램실(150), 수유실(50)
        '3F': 400,   // 미래교육 플랫폼(400)
      },
      basement: {
        floors: 1,
        area_m2: 500,
        use: '기계실(200), 전기실(100), 방재실(50), 창고(150)',
      },
    },
  ],
  parking: {
    required_parking_spots: 37,
    location_hint: 'underground_or_rear',
  },
  derived_metrics: {
    // 4개동 바닥면적 합계: 900 + 1,400 + 800 + 600
    total_footprint_area: 3700,
    // 실제 건폐율: 3,700 / 30,000 = 12.3%
    actual_coverage_ratio: 0.123,
    // 실제 용적률: 11,100 / 30,000 = 37%
    actual_floor_area_ratio: 0.37,
    // 잔여 건축 가능 면적: 6,000(최대건축면적) - 3,700 = 2,300㎡
    remaining_buildable_area: 2300,
  },
};

/**
 * 텍스트 형태의 건축 보고서에서 핵심 수치를 파싱하는 함수.
 * 실제 PDF 텍스트가 주어졌을 때 정규식으로 파라미터를 추출합니다.
 *
 * @param rawText PDF에서 추출한 전체 텍스트
 * @returns 파싱된 BuildingRequirements 또는 사전 정의된 데이터
 */
export function parseRequirementsFromText(rawText: string): BuildingRequirements {
  // 알려진 프로젝트 텍스트라면 사전 파싱된 데이터 반환
  if (rawText.includes('경주시') && rawText.includes('복합문화도서관')) {
    return GYEONGJU_LIBRARY_REQUIREMENTS;
  }

  // 범용 파싱: 정규식으로 핵심 수치 추출 시도
  const siteAreaMatch = rawText.match(/대지면적[^\d]*(\d[\d,]+)\s*㎡/);
  const coverageMatch = rawText.match(/건폐율[^\d]*(\d+)%/);
  const farMatch = rawText.match(/용적률[^\d]*(\d+)%/);
  const floorsMatch = rawText.match(/지상\s*(\d+)\s*층\s*이하/);
  const parkingMatch = rawText.match(/(\d+)\s*대\s*이상/);

  const siteArea = siteAreaMatch ? parseInt(siteAreaMatch[1].replace(',', '')) : 0;
  const coverageRatio = coverageMatch ? parseInt(coverageMatch[1]) / 100 : 0;
  const farRatio = farMatch ? parseInt(farMatch[1]) / 100 : 0;
  const maxFloors = floorsMatch ? parseInt(floorsMatch[1]) : 0;
  const parking = parkingMatch ? parseInt(parkingMatch[1]) : 0;
  const globalLayoutType: LayoutType =
    rawText.includes('\u3131') || /L[\s-]?shape/i.test(rawText)
      ? 'L_SHAPE'
      : 'AUTO';
  const globalMassLayoutType: MassLayoutType =
    rawText.includes('\u3137') || /courtyard|u[\s-]?shape|u[\s-]?type/i.test(rawText)
      ? 'COURTYARD_U'
      : 'AUTO';

  // 동/건물 정보 파싱 (문서 형식이 다양하므로 "가능한 것만" 추출)
  // 예시 패턴:
  // - "A동 ... 연면적 2,200㎡ ... 3층"
  // - "B동 도서관(지상 3층) ... 4,500㎡"
  const buildingMatches = Array.from(
    rawText.matchAll(
      /(?<name>[A-Z0-9가-힣]+동)[^\n]{0,120}?(?<area>\d[\d,]+)\s*㎡[^\n]{0,120}?(?:지상\s*)?(?<floors>\d+)\s*층/g,
    ),
  );

  const DEFAULT_POSITIONS: BuildingMass['position_hint'][] = [
    'center',
    'northeast',
    'southwest',
    'southeast',
    'northwest',
    'north',
    'south',
    'east',
    'west',
  ];

  const buildings: BuildingMass[] = buildingMatches.map((m, i) => {
    const name = (m.groups?.name ?? `건물${i + 1}`).trim();
    const area = parseInt((m.groups?.area ?? '0').replace(/,/g, ''), 10) || 0;
    const floors = parseInt(m.groups?.floors ?? '0', 10) || 0;
    const safeFloors = floors > 0 ? floors : 3;
    const footprint = area > 0 ? Math.max(1, Math.round(area / safeFloors)) : 0;

    return {
      name,
      target_floor_area: area,
      target_floors: safeFloors,
      footprint_area: footprint,
      mass_layout_type: globalMassLayoutType,
      position_hint: DEFAULT_POSITIONS[i % DEFAULT_POSITIONS.length],
      floor_breakdown: {},
      floor_layout_types: globalLayoutType === 'AUTO'
        ? {}
        : Object.fromEntries(
            Array.from({ length: safeFloors }, (_, floorIndex) => [`${floorIndex + 1}F`, globalLayoutType]),
          ),
    };
  });

  const totalFloorArea = buildings.reduce((s, b) => s + (b.target_floor_area || 0), 0);
  const totalFootprint = buildings.reduce((s, b) => s + (b.footprint_area || 0), 0);
  const safeSiteArea = siteArea > 0 ? siteArea : 0;
  const safeCoverage = coverageRatio > 0 ? coverageRatio : 0.6;
  const safeFar = farRatio > 0 ? farRatio : 2.0;
  const safeMaxFloors = maxFloors > 0 ? maxFloors : Math.max(...buildings.map((b) => b.target_floors), 0) || 20;

  return {
    project: {
      name: '(파싱된 프로젝트)',
      location: '',
      total_floor_area_m2: totalFloorArea,
    },
    site_limits: {
      total_site_area: safeSiteArea,
      max_building_coverage_ratio: safeCoverage,
      max_floor_area_ratio: safeFar,
      max_height_floors: safeMaxFloors,
    },
    buildings,
    parking: { required_parking_spots: parking, location_hint: '' },
    derived_metrics: {
      total_footprint_area: totalFootprint,
      actual_coverage_ratio: safeSiteArea > 0 ? parseFloat((totalFootprint / safeSiteArea).toFixed(4)) : 0,
      actual_floor_area_ratio: safeSiteArea > 0 ? parseFloat((totalFloorArea / safeSiteArea).toFixed(4)) : 0,
      remaining_buildable_area: safeSiteArea > 0 ? safeSiteArea * safeCoverage - totalFootprint : 0,
    },
  };
}
