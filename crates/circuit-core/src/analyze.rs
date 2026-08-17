use crate::CoreResult;
use crate::geometry::{
    bounds_to_board_edge, bounds_to_bounds, bounds_to_geometry, circle_to_board_edge,
    circle_to_bounds, circle_to_geometry,
};
use crate::model::{
    AnalysisSummary, BoundsNm, CoverageLevel, Design, Feature, FeatureGeometry, PointNm, Polarity,
    Severity, Side, Verdict, Violation, ViolationReview, ViolationReviewKind,
};
use crate::rules::{DistanceMetric, EntityKind, RuleDefinition, RuleKind, RulePack};
use rayon::prelude::*;
use std::collections::HashSet;
use std::time::Instant;
use uuid::Uuid;

#[derive(Clone, Copy)]
struct GeometryRef<'a> {
    id: &'a str,
    center: PointNm,
    bounds: BoundsNm,
    radius_nm: Option<i64>,
    net_name: Option<&'a str>,
    component_ref: Option<&'a str>,
    layer_id: Option<&'a str>,
    side: Side,
    confidence: CoverageLevel,
    kind: EntityKind,
    geometry: Option<&'a FeatureGeometry>,
}

#[derive(Clone, Copy)]
struct DistanceResult {
    measured_nm: i64,
    source_point: PointNm,
    target_point: PointNm,
    confidence: CoverageLevel,
}

pub fn analyze_design(design: &Design, rule_pack: &RulePack) -> CoreResult<AnalysisSummary> {
    rule_pack.validate_for_analysis()?;
    let started = Instant::now();
    let analysis_id = Uuid::new_v4().to_string();
    let per_rule = rule_pack
        .rules
        .par_iter()
        .map(|rule| evaluate_rule(design, rule, &analysis_id))
        .collect::<Vec<_>>();
    let mut violations = Vec::new();
    let mut pass_count = 0;
    let mut not_applicable_count = 0;
    for outcome in per_rule {
        match outcome.verdict {
            Verdict::Pass => pass_count += 1,
            Verdict::NotApplicable => not_applicable_count += 1,
            Verdict::Fail | Verdict::Review => {}
        }
        violations.extend(outcome.violations);
    }
    violations.sort_by(|left, right| {
        left.rule_id
            .cmp(&right.rule_id)
            .then(left.id.cmp(&right.id))
    });
    let fail_count = violations
        .iter()
        .filter(|violation| violation.verdict == Verdict::Fail)
        .count();
    let review_count = violations
        .iter()
        .filter(|violation| violation.verdict == Verdict::Review)
        .count();
    let verdict = if fail_count > 0 {
        Verdict::Fail
    } else if review_count > 0
        || violations
            .iter()
            .any(|violation| violation.verdict == Verdict::Review)
    {
        Verdict::Review
    } else if pass_count > 0 {
        Verdict::Pass
    } else {
        Verdict::NotApplicable
    };
    Ok(AnalysisSummary {
        id: analysis_id.clone(),
        design_id: design.id.clone(),
        rule_pack_id: rule_pack.id.clone(),
        verdict,
        pass_count,
        fail_count,
        review_count,
        not_applicable_count,
        violations,
        report_uri: format!("circuit://analysis/{analysis_id}/report"),
        elapsed_ms: started.elapsed().as_millis(),
    })
}

struct RuleOutcome {
    verdict: Verdict,
    violations: Vec<Violation>,
}

fn evaluate_rule(design: &Design, rule: &RuleDefinition, analysis_id: &str) -> RuleOutcome {
    let coverage = required_coverage(design, rule);
    if coverage == CoverageLevel::Missing {
        return RuleOutcome {
            verdict: Verdict::Review,
            violations: vec![review_violation(
                design,
                rule,
                analysis_id,
                Verdict::Review,
                "required semantic target is not identified in the imported design; the numeric baseline remains valid but needs entity confirmation before measurement",
            )],
        };
    }
    let mut violations = match rule.kind {
        RuleKind::MinimumDistance => evaluate_distance(design, rule, analysis_id),
        RuleKind::MinimumWidth => evaluate_width(design, rule, analysis_id),
        RuleKind::MinimumAnnularRing => evaluate_annular_ring(design, rule, analysis_id),
        RuleKind::MinimumDiameter => evaluate_diameter(design, rule, analysis_id),
    };
    if coverage == CoverageLevel::Inferred {
        if violations.is_empty() {
            violations.push(inferred_review_violation(design, rule, analysis_id));
        }
        for violation in &mut violations {
            if violation.semantic_confidence == CoverageLevel::Inferred {
                violation.verdict = Verdict::Review;
                if !violation.message.to_ascii_lowercase().contains("inferred") {
                    violation.message.push_str(
                        "; entity identity is inferred and must be confirmed before PASS/FAIL",
                    );
                }
            }
        }
        return RuleOutcome {
            verdict: Verdict::Review,
            violations,
        };
    }
    RuleOutcome {
        verdict: if violations
            .iter()
            .any(|violation| violation.verdict == Verdict::Fail)
        {
            Verdict::Fail
        } else if violations
            .iter()
            .any(|violation| violation.verdict == Verdict::Review)
        {
            Verdict::Review
        } else {
            Verdict::Pass
        },
        violations,
    }
}

fn evaluate_distance(design: &Design, rule: &RuleDefinition, analysis_id: &str) -> Vec<Violation> {
    let sources = entities(design, rule.source);
    let targets = entities(design, rule.target.unwrap_or(EntityKind::BoardEdge));
    let shield_candidates =
        if rule.source == EntityKind::TestPoint && rule.target == Some(EntityKind::Component) {
            entities(design, EntityKind::ShieldFence)
        } else {
            Vec::new()
        };
    let same_collection = rule.target == Some(rule.source);
    let mut violations = Vec::new();
    let mut emitted_pairs = HashSet::new();
    for (source_index, source) in sources.iter().enumerate() {
        if let Some(shield) = covering_shield(source, &shield_candidates) {
            violations.push(shield_coverage_review(
                design,
                rule,
                analysis_id,
                source,
                shield,
            ));
            continue;
        }
        let mut first_unmeasured = None;
        let mut unmeasured_pairs = 0_usize;
        let mut nearest_review: Option<(i64, &str, Violation)> = None;
        for (target_index, target) in targets.iter().enumerate() {
            if same_collection && target_index == source_index {
                continue;
            }
            if !eligible_pair(rule, source, target) {
                continue;
            }
            let Some(measurement) = distance(
                design,
                source,
                target,
                rule.metric.unwrap_or(DistanceMetric::EdgeToEdge),
            ) else {
                first_unmeasured.get_or_insert(target);
                unmeasured_pairs += 1;
                continue;
            };
            if measurement.measured_nm < rule.threshold_nm {
                let violation =
                    distance_violation(design, rule, analysis_id, source, target, measurement);
                if violation.verdict == Verdict::Review {
                    if nearest_review.as_ref().is_none_or(|(distance, id, _)| {
                        measurement.measured_nm < *distance
                            || (measurement.measured_nm == *distance && target.id < *id)
                    }) {
                        nearest_review = Some((measurement.measured_nm, target.id, violation));
                    }
                } else if !same_collection
                    || emitted_pairs.insert(unordered_pair_key(source.id, target.id))
                {
                    violations.push(violation);
                }
            }
        }
        if let Some((_, _, violation)) = nearest_review {
            let pair = unordered_pair_key(&violation.entity_ids[0], &violation.entity_ids[1]);
            if !same_collection || emitted_pairs.insert(pair) {
                violations.push(violation);
            }
        } else if let Some(target) = first_unmeasured {
            let pair = unordered_pair_key(source.id, target.id);
            if same_collection && !emitted_pairs.insert(pair) {
                continue;
            }
            violations.push(unmeasured_geometry_violation(
                design,
                rule,
                analysis_id,
                source,
                target,
                &format!(
                    "required feature geometry is not available; {unmeasured_pairs} candidate pair(s) were not measured for this source entity"
                ),
            ));
        }
    }
    violations
}

fn covering_shield<'a>(
    source: &GeometryRef<'_>,
    shields: &'a [GeometryRef<'a>],
) -> Option<&'a GeometryRef<'a>> {
    if source.kind != EntityKind::TestPoint || !matches!(source.side, Side::Top | Side::Bottom) {
        return None;
    }
    shields
        .iter()
        .filter(|shield| shield.side == source.side)
        .filter(|shield| {
            source.center.x >= shield.bounds.min_x
                && source.center.x <= shield.bounds.max_x
                && source.center.y >= shield.bounds.min_y
                && source.center.y <= shield.bounds.max_y
        })
        .min_by(|left, right| {
            bounds_area(left.bounds)
                .cmp(&bounds_area(right.bounds))
                .then_with(|| left.id.cmp(right.id))
        })
}

fn bounds_area(bounds: BoundsNm) -> i128 {
    i128::from(bounds.max_x.saturating_sub(bounds.min_x).max(0))
        * i128::from(bounds.max_y.saturating_sub(bounds.min_y).max(0))
}

fn shield_coverage_review(
    design: &Design,
    rule: &RuleDefinition,
    analysis_id: &str,
    source: &GeometryRef<'_>,
    shield: &GeometryRef<'_>,
) -> Violation {
    let mut component_refs = [source.component_ref, shield.component_ref]
        .into_iter()
        .flatten()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    component_refs.sort();
    component_refs.dedup();
    Violation {
        id: format!("{}:{}:{}:shield-coverage", rule.id, source.id, shield.id),
        analysis_id: analysis_id.into(),
        rule_id: rule.id.clone(),
        title: rule.title.clone(),
        severity: confirmed_severity(rule),
        verdict: Verdict::Review,
        source_format: design.format.clone(),
        semantic_confidence: source.confidence.weakest(CoverageLevel::Inferred),
        net_names: source.net_name.into_iter().map(ToOwned::to_owned).collect(),
        component_refs,
        layer_ids: source.layer_id.into_iter().map(ToOwned::to_owned).collect(),
        entity_ids: vec![source.id.to_owned(), shield.id.to_owned()],
        x_nm: source.center.x,
        y_nm: source.center.y,
        measured_value_nm: None,
        threshold_nm: Some(rule.threshold_nm),
        message: format!(
            "test point {} is inside inferred shield candidate {}; component-clearance measurement was skipped and requires review before this DFT check may be ignored",
            source.id, shield.id
        ),
        evidence_points: vec![
            source.center,
            PointNm {
                x: shield.bounds.min_x,
                y: shield.bounds.min_y,
            },
            PointNm {
                x: shield.bounds.max_x,
                y: shield.bounds.max_y,
            },
        ],
        evidence_uris: Vec::new(),
        rule_citation: rule.citation.clone(),
        review: Some(ViolationReview {
            kind: ViolationReviewKind::ShieldCoverageExclusion,
            resolution: None,
        }),
    }
}

fn unordered_pair_key(left: &str, right: &str) -> (String, String) {
    if left <= right {
        (left.to_owned(), right.to_owned())
    } else {
        (right.to_owned(), left.to_owned())
    }
}

fn eligible_pair(
    rule: &RuleDefinition,
    source: &GeometryRef<'_>,
    target: &GeometryRef<'_>,
) -> bool {
    if source.id == target.id {
        return false;
    }
    if entity_is_surface_bound(source.kind)
        && entity_is_surface_bound(target.kind)
        && (!matches!(source.side, Side::Top | Side::Bottom)
            || !matches!(target.side, Side::Top | Side::Bottom)
            || source.side != target.side)
    {
        return false;
    }
    if rule.same_net_only && source.net_name != target.net_name {
        return false;
    }
    if rule.different_net_only && (source.net_name.is_none() || source.net_name == target.net_name)
    {
        return false;
    }
    true
}

fn entity_is_surface_bound(kind: EntityKind) -> bool {
    matches!(
        kind,
        EntityKind::TestPoint
            | EntityKind::Component
            | EntityKind::Copper
            | EntityKind::BgaCsp
            | EntityKind::ShieldFence
            | EntityKind::UvGlue
    )
}

fn evaluate_width(design: &Design, rule: &RuleDefinition, analysis_id: &str) -> Vec<Violation> {
    let mut violations = Vec::new();
    for layer in &design.layers {
        if !rule.layer_functions.is_empty()
            && !rule.layer_functions.iter().any(|function| {
                layer
                    .function
                    .to_ascii_uppercase()
                    .contains(&function.to_ascii_uppercase())
            })
        {
            continue;
        }
        for feature in &layer.features {
            let width = match feature.geometry {
                FeatureGeometry::Line { width_nm, .. } | FeatureGeometry::Arc { width_nm, .. } => {
                    Some(width_nm)
                }
                _ => None,
            };
            if let Some(width) = width.filter(|width| *width < rule.threshold_nm) {
                let center = feature.geometry.bounds().center();
                let evidence_points = match &feature.geometry {
                    FeatureGeometry::Line { start, end, .. }
                    | FeatureGeometry::Arc { start, end, .. } => vec![*start, *end],
                    _ => vec![center],
                };
                violations.push(Violation {
                    id: format!("{}:{}", rule.id, violations.len()),
                    analysis_id: analysis_id.into(),
                    rule_id: rule.id.clone(),
                    title: rule.title.clone(),
                    severity: confirmed_severity(rule),
                    verdict: Verdict::Fail,
                    source_format: design.format.clone(),
                    semantic_confidence: CoverageLevel::Explicit,
                    net_names: feature.net_name.iter().cloned().collect(),
                    component_refs: feature.component_ref.iter().cloned().collect(),
                    layer_ids: vec![layer.id.clone()],
                    entity_ids: vec![feature.id.clone()],
                    x_nm: center.x,
                    y_nm: center.y,
                    measured_value_nm: Some(width),
                    threshold_nm: Some(rule.threshold_nm),
                    message: format!(
                        "measured width {:.3} mm is below {:.3} mm",
                        nm_mm(width),
                        nm_mm(rule.threshold_nm)
                    ),
                    evidence_points,
                    evidence_uris: Vec::new(),
                    rule_citation: rule.citation.clone(),
                    review: None,
                });
            }
        }
    }
    violations
}

fn evaluate_annular_ring(
    design: &Design,
    rule: &RuleDefinition,
    analysis_id: &str,
) -> Vec<Violation> {
    let drills = entities(design, EntityKind::Drill);
    let copper = entities(design, EntityKind::Copper);
    let mut violations = Vec::new();
    for drill in drills {
        let nearest = copper
            .iter()
            .filter(|pad| pad.center.distance_sq(drill.center) <= 25_000_i128.pow(2))
            .max_by_key(|pad| pad.radius_nm);
        let Some(pad) = nearest else { continue };
        let ring = pad.radius_nm.unwrap_or_default() - drill.radius_nm.unwrap_or_default();
        if ring < rule.threshold_nm {
            violations.push(distance_violation(
                design,
                rule,
                analysis_id,
                &drill,
                pad,
                DistanceResult {
                    measured_nm: ring,
                    source_point: drill.center,
                    target_point: pad.center,
                    confidence: CoverageLevel::Explicit,
                },
            ));
        }
    }
    violations
}

fn evaluate_diameter(design: &Design, rule: &RuleDefinition, analysis_id: &str) -> Vec<Violation> {
    entities(design, EntityKind::TestPoint)
        .into_iter()
        .filter_map(|point| match point.radius_nm {
            Some(radius) => {
                let diameter = radius.saturating_mul(2);
                (diameter < rule.threshold_nm)
                    .then(|| diameter_violation(design, rule, analysis_id, &point, diameter))
            }
            None => Some(unmeasured_geometry_violation(
                design,
                rule,
                analysis_id,
                &point,
                &point,
                "test-point identity is present but no unique external-copper pad geometry was resolved; diameter was not measured",
            )),
        })
        .collect()
}

fn diameter_violation(
    design: &Design,
    rule: &RuleDefinition,
    analysis_id: &str,
    point: &GeometryRef<'_>,
    diameter: i64,
) -> Violation {
    Violation {
        id: format!("{}:{}", rule.id, point.id),
        analysis_id: analysis_id.into(),
        rule_id: rule.id.clone(),
        title: rule.title.clone(),
        severity: confirmed_severity(rule),
        verdict: if point.confidence == CoverageLevel::Inferred {
            Verdict::Review
        } else {
            Verdict::Fail
        },
        source_format: design.format.clone(),
        semantic_confidence: point.confidence,
        net_names: point.net_name.into_iter().map(ToOwned::to_owned).collect(),
        component_refs: point
            .component_ref
            .into_iter()
            .map(ToOwned::to_owned)
            .collect(),
        layer_ids: point.layer_id.into_iter().map(ToOwned::to_owned).collect(),
        entity_ids: vec![point.id.to_owned()],
        x_nm: point.center.x,
        y_nm: point.center.y,
        measured_value_nm: Some(diameter),
        threshold_nm: Some(rule.threshold_nm),
        message: format!(
            "measured test-point diameter {:.3} mm is below {:.3} mm",
            nm_mm(diameter),
            nm_mm(rule.threshold_nm)
        ),
        evidence_points: vec![point.center],
        evidence_uris: Vec::new(),
        rule_citation: rule.citation.clone(),
        review: None,
    }
}

fn entities(design: &Design, kind: EntityKind) -> Vec<GeometryRef<'_>> {
    match kind {
        EntityKind::TestPoint => design
            .test_points
            .iter()
            .map(|point| GeometryRef {
                id: &point.id,
                center: point.center,
                bounds: design.test_point_bounds(point).unwrap_or(BoundsNm {
                    min_x: point.center.x,
                    min_y: point.center.y,
                    max_x: point.center.x,
                    max_y: point.center.y,
                }),
                radius_nm: point.radius_nm,
                net_name: point.net_name.as_deref(),
                component_ref: point.component_ref.as_deref(),
                layer_id: test_point_layer_id(design, point),
                side: test_point_side(design, point),
                confidence: point.confidence,
                kind: EntityKind::TestPoint,
                geometry: None,
            })
            .collect(),
        EntityKind::Component => design
            .components
            .iter()
            .filter(|component| !component.is_test_point_marker())
            .map(|component| GeometryRef {
                id: &component.refdes,
                center: component.center,
                bounds: component.bounds,
                radius_nm: Some(
                    ((component.bounds.max_x - component.bounds.min_x)
                        .max(component.bounds.max_y - component.bounds.min_y))
                        / 2,
                ),
                net_name: None,
                component_ref: Some(&component.refdes),
                layer_id: None,
                side: component.side,
                confidence: component.confidence,
                kind: EntityKind::Component,
                geometry: None,
            })
            .collect(),
        EntityKind::Copper => design
            .layers
            .iter()
            .filter(|layer| is_conductive_function(&layer.function))
            .flat_map(|layer| {
                layer.features.iter().map(move |feature| {
                    feature_ref(
                        feature,
                        &layer.id,
                        layer.side,
                        CoverageLevel::Explicit,
                        EntityKind::Copper,
                    )
                })
            })
            .collect(),
        EntityKind::Drill => design
            .layers
            .iter()
            .flat_map(|layer| {
                layer
                    .features
                    .iter()
                    .filter(|feature| matches!(feature.geometry, FeatureGeometry::Drill { .. }))
                    .map(move |feature| {
                        feature_ref(
                            feature,
                            &layer.id,
                            layer.side,
                            CoverageLevel::Explicit,
                            EntityKind::Drill,
                        )
                    })
            })
            .collect(),
        EntityKind::ToolingHole => design
            .tooling_hole_candidates()
            .into_iter()
            .map(|(layer, feature, confidence)| {
                feature_ref(
                    feature,
                    &layer.id,
                    layer.side,
                    confidence,
                    EntityKind::ToolingHole,
                )
            })
            .collect(),
        EntityKind::BoardEdge => vec![GeometryRef {
            id: "board-edge",
            center: design.bounds.center(),
            bounds: design.bounds,
            radius_nm: None,
            net_name: None,
            component_ref: None,
            layer_id: None,
            side: Side::Na,
            confidence: CoverageLevel::Explicit,
            kind: EntityKind::BoardEdge,
            geometry: None,
        }],
        EntityKind::ShieldFence => design
            .components
            .iter()
            .filter(|component| component.is_shield_candidate())
            .map(|component| GeometryRef {
                id: &component.refdes,
                center: component.center,
                bounds: component.bounds,
                radius_nm: Some(
                    ((component.bounds.max_x - component.bounds.min_x)
                        .max(component.bounds.max_y - component.bounds.min_y))
                        / 2,
                ),
                net_name: None,
                component_ref: Some(&component.refdes),
                layer_id: None,
                side: component.side,
                confidence: CoverageLevel::Inferred,
                kind: EntityKind::ShieldFence,
                geometry: None,
            })
            .collect(),
        EntityKind::UvGlue => design
            .layers
            .iter()
            .filter_map(|layer| {
                uv_glue_layer_confidence(layer).map(|confidence| (layer, confidence))
            })
            .flat_map(|(layer, confidence)| {
                layer
                    .features
                    .iter()
                    .filter(|feature| feature.polarity == Polarity::Dark)
                    .map(move |feature| {
                        feature_ref(
                            feature,
                            &layer.id,
                            layer.side,
                            confidence,
                            EntityKind::UvGlue,
                        )
                    })
            })
            .collect(),
        EntityKind::PanelTab | EntityKind::BgaCsp => Vec::new(),
    }
}

fn test_point_side(design: &Design, point: &crate::model::TestPoint) -> Side {
    test_point_layer_id(design, point)
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

fn test_point_layer_id<'a>(
    design: &'a Design,
    point: &'a crate::model::TestPoint,
) -> Option<&'a str> {
    if let Some(layer_id) = point.layer_id.as_deref() {
        return Some(layer_id);
    }
    let source = point.source.replace('\\', "/").to_ascii_lowercase();
    design
        .layers
        .iter()
        .find(|layer| {
            layer
                .features
                .iter()
                .any(|feature| feature.source == point.source)
                || source
                    .split('/')
                    .any(|segment| segment.eq_ignore_ascii_case(&layer.name))
        })
        .map(|layer| layer.id.as_str())
}

fn feature_ref<'a>(
    feature: &'a Feature,
    layer_id: &'a str,
    side: Side,
    confidence: CoverageLevel,
    kind: EntityKind,
) -> GeometryRef<'a> {
    let bounds = feature.geometry.bounds();
    let radius_nm = match feature.geometry {
        FeatureGeometry::Pad {
            size_x_nm,
            size_y_nm,
            ..
        } => Some(size_x_nm.min(size_y_nm) / 2),
        FeatureGeometry::Drill { diameter_nm, .. } => Some(diameter_nm / 2),
        FeatureGeometry::Line { width_nm, .. } | FeatureGeometry::Arc { width_nm, .. } => {
            Some(width_nm / 2)
        }
        _ => None,
    };
    GeometryRef {
        id: &feature.id,
        center: bounds.center(),
        bounds,
        radius_nm,
        net_name: feature.net_name.as_deref(),
        component_ref: feature.component_ref.as_deref(),
        layer_id: Some(layer_id),
        side,
        confidence,
        kind,
        geometry: Some(&feature.geometry),
    }
}

pub(crate) fn uv_glue_layer_confidence(layer: &crate::model::Layer) -> Option<CoverageLevel> {
    if has_explicit_uv_glue_marker(&layer.function) {
        Some(CoverageLevel::Explicit)
    } else if has_glue_candidate_marker(&layer.function) || has_glue_candidate_marker(&layer.name) {
        Some(CoverageLevel::Inferred)
    } else {
        None
    }
}

fn normalized_semantic_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
}

fn has_explicit_uv_glue_marker(value: &str) -> bool {
    let normalized = normalized_semantic_name(value);
    normalized.contains("UV_GLUE") || normalized.contains("UVGLUE")
}

fn has_glue_candidate_marker(value: &str) -> bool {
    let normalized = normalized_semantic_name(value);
    has_explicit_uv_glue_marker(&normalized)
        || normalized.contains("ADHESIVE")
        || normalized.contains("DISPENSE")
        || normalized.split('_').any(|token| token == "GLUE")
}

fn distance(
    design: &Design,
    source: &GeometryRef<'_>,
    target: &GeometryRef<'_>,
    metric: DistanceMetric,
) -> Option<DistanceResult> {
    if target.id == "board-edge" {
        let measurement = if matches!(source.kind, EntityKind::Component | EntityKind::ShieldFence)
            || source.radius_nm.is_none() && entity_uses_bounds(source)
        {
            bounds_to_board_edge(design, source.bounds)
        } else {
            circle_to_board_edge(design, source.center, source.radius_nm?)
        };
        return Some(DistanceResult {
            measured_nm: measurement.distance_nm,
            source_point: measurement.entity_point,
            target_point: measurement.edge_point,
            confidence: measurement.confidence,
        });
    }
    if metric == DistanceMetric::CenterToCenter {
        return Some(DistanceResult {
            measured_nm: (source.center.distance_sq(target.center) as f64)
                .sqrt()
                .round() as i64,
            source_point: source.center,
            target_point: target.center,
            confidence: CoverageLevel::Explicit,
        });
    }
    if target.kind == EntityKind::UvGlue {
        let measurement = if let Some(radius_nm) = source.radius_nm {
            circle_to_geometry(source.center, radius_nm, target.geometry?)
        } else if entity_uses_bounds(source) {
            bounds_to_geometry(source.bounds, target.geometry?)
        } else {
            return None;
        };
        return Some(DistanceResult {
            measured_nm: measurement.distance_nm,
            source_point: measurement.source_point,
            target_point: measurement.target_point,
            confidence: CoverageLevel::Explicit,
        });
    }
    if source.kind == EntityKind::UvGlue && metric == DistanceMetric::EdgeToEdge {
        let measurement = if let Some(radius_nm) = target.radius_nm {
            circle_to_geometry(target.center, radius_nm, source.geometry?)
        } else if entity_uses_bounds(target) {
            bounds_to_geometry(target.bounds, source.geometry?)
        } else {
            return None;
        };
        return Some(DistanceResult {
            measured_nm: measurement.distance_nm,
            source_point: measurement.target_point,
            target_point: measurement.source_point,
            confidence: CoverageLevel::Explicit,
        });
    }
    if matches!(target.kind, EntityKind::Component | EntityKind::ShieldFence)
        && matches!(
            metric,
            DistanceMetric::EdgeToEdge | DistanceMetric::BodyToPad
        )
    {
        let measurement = if let Some(radius_nm) = source.radius_nm {
            let measured = circle_to_bounds(source.center, radius_nm, target.bounds);
            crate::geometry::EdgeMeasurement {
                distance_nm: measured.distance_nm,
                source_point: measured.circle_point,
                target_point: measured.bounds_point,
            }
        } else if entity_uses_bounds(source) {
            bounds_to_bounds(source.bounds, target.bounds)
        } else {
            return None;
        };
        return Some(DistanceResult {
            measured_nm: measurement.distance_nm,
            source_point: measurement.source_point,
            target_point: measurement.target_point,
            confidence: CoverageLevel::Explicit,
        });
    }
    if matches!(source.kind, EntityKind::Component | EntityKind::ShieldFence)
        && metric == DistanceMetric::EdgeToEdge
    {
        let measurement = if let Some(radius_nm) = target.radius_nm {
            let measured = circle_to_bounds(target.center, radius_nm, source.bounds);
            crate::geometry::EdgeMeasurement {
                distance_nm: measured.distance_nm,
                source_point: measured.bounds_point,
                target_point: measured.circle_point,
            }
        } else if entity_uses_bounds(target) {
            bounds_to_bounds(source.bounds, target.bounds)
        } else {
            return None;
        };
        return Some(DistanceResult {
            measured_nm: measurement.distance_nm,
            source_point: measurement.source_point,
            target_point: measurement.target_point,
            confidence: CoverageLevel::Explicit,
        });
    }
    if metric == DistanceMetric::BodyToPad {
        return None;
    }
    let measurement = match (source.radius_nm, target.radius_nm) {
        (Some(source_radius), Some(target_radius)) => {
            let measured_nm = ((source.center.distance_sq(target.center) as f64)
                .sqrt()
                .round() as i64
                - source_radius
                - target_radius)
                .max(0);
            return Some(DistanceResult {
                measured_nm,
                source_point: source.center,
                target_point: target.center,
                confidence: CoverageLevel::Explicit,
            });
        }
        (Some(source_radius), None) if entity_uses_bounds(target) => {
            let measured = circle_to_bounds(source.center, source_radius, target.bounds);
            crate::geometry::EdgeMeasurement {
                distance_nm: measured.distance_nm,
                source_point: measured.circle_point,
                target_point: measured.bounds_point,
            }
        }
        (None, Some(target_radius)) if entity_uses_bounds(source) => {
            let measured = circle_to_bounds(target.center, target_radius, source.bounds);
            crate::geometry::EdgeMeasurement {
                distance_nm: measured.distance_nm,
                source_point: measured.bounds_point,
                target_point: measured.circle_point,
            }
        }
        (None, None) if entity_uses_bounds(source) && entity_uses_bounds(target) => {
            bounds_to_bounds(source.bounds, target.bounds)
        }
        _ => return None,
    };
    Some(DistanceResult {
        measured_nm: measurement.distance_nm,
        source_point: measurement.source_point,
        target_point: measurement.target_point,
        confidence: CoverageLevel::Explicit,
    })
}

fn entity_uses_bounds(entity: &GeometryRef<'_>) -> bool {
    matches!(
        entity.kind,
        EntityKind::TestPoint | EntityKind::Component | EntityKind::ShieldFence
    ) && !entity.bounds.is_empty()
        && (entity.bounds.max_x > entity.bounds.min_x || entity.bounds.max_y > entity.bounds.min_y)
}

fn distance_violation(
    design: &Design,
    rule: &RuleDefinition,
    analysis_id: &str,
    source: &GeometryRef<'_>,
    target: &GeometryRef<'_>,
    measurement: DistanceResult,
) -> Violation {
    let midpoint = PointNm {
        x: measurement
            .source_point
            .x
            .saturating_add((measurement.target_point.x - measurement.source_point.x) / 2),
        y: measurement
            .source_point
            .y
            .saturating_add((measurement.target_point.y - measurement.source_point.y) / 2),
    };
    let mut nets = [source.net_name, target.net_name]
        .into_iter()
        .flatten()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    nets.sort();
    nets.dedup();
    let mut components = [source.component_ref, target.component_ref]
        .into_iter()
        .flatten()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    components.sort();
    components.dedup();
    let mut layers = [source.layer_id, target.layer_id]
        .into_iter()
        .flatten()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    layers.sort();
    layers.dedup();
    Violation {
        id: format!("{}:{}:{}", rule.id, source.id, target.id),
        analysis_id: analysis_id.into(),
        rule_id: rule.id.clone(),
        title: rule.title.clone(),
        severity: confirmed_severity(rule),
        verdict: if [source, target]
            .into_iter()
            .any(|entity| entity.confidence == CoverageLevel::Inferred)
            || measurement.confidence == CoverageLevel::Inferred
        {
            Verdict::Review
        } else {
            Verdict::Fail
        },
        source_format: design.format.clone(),
        semantic_confidence: source
            .confidence
            .weakest(target.confidence)
            .weakest(measurement.confidence),
        net_names: nets,
        component_refs: components,
        layer_ids: layers,
        entity_ids: vec![source.id.to_owned(), target.id.to_owned()],
        x_nm: midpoint.x,
        y_nm: midpoint.y,
        measured_value_nm: Some(measurement.measured_nm),
        threshold_nm: Some(rule.threshold_nm),
        message: format!(
            "measured {:.3} mm is below {:.3} mm",
            nm_mm(measurement.measured_nm),
            nm_mm(rule.threshold_nm)
        ),
        evidence_points: vec![measurement.source_point, measurement.target_point],
        evidence_uris: Vec::new(),
        rule_citation: rule.citation.clone(),
        review: None,
    }
}

fn unmeasured_geometry_violation(
    design: &Design,
    rule: &RuleDefinition,
    analysis_id: &str,
    source: &GeometryRef<'_>,
    target: &GeometryRef<'_>,
    message: &str,
) -> Violation {
    Violation {
        id: format!("{}:{}:{}:geometry", rule.id, source.id, target.id),
        analysis_id: analysis_id.into(),
        rule_id: rule.id.clone(),
        title: rule.title.clone(),
        severity: confirmed_severity(rule),
        verdict: Verdict::Review,
        source_format: design.format.clone(),
        semantic_confidence: CoverageLevel::Inferred,
        net_names: [source.net_name, target.net_name]
            .into_iter()
            .flatten()
            .map(ToOwned::to_owned)
            .collect(),
        component_refs: [source.component_ref, target.component_ref]
            .into_iter()
            .flatten()
            .map(ToOwned::to_owned)
            .collect(),
        layer_ids: [source.layer_id, target.layer_id]
            .into_iter()
            .flatten()
            .map(ToOwned::to_owned)
            .collect(),
        entity_ids: vec![source.id.to_owned(), target.id.to_owned()],
        x_nm: source.center.x,
        y_nm: source.center.y,
        measured_value_nm: None,
        threshold_nm: Some(rule.threshold_nm),
        message: message.into(),
        evidence_points: vec![source.center],
        evidence_uris: Vec::new(),
        rule_citation: rule.citation.clone(),
        review: None,
    }
}

fn is_conductive_function(function: &str) -> bool {
    let upper = function.to_ascii_uppercase();
    ["SIGNAL", "POWER_GROUND", "MIXED", "COPPER"]
        .iter()
        .any(|kind| upper.contains(kind))
}

fn review_violation(
    design: &Design,
    rule: &RuleDefinition,
    analysis_id: &str,
    verdict: Verdict,
    message: &str,
) -> Violation {
    let center = design.bounds.center();
    Violation {
        id: format!("{}:coverage", rule.id),
        analysis_id: analysis_id.into(),
        rule_id: rule.id.clone(),
        title: rule.title.clone(),
        severity: confirmed_severity(rule),
        verdict,
        source_format: design.format.clone(),
        semantic_confidence: required_coverage(design, rule),
        net_names: Vec::new(),
        component_refs: Vec::new(),
        layer_ids: Vec::new(),
        entity_ids: Vec::new(),
        x_nm: center.x,
        y_nm: center.y,
        measured_value_nm: None,
        threshold_nm: Some(rule.threshold_nm),
        message: message.into(),
        evidence_points: Vec::new(),
        evidence_uris: Vec::new(),
        rule_citation: rule.citation.clone(),
        review: None,
    }
}

fn inferred_review_violation(
    design: &Design,
    rule: &RuleDefinition,
    analysis_id: &str,
) -> Violation {
    match rule.kind {
        RuleKind::MinimumDistance => {
            let sources = entities(design, rule.source);
            let targets = entities(design, rule.target.unwrap_or(EntityKind::BoardEdge));
            let same_collection = rule.target == Some(rule.source);
            let mut nearest: Option<(GeometryRef<'_>, GeometryRef<'_>, DistanceResult)> = None;
            for (source_index, source) in sources.iter().enumerate() {
                for (target_index, target) in targets.iter().enumerate() {
                    if (same_collection && target_index <= source_index)
                        || !eligible_pair(rule, source, target)
                    {
                        continue;
                    }
                    let Some(measured) = distance(
                        design,
                        source,
                        target,
                        rule.metric.unwrap_or(DistanceMetric::EdgeToEdge),
                    ) else {
                        continue;
                    };
                    if nearest
                        .as_ref()
                        .is_none_or(|(_, _, current)| measured.measured_nm < current.measured_nm)
                    {
                        nearest = Some((*source, *target, measured));
                    }
                }
            }
            if let Some((source, target, measured)) = nearest {
                let mut violation =
                    distance_violation(design, rule, analysis_id, &source, &target, measured);
                violation.message = format!(
                    "closest measured distance {:.3} mm against {:.3} mm; entities are inferred and require confirmation",
                    nm_mm(measured.measured_nm),
                    nm_mm(rule.threshold_nm)
                );
                return violation;
            }
        }
        RuleKind::MinimumDiameter => {
            if let Some(point) = entities(design, EntityKind::TestPoint)
                .into_iter()
                .filter(|point| point.radius_nm.is_some())
                .min_by_key(|point| point.radius_nm)
            {
                let diameter = point.radius_nm.unwrap_or_default().saturating_mul(2);
                let mut violation = diameter_violation(design, rule, analysis_id, &point, diameter);
                violation.message = format!(
                    "closest measured test-point diameter {:.3} mm against {:.3} mm; entity is inferred and requires confirmation",
                    nm_mm(diameter),
                    nm_mm(rule.threshold_nm)
                );
                return violation;
            }
        }
        RuleKind::MinimumWidth | RuleKind::MinimumAnnularRing => {}
    }
    review_violation(
        design,
        rule,
        analysis_id,
        Verdict::Review,
        "required entities are inferred but no measurable candidate pair is available; confirm the entity mapping before PASS/FAIL",
    )
}

fn confirmed_severity(rule: &RuleDefinition) -> Severity {
    rule.severity
        .expect("approved rule packs are validated before evaluation")
}

fn coverage_for(design: &Design, kind: EntityKind) -> CoverageLevel {
    match kind {
        EntityKind::TestPoint => {
            if design.test_points.iter().any(|test_point| {
                !matches!(
                    test_point_side(design, test_point),
                    Side::Top | Side::Bottom
                )
            }) {
                design.coverage.test_points.weakest(CoverageLevel::Inferred)
            } else {
                design.coverage.test_points
            }
        }
        EntityKind::Component => {
            if entities(design, EntityKind::Component).is_empty() {
                CoverageLevel::Missing
            } else {
                design.coverage.components
            }
        }
        EntityKind::Copper | EntityKind::BoardEdge => design.coverage.layers,
        EntityKind::Drill => design.coverage.drills,
        EntityKind::ToolingHole => {
            let candidates = entities(design, EntityKind::ToolingHole);
            if candidates.is_empty() {
                CoverageLevel::Missing
            } else {
                candidates
                    .iter()
                    .fold(CoverageLevel::Explicit, |coverage, candidate| {
                        coverage.weakest(candidate.confidence)
                    })
            }
        }
        EntityKind::ShieldFence => {
            if entities(design, EntityKind::ShieldFence).is_empty() {
                CoverageLevel::Missing
            } else {
                CoverageLevel::Inferred
            }
        }
        EntityKind::UvGlue => {
            let candidates = entities(design, EntityKind::UvGlue);
            if candidates.is_empty() {
                CoverageLevel::Missing
            } else {
                candidates
                    .iter()
                    .fold(CoverageLevel::Explicit, |coverage, candidate| {
                        coverage.weakest(candidate.confidence)
                    })
            }
        }
        EntityKind::PanelTab | EntityKind::BgaCsp => CoverageLevel::Missing,
    }
}

fn required_coverage(design: &Design, rule: &RuleDefinition) -> CoverageLevel {
    let mut coverage = rule
        .target
        .map(|target| coverage_for(design, rule.source).weakest(coverage_for(design, target)))
        .unwrap_or_else(|| coverage_for(design, rule.source));
    if rule.kind == RuleKind::MinimumDistance {
        for kind in std::iter::once(rule.source).chain(rule.target) {
            if entity_is_surface_bound(kind)
                && entities(design, kind)
                    .iter()
                    .any(|entity| !matches!(entity.side, Side::Top | Side::Bottom))
            {
                coverage = coverage.weakest(CoverageLevel::Inferred);
            }
        }
    }
    coverage
}

fn nm_mm(value: i64) -> f64 {
    value as f64 / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        Component, DesignFormat, Feature, Layer, SemanticCoverage, Severity, TestPoint,
    };
    use crate::rules::{RuleApproval, RulePackStatus};
    use std::collections::BTreeMap;

    #[test]
    fn finds_testpoint_spacing_and_diameter_failures() {
        let design = Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "board".into(),
            format: DesignFormat::GerberPackage,
            source_path: "board.zip".into(),
            content_hash: "hash".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 10_000_000,
                max_y: 10_000_000,
            },
            layers: vec![Layer {
                id: "top".into(),
                name: "Top".into(),
                function: "SIGNAL".into(),
                side: Side::Top,
                features: Vec::new(),
            }],
            components: Vec::new(),
            nets: vec!["A".into(), "B".into()],
            test_points: vec![
                TestPoint {
                    id: "a".into(),
                    center: PointNm {
                        x: 1_000_000,
                        y: 1_000_000,
                    },
                    radius_nm: Some(100_000),
                    net_name: Some("A".into()),
                    component_ref: None,
                    confidence: CoverageLevel::Explicit,
                    layer_id: Some("top".into()),
                    source: "fixture".into(),
                    geometry_source: Some("fixture".into()),
                    confirmation: None,
                },
                TestPoint {
                    id: "b".into(),
                    center: PointNm {
                        x: 1_400_000,
                        y: 1_000_000,
                    },
                    radius_nm: Some(100_000),
                    net_name: Some("B".into()),
                    component_ref: None,
                    confidence: CoverageLevel::Explicit,
                    layer_id: Some("top".into()),
                    source: "fixture".into(),
                    geometry_source: Some("fixture".into()),
                    confirmation: None,
                },
            ],
            coverage: SemanticCoverage {
                test_points: CoverageLevel::Explicit,
                ..Default::default()
            },
            diagnostics: Vec::new(),
        };
        let pack = RulePack {
            id: "dft".into(),
            version: "1".into(),
            title: "DFT".into(),
            status: RulePackStatus::Approved,
            rules: vec![
                RuleDefinition {
                    id: "tp-spacing".into(),
                    title: "Test point spacing".into(),
                    kind: RuleKind::MinimumDistance,
                    source: EntityKind::TestPoint,
                    target: Some(EntityKind::TestPoint),
                    metric: Some(DistanceMetric::EdgeToEdge),
                    threshold_nm: 500_000,
                    severity: Some(Severity::Error),
                    layer_functions: Vec::new(),
                    same_net_only: false,
                    different_net_only: false,
                    citation: None,
                },
                RuleDefinition {
                    id: "tp-diameter".into(),
                    title: "Test point diameter".into(),
                    kind: RuleKind::MinimumDiameter,
                    source: EntityKind::TestPoint,
                    target: None,
                    metric: None,
                    threshold_nm: 400_000,
                    severity: Some(Severity::Warning),
                    layer_functions: Vec::new(),
                    same_net_only: false,
                    different_net_only: false,
                    citation: None,
                },
            ],
            review_items: Vec::new(),
            approval: Some(RuleApproval {
                approved_by: "fixture".into(),
                approved_at: "2026-08-07T00:00:00Z".into(),
                content_hash: "approved".into(),
            }),
        };
        let analysis = analyze_design(&design, &pack).unwrap();
        assert_eq!(analysis.fail_count, 3);
        assert_eq!(
            analysis
                .violations
                .iter()
                .filter(|violation| violation.rule_id == "tp-diameter")
                .count(),
            2
        );
    }

    #[test]
    fn inferred_testpoints_remain_review_even_with_identified_net_and_component() {
        let mut design = Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "board".into(),
            format: DesignFormat::GerberPackage,
            source_path: "board.zip".into(),
            content_hash: "hash".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 10_000_000,
                max_y: 10_000_000,
            },
            layers: vec![Layer {
                id: "top".into(),
                name: "Top".into(),
                function: "SIGNAL".into(),
                side: Side::Top,
                features: Vec::new(),
            }],
            components: Vec::new(),
            nets: vec!["A".into(), "B".into()],
            test_points: vec![
                TestPoint {
                    id: "a".into(),
                    center: PointNm {
                        x: 1_000_000,
                        y: 1_000_000,
                    },
                    radius_nm: Some(100_000),
                    net_name: Some("A".into()),
                    component_ref: Some("TP1".into()),
                    confidence: CoverageLevel::Inferred,
                    layer_id: Some("top".into()),
                    source: "fixture".into(),
                    geometry_source: Some("fixture".into()),
                    confirmation: None,
                },
                TestPoint {
                    id: "b".into(),
                    center: PointNm {
                        x: 1_400_000,
                        y: 1_000_000,
                    },
                    radius_nm: Some(100_000),
                    net_name: Some("B".into()),
                    component_ref: Some("TP2".into()),
                    confidence: CoverageLevel::Inferred,
                    layer_id: Some("top".into()),
                    source: "fixture".into(),
                    geometry_source: Some("fixture".into()),
                    confirmation: None,
                },
            ],
            coverage: SemanticCoverage {
                test_points: CoverageLevel::Inferred,
                ..Default::default()
            },
            diagnostics: Vec::new(),
        };
        let pack = RulePack {
            id: "dft".into(),
            version: "1".into(),
            title: "DFT".into(),
            status: RulePackStatus::Approved,
            rules: vec![
                RuleDefinition {
                    id: "tp-spacing".into(),
                    title: "Test point spacing".into(),
                    kind: RuleKind::MinimumDistance,
                    source: EntityKind::TestPoint,
                    target: Some(EntityKind::TestPoint),
                    metric: Some(DistanceMetric::EdgeToEdge),
                    threshold_nm: 100_000,
                    severity: Some(Severity::Warning),
                    layer_functions: Vec::new(),
                    same_net_only: false,
                    different_net_only: false,
                    citation: None,
                },
                RuleDefinition {
                    id: "zz-tp-diameter".into(),
                    title: "Test point diameter".into(),
                    kind: RuleKind::MinimumDiameter,
                    source: EntityKind::TestPoint,
                    target: None,
                    metric: None,
                    threshold_nm: 400_000,
                    severity: Some(Severity::Warning),
                    layer_functions: Vec::new(),
                    same_net_only: false,
                    different_net_only: false,
                    citation: None,
                },
            ],
            review_items: Vec::new(),
            approval: Some(RuleApproval {
                approved_by: "fixture".into(),
                approved_at: "2026-08-07T00:00:00Z".into(),
                content_hash: "approved".into(),
            }),
        };

        let analysis = analyze_design(&design, &pack).unwrap();

        assert_eq!(analysis.verdict, Verdict::Review);
        assert_eq!(analysis.pass_count, 0);
        assert_eq!(analysis.fail_count, 0);
        assert_eq!(analysis.review_count, 3);
        assert_eq!(analysis.violations.len(), 3);
        let finding = analysis
            .violations
            .iter()
            .find(|finding| finding.rule_id == "zz-tp-diameter")
            .unwrap();
        assert_eq!(finding.verdict, Verdict::Review);
        assert_eq!(finding.semantic_confidence, CoverageLevel::Inferred);
        assert_eq!(finding.net_names, ["A"]);
        assert_eq!(finding.component_refs, ["TP1"]);
        assert_eq!(finding.measured_value_nm, Some(200_000));
        assert_eq!(finding.threshold_nm, Some(400_000));
        assert_eq!(finding.evidence_points.len(), 1);
        assert_eq!(finding.x_nm, 1_000_000);
        assert_eq!(finding.y_nm, 1_000_000);

        design.test_points[1].confidence = CoverageLevel::Explicit;
        let partially_confirmed = analyze_design(&design, &pack).unwrap();
        assert_eq!(partially_confirmed.verdict, Verdict::Fail);
        assert_eq!(partially_confirmed.fail_count, 1);
        assert_eq!(partially_confirmed.review_count, 2);
        assert_eq!(
            partially_confirmed
                .violations
                .iter()
                .find(|finding| finding.id == "zz-tp-diameter:b")
                .unwrap()
                .verdict,
            Verdict::Fail
        );
        assert_eq!(
            partially_confirmed
                .violations
                .iter()
                .find(|finding| finding.id == "zz-tp-diameter:a")
                .unwrap()
                .verdict,
            Verdict::Review
        );
        design.test_points[1].confidence = CoverageLevel::Inferred;

        design.test_points[0].component_ref = None;
        let incomplete = analyze_design(&design, &pack).unwrap();
        assert_eq!(incomplete.verdict, Verdict::Review);
        assert_eq!(incomplete.fail_count, 0);
        assert!(
            incomplete
                .violations
                .iter()
                .all(|finding| finding.verdict == Verdict::Review)
        );

        for point in &mut design.test_points {
            point.radius_nm = None;
            point.geometry_source = None;
        }
        let missing_geometry = analyze_design(&design, &pack).unwrap();
        let diameter = missing_geometry
            .violations
            .iter()
            .find(|finding| finding.rule_id == "zz-tp-diameter")
            .unwrap();
        assert_eq!(diameter.verdict, Verdict::Review);
        assert_eq!(diameter.measured_value_nm, None);
        assert_eq!(diameter.evidence_points, [design.test_points[0].center]);
    }

    #[test]
    fn missing_target_semantics_cannot_be_reported_as_pass() {
        let mut design = Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "board".into(),
            format: DesignFormat::GerberPackage,
            source_path: "board.zip".into(),
            content_hash: "hash".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 10_000_000,
                max_y: 10_000_000,
            },
            layers: Vec::new(),
            components: Vec::new(),
            nets: vec!["A".into()],
            test_points: vec![TestPoint {
                id: "a".into(),
                center: PointNm {
                    x: 1_000_000,
                    y: 1_000_000,
                },
                radius_nm: Some(100_000),
                net_name: Some("A".into()),
                component_ref: None,
                confidence: CoverageLevel::Explicit,
                layer_id: None,
                source: "fixture".into(),
                geometry_source: Some("fixture".into()),
                confirmation: None,
            }],
            coverage: SemanticCoverage {
                test_points: CoverageLevel::Explicit,
                components: CoverageLevel::Missing,
                ..Default::default()
            },
            diagnostics: Vec::new(),
        };
        design.finalize();
        let pack = RulePack {
            id: "dft".into(),
            version: "1".into(),
            title: "DFT".into(),
            status: RulePackStatus::Approved,
            rules: vec![RuleDefinition {
                id: "tp-component".into(),
                title: "Test point to component".into(),
                kind: RuleKind::MinimumDistance,
                source: EntityKind::TestPoint,
                target: Some(EntityKind::Component),
                metric: Some(DistanceMetric::BodyToPad),
                threshold_nm: 500_000,
                severity: Some(Severity::Error),
                layer_functions: Vec::new(),
                same_net_only: false,
                different_net_only: false,
                citation: None,
            }],
            review_items: Vec::new(),
            approval: Some(RuleApproval {
                approved_by: "fixture".into(),
                approved_at: "2026-08-07T00:00:00Z".into(),
                content_hash: "approved".into(),
            }),
        };
        let analysis = analyze_design(&design, &pack).unwrap();
        assert_eq!(analysis.verdict, Verdict::Review);
        assert_eq!(analysis.fail_count, 0);
        assert_eq!(analysis.review_count, 1);
        assert_eq!(
            analysis.violations[0].semantic_confidence,
            CoverageLevel::Missing
        );
    }

    #[test]
    fn component_clearance_excludes_test_point_bodies_and_measures_shield_candidates() {
        let design = Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "component-clearance".into(),
            format: DesignFormat::Odbpp,
            source_path: "fixture".into(),
            content_hash: "hash".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 10_000_000,
                max_y: 10_000_000,
            },
            layers: Vec::new(),
            components: vec![
                Component {
                    refdes: "MTP1".into(),
                    package_name: Some("TEST_POINT".into()),
                    center: PointNm {
                        x: 1_000_000,
                        y: 1_000_000,
                    },
                    bounds: BoundsNm {
                        min_x: 800_000,
                        min_y: 800_000,
                        max_x: 1_200_000,
                        max_y: 1_200_000,
                    },
                    side: Side::Top,
                    pins: vec!["1".into()],
                    confidence: CoverageLevel::Explicit,
                },
                Component {
                    refdes: "R1".into(),
                    package_name: Some("0603".into()),
                    center: PointNm {
                        x: 3_000_000,
                        y: 1_000_000,
                    },
                    bounds: BoundsNm {
                        min_x: 2_500_000,
                        min_y: 750_000,
                        max_x: 3_500_000,
                        max_y: 1_250_000,
                    },
                    side: Side::Top,
                    pins: vec!["1".into(), "2".into()],
                    confidence: CoverageLevel::Explicit,
                },
                Component {
                    refdes: "R2".into(),
                    package_name: Some("0603".into()),
                    center: PointNm {
                        x: 4_000_000,
                        y: 1_000_000,
                    },
                    bounds: BoundsNm {
                        min_x: 3_800_000,
                        min_y: 750_000,
                        max_x: 4_200_000,
                        max_y: 1_250_000,
                    },
                    side: Side::Top,
                    pins: vec!["1".into(), "2".into()],
                    confidence: CoverageLevel::Explicit,
                },
                Component {
                    refdes: "SH1".into(),
                    package_name: Some("EMI_SHIELD".into()),
                    center: PointNm {
                        x: 5_000_000,
                        y: 1_000_000,
                    },
                    bounds: BoundsNm {
                        min_x: 4_500_000,
                        min_y: 500_000,
                        max_x: 5_500_000,
                        max_y: 1_500_000,
                    },
                    side: Side::Top,
                    pins: Vec::new(),
                    confidence: CoverageLevel::Explicit,
                },
                Component {
                    refdes: "SH2".into(),
                    package_name: Some("SHIELD_CAN".into()),
                    center: PointNm {
                        x: 7_000_000,
                        y: 1_000_000,
                    },
                    bounds: BoundsNm {
                        min_x: 6_500_000,
                        min_y: 500_000,
                        max_x: 7_500_000,
                        max_y: 1_500_000,
                    },
                    side: Side::Top,
                    pins: Vec::new(),
                    confidence: CoverageLevel::Explicit,
                },
            ],
            nets: vec!["A".into()],
            test_points: vec![TestPoint {
                id: "tp-a".into(),
                center: PointNm {
                    x: 1_000_000,
                    y: 1_000_000,
                },
                radius_nm: Some(100_000),
                net_name: Some("A".into()),
                component_ref: Some("MTP1".into()),
                confidence: CoverageLevel::Explicit,
                layer_id: None,
                source: "fixture".into(),
                geometry_source: Some("fixture".into()),
                confirmation: None,
            }],
            coverage: SemanticCoverage {
                components: CoverageLevel::Explicit,
                test_points: CoverageLevel::Explicit,
                ..Default::default()
            },
            diagnostics: Vec::new(),
        };
        let pack = RulePack {
            id: "clearance".into(),
            version: "1".into(),
            title: "Clearance".into(),
            status: RulePackStatus::Approved,
            rules: vec![
                RuleDefinition {
                    id: "tp-component".into(),
                    title: "Test point to component".into(),
                    kind: RuleKind::MinimumDistance,
                    source: EntityKind::TestPoint,
                    target: Some(EntityKind::Component),
                    metric: Some(DistanceMetric::BodyToPad),
                    threshold_nm: 4_000_000,
                    severity: Some(Severity::Error),
                    layer_functions: Vec::new(),
                    same_net_only: false,
                    different_net_only: false,
                    citation: None,
                },
                RuleDefinition {
                    id: "tp-shield".into(),
                    title: "Test point to shield".into(),
                    kind: RuleKind::MinimumDistance,
                    source: EntityKind::TestPoint,
                    target: Some(EntityKind::ShieldFence),
                    metric: Some(DistanceMetric::EdgeToEdge),
                    threshold_nm: 7_000_000,
                    severity: Some(Severity::Warning),
                    layer_functions: Vec::new(),
                    same_net_only: false,
                    different_net_only: false,
                    citation: None,
                },
            ],
            review_items: Vec::new(),
            approval: Some(RuleApproval {
                approved_by: "fixture".into(),
                approved_at: "2026-08-11T00:00:00Z".into(),
                content_hash: "approved".into(),
            }),
        };

        let analysis = analyze_design(&design, &pack).unwrap();
        let component = analysis
            .violations
            .iter()
            .find(|finding| finding.rule_id == "tp-component")
            .unwrap();
        assert_eq!(component.measured_value_nm, Some(1_400_000));
        assert!(component.id.contains("R1"));
        assert_eq!(
            analysis
                .violations
                .iter()
                .filter(|finding| finding.rule_id == "tp-component")
                .count(),
            3,
            "confirmed failures must not be collapsed"
        );
        let shield = analysis
            .violations
            .iter()
            .find(|finding| finding.rule_id == "tp-shield")
            .unwrap();
        assert_eq!(shield.measured_value_nm, Some(3_400_000));
        assert_eq!(shield.verdict, Verdict::Review);
        assert_eq!(shield.semantic_confidence, CoverageLevel::Inferred);
        assert!(shield.id.contains("SH1"));
        assert_eq!(
            analysis
                .violations
                .iter()
                .filter(|finding| finding.rule_id == "tp-shield")
                .count(),
            1,
            "only the nearest inferred shield candidate needs review"
        );
    }

    #[test]
    fn component_clearance_reviews_points_inside_shields_and_measures_points_outside() {
        let design = Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "shield-covered-test-point".into(),
            format: DesignFormat::Odbpp,
            source_path: "fixture".into(),
            content_hash: "hash".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 10_000_000,
                max_y: 10_000_000,
            },
            layers: vec![Layer {
                id: "top".into(),
                name: "Top".into(),
                function: "SIGNAL".into(),
                side: Side::Top,
                features: Vec::new(),
            }],
            components: vec![
                Component {
                    refdes: "SH1".into(),
                    package_name: Some("SHIELD_CAN".into()),
                    center: PointNm {
                        x: 1_250_000,
                        y: 1_250_000,
                    },
                    bounds: BoundsNm {
                        min_x: 500_000,
                        min_y: 500_000,
                        max_x: 2_000_000,
                        max_y: 2_000_000,
                    },
                    side: Side::Top,
                    pins: Vec::new(),
                    confidence: CoverageLevel::Explicit,
                },
                Component {
                    refdes: "R-IN".into(),
                    package_name: Some("0402".into()),
                    center: PointNm {
                        x: 1_300_000,
                        y: 1_000_000,
                    },
                    bounds: BoundsNm {
                        min_x: 1_200_000,
                        min_y: 900_000,
                        max_x: 1_400_000,
                        max_y: 1_100_000,
                    },
                    side: Side::Top,
                    pins: vec!["1".into(), "2".into()],
                    confidence: CoverageLevel::Explicit,
                },
                Component {
                    refdes: "R-OUT".into(),
                    package_name: Some("0402".into()),
                    center: PointNm {
                        x: 5_000_000,
                        y: 1_000_000,
                    },
                    bounds: BoundsNm {
                        min_x: 4_700_000,
                        min_y: 900_000,
                        max_x: 5_300_000,
                        max_y: 1_100_000,
                    },
                    side: Side::Top,
                    pins: vec!["1".into(), "2".into()],
                    confidence: CoverageLevel::Explicit,
                },
                Component {
                    refdes: "SH-BOT".into(),
                    package_name: Some("SHIELD_CAN".into()),
                    center: PointNm {
                        x: 4_000_000,
                        y: 1_000_000,
                    },
                    bounds: BoundsNm {
                        min_x: 3_500_000,
                        min_y: 500_000,
                        max_x: 4_500_000,
                        max_y: 1_500_000,
                    },
                    side: Side::Bottom,
                    pins: Vec::new(),
                    confidence: CoverageLevel::Explicit,
                },
            ],
            nets: vec!["INSIDE".into(), "OUTSIDE".into()],
            test_points: vec![
                TestPoint {
                    id: "tp-inside".into(),
                    center: PointNm {
                        x: 1_000_000,
                        y: 1_000_000,
                    },
                    radius_nm: Some(100_000),
                    net_name: Some("INSIDE".into()),
                    component_ref: Some("TP-IN".into()),
                    confidence: CoverageLevel::Explicit,
                    layer_id: Some("top".into()),
                    source: "fixture".into(),
                    geometry_source: Some("fixture".into()),
                    confirmation: None,
                },
                TestPoint {
                    id: "tp-outside".into(),
                    center: PointNm {
                        x: 4_000_000,
                        y: 1_000_000,
                    },
                    radius_nm: Some(100_000),
                    net_name: Some("OUTSIDE".into()),
                    component_ref: Some("TP-OUT".into()),
                    confidence: CoverageLevel::Explicit,
                    layer_id: Some("top".into()),
                    source: "fixture".into(),
                    geometry_source: Some("fixture".into()),
                    confirmation: None,
                },
            ],
            coverage: SemanticCoverage {
                components: CoverageLevel::Explicit,
                test_points: CoverageLevel::Explicit,
                ..Default::default()
            },
            diagnostics: Vec::new(),
        };
        let pack = RulePack {
            id: "clearance".into(),
            version: "1".into(),
            title: "Clearance".into(),
            status: RulePackStatus::Approved,
            rules: vec![RuleDefinition {
                id: "tp-component".into(),
                title: "Test point to component".into(),
                kind: RuleKind::MinimumDistance,
                source: EntityKind::TestPoint,
                target: Some(EntityKind::Component),
                metric: Some(DistanceMetric::BodyToPad),
                threshold_nm: 1_000_000,
                severity: Some(Severity::Error),
                layer_functions: Vec::new(),
                same_net_only: false,
                different_net_only: false,
                citation: None,
            }],
            review_items: Vec::new(),
            approval: Some(RuleApproval {
                approved_by: "fixture".into(),
                approved_at: "2026-08-17T00:00:00Z".into(),
                content_hash: "approved".into(),
            }),
        };

        let analysis = analyze_design(&design, &pack).unwrap();

        assert_eq!(analysis.fail_count, 1);
        assert_eq!(analysis.review_count, 1);
        let covered = analysis
            .violations
            .iter()
            .find(|finding| finding.entity_ids.contains(&"tp-inside".into()))
            .unwrap();
        assert_eq!(covered.verdict, Verdict::Review);
        assert_eq!(covered.measured_value_nm, None);
        assert_eq!(covered.component_refs, ["SH1", "TP-IN"]);
        assert_eq!(
            covered.review.as_ref().map(|review| review.kind),
            Some(crate::model::ViolationReviewKind::ShieldCoverageExclusion)
        );
        let outside = analysis
            .violations
            .iter()
            .find(|finding| finding.entity_ids.contains(&"tp-outside".into()))
            .unwrap();
        assert_eq!(outside.verdict, Verdict::Fail);
        assert_eq!(outside.measured_value_nm, Some(600_000));
        assert!(outside.entity_ids.contains(&"R-OUT".into()));
    }

    #[test]
    fn missing_test_point_geometry_is_reported_once_per_source_instead_of_per_pair() {
        let design = Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "missing-geometry".into(),
            format: DesignFormat::Odbpp,
            source_path: "fixture".into(),
            content_hash: "hash".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 10_000_000,
                max_y: 10_000_000,
            },
            layers: vec![Layer {
                id: "top".into(),
                name: "Top".into(),
                function: "SIGNAL".into(),
                side: Side::Top,
                features: Vec::new(),
            }],
            components: Vec::new(),
            nets: Vec::new(),
            test_points: (0..4)
                .map(|index| TestPoint {
                    id: format!("tp-{index}"),
                    center: PointNm {
                        x: i64::from(index) * 1_000_000,
                        y: 1_000_000,
                    },
                    radius_nm: None,
                    net_name: None,
                    component_ref: Some(format!("MTP{index}")),
                    confidence: CoverageLevel::Inferred,
                    layer_id: Some("top".into()),
                    source: "fixture".into(),
                    geometry_source: None,
                    confirmation: None,
                })
                .collect(),
            coverage: SemanticCoverage {
                test_points: CoverageLevel::Inferred,
                ..Default::default()
            },
            diagnostics: Vec::new(),
        };
        let rule = RuleDefinition {
            id: "tp-spacing".into(),
            title: "Test point spacing".into(),
            kind: RuleKind::MinimumDistance,
            source: EntityKind::TestPoint,
            target: Some(EntityKind::TestPoint),
            metric: Some(DistanceMetric::EdgeToEdge),
            threshold_nm: 1_000_000,
            severity: Some(Severity::Warning),
            layer_functions: Vec::new(),
            same_net_only: false,
            different_net_only: false,
            citation: None,
        };

        let findings = evaluate_distance(&design, &rule, "analysis");

        assert_eq!(findings.len(), 3);
        assert!(findings.iter().all(|finding| {
            finding.measured_value_nm.is_none() && finding.message.contains("candidate pair(s)")
        }));
    }

    #[test]
    fn inferred_test_point_spacing_keeps_only_each_points_nearest_review_pair() {
        let design = Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "nearest-test-point-review".into(),
            format: DesignFormat::Odbpp,
            source_path: "fixture".into(),
            content_hash: "hash".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 10_000_000,
                max_y: 10_000_000,
            },
            layers: vec![Layer {
                id: "top".into(),
                name: "Top".into(),
                function: "SIGNAL".into(),
                side: Side::Top,
                features: Vec::new(),
            }],
            components: Vec::new(),
            nets: Vec::new(),
            test_points: [1_i64, 2, 4, 8]
                .into_iter()
                .enumerate()
                .map(|(index, x)| TestPoint {
                    id: format!("tp-{index}"),
                    center: PointNm {
                        x: x * 1_000_000,
                        y: 1_000_000,
                    },
                    radius_nm: Some(100_000),
                    net_name: None,
                    component_ref: None,
                    confidence: CoverageLevel::Inferred,
                    layer_id: Some("top".into()),
                    source: "fixture".into(),
                    geometry_source: Some("fixture".into()),
                    confirmation: None,
                })
                .collect(),
            coverage: SemanticCoverage {
                test_points: CoverageLevel::Inferred,
                ..Default::default()
            },
            diagnostics: Vec::new(),
        };
        let rule = RuleDefinition {
            id: "tp-spacing".into(),
            title: "Test point spacing".into(),
            kind: RuleKind::MinimumDistance,
            source: EntityKind::TestPoint,
            target: Some(EntityKind::TestPoint),
            metric: Some(DistanceMetric::EdgeToEdge),
            threshold_nm: 10_000_000,
            severity: Some(Severity::Warning),
            layer_functions: Vec::new(),
            same_net_only: false,
            different_net_only: false,
            citation: None,
        };

        let findings = evaluate_distance(&design, &rule, "analysis");

        assert_eq!(findings.len(), 3);
        assert!(
            findings
                .iter()
                .all(|finding| finding.verdict == Verdict::Review)
        );
        assert!(
            findings
                .iter()
                .any(|finding| finding.id.contains("tp-0:tp-1"))
        );
        assert!(
            findings
                .iter()
                .any(|finding| finding.id.contains("tp-2:tp-1"))
        );
        assert!(
            findings
                .iter()
                .any(|finding| finding.id.contains("tp-3:tp-2"))
        );
    }

    #[test]
    fn measures_component_backed_square_test_points_uv_glue_and_candidate_tooling_holes() {
        let test_point = |id: &str, reference: &str, x: i64| TestPoint {
            id: id.into(),
            center: PointNm { x, y: 1_000_000 },
            radius_nm: None,
            net_name: None,
            component_ref: Some(reference.into()),
            confidence: CoverageLevel::Inferred,
            layer_id: Some("top".into()),
            source: "components".into(),
            geometry_source: None,
            confirmation: None,
        };
        let component = |reference: &str, min_x: i64, max_x: i64| Component {
            refdes: reference.into(),
            package_name: Some("TEST_POINT".into()),
            center: PointNm {
                x: min_x + (max_x - min_x) / 2,
                y: 1_000_000,
            },
            bounds: BoundsNm {
                min_x,
                min_y: 800_000,
                max_x,
                max_y: 1_200_000,
            },
            side: Side::Top,
            pins: vec!["1".into()],
            confidence: CoverageLevel::Explicit,
        };
        let design = Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "square-test-points".into(),
            format: DesignFormat::Odbpp,
            source_path: "fixture".into(),
            content_hash: "hash".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 10_000_000,
                max_y: 10_000_000,
            },
            layers: vec![
                Layer {
                    id: "uv".into(),
                    name: "uv_glue_top".into(),
                    function: "DOCUMENT".into(),
                    side: Side::Top,
                    features: vec![Feature {
                        id: "uv-outline".into(),
                        layer_id: "uv".into(),
                        polarity: Polarity::Dark,
                        geometry: FeatureGeometry::Region {
                            points: vec![
                                PointNm {
                                    x: 4_000_000,
                                    y: 500_000,
                                },
                                PointNm {
                                    x: 5_000_000,
                                    y: 500_000,
                                },
                                PointNm {
                                    x: 5_000_000,
                                    y: 1_500_000,
                                },
                                PointNm {
                                    x: 4_000_000,
                                    y: 1_500_000,
                                },
                            ],
                        },
                        net_name: None,
                        component_ref: None,
                        pin: None,
                        attributes: BTreeMap::new(),
                        source: "uv/features".into(),
                    }],
                },
                Layer {
                    id: "drill".into(),
                    name: "drill".into(),
                    function: "DRILL".into(),
                    side: Side::Na,
                    features: vec![Feature {
                        id: "candidate-hole".into(),
                        layer_id: "drill".into(),
                        polarity: Polarity::Dark,
                        geometry: FeatureGeometry::Drill {
                            center: PointNm {
                                x: 4_000_000,
                                y: 1_000_000,
                            },
                            diameter_nm: 1_000_000,
                            plated: Some(false),
                        },
                        net_name: None,
                        component_ref: None,
                        pin: None,
                        attributes: BTreeMap::new(),
                        source: "drill/features".into(),
                    }],
                },
            ],
            components: vec![
                component("MTP2602", 800_000, 1_200_000),
                component("TP3702", 2_200_000, 2_800_000),
            ],
            nets: Vec::new(),
            test_points: vec![
                test_point("odb-tp-62", "MTP2602", 1_000_000),
                test_point("odb-tp-63", "TP3702", 2_500_000),
            ],
            coverage: SemanticCoverage {
                layers: CoverageLevel::Explicit,
                components: CoverageLevel::Explicit,
                test_points: CoverageLevel::Inferred,
                drills: CoverageLevel::Explicit,
                ..Default::default()
            },
            diagnostics: Vec::new(),
        };
        let distance_rule = |id: &str, target: EntityKind, threshold_nm: i64| RuleDefinition {
            id: id.into(),
            title: id.into(),
            kind: RuleKind::MinimumDistance,
            source: EntityKind::TestPoint,
            target: Some(target),
            metric: Some(DistanceMetric::EdgeToEdge),
            threshold_nm,
            severity: Some(Severity::Warning),
            layer_functions: Vec::new(),
            same_net_only: false,
            different_net_only: false,
            citation: None,
        };
        let pack = RulePack {
            id: "geometry".into(),
            version: "1".into(),
            title: "Geometry".into(),
            status: RulePackStatus::Approved,
            rules: vec![
                distance_rule("tp-spacing", EntityKind::TestPoint, 1_500_000),
                distance_rule("tp-tooling", EntityKind::ToolingHole, 1_000_000),
                distance_rule("tp-uv", EntityKind::UvGlue, 1_500_000),
            ],
            review_items: Vec::new(),
            approval: Some(RuleApproval {
                approved_by: "fixture".into(),
                approved_at: "2026-08-11T00:00:00Z".into(),
                content_hash: "approved".into(),
            }),
        };

        let analysis = analyze_design(&design, &pack).unwrap();

        for (rule_id, measured_nm) in [
            ("tp-spacing", 1_000_000),
            ("tp-tooling", 700_000),
            ("tp-uv", 1_200_000),
        ] {
            let finding = analysis
                .violations
                .iter()
                .find(|finding| finding.rule_id == rule_id)
                .unwrap();
            assert_eq!(finding.verdict, Verdict::Review);
            assert_eq!(finding.measured_value_nm, Some(measured_nm));
            assert_eq!(finding.evidence_points.len(), 2);
            assert!(!finding.message.contains("geometry is not available"));
        }
    }
}
