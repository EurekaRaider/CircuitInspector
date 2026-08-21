use crate::analyze::{analyze_design, uv_glue_layer_confidence};
use crate::archive::hash_input;
use crate::cache::CacheStore;
use crate::evidence::{render_evidence, write_html_report};
use crate::geometry::{
    bounds_to_board_edge, bounds_to_bounds, bounds_to_geometry, circle_to_board_edge,
    circle_to_bounds, circle_to_geometry,
};
use crate::model::{
    BoundsNm, CoverageLevel, Design, DesignSummary, FeatureGeometry, PointNm, Severity, Side,
    TestPoint, TestPointConfirmation, TestPointConfirmationMethod, Verdict,
    ViolationReviewDecision, ViolationReviewKind, ViolationReviewResolution,
};
use crate::parsers::import_design;
use crate::rules::{
    RuleApproval, RuleDefinition, RulePack, RulePackStatus, RuleReviewDecision, RuleReviewItem,
    RuleReviewResolution,
};
use crate::tile::{cached_tile, write_tile};
use crate::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
pub struct CoreRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct CoreResponse {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CoreResponseError>,
}

#[derive(Debug, Serialize)]
pub struct CoreResponseError {
    pub code: String,
    pub message: String,
}

pub fn run_stdio_server(reader: impl BufRead, mut writer: impl Write) -> CoreResult<()> {
    eprintln!("CircuitInspector core ready");
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<CoreRequest>(&line) {
            Ok(request) => request,
            Err(error) => {
                let response = CoreResponse {
                    id: 0,
                    result: None,
                    error: Some(CoreResponseError {
                        code: "INVALID_REQUEST".into(),
                        message: error.to_string(),
                    }),
                };
                writeln!(writer, "{}", serde_json::to_string(&response)?)?;
                writer.flush()?;
                continue;
            }
        };
        if request.method == "shutdown" {
            writeln!(
                writer,
                "{}",
                serde_json::to_string(&success(request.id, json!({ "ok": true })))?
            )?;
            writer.flush()?;
            return Ok(());
        }
        let response = match dispatch(&request.method, request.params) {
            Ok(value) => success(request.id, value),
            Err(error) => failure(request.id, &error),
        };
        writeln!(writer, "{}", serde_json::to_string(&response)?)?;
        writer.flush()?;
    }
    Ok(())
}

pub fn dispatch(method: &str, params: Value) -> CoreResult<Value> {
    match method {
        "ping" => {
            Ok(json!({ "name": "circuit-inspector-core", "version": env!("CARGO_PKG_VERSION") }))
        }
        "import_design" => import_request(params),
        "list_designs" => list_designs_request(params),
        "get_design_summary" => design_summary_request(params),
        "get_tile" => tile_request(params),
        "search_design" => search_request(params),
        "pick_design" => pick_request(params),
        "list_test_points" => list_test_points_request(params),
        "review_test_points" => review_test_points_request(params),
        "detect_kicad_cli" => crate::brd::detect_kicad_cli_request(params),
        "import_brd_test_points" => crate::brd::import_brd_test_points_request(params),
        "query_brd_test_points" => crate::brd::query_brd_test_points_request(params),
        "export_test_point_review" => crate::brd::export_test_point_review_request(params),
        "import_test_point_review" => crate::brd::import_test_point_review_request(params),
        "approve_test_point_selection" => crate::brd::approve_test_point_selection_request(params),
        "propose_test_point_alignment" => crate::brd::propose_test_point_alignment_request(params),
        "approve_test_point_alignment" => crate::brd::approve_test_point_alignment_request(params),
        "analyze_selected_test_points" => crate::brd::analyze_selected_test_points_request(params),
        "read_selected_test_point_analysis" => {
            crate::brd::read_selected_test_point_analysis_request(params)
        }
        "read_brd_test_point_catalog" => crate::brd::read_brd_test_point_catalog_request(params),
        "read_test_point_selection" => crate::brd::read_test_point_selection_request(params),
        "read_test_point_alignment" => crate::brd::read_test_point_alignment_request(params),
        "save_rule_pack" => save_rule_pack_request(params),
        "update_rule_pack" => update_rule_pack_request(params),
        "list_rule_packs" => list_rule_packs_request(params),
        "delete_rule_pack" => delete_rule_pack_request(params),
        "approve_rule_pack" => approve_rule_pack_request(params),
        "analyze_design" => analyze_request(params),
        "list_analyses" => list_analyses_request(params),
        "query_violations" => query_request(params),
        "review_violation" => review_violation_request(params),
        "render_evidence" => render_request(params),
        "read_analysis" => read_analysis_request(params),
        other => Err(CoreError::Unsupported(format!("unknown method {other}"))),
    }
}

fn import_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        path: PathBuf,
        cache_dir: PathBuf,
    }
    let params: Params = serde_json::from_value(params)?;
    let started = Instant::now();
    let cache = CacheStore::new(&params.cache_dir)?;
    let content_hash = hash_input(&params.path)?;
    let id = content_hash[..24.min(content_hash.len())].to_owned();
    let (design, cache_hit) = if cache.design_path(&id).exists() {
        let cached: crate::model::Design = cache.load_json(&cache.design_path(&id))?;
        if cached.schema_version == crate::model::Design::SCHEMA_VERSION {
            (cached, true)
        } else {
            let design = import_design(&params.path)?;
            cache.save_design(&design)?;
            (design, false)
        }
    } else {
        let design = import_design(&params.path)?;
        cache.save_design(&design)?;
        (design, false)
    };
    write_confirmed_test_points_report(&cache, &design)?;
    Ok(serde_json::to_value(DesignSummary::from_design(
        &design,
        cache_hit,
        started.elapsed().as_millis(),
    ))?)
}

fn list_designs_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(&params.cache_dir)?;
    let mut designs = Vec::new();
    let mut diagnostics = Vec::new();
    for entry in fs::read_dir(cache.root().join("designs"))? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let loaded: CoreResult<crate::model::Design> = cache.load_json(&path);
        match loaded {
            Ok(design) if design.schema_version == crate::model::Design::SCHEMA_VERSION => {
                let design: crate::model::Design = design;
                designs.push(json!({
                    "summary": DesignSummary::from_design(&design, true, 0),
                    "updated_at_unix_ms": modified_unix_ms(&path),
                }));
            }
            Ok(design) => diagnostics.push(json!({
                "code": "STALE_CACHED_DESIGN",
                "severity": "WARNING",
                "message": format!("cached design uses schema {}, current schema is {}; re-import the source design", design.schema_version, crate::model::Design::SCHEMA_VERSION),
                "source": path,
            })),
            Err(error) => diagnostics.push(json!({
                "code": "INVALID_CACHED_DESIGN",
                "severity": "WARNING",
                "message": error.to_string(),
                "source": path,
            })),
        }
    }
    designs.sort_by_key(|value| {
        std::cmp::Reverse(value["updated_at_unix_ms"].as_u64().unwrap_or_default())
    });
    Ok(json!({ "designs": designs, "diagnostics": diagnostics }))
}

fn design_summary_request(params: Value) -> CoreResult<Value> {
    let (cache, design_id) = design_cache_params(params)?;
    let design = cache.load_design(&design_id)?;
    Ok(serde_json::to_value(DesignSummary::from_design(
        &design, true, 0,
    ))?)
}

fn tile_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        design_id: String,
        cache_dir: PathBuf,
        viewport: BoundsNm,
        #[serde(default)]
        layer_ids: Vec<String>,
        #[serde(default)]
        lod: u8,
        #[serde(default = "default_max_features")]
        max_features: usize,
    }
    fn default_max_features() -> usize {
        500_000
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(&params.cache_dir)?;
    let max_features = params.max_features.clamp(1_000, 1_000_000);
    if !cache.design_path(&params.design_id).exists() {
        return Err(CoreError::NotFound(params.design_id));
    }
    let tile = if let Some(tile) = cached_tile(
        &cache,
        &params.design_id,
        params.viewport,
        &params.layer_ids,
        params.lod,
        max_features,
    )? {
        tile
    } else {
        let design = cache.load_design_shared(&params.design_id)?;
        write_tile(
            &cache,
            &design,
            params.viewport,
            &params.layer_ids,
            params.lod,
            max_features,
        )?
    };
    Ok(serde_json::to_value(tile)?)
}

fn search_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        design_id: String,
        cache_dir: PathBuf,
        query: String,
        #[serde(default = "default_limit")]
        limit: usize,
    }
    fn default_limit() -> usize {
        50
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(&params.cache_dir)?;
    let design = cache.load_design(&params.design_id)?;
    let query = params.query.to_ascii_lowercase();
    let mut results = Vec::new();
    for component in &design.components {
        if component.refdes.to_ascii_lowercase().contains(&query) {
            results.push(json!({
                "kind": "COMPONENT",
                "id": component.refdes,
                "label": component.refdes,
                "xNm": component.center.x,
                "yNm": component.center.y,
                "bounds": component.bounds,
            }));
        }
    }
    for net in &design.nets {
        if net.to_ascii_lowercase().contains(&query) {
            let feature = design
                .layers
                .iter()
                .flat_map(|layer| &layer.features)
                .find(|feature| feature.net_name.as_deref() == Some(net));
            results.push(json!({
                "kind": "NET",
                "id": net,
                "label": net,
                "xNm": feature.map(|feature| feature.geometry.bounds().center().x),
                "yNm": feature.map(|feature| feature.geometry.bounds().center().y),
            }));
        }
    }
    results.truncate(params.limit.min(200));
    Ok(json!({ "results": results }))
}

fn pick_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        design_id: String,
        cache_dir: PathBuf,
        point: crate::model::PointNm,
        #[serde(default)]
        layer_ids: Vec<String>,
        #[serde(default = "default_tolerance")]
        tolerance_nm: i64,
    }
    fn default_tolerance() -> i64 {
        250_000
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(&params.cache_dir)?;
    let design = cache.load_design(&params.design_id)?;
    let tolerance = params.tolerance_nm.clamp(1_000, 10_000_000);
    let layer_enabled = |layer_id: &str| {
        params.layer_ids.is_empty() || params.layer_ids.iter().any(|id| id == layer_id)
    };
    let side_enabled = |side: Side| {
        params.layer_ids.is_empty()
            || design
                .layers
                .iter()
                .any(|layer| layer.side == side && layer_enabled(&layer.id))
    };
    let mut results = Vec::new();
    for component in design
        .components
        .iter()
        .filter(|component| side_enabled(component.side))
    {
        let distance = component.bounds.distance_to_point(params.point);
        if distance <= tolerance {
            results.push(json!({
                "kind": "COMPONENT",
                "id": component.refdes,
                "label": component.refdes,
                "layer_id": null,
                "net_name": null,
                "component_ref": component.refdes,
                "x_nm": component.center.x,
                "y_nm": component.center.y,
                "distance_nm": distance,
            }));
        }
    }
    for point in design.test_points.iter().filter(|point| {
        let side = test_point_side(&design, point);
        matches!(side, Side::Top | Side::Bottom) && side_enabled(side)
    }) {
        let distance = ((point.center.distance_sq(params.point) as f64)
            .sqrt()
            .round() as i64)
            .saturating_sub(point.radius_nm.unwrap_or_default())
            .max(0);
        if distance <= tolerance {
            results.push(json!({
                "kind": "TEST_POINT",
                "id": point.id,
                "label": point.id,
                "layer_id": null,
                "net_name": point.net_name,
                "component_ref": point.component_ref,
                "x_nm": point.center.x,
                "y_nm": point.center.y,
                "distance_nm": distance,
            }));
        }
    }
    for layer in &design.layers {
        if !layer_enabled(&layer.id) {
            continue;
        }
        for feature in &layer.features {
            let distance = feature.geometry.bounds().distance_to_point(params.point);
            if distance <= tolerance {
                results.push(json!({
                    "kind": "FEATURE",
                    "id": feature.id,
                    "label": feature.id,
                    "layer_id": layer.id,
                    "net_name": feature.net_name,
                    "component_ref": feature.component_ref,
                    "x_nm": feature.geometry.bounds().center().x,
                    "y_nm": feature.geometry.bounds().center().y,
                    "distance_nm": distance,
                }));
            }
        }
    }
    results.sort_by_key(|value| {
        value
            .get("distance_nm")
            .and_then(Value::as_i64)
            .unwrap_or(i64::MAX)
    });
    results.truncate(20);
    Ok(json!({ "results": results }))
}

fn list_test_points_request(params: Value) -> CoreResult<Value> {
    let (cache, design_id) = design_cache_params(params)?;
    let design = cache.load_design(&design_id)?;
    let report = write_confirmed_test_points_report(&cache, &design)?;
    Ok(json!({
        "test_points": test_points_with_review_context(&design),
        "confirmed_test_points_report": report,
    }))
}

#[derive(Serialize)]
struct TestPointReviewCandidate<'a> {
    #[serde(flatten)]
    point: &'a TestPoint,
    side: Side,
    review_context: TestPointReviewContext<'a>,
}

#[derive(Serialize)]
struct TestPointReviewContext<'a> {
    metric: &'static str,
    board_edge: DistanceEvidence,
    nearest_test_point: Option<NearestGeometry<'a>>,
    nearest_tooling_hole: Option<NearestGeometry<'a>>,
    nearest_component: Option<NearestGeometry<'a>>,
    nearest_shield: Option<NearestGeometry<'a>>,
    nearest_uv_glue: Option<NearestGeometry<'a>>,
}

#[derive(Serialize)]
struct DistanceEvidence {
    distance_nm: Option<i64>,
    point: Option<PointNm>,
    confidence: CoverageLevel,
}

#[derive(Serialize)]
struct NearestGeometry<'a> {
    id: &'a str,
    distance_nm: Option<i64>,
    center: PointNm,
    confidence: CoverageLevel,
}

fn test_points_with_review_context(design: &Design) -> Vec<TestPointReviewCandidate<'_>> {
    design
        .test_points
        .iter()
        .map(|point| TestPointReviewCandidate {
            point,
            side: test_point_side(design, point),
            review_context: TestPointReviewContext {
                metric: "EDGE_TO_EDGE",
                board_edge: if let Some(radius) = point.radius_nm {
                    let measurement = circle_to_board_edge(design, point.center, radius);
                    DistanceEvidence {
                        distance_nm: Some(measurement.distance_nm),
                        point: Some(measurement.edge_point),
                        confidence: measurement.confidence,
                    }
                } else {
                    design.test_point_bounds(point).map_or(
                        DistanceEvidence {
                            distance_nm: None,
                            point: None,
                            confidence: CoverageLevel::Inferred,
                        },
                        |bounds| {
                            let measurement = bounds_to_board_edge(design, bounds);
                            DistanceEvidence {
                                distance_nm: Some(measurement.distance_nm),
                                point: Some(measurement.edge_point),
                                confidence: point.confidence.weakest(measurement.confidence),
                            }
                        },
                    )
                },
                nearest_test_point: nearest_test_point(design, point),
                nearest_tooling_hole: nearest_tooling_hole(design, point),
                nearest_component: nearest_component(design, point, false),
                nearest_shield: nearest_component(design, point, true),
                nearest_uv_glue: nearest_uv_glue(design, point),
            },
        })
        .collect()
}

fn nearest_test_point<'a>(design: &'a Design, point: &'a TestPoint) -> Option<NearestGeometry<'a>> {
    let side = test_point_side(design, point);
    design
        .test_points
        .iter()
        .filter(|other| other.id != point.id && same_side(side, test_point_side(design, other)))
        .map(|other| {
            let center_distance_nm = point_distance(point.center, other.center);
            let distance_nm = test_point_distance(design, point, other);
            (
                other,
                distance_nm.unwrap_or(center_distance_nm),
                distance_nm,
            )
        })
        .min_by(|(left, left_distance, _), (right, right_distance, _)| {
            left_distance
                .cmp(right_distance)
                .then_with(|| left.id.cmp(&right.id))
        })
        .map(|(other, _, distance_nm)| NearestGeometry {
            id: &other.id,
            distance_nm,
            center: other.center,
            confidence: point.confidence.weakest(other.confidence),
        })
}

fn nearest_tooling_hole<'a>(
    design: &'a Design,
    point: &'a TestPoint,
) -> Option<NearestGeometry<'a>> {
    design
        .tooling_hole_candidates()
        .into_iter()
        .filter_map(|(_, feature, confidence)| {
            let FeatureGeometry::Drill {
                center,
                diameter_nm,
                ..
            } = feature.geometry
            else {
                return None;
            };
            let center_distance_nm = point_distance(point.center, center);
            let distance_nm = if let Some(point_radius) = point.radius_nm {
                Some(
                    center_distance_nm
                        .saturating_sub(point_radius)
                        .saturating_sub(diameter_nm / 2)
                        .max(0),
                )
            } else {
                design
                    .test_point_bounds(point)
                    .map(|bounds| circle_to_bounds(center, diameter_nm / 2, bounds).distance_nm)
            };
            Some((
                feature,
                center,
                distance_nm.unwrap_or(center_distance_nm),
                distance_nm,
                confidence,
            ))
        })
        .min_by(
            |(left, _, left_distance, _, _), (right, _, right_distance, _, _)| {
                left_distance
                    .cmp(right_distance)
                    .then_with(|| left.id.cmp(&right.id))
            },
        )
        .map(
            |(feature, center, _, distance_nm, confidence)| NearestGeometry {
                id: &feature.id,
                distance_nm,
                center,
                confidence,
            },
        )
}

fn nearest_component<'a>(
    design: &'a Design,
    point: &'a TestPoint,
    shield_only: bool,
) -> Option<NearestGeometry<'a>> {
    let side = test_point_side(design, point);
    design
        .components
        .iter()
        .filter(|component| same_side(side, component.side))
        .filter(|component| !component.is_test_point_marker())
        .filter(|component| component.is_shield_candidate() == shield_only)
        .map(|component| {
            let center_distance_nm = component.bounds.distance_to_point(point.center);
            let distance_nm = if let Some(radius) = point.radius_nm {
                Some(circle_to_bounds(point.center, radius, component.bounds).distance_nm)
            } else {
                design
                    .test_point_bounds(point)
                    .map(|bounds| bounds_to_bounds(bounds, component.bounds).distance_nm)
            };
            (
                component,
                distance_nm.unwrap_or(center_distance_nm),
                distance_nm,
            )
        })
        .min_by(|(left, left_distance, _), (right, right_distance, _)| {
            left_distance
                .cmp(right_distance)
                .then_with(|| left.refdes.cmp(&right.refdes))
        })
        .map(|(component, _, distance_nm)| NearestGeometry {
            id: &component.refdes,
            distance_nm,
            center: component.center,
            confidence: if shield_only {
                CoverageLevel::Inferred
            } else {
                point.confidence.weakest(component.confidence)
            },
        })
}

fn nearest_uv_glue<'a>(design: &'a Design, point: &'a TestPoint) -> Option<NearestGeometry<'a>> {
    let side = test_point_side(design, point);
    design
        .layers
        .iter()
        .filter(|layer| same_side(side, layer.side))
        .filter_map(|layer| uv_glue_layer_confidence(layer).map(|confidence| (layer, confidence)))
        .flat_map(|(layer, confidence)| {
            layer
                .features
                .iter()
                .filter(|feature| feature.polarity == crate::model::Polarity::Dark)
                .map(move |feature| (feature, confidence))
        })
        .map(|(feature, confidence)| {
            let center = feature.geometry.bounds().center();
            let distance_nm = point.radius_nm.map_or_else(
                || {
                    design
                        .test_point_bounds(point)
                        .map(|bounds| bounds_to_geometry(bounds, &feature.geometry).distance_nm)
                },
                |radius| {
                    Some(circle_to_geometry(point.center, radius, &feature.geometry).distance_nm)
                },
            );
            (
                feature,
                center,
                distance_nm.unwrap_or_else(|| point_distance(point.center, center)),
                distance_nm,
                point.confidence.weakest(confidence),
            )
        })
        .min_by(
            |(left, _, left_distance, _, _), (right, _, right_distance, _, _)| {
                left_distance
                    .cmp(right_distance)
                    .then_with(|| left.id.cmp(&right.id))
            },
        )
        .map(
            |(feature, center, _, distance_nm, confidence)| NearestGeometry {
                id: &feature.id,
                distance_nm,
                center,
                confidence,
            },
        )
}

fn test_point_distance(design: &Design, left: &TestPoint, right: &TestPoint) -> Option<i64> {
    match (left.radius_nm, right.radius_nm) {
        (Some(left_radius), Some(right_radius)) => Some(
            point_distance(left.center, right.center)
                .saturating_sub(left_radius)
                .saturating_sub(right_radius)
                .max(0),
        ),
        (Some(left_radius), None) => design.test_point_bounds(right).map(|right_bounds| {
            circle_to_bounds(left.center, left_radius, right_bounds).distance_nm
        }),
        (None, Some(right_radius)) => design.test_point_bounds(left).map(|left_bounds| {
            circle_to_bounds(right.center, right_radius, left_bounds).distance_nm
        }),
        (None, None) => design
            .test_point_bounds(left)
            .zip(design.test_point_bounds(right))
            .map(|(left_bounds, right_bounds)| {
                bounds_to_bounds(left_bounds, right_bounds).distance_nm
            }),
    }
}

fn test_point_side(design: &Design, point: &TestPoint) -> Side {
    point
        .layer_id
        .as_deref()
        .and_then(|layer_id| design.layers.iter().find(|layer| layer.id == layer_id))
        .map(|layer| layer.side)
        .or_else(|| {
            point.component_ref.as_deref().and_then(|reference| {
                design
                    .components
                    .iter()
                    .find(|component| component.refdes == reference)
                    .map(|component| component.side)
            })
        })
        .unwrap_or(Side::Na)
}

fn same_side(left: Side, right: Side) -> bool {
    matches!(left, Side::Top | Side::Bottom) && left == right
}

fn point_distance(left: PointNm, right: PointNm) -> i64 {
    (left.distance_sq(right) as f64).sqrt().round() as i64
}

fn review_test_points_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Addition {
        source_kind: String,
        source_id: String,
    }
    #[derive(Deserialize)]
    struct Params {
        design_id: String,
        cache_dir: PathBuf,
        reviewed_by: String,
        #[serde(default)]
        confirm_ids: Vec<String>,
        #[serde(default)]
        reject_ids: Vec<String>,
        #[serde(default)]
        additions: Vec<Addition>,
    }
    let params: Params = serde_json::from_value(params)?;
    if params.reviewed_by.trim().is_empty() {
        return Err(CoreError::Parse(
            "reviewed_by is required for test-point review".into(),
        ));
    }
    let cache = CacheStore::new(&params.cache_dir)?;
    let mut design = cache.load_design(&params.design_id)?;
    let known = design
        .test_points
        .iter()
        .map(|point| point.id.as_str())
        .collect::<HashSet<_>>();
    if params
        .confirm_ids
        .iter()
        .chain(&params.reject_ids)
        .any(|id| !known.contains(id.as_str()))
    {
        return Err(CoreError::Parse(
            "test-point review contains an unknown candidate id".into(),
        ));
    }
    if params
        .confirm_ids
        .iter()
        .any(|id| params.reject_ids.iter().any(|rejected| rejected == id))
    {
        return Err(CoreError::Parse(
            "a test-point candidate cannot be confirmed and rejected together".into(),
        ));
    }
    let reviewed_by = params.reviewed_by.trim().to_owned();
    let confirmed_at = unix_timestamp();
    design
        .test_points
        .retain(|point| !params.reject_ids.iter().any(|id| id == &point.id));
    for point in &mut design.test_points {
        if params.confirm_ids.iter().any(|id| id == &point.id) {
            point.confidence = CoverageLevel::Explicit;
            point.confirmation = Some(TestPointConfirmation {
                method: TestPointConfirmationMethod::HumanReview,
                confirmed_by: reviewed_by.clone(),
                confirmed_at: confirmed_at.clone(),
            });
        }
    }
    for addition in &params.additions {
        let candidate = if addition.source_kind.eq_ignore_ascii_case("COMPONENT") {
            design
                .components
                .iter()
                .find(|component| component.refdes == addition.source_id)
                .map(|component| TestPoint {
                    id: manual_test_point_id(&addition.source_kind, &addition.source_id),
                    center: component.center,
                    radius_nm: None,
                    net_name: None,
                    component_ref: Some(component.refdes.clone()),
                    confidence: CoverageLevel::Explicit,
                    layer_id: None,
                    source: format!("manual:{}", addition.source_id),
                    geometry_source: None,
                    confirmation: Some(TestPointConfirmation {
                        method: TestPointConfirmationMethod::ManualAddition,
                        confirmed_by: reviewed_by.clone(),
                        confirmed_at: confirmed_at.clone(),
                    }),
                })
        } else if addition.source_kind.eq_ignore_ascii_case("FEATURE") {
            design
                .layers
                .iter()
                .flat_map(|layer| &layer.features)
                .find(|feature| feature.id == addition.source_id)
                .map(|feature| {
                    let bounds = feature.geometry.bounds();
                    let radius_nm = match feature.geometry {
                        FeatureGeometry::Pad {
                            size_x_nm,
                            size_y_nm,
                            ..
                        } => Some(size_x_nm.min(size_y_nm).max(2) / 2),
                        _ => None,
                    };
                    TestPoint {
                        id: manual_test_point_id(&addition.source_kind, &addition.source_id),
                        center: bounds.center(),
                        radius_nm,
                        net_name: feature.net_name.clone(),
                        component_ref: feature.component_ref.clone(),
                        confidence: CoverageLevel::Explicit,
                        layer_id: Some(feature.layer_id.clone()),
                        source: format!("manual:{}", addition.source_id),
                        geometry_source: radius_nm.map(|_| feature.source.clone()),
                        confirmation: Some(TestPointConfirmation {
                            method: TestPointConfirmationMethod::ManualAddition,
                            confirmed_by: reviewed_by.clone(),
                            confirmed_at: confirmed_at.clone(),
                        }),
                    }
                })
        } else {
            return Err(CoreError::Parse(format!(
                "unsupported test-point source kind {}",
                addition.source_kind
            )));
        };
        let candidate = candidate.ok_or_else(|| {
            CoreError::Parse(format!(
                "test-point source {} was not found",
                addition.source_id
            ))
        })?;
        if !design
            .test_points
            .iter()
            .any(|point| point.id == candidate.id)
        {
            design.test_points.push(candidate);
        }
    }
    design.coverage.test_points = if design.test_points.is_empty() {
        CoverageLevel::Missing
    } else if design
        .test_points
        .iter()
        .all(|point| point.confidence == CoverageLevel::Explicit)
    {
        CoverageLevel::Explicit
    } else {
        CoverageLevel::Inferred
    };
    design.diagnostics.push(crate::parsers::diagnostic(
        "TEST_POINT_REVIEW_APPLIED",
        Severity::Info,
        format!(
            "{} confirmed {}, rejected {}, and added {} test-point candidates",
            reviewed_by,
            params.confirm_ids.len(),
            params.reject_ids.len(),
            params.additions.len()
        ),
        None,
    ));
    cache.save_design(&design)?;
    let report = write_confirmed_test_points_report(&cache, &design)?;
    Ok(json!({
        "summary": DesignSummary::from_design(&design, true, 0),
        "test_points": test_points_with_review_context(&design),
        "confirmed_test_points_report": report,
    }))
}

#[derive(Serialize)]
struct ConfirmedTestPointsReport {
    report_path: String,
    confirmed_count: usize,
}

fn write_confirmed_test_points_report(
    cache: &CacheStore,
    design: &Design,
) -> CoreResult<ConfirmedTestPointsReport> {
    let mut points = design
        .test_points
        .iter()
        .filter(|point| point.confidence == CoverageLevel::Explicit)
        .collect::<Vec<_>>();
    points.sort_by(|left, right| left.id.cmp(&right.id));

    let report_id = format!("confirmed-test-points-{}", design.id);
    let directory = cache.evidence_dir(&report_id);
    fs::create_dir_all(&directory)?;
    let report_path = directory.join("confirmed-test-points.md");
    let temporary = directory.join(".confirmed-test-points.md.tmp");
    let generated_at = unix_timestamp();
    let mut markdown = String::new();
    writeln!(markdown, "---").expect("writing to a string cannot fail");
    writeln!(markdown, "schema_version: 1").expect("writing to a string cannot fail");
    writeln!(markdown, "kind: CONFIRMED_TEST_POINT_CATALOG")
        .expect("writing to a string cannot fail");
    writeln!(markdown, "design_id: {}", yaml_string(&design.id)?)
        .expect("writing to a string cannot fail");
    writeln!(
        markdown,
        "design_content_hash: {}",
        yaml_string(&design.content_hash)?
    )
    .expect("writing to a string cannot fail");
    writeln!(
        markdown,
        "source_path: {}",
        yaml_string(&design.source_path)?
    )
    .expect("writing to a string cannot fail");
    writeln!(markdown, "generated_at: {}", yaml_string(&generated_at)?)
        .expect("writing to a string cannot fail");
    writeln!(markdown, "confirmed_test_point_count: {}", points.len())
        .expect("writing to a string cannot fail");
    writeln!(markdown, "---\n").expect("writing to a string cannot fail");
    writeln!(
        markdown,
        "# 已确认测试点清单 / Confirmed Test-Point Catalog\n"
    )
    .expect("writing to a string cannot fail");
    writeln!(
        markdown,
        "> 本文件只确认测试点身份，供后续建议测试方案和 Layout DFT 追溯使用；它不表示尺寸、间距、夹具可达性或生产测试已经 PASS。\n"
    )
    .expect("writing to a string cannot fail");
    writeln!(markdown, "- Design ID: `{}`", escape_markdown(&design.id))
        .expect("writing to a string cannot fail");
    writeln!(
        markdown,
        "- Design SHA-256: `{}`",
        escape_markdown(&design.content_hash)
    )
    .expect("writing to a string cannot fail");
    writeln!(
        markdown,
        "- 已确认测试点 / Confirmed test points: **{}**",
        points.len()
    )
    .expect("writing to a string cannot fail");
    writeln!(
        markdown,
        "- 待人工复核候选 / Pending inferred candidates: **{}**\n",
        design
            .test_points
            .iter()
            .filter(|point| point.confidence == CoverageLevel::Inferred)
            .count()
    )
    .expect("writing to a string cannot fail");

    if points.is_empty() {
        writeln!(markdown, "当前设计没有已确认测试点。").expect("writing to a string cannot fail");
    } else {
        writeln!(markdown, "| ID | 器件位号 | NET | 层 | 面 | X (mm) | Y (mm) | 直径 (mm) | 确认方式 | 确认人 | 确认时间 | 来源 |")
            .expect("writing to a string cannot fail");
        writeln!(
            markdown,
            "|---|---|---|---|---|---:|---:|---:|---|---|---|---|"
        )
        .expect("writing to a string cannot fail");
        for point in points {
            let (method, confirmed_by, confirmed_at) = match point.confirmation.as_ref() {
                Some(confirmation) => (
                    match confirmation.method {
                        TestPointConfirmationMethod::HumanReview => "HUMAN_REVIEW",
                        TestPointConfirmationMethod::ManualAddition => "MANUAL_ADDITION",
                    },
                    confirmation.confirmed_by.as_str(),
                    confirmation.confirmed_at.as_str(),
                ),
                None => ("PROGRAM_OR_SOURCE_CONFIRMED", "-", "-"),
            };
            let side = side_label(test_point_side(design, point));
            let diameter = point
                .radius_nm
                .map(|radius| format!("{:.6}", radius.saturating_mul(2) as f64 / 1_000_000.0))
                .unwrap_or_else(|| "N/A".into());
            let source = point.geometry_source.as_deref().unwrap_or(&point.source);
            writeln!(
                markdown,
                "| {} | {} | {} | {} | {} | {:.6} | {:.6} | {} | {} | {} | {} | {} |",
                escape_markdown(&point.id),
                escape_markdown(point.component_ref.as_deref().unwrap_or("-")),
                escape_markdown(point.net_name.as_deref().unwrap_or("-")),
                escape_markdown(point.layer_id.as_deref().unwrap_or("-")),
                side,
                point.center.x as f64 / 1_000_000.0,
                point.center.y as f64 / 1_000_000.0,
                diameter,
                method,
                escape_markdown(confirmed_by),
                escape_markdown(confirmed_at),
                escape_markdown(source),
            )
            .expect("writing to a string cannot fail");
        }
    }
    writeln!(
        markdown,
        "\n## 后续使用边界\n\n- 建议测试方案可以引用本清单中的 NET、坐标、层面和来源。\n- 测试点身份明确不等于规则合格；尺寸、间距等结论必须由批准规则包重新分析。\n- 探针可达性、夹具结构、接触可靠性、测试机资源和量产放行仍需 `MANUAL_FACTORY_CONFIRMATION`。"
    )
    .expect("writing to a string cannot fail");
    fs::write(&temporary, markdown)?;
    fs::rename(&temporary, &report_path)?;
    Ok(ConfirmedTestPointsReport {
        report_path: report_path.to_string_lossy().into_owned(),
        confirmed_count: design
            .test_points
            .iter()
            .filter(|point| point.confidence == CoverageLevel::Explicit)
            .count(),
    })
}

fn yaml_string(value: &str) -> CoreResult<String> {
    Ok(serde_json::to_string(value)?)
}

fn escape_markdown(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace('\r', " ")
        .replace('\n', " ")
}

fn side_label(side: Side) -> &'static str {
    match side {
        Side::Top => "TOP",
        Side::Bottom => "BOTTOM",
        Side::Inner => "INNER",
        Side::Na => "NA",
    }
}

fn unix_timestamp() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("unix:{timestamp}")
}

fn manual_test_point_id(kind: &str, id: &str) -> String {
    let digest = Sha256::digest(format!("{kind}:{id}").as_bytes());
    format!("manual-tp-{}", &hex::encode(digest)[..16])
}

fn save_rule_pack_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        rule_pack: RulePack,
    }
    let params: Params = serde_json::from_value(params)?;
    if params.rule_pack.status != RulePackStatus::Draft || params.rule_pack.approval.is_some() {
        return Err(CoreError::Rule(
            "newly extracted rule packs must be DRAFT without approval".into(),
        ));
    }
    let cache = CacheStore::new(&params.cache_dir)?;
    let path = rule_path(&cache, &params.rule_pack.id);
    if path.exists() {
        return Err(CoreError::Rule(format!(
            "rule pack {} already exists",
            params.rule_pack.id
        )));
    }
    cache.save_json(&path, &params.rule_pack)?;
    Ok(json!({ "id": params.rule_pack.id, "path": path }))
}

fn update_rule_pack_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct ReviewResolutionUpdate {
        review_item_id: String,
        decision: RuleReviewDecision,
        #[serde(default)]
        note: String,
        #[serde(default)]
        rule_id: Option<String>,
    }

    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        rule_pack_id: String,
        rules: Vec<RuleDefinition>,
        #[serde(default)]
        acknowledged_review_item_ids: Vec<String>,
        #[serde(default)]
        review_item_resolutions: Vec<ReviewResolutionUpdate>,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(&params.cache_dir)?;
    let path = resolve_rule_path(&cache, &params.rule_pack_id)?;
    let mut pack: RulePack = cache.load_json(&path)?;
    prepare_legacy_draft(&mut pack);
    if pack.status != RulePackStatus::Draft || pack.approval.is_some() {
        return Err(CoreError::Rule(format!(
            "rule pack {} is immutable because it is not an unapproved DRAFT",
            pack.id
        )));
    }
    let submitted_ids = params
        .rules
        .iter()
        .map(|rule| rule.id.as_str())
        .collect::<HashSet<_>>();
    if submitted_ids.len() != params.rules.len() {
        return Err(CoreError::Rule(
            "draft contains duplicate rule identifiers".into(),
        ));
    }
    for submitted in &params.rules {
        let original = pack
            .rules
            .iter()
            .find(|rule| rule.id == submitted.id)
            .ok_or_else(|| CoreError::Rule(format!("unknown draft rule {}", submitted.id)))?;
        if submitted.title != original.title || submitted.citation != original.citation {
            return Err(CoreError::Rule(format!(
                "rule {} cannot change its extracted title or citation",
                submitted.id
            )));
        }
    }
    let acknowledged = params
        .acknowledged_review_item_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if acknowledged
        .iter()
        .any(|id| !pack.review_items.iter().any(|item| item.id == *id))
    {
        return Err(CoreError::Rule(
            "draft contains an unknown review item acknowledgement".into(),
        ));
    }
    let resolution_ids = params
        .review_item_resolutions
        .iter()
        .map(|update| update.review_item_id.as_str())
        .collect::<HashSet<_>>();
    if resolution_ids.len() != params.review_item_resolutions.len()
        || resolution_ids
            .iter()
            .any(|id| !pack.review_items.iter().any(|item| item.id == *id))
    {
        return Err(CoreError::Rule(
            "draft contains duplicate or unknown review item resolutions".into(),
        ));
    }
    for update in &params.review_item_resolutions {
        if let Some(rule_id) = update.rule_id.as_deref()
            && (!matches!(update.decision, RuleReviewDecision::ModifyRule)
                || !submitted_ids.contains(rule_id))
        {
            return Err(CoreError::Rule(format!(
                "review item {} references an invalid modified rule",
                update.review_item_id
            )));
        }
    }
    for item in &mut pack.review_items {
        item.resolution = params
            .review_item_resolutions
            .iter()
            .find(|update| update.review_item_id == item.id)
            .map(|update| RuleReviewResolution {
                decision: update.decision.clone(),
                note: update.note.clone(),
                rule_id: update.rule_id.clone(),
            })
            .or_else(|| {
                acknowledged
                    .contains(item.id.as_str())
                    .then_some(RuleReviewResolution {
                        decision: RuleReviewDecision::AcceptSuggestion,
                        note: String::new(),
                        rule_id: None,
                    })
            });
        item.acknowledged = item.resolution.is_some();
    }
    pack.rules = params.rules;
    cache.save_json(&path, &pack)?;
    Ok(serde_json::to_value(pack)?)
}

fn list_rule_packs_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(&params.cache_dir)?;
    let mut packs = Vec::<RulePack>::new();
    for entry in fs::read_dir(cache.root().join("rules"))? {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) == Some("json") {
            match cache.load_json(&path) {
                Ok(mut pack) => {
                    prepare_legacy_draft(&mut pack);
                    packs.push(pack);
                }
                Err(error) => eprintln!("Skipping invalid rule pack {}: {error}", path.display()),
            }
        }
    }
    packs.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then(left.version.cmp(&right.version))
    });
    Ok(json!({ "rule_packs": packs }))
}

fn delete_rule_pack_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        rule_pack_id: String,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(&params.cache_dir)?;
    let path = resolve_rule_path(&cache, &params.rule_pack_id)?;
    let pack: RulePack = cache.load_json(&path)?;
    if pack.id != params.rule_pack_id {
        return Err(CoreError::Rule(
            "rule pack identifier does not match the cached artifact".into(),
        ));
    }
    fs::remove_file(path)?;
    Ok(json!({ "id": pack.id, "deleted": true }))
}

fn approve_rule_pack_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        rule_pack_id: String,
        approved_by: String,
    }
    let params: Params = serde_json::from_value(params)?;
    if params.approved_by.trim().is_empty() {
        return Err(CoreError::Rule("approved_by is required".into()));
    }
    let cache = CacheStore::new(&params.cache_dir)?;
    let path = resolve_rule_path(&cache, &params.rule_pack_id)?;
    let mut pack: RulePack = cache.load_json(&path)?;
    prepare_legacy_draft(&mut pack);
    if pack.status != RulePackStatus::Draft {
        return Err(CoreError::Rule(format!(
            "rule pack {} is not DRAFT",
            pack.id
        )));
    }
    pack.validate_for_approval()?;
    let content = serde_json::to_vec(&pack.rules)?;
    let hash = hex::encode(Sha256::digest(content));
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    pack.status = RulePackStatus::Approved;
    pack.approval = Some(RuleApproval {
        approved_by: params.approved_by,
        approved_at: format!("unix:{timestamp}"),
        content_hash: hash,
    });
    cache.save_json(&path, &pack)?;
    Ok(serde_json::to_value(pack)?)
}

fn prepare_legacy_draft(pack: &mut RulePack) {
    if pack.status != RulePackStatus::Draft
        || pack.version != "0.1.0-draft"
        || !pack.review_items.is_empty()
    {
        return;
    }
    let mut review_items = Vec::new();
    for rule in &mut pack.rules {
        rule.severity = None;
        if let Some(citation) = rule.citation.clone() {
            review_items.push(RuleReviewItem {
                id: format!("legacy-severity-{}", rule.id),
                code: "LEGACY_AUTO_SEVERITY".into(),
                message: "This severity came from the legacy automatic default and must be confirmed again.".into(),
                acknowledged: false,
                resolution: None,
                citation,
            });
        }
    }
    pack.review_items = review_items;
}

fn analyze_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        design_id: String,
        rule_pack_id: String,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(&params.cache_dir)?;
    let design = cache.load_design(&params.design_id)?;
    let rule_pack: RulePack = cache.load_json(&resolve_rule_path(&cache, &params.rule_pack_id)?)?;
    let analysis = analyze_design(&design, &rule_pack)?;
    cache.save_analysis(&analysis)?;
    let report_path = write_html_report(&cache, &design, &analysis)?;
    let mut value = serde_json::to_value(&analysis)?;
    if let Value::Object(object) = &mut value {
        object.insert(
            "report_path".into(),
            Value::String(report_path.display().to_string()),
        );
    }
    Ok(value)
}

fn list_analyses_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(&params.cache_dir)?;
    let mut analyses = Vec::new();
    let mut diagnostics = Vec::new();
    for entry in fs::read_dir(cache.root().join("analyses"))? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        match cache.load_json(&path) {
            Ok(analysis) => {
                let analysis: crate::model::AnalysisSummary = analysis;
                analyses.push(json!({
                    "summary": analysis,
                    "updated_at_unix_ms": modified_unix_ms(&path),
                }));
            }
            Err(error) => diagnostics.push(json!({
                "code": "INVALID_CACHED_ANALYSIS",
                "severity": "WARNING",
                "message": error.to_string(),
                "source": path,
            })),
        }
    }
    analyses.sort_by_key(|value| {
        std::cmp::Reverse(value["updated_at_unix_ms"].as_u64().unwrap_or_default())
    });
    Ok(json!({ "analyses": analyses, "diagnostics": diagnostics }))
}

fn query_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        analysis_id: String,
        net_name: Option<String>,
        component_ref: Option<String>,
        rule_id: Option<String>,
        verdict: Option<Verdict>,
        #[serde(default)]
        offset: usize,
        #[serde(default = "default_limit")]
        limit: usize,
    }
    fn default_limit() -> usize {
        100
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(&params.cache_dir)?;
    let analysis = cache.load_analysis(&params.analysis_id)?;
    let filtered = analysis
        .violations
        .iter()
        .filter(|violation| {
            params
                .net_name
                .as_ref()
                .is_none_or(|value| violation.net_names.iter().any(|net| net.contains(value)))
        })
        .filter(|violation| {
            params.component_ref.as_ref().is_none_or(|value| {
                violation
                    .component_refs
                    .iter()
                    .any(|reference| reference.contains(value))
            })
        })
        .filter(|violation| {
            params
                .rule_id
                .as_ref()
                .is_none_or(|value| &violation.rule_id == value)
        })
        .filter(|violation| {
            params
                .verdict
                .is_none_or(|value| violation.verdict == value)
        })
        .skip(params.offset)
        .take(params.limit.clamp(1, 1000))
        .cloned()
        .collect::<Vec<_>>();
    Ok(
        json!({ "analysis_id": analysis.id, "total": analysis.violations.len(), "offset": params.offset, "violations": filtered }),
    )
}

fn review_violation_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        analysis_id: String,
        violation_id: String,
        decision: ViolationReviewDecision,
        comment: String,
        reviewed_by: String,
    }
    let params: Params = serde_json::from_value(params)?;
    let comment = params.comment.trim();
    let reviewed_by = params.reviewed_by.trim();
    if comment.len() > 2_000
        || matches!(
            params.decision,
            ViolationReviewDecision::Ignore | ViolationReviewDecision::Fail
        ) && comment.is_empty()
    {
        return Err(CoreError::Parse(
            "IGNORE and FAIL review dispositions require a comment of 1 to 2000 characters".into(),
        ));
    }
    if reviewed_by.is_empty() || reviewed_by.len() > 200 {
        return Err(CoreError::Parse(
            "violation reviewer must contain 1 to 200 characters".into(),
        ));
    }
    let cache = CacheStore::new(&params.cache_dir)?;
    let mut analysis = cache.load_analysis(&params.analysis_id)?;
    let violation = analysis
        .violations
        .iter_mut()
        .find(|violation| violation.id == params.violation_id)
        .ok_or_else(|| CoreError::NotFound(params.violation_id.clone()))?;
    if violation.verdict != Verdict::Review {
        return Err(CoreError::Parse(
            "only REVIEW findings can receive a review disposition".into(),
        ));
    }
    let review_kind = violation
        .review
        .as_ref()
        .map(|review| review.kind)
        .unwrap_or(ViolationReviewKind::ManualAdjudication);
    if params.decision == ViolationReviewDecision::Ignore
        && review_kind != ViolationReviewKind::ShieldCoverageExclusion
    {
        return Err(CoreError::Parse(
            "only shield-coverage exclusions support this review disposition".into(),
        ));
    }
    let review = violation
        .review
        .get_or_insert(crate::model::ViolationReview {
            kind: ViolationReviewKind::ManualAdjudication,
            resolution: None,
        });
    review.resolution = Some(ViolationReviewResolution {
        decision: params.decision,
        comment: comment.into(),
        reviewed_by: reviewed_by.into(),
        reviewed_at: unix_timestamp(),
    });
    cache.save_analysis(&analysis)?;
    let design = cache.load_design(&analysis.design_id)?;
    let report_path = write_html_report(&cache, &design, &analysis)?;
    let mut value = serde_json::to_value(&analysis)?;
    if let Value::Object(object) = &mut value {
        object.insert(
            "report_path".into(),
            Value::String(report_path.display().to_string()),
        );
    }
    Ok(value)
}

fn render_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        analysis_id: String,
        #[serde(default)]
        violation_ids: Vec<String>,
        #[serde(default = "default_width")]
        width: u32,
        #[serde(default = "default_height")]
        height: u32,
    }
    fn default_width() -> u32 {
        1600
    }
    fn default_height() -> u32 {
        1200
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(&params.cache_dir)?;
    let mut analysis = cache.load_analysis(&params.analysis_id)?;
    let design = cache.load_design(&analysis.design_id)?;
    let evidence = render_evidence(
        &cache,
        &design,
        &analysis,
        &params.violation_ids,
        params.width,
        params.height,
    )?;
    for item in &evidence {
        if let Some(violation) = analysis
            .violations
            .iter_mut()
            .find(|violation| violation.id == item.violation_id)
        {
            violation.evidence_uris = vec![
                format!(
                    "circuit://analysis/{}/evidence/{}.png",
                    analysis.id, item.violation_id
                ),
                format!(
                    "circuit://analysis/{}/evidence/{}.svg",
                    analysis.id, item.violation_id
                ),
            ];
        }
    }
    cache.save_analysis(&analysis)?;
    Ok(json!({ "analysis_id": analysis.id, "evidence": evidence }))
}

fn read_analysis_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        analysis_id: String,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(params.cache_dir)?;
    Ok(serde_json::to_value(
        cache.load_analysis(&params.analysis_id)?,
    )?)
}

fn design_cache_params(params: Value) -> CoreResult<(CacheStore, String)> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        design_id: String,
    }
    let params: Params = serde_json::from_value(params)?;
    Ok((CacheStore::new(params.cache_dir)?, params.design_id))
}

fn rule_path(cache: &CacheStore, id: &str) -> PathBuf {
    let safe = id
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || value == '-' || value == '_' {
                value
            } else {
                '-'
            }
        })
        .collect::<String>();
    cache.root().join("rules").join(format!("{safe}.json"))
}

fn resolve_rule_path(cache: &CacheStore, id: &str) -> CoreResult<PathBuf> {
    let canonical = rule_path(cache, id);
    if canonical.is_file() {
        let pack: RulePack = cache.load_json(&canonical)?;
        if pack.id != id {
            return Err(CoreError::Rule(
                "rule pack identifier does not match the cached artifact".into(),
            ));
        }
        return Ok(canonical);
    }

    let mut matched = None;
    for entry in fs::read_dir(cache.root().join("rules"))? {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(pack) = cache.load_json::<RulePack>(&path) else {
            continue;
        };
        if pack.id != id {
            continue;
        }
        if matched.is_some() {
            return Err(CoreError::Rule(format!(
                "multiple cached rule packs use identifier {id}"
            )));
        }
        matched = Some(path);
    }
    matched.ok_or_else(|| CoreError::NotFound(canonical.display().to_string()))
}

fn modified_unix_ms(path: &Path) -> u128 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn success(id: u64, result: Value) -> CoreResponse {
    CoreResponse {
        id,
        result: Some(result),
        error: None,
    }
}

fn failure(id: u64, error: &CoreError) -> CoreResponse {
    let code = match error {
        CoreError::InvalidInput(_) => "INVALID_INPUT",
        CoreError::Unsupported(_) => "UNSUPPORTED",
        CoreError::ArchiveRejected(_) => "ARCHIVE_REJECTED",
        CoreError::Parse(_) => "PARSE_FAILED",
        CoreError::Cache(_) => "CACHE_FAILED",
        CoreError::Rule(_) => "RULE_REJECTED",
        CoreError::NotFound(_) => "NOT_FOUND",
        _ => "INTERNAL_ERROR",
    };
    CoreResponse {
        id,
        result: None,
        error: Some(CoreResponseError {
            code: code.into(),
            message: error.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_point_review_context_uses_edge_to_edge_clearances() {
        let mut design = Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "distance-context".into(),
            format: crate::model::DesignFormat::Odbpp,
            source_path: "fixture".into(),
            content_hash: "hash".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 10_000_000,
                max_y: 10_000_000,
            },
            layers: vec![
                crate::model::Layer {
                    id: "top".into(),
                    name: "Top".into(),
                    function: "SIGNAL".into(),
                    side: Side::Top,
                    features: Vec::new(),
                },
                crate::model::Layer {
                    id: "uv-top".into(),
                    name: "UV glue top".into(),
                    function: "UV_GLUE".into(),
                    side: Side::Top,
                    features: [3_i64, 8]
                        .into_iter()
                        .enumerate()
                        .map(|(index, x)| crate::model::Feature {
                            id: format!("uv-{index}"),
                            layer_id: "uv-top".into(),
                            polarity: crate::model::Polarity::Dark,
                            geometry: FeatureGeometry::Pad {
                                center: PointNm {
                                    x: x * 1_000_000,
                                    y: 4_000_000,
                                },
                                size_x_nm: 200_000,
                                size_y_nm: 200_000,
                                rotation_deg: 0.0,
                            },
                            net_name: None,
                            component_ref: None,
                            pin: None,
                            attributes: Default::default(),
                            source: "fixture".into(),
                        })
                        .collect(),
                },
            ],
            components: Vec::new(),
            nets: Vec::new(),
            test_points: vec![
                TestPoint {
                    id: "tp-a".into(),
                    center: PointNm {
                        x: 2_000_000,
                        y: 4_000_000,
                    },
                    radius_nm: Some(100_000),
                    net_name: None,
                    component_ref: Some("TP1".into()),
                    confidence: CoverageLevel::Inferred,
                    layer_id: Some("top".into()),
                    source: "fixture".into(),
                    geometry_source: Some("fixture".into()),
                    confirmation: None,
                },
                TestPoint {
                    id: "tp-b".into(),
                    center: PointNm {
                        x: 5_000_000,
                        y: 4_000_000,
                    },
                    radius_nm: Some(200_000),
                    net_name: None,
                    component_ref: Some("TP2".into()),
                    confidence: CoverageLevel::Inferred,
                    layer_id: Some("top".into()),
                    source: "fixture".into(),
                    geometry_source: Some("fixture".into()),
                    confirmation: None,
                },
            ],
            coverage: crate::model::SemanticCoverage::default(),
            diagnostics: Vec::new(),
        };

        let candidates = test_points_with_review_context(&design);
        assert_eq!(candidates[0].review_context.metric, "EDGE_TO_EDGE");
        assert_eq!(
            candidates[0].review_context.board_edge.distance_nm,
            Some(1_900_000)
        );
        assert_eq!(
            candidates[0].review_context.board_edge.point,
            Some(PointNm { x: 0, y: 4_000_000 })
        );
        let nearest = candidates[0]
            .review_context
            .nearest_test_point
            .as_ref()
            .unwrap();
        assert_eq!(nearest.id, "tp-b");
        assert_eq!(nearest.distance_nm, Some(2_700_000));
        let nearest_uv = candidates[0]
            .review_context
            .nearest_uv_glue
            .as_ref()
            .unwrap();
        assert_eq!(nearest_uv.id, "uv-0");
        assert_eq!(nearest_uv.distance_nm, Some(800_000));

        design.components = vec![
            crate::model::Component {
                refdes: "TP1".into(),
                package_name: Some("TEST_POINT".into()),
                center: design.test_points[0].center,
                bounds: BoundsNm {
                    min_x: 1_800_000,
                    min_y: 3_800_000,
                    max_x: 2_200_000,
                    max_y: 4_200_000,
                },
                side: Side::Top,
                pins: vec!["1".into()],
                confidence: CoverageLevel::Explicit,
            },
            crate::model::Component {
                refdes: "TP2".into(),
                package_name: Some("TEST_POINT".into()),
                center: design.test_points[1].center,
                bounds: BoundsNm {
                    min_x: 4_700_000,
                    min_y: 3_700_000,
                    max_x: 5_300_000,
                    max_y: 4_300_000,
                },
                side: Side::Top,
                pins: vec!["1".into()],
                confidence: CoverageLevel::Explicit,
            },
        ];
        for point in &mut design.test_points {
            point.radius_nm = None;
            point.geometry_source = None;
        }

        let outlined = test_points_with_review_context(&design);
        assert_eq!(
            outlined[0].review_context.board_edge.distance_nm,
            Some(1_800_000)
        );
        assert_eq!(
            outlined[0]
                .review_context
                .nearest_test_point
                .as_ref()
                .unwrap()
                .distance_nm,
            Some(2_500_000)
        );
    }

    #[test]
    fn legacy_draft_severity_must_be_confirmed_before_approval() {
        let temporary = tempfile::tempdir().unwrap();
        let cache_dir = temporary.path();
        let legacy = json!({
            "id": "legacy-draft",
            "version": "0.1.0-draft",
            "title": "Legacy draft",
            "status": "DRAFT",
            "rules": [{
                "id": "tp-edge",
                "title": "Test point to board edge",
                "kind": "MINIMUM_DISTANCE",
                "source": "TEST_POINT",
                "target": "BOARD_EDGE",
                "metric": "EDGE_TO_EDGE",
                "threshold_nm": 1_200_000,
                "severity": "ERROR",
                "layer_functions": [],
                "same_net_only": false,
                "different_net_only": false,
                "citation": {
                    "source_path": "rules.pdf",
                    "source_hash": "hash",
                    "page": 1,
                    "paragraph": 1,
                    "excerpt": "At least 1.2 mm"
                }
            }],
            "approval": null
        });
        dispatch(
            "save_rule_pack",
            json!({ "cache_dir": cache_dir, "rule_pack": legacy }),
        )
        .unwrap();

        let listed = dispatch("list_rule_packs", json!({ "cache_dir": cache_dir })).unwrap();
        let pack = &listed["rule_packs"][0];
        assert!(pack["rules"][0]["severity"].is_null());
        assert_eq!(pack["review_items"][0]["code"], "LEGACY_AUTO_SEVERITY");
        assert!(
            dispatch(
                "approve_rule_pack",
                json!({ "cache_dir": cache_dir, "rule_pack_id": "legacy-draft", "approved_by": "owner" })
            )
            .is_err()
        );

        let mut rule = pack["rules"][0].clone();
        rule["severity"] = json!("ERROR");
        let review_id = pack["review_items"][0]["id"].as_str().unwrap();
        dispatch(
            "update_rule_pack",
            json!({
                "cache_dir": cache_dir,
                "rule_pack_id": "legacy-draft",
                "rules": [rule],
                "review_item_resolutions": [{
                    "review_item_id": review_id,
                    "decision": "MODIFY_RULE",
                    "note": "Confirmed the severity from controlled project requirements",
                    "rule_id": "tp-edge"
                }]
            }),
        )
        .unwrap();
        let approved = dispatch(
            "approve_rule_pack",
            json!({ "cache_dir": cache_dir, "rule_pack_id": "legacy-draft", "approved_by": "owner" }),
        )
        .unwrap();
        assert_eq!(approved["status"], "APPROVED");
        assert_eq!(approved["rules"][0]["severity"], "ERROR");
        assert_eq!(
            approved["review_items"][0]["resolution"]["decision"],
            "MODIFY_RULE"
        );
    }

    #[test]
    fn draft_with_noncanonical_filename_can_save_review_progress() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = CacheStore::new(temporary.path()).unwrap();
        let path = cache.root().join("rules/imported-draft.json");
        let draft = json!({
            "id": "rules-noncanonical",
            "version": "0.2.0-draft",
            "title": "Imported draft",
            "status": "DRAFT",
            "rules": [{
                "id": "tp-edge",
                "title": "Test point to board edge",
                "kind": "MINIMUM_DISTANCE",
                "source": "TEST_POINT",
                "target": "BOARD_EDGE",
                "metric": "EDGE_TO_EDGE",
                "threshold_nm": 1_200_000,
                "severity": null,
                "layer_functions": [],
                "same_net_only": false,
                "different_net_only": false,
                "citation": {
                    "source_path": "rules.pdf",
                    "source_hash": "hash",
                    "page": 1,
                    "paragraph": 1,
                    "excerpt": "At least 1.2 mm"
                }
            }],
            "review_items": [],
            "approval": null
        });
        cache.save_json(&path, &draft).unwrap();

        let mut rule = draft["rules"][0].clone();
        rule["severity"] = json!("WARNING");
        let updated = dispatch(
            "update_rule_pack",
            json!({
                "cache_dir": cache.root(),
                "rule_pack_id": "rules-noncanonical",
                "rules": [rule],
                "review_item_resolutions": []
            }),
        )
        .unwrap();

        assert_eq!(updated["rules"][0]["severity"], "WARNING");
        assert!(path.exists());
        assert!(!cache.root().join("rules/rules-noncanonical.json").exists());
        let persisted: Value = cache.load_json(&path).unwrap();
        assert_eq!(persisted["rules"][0]["severity"], "WARNING");
    }

    #[test]
    fn local_rule_pack_can_be_deleted_without_removing_other_packs() {
        let temporary = tempfile::tempdir().unwrap();
        let cache_dir = temporary.path();
        for id in ["keep-draft", "delete-draft"] {
            dispatch(
                "save_rule_pack",
                json!({
                    "cache_dir": cache_dir,
                    "rule_pack": {
                        "id": id,
                        "version": "0.2.0-draft",
                        "title": id,
                        "status": "DRAFT",
                        "rules": [],
                        "review_items": [],
                        "approval": null
                    }
                }),
            )
            .unwrap();
        }

        let deleted = dispatch(
            "delete_rule_pack",
            json!({ "cache_dir": cache_dir, "rule_pack_id": "delete-draft" }),
        )
        .unwrap();
        assert_eq!(deleted, json!({ "id": "delete-draft", "deleted": true }));

        let listed = dispatch("list_rule_packs", json!({ "cache_dir": cache_dir })).unwrap();
        assert_eq!(listed["rule_packs"].as_array().unwrap().len(), 1);
        assert_eq!(listed["rule_packs"][0]["id"], "keep-draft");
        assert!(
            dispatch(
                "delete_rule_pack",
                json!({ "cache_dir": cache_dir, "rule_pack_id": "delete-draft" })
            )
            .is_err()
        );
    }

    #[test]
    fn review_dispositions_are_audited_without_overwriting_the_automated_verdict() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = CacheStore::new(temporary.path()).unwrap();
        let design = Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "review-design".into(),
            format: crate::model::DesignFormat::Odbpp,
            source_path: "fixture".into(),
            content_hash: "hash".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 10_000_000,
                max_y: 10_000_000,
            },
            layers: Vec::new(),
            components: Vec::new(),
            nets: Vec::new(),
            test_points: Vec::new(),
            coverage: crate::model::SemanticCoverage::default(),
            diagnostics: Vec::new(),
        };
        cache.save_design(&design).unwrap();
        let finding = |id: &str, review| crate::model::Violation {
            id: id.into(),
            analysis_id: "review-analysis".into(),
            rule_id: "tp-component".into(),
            title: "Test point to component".into(),
            severity: Severity::Warning,
            verdict: Verdict::Review,
            source_format: crate::model::DesignFormat::Odbpp,
            semantic_confidence: CoverageLevel::Inferred,
            net_names: vec!["RESET".into()],
            component_refs: vec!["TP1".into(), "SH1".into()],
            layer_ids: vec!["top".into()],
            entity_ids: vec!["tp-1".into(), "SH1".into()],
            x_nm: 1_000_000,
            y_nm: 1_000_000,
            measured_value_nm: None,
            threshold_nm: Some(1_000_000),
            message: "manual review required".into(),
            evidence_points: vec![PointNm {
                x: 1_000_000,
                y: 1_000_000,
            }],
            evidence_uris: Vec::new(),
            rule_citation: None,
            review,
        };
        let analysis = crate::model::AnalysisSummary {
            id: "review-analysis".into(),
            design_id: design.id.clone(),
            rule_pack_id: "rules".into(),
            verdict: Verdict::Review,
            pass_count: 0,
            fail_count: 0,
            review_count: 2,
            not_applicable_count: 0,
            violations: vec![
                finding("generic-review", None),
                finding(
                    "shield-review",
                    Some(crate::model::ViolationReview {
                        kind: ViolationReviewKind::ShieldCoverageExclusion,
                        resolution: None,
                    }),
                ),
            ],
            report_uri: "circuit://analysis/review-analysis/report".into(),
            elapsed_ms: 0,
        };
        cache.save_analysis(&analysis).unwrap();

        let passed = dispatch(
            "review_violation",
            json!({
                "cache_dir": cache.root(),
                "analysis_id": analysis.id,
                "violation_id": "generic-review",
                "decision": "PASS",
                "comment": "",
                "reviewed_by": "dft-owner"
            }),
        )
        .unwrap();
        assert_eq!(passed["violations"][0]["verdict"], "REVIEW");
        assert_eq!(
            passed["violations"][0]["review"]["kind"],
            "MANUAL_ADJUDICATION"
        );
        assert_eq!(
            passed["violations"][0]["review"]["resolution"]["decision"],
            "PASS"
        );
        assert!(
            dispatch(
                "review_violation",
                json!({
                    "cache_dir": cache.root(),
                    "analysis_id": "review-analysis",
                    "violation_id": "shield-review",
                    "decision": "FAIL",
                    "comment": "",
                    "reviewed_by": "dft-owner"
                })
            )
            .is_err()
        );
        let ignored = dispatch(
            "review_violation",
            json!({
                "cache_dir": cache.root(),
                "analysis_id": "review-analysis",
                "violation_id": "shield-review",
                "decision": "IGNORE",
                "comment": "Shield can blocks fixture access.",
                "reviewed_by": "dft-owner"
            }),
        )
        .unwrap();
        assert_eq!(ignored["violations"][1]["verdict"], "REVIEW");
        assert_eq!(
            ignored["violations"][1]["review"]["resolution"]["decision"],
            "IGNORE"
        );
        let report = fs::read_to_string(ignored["report_path"].as_str().unwrap()).unwrap();
        assert!(report.contains("Shield can blocks fixture access."));
    }
}

#[allow(dead_code)]
fn _is_file(path: &Path) -> bool {
    path.is_file()
}
