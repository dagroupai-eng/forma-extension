import type Anthropic from '@anthropic-ai/sdk';

/**
 * Claude에게 노출할 Forma API 도구 목록.
 * Claude는 사용자 질문을 분석하고 이 도구들 중 적절한 것을 골라 호출 요청을 반환합니다.
 */
export const FORMA_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_elements_by_category',
    description: `Forma 프로젝트에서 특정 카테고리의 요소 경로 목록을 가져옵니다.
사용 가능한 카테고리:
- "building": 건물 (건축물 전체)
- "terrain": 지형 (대지, 토지)
- "generic": 일반 요소
- "road": 도로
반환값: 요소 경로 배열과 개수`,
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: '요소 카테고리',
          enum: ['building', 'terrain', 'generic', 'road'],
        },
      },
      required: ['category'],
    },
  },

  {
    name: 'get_element_mesh_info',
    description: `특정 요소의 3D 메쉬 정보(삼각형 수, 표면적)를 가져옵니다.
면적, 부피 등 수치 분석에 사용됩니다.
반환값: { triangleCount, surfaceArea_m2 }`,
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'get_elements_by_category에서 얻은 요소 경로',
        },
      },
      required: ['path'],
    },
  },

  {
    name: 'get_multiple_elements_mesh_info',
    description: `여러 요소의 메쉬 정보를 한꺼번에 가져옵니다.
단일 카테고리 전체 면적 합산 시 사용하면 효율적입니다.
반환값: 각 요소의 { path, surfaceArea_m2 } 배열과 totalArea_m2 합계`,
    input_schema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '요소 경로 배열',
        },
      },
      required: ['paths'],
    },
  },

  {
    name: 'get_current_selection',
    description: `사용자가 Forma 3D 뷰어에서 현재 선택한 요소들의 경로를 가져옵니다.
"선택한 요소" 또는 "지금 선택된 것"에 대한 질문에 사용합니다.
반환값: 선택된 경로 배열과 개수, 그리고 각 path가 site_limit/terrain/building/road/generic 중 어디에 속하는지 판별 결과(classified)`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'highlight_elements',
    description: `지정한 요소들을 Forma 3D 뷰어에서 색상으로 강조 표시합니다.
분석 결과 요소를 시각적으로 확인할 때 사용합니다.
색상 옵션: "yellow"(노란색, 기본), "red"(빨간색), "green"(초록색), "blue"(파란색)`,
    input_schema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '강조할 요소 경로 배열',
        },
        color: {
          type: 'string',
          description: '강조 색상',
          enum: ['yellow', 'red', 'green', 'blue'],
        },
      },
      required: ['paths'],
    },
  },

  {
    name: 'clear_highlights',
    description: `Forma 3D 뷰어의 모든 강조 표시를 제거하고 원래 색상으로 복원합니다.`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'test_floorstack_plan_units',
    description: `Create a tiny one-floor FloorStack building with a single plan/unit to test whether this Forma project accepts FloorStackApi.createFromFloors({ floors, plans }).
Use this before the PDF floor-plan recreation workflow when diagnosing program/functionId validation.
The tool first tries two adjacent units with shared vertices, then simpler single-unit variants. It adds only the first successful test building and does not delete existing buildings.`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'recreate_buildings_with_floor_plans',
    description: `Create new FloorStack buildings with real FloorStack plans.units from PDF-derived room schedules.
This is the Autodesk-recommended workflow when existing plans cannot be edited through the API: re-create a new building with updated floor plans.

  Important:
  - Do not delete or replace the existing building in this tool.
  - Extract room layouts into requirements.buildings[].floor_plans and requirements.buildings[].basement.floor_plans.
  - If the PDF mentions ㄱ자형, L-shape, or an L-shaped arrangement, extract it into floor_layout_types for the relevant floors using L_SHAPE.
  - Preserve each PDF room as a separate unit. Do not merge a floor's rooms into one unit unless every multi-unit attempt fails.
- Each room must include name and area_m2. Add unit_type only when confident: CORE, CORRIDOR, LIVING_UNIT, PARKING.
- The tool will try multiple compatibility variants: program+functionId, program only, all LIVING_UNIT, polygon units only.
- Report which variant succeeded or failed.`,
    input_schema: {
      type: 'object',
      properties: {
        requirements: {
          type: 'object',
          description: 'PDF-derived building requirements with floor_plans rooms for each floor.',
          properties: {
            project_name: { type: 'string' },
            location: { type: 'string' },
            site_limits: { type: 'object' },
            buildings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  target_floor_area: { type: 'number' },
                  target_floors: { type: 'number' },
                  footprint_area: { type: 'number' },
                  mass_layout_type: {
                    type: 'string',
                    enum: ['AUTO', 'RECTANGLE', 'COURTYARD_U'],
                  },
                  floor_breakdown: {
                    type: 'object',
                    additionalProperties: { type: 'number' },
                  },
                    floor_heights_m: {
                      type: 'object',
                      additionalProperties: { type: 'number' },
                    },
                    floor_layout_types: {
                      type: 'object',
                      additionalProperties: {
                        type: 'string',
                        enum: ['AUTO', 'ROW_LAYOUT', 'EDGE_STRIP', 'L_SHAPE'],
                      },
                    },
                    floor_plans: {
                      type: 'object',
                      additionalProperties: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          area_m2: { type: 'number' },
                          function_id: { type: 'string' },
                          unit_type: {
                            type: 'string',
                            enum: ['CORE', 'CORRIDOR', 'LIVING_UNIT', 'PARKING'],
                          },
                        },
                        required: ['name', 'area_m2'],
                      },
                    },
                  },
                  basement: {
                    type: 'object',
                    properties: {
                      floors: { type: 'number' },
                      area_m2: { type: 'number' },
                      use: { type: 'string' },
                      floor_breakdown: {
                        type: 'object',
                        additionalProperties: { type: 'number' },
                      },
                        floor_heights_m: {
                          type: 'object',
                          additionalProperties: { type: 'number' },
                        },
                        floor_layout_types: {
                          type: 'object',
                          additionalProperties: {
                            type: 'string',
                            enum: ['AUTO', 'ROW_LAYOUT', 'EDGE_STRIP', 'L_SHAPE'],
                          },
                        },
                        floor_plans: {
                          type: 'object',
                        additionalProperties: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              name: { type: 'string' },
                              area_m2: { type: 'number' },
                              function_id: { type: 'string' },
                              unit_type: {
                                type: 'string',
                                enum: ['CORE', 'CORRIDOR', 'LIVING_UNIT', 'PARKING'],
                              },
                            },
                            required: ['name', 'area_m2'],
                          },
                        },
                      },
                    },
                  },
                  position_hint: {
                    type: 'string',
                    enum: ['center', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'],
                  },
                },
                required: ['name', 'target_floor_area', 'target_floors'],
              },
            },
          },
          required: ['buildings'],
        },
      },
      required: ['requirements'],
    },
  },

  {
    name: 'place_building_masses',
    description: `건축 기획 파라미터를 기반으로 Forma 3D 뷰어에 건물 매스(Mass)를 배치합니다.

동작 방식:
1. Forma 대지(site_limit / terrain)에서 좌표계를 자동으로 파악
2. 각 동의 position_hint → 대지 내 실제 좌표 변환
3. footprint_area(바닥면적) → 직사각형 GeoJSON Polygon 생성
4. floor_breakdown / floor_heights_m가 있으면 층별 면적과 층고를 그대로 적용
5. basement.floor_breakdown / basement.floor_heights_m가 있으면 지하층을 기준 레벨 아래로 생성
6. Forma.render.geojson으로 뷰어에 즉시 표시 (임시 시각화)

requirements 파라미터:
- 사용자가 PDF를 첨부한 경우: 문서에서 추출한 건물 데이터를 이 파라미터로 제공하세요.
- 생략 시: 사전 내장된 경주시 복합문화도서관 데이터를 사용합니다.

반환값: 배치된 각 동의 좌표, 치수, geojsonId, 건폐율 요약`,
    input_schema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: '배치할 프로젝트 이름. requirements를 직접 제공할 경우 생략 가능.',
        },
        floor_height_m: {
          type: 'number',
          description: '층당 높이(m). 기본값 4.0m (공공건물 기준). 변경 가능.',
        },
        requirements: {
          type: 'object',
          description: `PDF/문서에서 추출한 건축 기획 파라미터. 제공 시 이 데이터로 매스를 배치합니다.
PDF가 첨부된 경우에는 반드시 이 파라미터를 채워서 제공하세요.`,
          properties: {
            project_name: {
              type: 'string',
              description: '프로젝트 이름 (예: "경주시 복합문화도서관")',
            },
            location: {
              type: 'string',
              description: '프로젝트 위치 (예: "경상북도 경주시")',
            },
            site_limits: {
              type: 'object',
              description: '대지 제약 조건',
              properties: {
                total_site_area: {
                  type: 'number',
                  description: '전체 대지 면적 (m²)',
                },
                max_building_coverage_ratio: {
                  type: 'number',
                  description: '최대 건폐율 소수점 형태 (예: 건폐율 20% → 0.2)',
                },
                max_floor_area_ratio: {
                  type: 'number',
                  description: '최대 용적률 소수점 형태 (예: 용적률 100% → 1.0)',
                },
                max_height_floors: {
                  type: 'number',
                  description: '지상 최대 층수 제한',
                },
              },
            },
            buildings: {
              type: 'array',
              description: '각 동/건물 배치 계획 배열',
              items: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: '동/건물 이름 (예: "A동 융합허브", "도서관동")',
                  },
                  target_floor_area: {
                    type: 'number',
                    description: '목표 연면적 (m²)',
                  },
                  target_floors: {
                    type: 'number',
                    description: '계획 층수 (지상)',
                  },
                  footprint_area: {
                    type: 'number',
                    description: '1층 바닥면적(건축면적) (m²). 없으면 target_floor_area ÷ target_floors로 자동 계산',
                  },
                  floor_breakdown: {
                    type: 'object',
                    description: '층별 면적(m²). 문서에 층별 면적이 있으면 반드시 입력하세요. 예: {"1F":500,"2F":742,"3F":742}',
                    additionalProperties: { type: 'number' },
                  },
                  floor_heights_m: {
                    type: 'object',
                    description: '층별 층고(m). 문서에 층별 층고가 있으면 평균값으로 합치지 말고 반드시 층별로 입력하세요. 예: {"1F":5.0,"2F":7.0,"4F":8.0}',
                    additionalProperties: { type: 'number' },
                  },
                  basement: {
                    type: 'object',
                    description: '지하층 정보. 지하층이 있으면 지상층에 합치지 말고 이 객체에 별도로 입력하세요.',
                    properties: {
                      floors: {
                        type: 'number',
                        description: '지하층 수',
                      },
                      area_m2: {
                        type: 'number',
                        description: '지하층 전체 면적 합계(m²)',
                      },
                      use: {
                        type: 'string',
                        description: '지하층 주요 용도',
                      },
                      floor_breakdown: {
                        type: 'object',
                        description: '지하 층별 면적(m²). 예: {"B4":990,"B3":990,"B2":990,"B1":990}',
                        additionalProperties: { type: 'number' },
                      },
                      floor_heights_m: {
                        type: 'object',
                        description: '지하 층별 층고(m). 예: {"B4":8.0,"B3":8.0,"B2":8.0,"B1":3.5}',
                        additionalProperties: { type: 'number' },
                      },
                    },
                  },
                  position_hint: {
                    type: 'string',
                    description: '대지 내 배치 위치. 문서의 배치 계획·평면도 설명에서 유추하세요.',
                    enum: ['center', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'],
                  },
                },
                required: ['name', 'target_floor_area', 'target_floors'],
              },
            },
            parking: {
              type: 'object',
              properties: {
                required_parking_spots: {
                  type: 'number',
                  description: '필요 주차 대수',
                },
                location_hint: {
                  type: 'string',
                  description: '주차 위치 (예: "underground", "rear", "underground_or_rear")',
                },
              },
            },
          },
          required: ['buildings'],
        },
      },
    },
  },

  {
    name: 'clear_building_masses',
    description: `Forma 3D 뷰어에 배치된 모든 건물 매스 시각화를 제거합니다.
place_building_masses로 추가한 GeoJSON 렌더링을 모두 삭제합니다.`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'parse_building_requirements',
    description: `건축 기획 문서(보고서)에서 절차적 매스 생성(Procedural Mass Generation)에 필요한
기하학적 파라미터를 추출하여 구조화된 JSON으로 반환합니다.

반환 데이터:
- site_limits: 대지 제약 조건 (면적, 건폐율, 용적률, 최대 층수)
- buildings: 동별 배치 계획 (이름, 연면적, 층수, 바닥면적, 배치 위치)
- parking: 주차 요구사항
- derived_metrics: 실제 건폐율/용적률 등 파생 수치

이 데이터를 기반으로 Forma 캔버스에 3D 매스를 배치할 수 있습니다.

사용 방법:
- 사용자가 PDF/TXT를 첨부한 경우: raw_text에 문서 전체 텍스트를 전달하세요.
- 특정 프로젝트 이름으로 조회할 때: project_name을 전달하세요.`,
    input_schema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: '조회할 프로젝트 이름 (예: "경주시 복합문화도서관"). 생략 시 현재 로드된 프로젝트 데이터를 반환합니다.',
        },
        raw_text: {
          type: 'string',
          description: 'PDF/TXT에서 추출한 문서 전체 텍스트. 제공 시 이 텍스트를 기반으로 requirements를 파싱합니다.',
        },
      },
    },
  },

  {
    name: 'debug_site_bounds',
    description: `Forma 프로젝트에서 Site Limits(대지 경계) 요소를 진단합니다.
모든 카테고리(site_limit, terrain, generic, building, road)를 순서대로 조회하고
각 요소의 path, footprint 좌표, 삼각형 기반 바운딩 박스를 반환합니다.

매스 배치가 원점 기준으로 잘못 배치될 때 이 도구로 원인을 파악하세요.
반환값: 카테고리별 조회 결과 (path 목록, footprint 좌표, bbox)`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];
