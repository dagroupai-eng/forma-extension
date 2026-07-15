import type Anthropic from '@anthropic-ai/sdk';

/**
 * Forma API tools exposed to Claude.
 * Claude chooses the appropriate tool based on the user's request and returns a tool-use request.
 */
export const FORMA_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_elements_by_category',
    description: `Get element paths from the current Forma project by category.
Available categories:
- "building": building elements
- "terrain": terrain/site geometry
- "generic": generic proposal elements
- "road": road elements
Returns an array of element paths and a count.`,
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Element category to query.',
          enum: ['building', 'terrain', 'generic', 'road'],
        },
      },
      required: ['category'],
    },
  },

  {
    name: 'get_element_mesh_info',
    description: `Get 3D triangle mesh information for one Forma element.
Use this for surface-area and geometry analysis.
Returns { triangleCount, surfaceArea_m2 }.`,
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Element path returned by get_elements_by_category or get_current_selection.',
        },
      },
      required: ['path'],
    },
  },

  {
    name: 'get_multiple_elements_mesh_info',
    description: `Get mesh area information for multiple Forma elements in one call.
Use this when summing the total surface area of many elements.
Returns per-element { path, surfaceArea_m2 } and totalArea_m2.`,
    input_schema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of element paths.',
        },
      },
      required: ['paths'],
    },
  },

  {
    name: 'get_current_selection',
    description: `Get paths for the elements currently selected in the Forma 3D viewer.
Use this for questions such as "the selected element" or "what I selected now".
Returns selected paths, count, and category classification for each path.`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'highlight_elements',
    description: `Highlight the specified Forma elements in the 3D viewer.
Use this to visually confirm selected or analyzed elements.
Color options: "yellow" (default), "red", "green", "blue".`,
    input_schema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of element paths to highlight.',
        },
        color: {
          type: 'string',
          description: 'Highlight color.',
          enum: ['yellow', 'red', 'green', 'blue'],
        },
      },
      required: ['paths'],
    },
  },

  {
    name: 'clear_highlights',
    description: `Clear all highlight overlays in the Forma 3D viewer and restore the original display.`,
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
    name: 'test_minimal_floorplan_recreation',
    description: `Create a very small FloorStack recreation test using only the first available floor and up to three rooms from the provided requirements.
Use this to diagnose whether the project can save any PDF-derived room plan at all before trying the full building recreation.
It does not delete existing buildings.` ,
    input_schema: {
      type: 'object',
      properties: {
        requirements: {
          type: 'object',
          description: 'Building requirements containing at least one building with floor_plans or basement.floor_plans.',
        },
      },
      required: ['requirements'],
    },
  },

  {
    name: 'test_floor_plan_unit_compatibility',
    description: `Diagnose exactly where a PDF-derived FloorStack room plan starts failing for one floor, usually 1F.
It tests: single unit, core + other, incremental room counts, and the full floor.
Use this instead of repeatedly running full building recreation when detailed floor plans are being replaced by single-unit fallbacks.`,
    input_schema: {
      type: 'object',
      properties: {
        requirements: {
          type: 'object',
          description: 'Building requirements containing at least one building with floor_plans.',
        },
        floor_label: {
          type: 'string',
          description: 'Floor label to diagnose, for example 1F, 2F, or B1. Defaults to 1F.',
        },
      },
      required: ['requirements'],
    },
  },

  {
    name: 'test_generic_room_program_compatibility',
    description: `Create a tiny one-room FloorStack test and try several program values to find which program is accepted for a generic non-core room in the current Forma project.
Use this when basement/core rooms succeed but ordinary rooms still fail during full floor plan recreation.`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'test_circular_floorstack_mass',
    description: `Create a minimal one-floor solid circular FloorStack mass at the site center to test whether this Forma project accepts a simple circular polygon footprint.
This tool does not create an atrium void, room units, or floor plans. It only tests a saved FloorStack mass using progressively simpler polygons such as 24-gon and 16-gon.`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'test_ring_atrium_floorstack_mass',
    description: `Create a minimal one-floor ring atrium FloorStack mass to test whether this Forma project accepts a center void represented by sector units around an empty middle.
This tool does not use PDF parsing or detailed room plans. It only tests whether a simple ring-shaped atrium mass can be saved.`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'prepare_zone_import_package',
    description: `Validate a pasted levels/zones JSON schema and prepare a normalized Zone import package.
Use this when the user already has exact room polygons and wants to preserve them as the source of truth, even if FloorStack plans.units creation fails.
Return the normalized JSON, a count of levels/zones, consistent core information, and a mass-shell requirements summary that can still be used for mass generation.`,
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'string' },
        project_name: { type: 'string' },
        coordinate_system: { type: 'string' },
        levels: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              level: { type: 'number' },
              elevation_m: { type: 'number' },
              floor_name: { type: 'string' },
              zones: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    zone_id: { type: 'string' },
                    name: { type: 'string' },
                    polygon: {
                      type: 'array',
                      items: {
                        type: 'array',
                        items: { type: 'number' },
                        minItems: 2,
                        maxItems: 2,
                      },
                    },
                    area_m2: { type: 'number' },
                    use_type: { type: 'string' },
                    color: { type: 'string' },
                    height_m: { type: 'number' },
                    is_consistent_across_floors: { type: 'boolean' },
                  },
                  required: ['zone_id', 'name', 'polygon', 'area_m2'],
                },
              },
            },
            required: ['level', 'zones'],
          },
        },
      },
      required: ['levels'],
    },
  },

  {
    name: 'recreate_buildings_with_floor_plans',
    description: `Regenerate the selected/existing building mass as a new FloorStack and include PDF-derived floor_plans as FloorStack plans.units during creation.
Use this when the user wants room layout to be part of the actual generated mass, not a render.geojson or generic line overlay. The existing mass is used as the envelope/placement reference. Create and confirm the new FloorStack building first, then remove the previous mass.
If the selected existing mass is a Basic Building without gross-floor polygons, provide a polygon for every positive-area room on every floor. Those source-authored polygons become the geometry authority for the new FloorStack; do not estimate them from a total area.
It requires an existing mass from the mass generation workflow or one selected Buildings layer mass; if no target mass exists, report failure and ask the user to run mass generation first.

  Important:
  - Do not count render.geojson or generic proposal line overlays as successful room layout.
  - Build a new FloorStack with floors and plans in the same createFromFloors request.
  - Keep the existing mass until the new FloorStack is confirmed as a readable Buildings layer element.
  - Preserve the existing mass envelope and placement as closely as possible when regenerating.
  - Extract room layouts into requirements.buildings[].floor_plans and requirements.buildings[].basement.floor_plans.
  - If the PDF mentions an L-shape, ㄱ-shape, or an L-shaped arrangement, extract it into floor_layout_types for the relevant floors using L_SHAPE.
  - Preserve each PDF room as a separate FloorStack unit when possible.
- Each room must include name. Include area_m2 only when the PDF explicitly gives that room area. Add unit_type only when confident: CORE, CORRIDOR, LIVING_UNIT, PARKING.
- If room area_m2 is missing or marked inferred/estimated/AI 추론, omit that room from floor_plans instead of assigning an area.
- Report the new FloorStack path, plan unit count, any simplification, and whether the previous mass was removed after confirmation.`,
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
                    enum: ['AUTO', 'RECTANGLE', 'COURTYARD_U', 'COURTYARD_O', 'CIRCULAR', 'RING_ATRIUM'],
                  },
                  base_offset_m: {
                    type: 'number',
                    description: 'Podium 상부처럼 지면보다 높은 기준면에서 시작해야 하는 매스의 높이 오프셋(m).',
                  },
                  core_template: {
                    type: 'object',
                    description: '층별로 동일하게 유지할 코어 템플릿. width/depth/position을 지정하면 코어를 먼저 고정하고 나머지 실을 배치합니다.',
                    properties: {
                      width_m: { type: 'number' },
                      depth_m: { type: 'number' },
                      position: {
                        type: 'string',
                        enum: ['center', 'west', 'east', 'north', 'south', 'northwest', 'northeast', 'southwest', 'southeast'],
                      },
                      fixed_across_floors: { type: 'boolean' },
                      applicable_floors: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                      center_x_m: { type: 'number' },
                      center_y_m: { type: 'number' },
                      offset_x_m: { type: 'number' },
                      offset_y_m: { type: 'number' },
                      room_name: { type: 'string' },
                      function_id: { type: 'string' },
                    },
                    required: ['width_m', 'depth_m', 'position'],
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
                          polygon: {
                            type: 'array',
                            description: 'Authoritative room outline in local metres. Include every positive-area room on the floor when replacing a Basic Building without GFA polygons.',
                            items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
                          },
                          function_id: { type: 'string' },
                          unit_type: {
                            type: 'string',
                            enum: ['CORE', 'CORRIDOR', 'LIVING_UNIT', 'PARKING'],
                          },
                        },
                        required: ['name'],
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
                        core_template: {
                          type: 'object',
                          properties: {
                            width_m: { type: 'number' },
                            depth_m: { type: 'number' },
                            position: {
                              type: 'string',
                              enum: ['center', 'west', 'east', 'north', 'south', 'northwest', 'northeast', 'southwest', 'southeast'],
                            },
                            fixed_across_floors: { type: 'boolean' },
                            applicable_floors: {
                              type: 'array',
                              items: { type: 'string' },
                            },
                            center_x_m: { type: 'number' },
                            center_y_m: { type: 'number' },
                            offset_x_m: { type: 'number' },
                            offset_y_m: { type: 'number' },
                            room_name: { type: 'string' },
                            function_id: { type: 'string' },
                          },
                          required: ['width_m', 'depth_m', 'position'],
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
                              polygon: {
                                type: 'array',
                                description: 'Authoritative room outline in local metres. Include every positive-area room on the floor when replacing a Basic Building without GFA polygons.',
                                items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
                              },
                              function_id: { type: 'string' },
                              unit_type: {
                                type: 'string',
                                enum: ['CORE', 'CORRIDOR', 'LIVING_UNIT', 'PARKING'],
                              },
                            },
                            required: ['name'],
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
    description: `Create actual Forma Buildings layer mass elements from building planning requirements.
This tool must create real FloorStack/proposal building elements. Temporary render.geojson overlays are not counted as generated buildings and should not be treated as success.

Important:
- Use requirements extracted from the attached PDF when available.
- Preserve floor_breakdown, floor_heights_m, basement data, and mass_layout_type.
- If actual Buildings layer creation fails, report failure instead of claiming that a building was generated.
- Do not use this tool to regenerate embedded room plans; use recreate_buildings_with_floor_plans only after a real mass exists.`,
    input_schema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: 'Project name for placement. Optional when requirements are provided directly.',
        },
        target_path: {
          type: 'string',
          description: 'Optional Forma element path to use as the placement constraint. Pass the path returned by get_current_selection when the user selected a specific Constraint or Site Limit.',
        },
        floor_height_m: {
          type: 'number',
          description: 'Default floor height in meters. Defaults to 4.0m when floor-specific heights are absent.',
        },
        requirements: {
          type: 'object',
          description: `Building planning parameters extracted from a PDF or document.
When a PDF is attached, fill this object with the extracted planning values before placing masses.`,
          properties: {
            project_name: {
              type: 'string',
              description: 'Project name.',
            },
            location: {
              type: 'string',
              description: 'Project location.',
            },
            site_limits: {
              type: 'object',
              description: 'Site limit and planning constraints.',
              properties: {
                total_site_area: {
                  type: 'number',
                  description: 'Total site area in square meters.',
                },
                max_building_coverage_ratio: {
                  type: 'number',
                  description: 'Maximum building coverage ratio, for example 0.2 for 20%.',
                },
                max_floor_area_ratio: {
                  type: 'number',
                  description: 'Maximum floor area ratio, for example 1.0 for 100%.',
                },
                max_height_floors: {
                  type: 'number',
                  description: 'Maximum allowed above-grade floor count.',
                },
              },
            },
            buildings: {
              type: 'array',
              description: 'Array of building mass placement plans.',
              items: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Building name.',
                  },
                  target_floor_area: {
                    type: 'number',
                    description: 'Target total floor area in square meters.',
                  },
                  target_floors: {
                    type: 'number',
                    description: 'Planned above-grade floor count.',
                  },
                  footprint_area: {
                    type: 'number',
                    description: 'Ground-floor footprint area in square meters. If absent, it is derived from target_floor_area / target_floors.',
                  },
                  floor_breakdown: {
                    type: 'object',
                    description: 'Floor-by-floor area in square meters. Preserve explicit document values, for example {"1F":500,"2F":742,"3F":742}.',
                    additionalProperties: { type: 'number' },
                  },
                  floor_heights_m: {
                    type: 'object',
                    description: 'Floor-by-floor height in meters. Preserve explicit document values instead of averaging them.',
                    additionalProperties: { type: 'number' },
                  },
                  basement: {
                    type: 'object',
                    description: 'Basement information. Keep basement floors separate from above-grade floors.',
                    properties: {
                      floors: {
                        type: 'number',
                        description: '지하층 수',
                      },
                      area_m2: {
                        type: 'number',
                        description: 'Total basement area in square meters.',
                      },
                      use: {
                        type: 'string',
                        description: 'Primary basement use.',
                      },
                      floor_breakdown: {
                        type: 'object',
                        description: 'Basement floor-by-floor area in square meters, for example {"B4":990,"B3":990,"B2":990,"B1":990}.',
                        additionalProperties: { type: 'number' },
                      },
                      floor_heights_m: {
                        type: 'object',
                        description: 'Basement floor-by-floor height in meters, for example {"B4":8.0,"B3":8.0,"B2":8.0,"B1":3.5}.',
                        additionalProperties: { type: 'number' },
                      },
                    },
                  },
                  position_hint: {
                    type: 'string',
                    description: 'Preferred placement within the site. Infer from the document only when stated.',
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
                  description: 'Parking location hint, for example "underground", "rear", or "underground_or_rear".',
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
    description: `Remove all building masses and temporary mass artifacts created by this extension from the Forma proposal/viewer.`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  {
    name: 'parse_building_requirements',
    description: `Extract structured building planning requirements from a report, PDF text, or user-provided description.
Use this before procedural mass generation when the user has supplied unstructured planning text.

Returned data includes:
- site_limits: site constraints such as area, coverage ratio, FAR, and max floors
- buildings: individual building plans such as name, area, floors, footprint, and position
- parking: parking requirements
- derived_metrics: generated planning metrics

Usage:
- When the user attached a PDF/TXT, pass the extracted full text as raw_text.
- When querying by project name, pass project_name.`,
    input_schema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: 'Project name to look up. Optional; if omitted, the current/default project data may be used.',
        },
        raw_text: {
          type: 'string',
          description: 'Full text extracted from a PDF/TXT document. Requirements are parsed from this text when provided.',
        },
      },
    },
  },

  {
    name: 'debug_site_bounds',
    description: `Diagnose Site Limits and placement bounds in the current Forma project.
It queries site_limit, terrain, generic, building, and road categories and returns path, footprint coordinates, and triangle-based bounding boxes when available.

Use this when mass placement seems offset or falls back to the origin because site bounds were not found.`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];
