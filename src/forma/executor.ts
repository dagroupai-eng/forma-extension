import { Forma } from 'forma-embedded-view-sdk/auto';
import { calculateSurfaceArea, round2 } from './geometry';
import { highlightElements, clearHighlights } from './highlight';
import { GYEONGJU_LIBRARY_REQUIREMENTS, parseRequirementsFromText } from '../data/building_requirements';
import type { BuildingRequirements } from '../data/building_requirements';
import {
  clearAllMasses,
  placeBuildingMasses,
  recreateBuildingsWithFloorPlans,
  testFloorStackPlanUnits,
} from './mass_generator';

/**
 * Claude가 PDF에서 추출해 제공한 raw requirements 객체를
 * 완전한 BuildingRequirements 타입으로 정규화합니다.
 *
 * - footprint_area 미제공 → target_floor_area ÷ target_floors 자동 계산
 * - position_hint 미제공 → 동 순서에 따라 기본 위치 배분
 * - derived_metrics → 입력값에서 자동 계산
 */
function normalizeRequirements(raw: Record<string, any>): BuildingRequirements {
  const DEFAULT_POSITIONS = ['center', 'northeast', 'southwest', 'southeast', 'northwest', 'north', 'south'];

  const buildings = ((raw.buildings ?? []) as any[]).map((b, i) => {
    const floors = b.target_floors ?? 3;
    const floorArea = b.target_floor_area ?? 1000;
    const footprint = b.footprint_area ?? Math.round(floorArea / floors);

    return {
      name: b.name ?? `${String.fromCharCode(65 + i)}동`,
      target_floor_area: floorArea,
      target_floors: floors,
      footprint_area: footprint,
      mass_layout_type: b.mass_layout_type ?? 'AUTO',
      position_hint: b.position_hint ?? DEFAULT_POSITIONS[i % DEFAULT_POSITIONS.length],
      floor_breakdown: b.floor_breakdown ?? {},
      floor_heights_m: b.floor_heights_m ?? b.floor_heights ?? {},
      floor_plans: b.floor_plans ?? {},
      floor_layout_types: b.floor_layout_types ?? {},
      ...(b.basement ? {
        basement: {
          ...b.basement,
          floor_layout_types: b.basement.floor_layout_types ?? {},
        },
      } : {}),
    };
  });

  const siteLimits = raw.site_limits ?? {};
  const siteArea: number = siteLimits.total_site_area ?? 0;
  const totalFootprint = buildings.reduce((s, b) => s + b.footprint_area, 0);
  const totalFloorArea = buildings.reduce((s, b) => s + b.target_floor_area, 0);
  const coverageRatio = siteLimits.max_building_coverage_ratio ?? 0.6;

  return {
    project: {
      name: raw.project_name ?? '(업로드된 프로젝트)',
      location: raw.location ?? '',
      total_floor_area_m2: totalFloorArea,
    },
    site_limits: {
      total_site_area: siteArea,
      max_building_coverage_ratio: coverageRatio,
      max_floor_area_ratio: siteLimits.max_floor_area_ratio ?? 2.0,
      max_height_floors: siteLimits.max_height_floors ?? 20,
    },
    buildings,
    parking: {
      required_parking_spots: raw.parking?.required_parking_spots ?? 0,
      location_hint: raw.parking?.location_hint ?? '',
    },
    derived_metrics: {
      total_footprint_area: totalFootprint,
      actual_coverage_ratio: siteArea > 0 ? parseFloat((totalFootprint / siteArea).toFixed(4)) : 0,
      actual_floor_area_ratio: siteArea > 0 ? parseFloat((totalFloorArea / siteArea).toFixed(4)) : 0,
      remaining_buildable_area: siteArea > 0 ? siteArea * coverageRatio - totalFootprint : 0,
    },
  };
}

/**
 * Claude의 Tool Use 요청을 받아 실제 Forma API를 실행하고 결과를 반환합니다.
 * agent.ts의 루프에서 호출됩니다.
 */
export async function executeFormaTool(
  toolName: string,
  input: Record<string, any>,
): Promise<unknown> {
  switch (toolName) {
    // ─────────────────────────────────────────────────
    case 'get_elements_by_category': {
      const paths = await Forma.geometry.getPathsByCategory({
        category: input.category,
      });
      return {
        category: input.category,
        paths,
        count: paths.length,
      };
    }

    // ─────────────────────────────────────────────────
    case 'get_element_mesh_info': {
      const triangles = await Forma.geometry.getTriangles({ path: input.path });
      const surfaceArea = calculateSurfaceArea(triangles);
      return {
        path: input.path,
        triangleCount: triangles.length / 9,
        surfaceArea_m2: round2(surfaceArea),
      };
    }

    // ─────────────────────────────────────────────────
    case 'get_multiple_elements_mesh_info': {
      const paths: string[] = input.paths;
      const results = await Promise.all(
        paths.map(async (path) => {
          try {
            const triangles = await Forma.geometry.getTriangles({ path });
            return {
              path,
              surfaceArea_m2: round2(calculateSurfaceArea(triangles)),
              error: null,
            };
          } catch (err) {
            return { path, surfaceArea_m2: 0, error: String(err) };
          }
        }),
      );
      const totalArea = results.reduce((sum, r) => sum + r.surfaceArea_m2, 0);
      return {
        elements: results,
        totalArea_m2: round2(totalArea),
        count: paths.length,
      };
    }

    // ─────────────────────────────────────────────────
    case 'get_current_selection': {
      const paths = await Forma.selection.getSelection();

      // 선택된 path가 어떤 카테고리에 속하는지(특히 site_limit) 빠르게 판별
      const CATEGORIES = ['site_limit', 'terrain', 'building', 'road', 'generic'] as const;
      const categorySets: Partial<Record<(typeof CATEGORIES)[number], Set<string>>> = {};

      await Promise.all(CATEGORIES.map(async (category) => {
        try {
          const catPaths = await Forma.geometry.getPathsByCategory({ category });
          categorySets[category] = new Set(catPaths);
        } catch {
          // 일부 환경에서 카테고리 조회가 실패할 수 있어 무시하고 진행
        }
      }));

      const classified = paths.map((p) => {
        const matchedCategories = CATEGORIES.filter((c) => categorySets[c]?.has(p));
        return {
          path: p,
          matchedCategories,
          isSiteLimit: matchedCategories.includes('site_limit'),
        };
      });

      return {
        paths,
        count: paths.length,
        classified,
      };
    }

    // ─────────────────────────────────────────────────
    case 'highlight_elements': {
      const { succeeded, failed } = await highlightElements(
        input.paths,
        input.color ?? 'yellow',
      );
      return {
        color: input.color ?? 'yellow',
        highlightedCount: succeeded.length,
        failedCount: failed.length,
        succeeded,
        failed,
      };
    }

    // ─────────────────────────────────────────────────
    case 'clear_highlights': {
      await clearHighlights();
      return { cleared: true };
    }

    // ─────────────────────────────────────────────────
    case 'test_floorstack_plan_units': {
      return await testFloorStackPlanUnits();
    }

    case 'recreate_buildings_with_floor_plans': {
      let requirements: BuildingRequirements;

      if (input.requirements && Array.isArray(input.requirements.buildings) && input.requirements.buildings.length > 0) {
        requirements = normalizeRequirements(input.requirements);
      } else {
        return {
          status: 'failed',
          message: 'requirements.buildings is required. Include floor_plans with rooms for each floor.',
        };
      }

      return await recreateBuildingsWithFloorPlans(requirements);
    }

    case 'place_building_masses': {
      const projectName: string = input.project_name ?? '';

      // Claude가 PDF에서 추출한 requirements를 직접 제공한 경우 → 그것을 사용
      // 그렇지 않으면 사전 내장 경주 데이터로 폴백
      let requirements: BuildingRequirements;

      if (input.requirements && Array.isArray(input.requirements.buildings) && input.requirements.buildings.length > 0) {
        requirements = normalizeRequirements(input.requirements);
      } else if (!projectName || projectName.includes('경주') || projectName.includes('복합문화')) {
        requirements = GYEONGJU_LIBRARY_REQUIREMENTS;
      } else {
        return {
          status: 'not_found',
          message: `"${projectName}" 프로젝트 데이터가 없습니다. PDF를 첨부하면 AI가 문서에서 직접 파라미터를 추출해 배치합니다.`,
        };
      }

      const result = await placeBuildingMasses(requirements);

      const summary = result.placed.map((m) => ({
        name: m.name,
        position: `(${m.centerX.toFixed(4)}, ${m.centerY.toFixed(4)})`,
        placementZ: `${m.placementZ.toFixed(2)}m`,
        dimensions: `${m.widthM}m × ${m.depthM}m`,
        height: `${m.heightM}m (지상 ${m.floors}층${m.basementFloors > 0 ? `, 지하 ${m.basementFloors}층` : ''})`,
        footprint: `${m.footprintArea}㎡`,
        totalFloorArea: `${m.totalFloorArea}㎡`,
        floors: m.floorDetails,
        layer: m.method === 'building_element' ? '✅ Buildings 레이어' : '⚠️ 임시 오버레이',
        debug: `meshZ=${m.debug.localMeshElevation === null ? 'null' : `${m.debug.localMeshElevation.toFixed(2)}m`}, baseZ=${m.debug.baseElevation.toFixed(2)}m, zSource=${m.debug.elevationSourcePath || 'none'}`,
      }));

      return {
        status: 'success',
        massesPlaced: result.placed.length,
        siteReference: result.siteReference,
        totalFootprint_m2: result.totalFootprint,
        actualCoverageRatio: `${(result.coverageRatio * 100).toFixed(1)}%`,
        maxAllowedCoverage: `${(requirements.site_limits.max_building_coverage_ratio * 100).toFixed(0)}%`,
        summary,
        warnings: result.warnings,
      };
    }

    // ─────────────────────────────────────────────────
    case 'clear_building_masses': {
      const { removedCount } = await clearAllMasses();
      return {
        status: 'success',
        removedCount,
        message: `${removedCount}개 매스 시각화를 제거했습니다.`,
      };
    }

    // ─────────────────────────────────────────────────
    case 'parse_building_requirements': {
      const projectName: string = input.project_name ?? '';
      const rawText: string = input.raw_text ?? '';

      // 업로드 문서 텍스트가 있으면 그것을 우선 파싱
      if (rawText && rawText.trim().length > 0) {
        const data = parseRequirementsFromText(rawText);
        return {
          status: 'success',
          source: 'uploaded_document_text',
          data,
          summary: {
            total_buildings: data.buildings.length,
            building_names: data.buildings.map((b) => b.name),
            total_floor_area_m2: data.project.total_floor_area_m2,
            site_area_m2: data.site_limits.total_site_area,
            max_allowed_coverage_pct: `${(data.site_limits.max_building_coverage_ratio * 100).toFixed(0)}%`,
            max_allowed_far_pct: `${(data.site_limits.max_floor_area_ratio * 100).toFixed(0)}%`,
            max_height_floors: data.site_limits.max_height_floors,
            parking_required: data.parking.required_parking_spots,
          },
        };
      }

      // 경주시 복합문화도서관 프로젝트 (사전 파싱 데이터)
      if (!projectName || projectName.includes('경주') || projectName.includes('복합문화')) {
        const data = GYEONGJU_LIBRARY_REQUIREMENTS;
        return {
          status: 'success',
          source: '경주시 복합문화도서관_Text 보고서.pdf',
          data,
          summary: {
            total_buildings: data.buildings.length,
            building_names: data.buildings.map((b) => b.name),
            total_footprint_m2: data.derived_metrics.total_footprint_area,
            actual_coverage_pct: `${(data.derived_metrics.actual_coverage_ratio * 100).toFixed(1)}%`,
            actual_far_pct: `${(data.derived_metrics.actual_floor_area_ratio * 100).toFixed(1)}%`,
            max_allowed_coverage_pct: `${(data.site_limits.max_building_coverage_ratio * 100).toFixed(0)}%`,
            parking_required: data.parking.required_parking_spots,
          },
        };
      }

      return {
        status: 'not_found',
        message: `"${projectName}" 프로젝트의 사전 파싱 데이터가 없습니다. 현재 지원: 경주시 복합문화도서관`,
      };
    }

    // ─────────────────────────────────────────────────
    case 'debug_site_bounds': {
      const CATEGORIES = ['site_limit', 'terrain', 'generic', 'building', 'road'];
      const results: Record<string, any> = {};

      for (const category of CATEGORIES) {
        try {
          const paths = await Forma.geometry.getPathsByCategory({ category });
          if (paths.length === 0) {
            results[category] = { found: false };
            continue;
          }

          const categoryResult: any = { found: true, paths, elements: [] };

          for (const path of paths.slice(0, 3)) {
            const elemInfo: any = { path };

            // footprint 시도
            try {
              const fp = await Forma.geometry.getFootprint({ path });
              elemInfo.footprint = fp;
              elemInfo.footprintType = typeof fp;

              // GeoJSON 구조 파악
              if (fp && typeof fp === 'object') {
                const fpAny = fp as any;
                if (fpAny.coordinates) {
                  const ring = fpAny.coordinates[0] as [number, number][];
                  if (ring?.length > 0) {
                    const xs = ring.map(([x]) => x);
                    const ys = ring.map(([, y]) => y);
                    elemInfo.footprintBbox = {
                      minX: Math.min(...xs).toFixed(2),
                      maxX: Math.max(...xs).toFixed(2),
                      minY: Math.min(...ys).toFixed(2),
                      maxY: Math.max(...ys).toFixed(2),
                      width: (Math.max(...xs) - Math.min(...xs)).toFixed(2),
                      height: (Math.max(...ys) - Math.min(...ys)).toFixed(2),
                      centerX: ((Math.min(...xs) + Math.max(...xs)) / 2).toFixed(2),
                      centerY: ((Math.min(...ys) + Math.max(...ys)) / 2).toFixed(2),
                    };
                    elemInfo.footprintStatus = 'OK - coordinates 직접 접근 성공';
                  }
                } else if (fpAny.geometry?.coordinates) {
                  elemInfo.footprintStatus = 'geometry.coordinates 구조 (수정 필요)';
                } else if (fpAny.polygon?.coordinates) {
                  elemInfo.footprintStatus = 'polygon.coordinates 구조 (수정 필요)';
                } else {
                  elemInfo.footprintStatus = `알 수 없는 구조: keys=${Object.keys(fpAny).join(',')}`;
                }
              }
            } catch (e) {
              elemInfo.footprintError = String(e);
            }

            // triangles로 bbox 폴백 시도
            try {
              const triangles = await Forma.geometry.getTriangles({ path });
              if (triangles.length > 0) {
                let minX = Infinity, maxX = -Infinity;
                let minY = Infinity, maxY = -Infinity;
                for (let i = 0; i < triangles.length; i += 3) {
                  const x = triangles[i];
                  const y = triangles[i + 1];
                  if (x < minX) minX = x;
                  if (x > maxX) maxX = x;
                  if (y < minY) minY = y;
                  if (y > maxY) maxY = y;
                }
                elemInfo.trianglesBbox = {
                  minX: minX.toFixed(2),
                  maxX: maxX.toFixed(2),
                  minY: minY.toFixed(2),
                  maxY: maxY.toFixed(2),
                  width: (maxX - minX).toFixed(2),
                  height: (maxY - minY).toFixed(2),
                  centerX: ((minX + maxX) / 2).toFixed(2),
                  centerY: ((minY + maxY) / 2).toFixed(2),
                  triangleCount: triangles.length / 9,
                };
                elemInfo.trianglesStatus = 'OK';
              }
            } catch (e) {
              elemInfo.trianglesError = String(e);
            }

            categoryResult.elements.push(elemInfo);
          }

          results[category] = categoryResult;
        } catch (e) {
          results[category] = { error: String(e) };
        }
      }

      return {
        diagnosis: results,
        recommendation: '위 결과를 보고 site_limit 또는 terrain 카테고리에서 footprintBbox 또는 trianglesBbox가 있는 항목의 centerX/Y 값을 확인하세요.',
      };
    }

    // ─────────────────────────────────────────────────
    default:
      throw new Error(`알 수 없는 Tool 이름: ${toolName}`);
  }
}
