use crate::CoreResult;
use crate::geometry::{bounds_to_board_edge, circle_to_board_edge};
use crate::model::{
    AnalysisSummary, BoundsNm, CoverageLevel, Design, Feature, FeatureGeometry, PointNm, Severity,
    Verdict, Violation,
};
use crate::rules::{DistanceMetric, EntityKind, RuleDefinition, RuleKind, RulePack};
use rayon::prelude::*;
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
    confidence: CoverageLevel,
    kind: EntityKind,
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
            violation.verdict = Verdict::Review;
            violation.semantic_confidence = violation
                .semantic_confidence
                .weakest(CoverageLevel::Inferred);
            if !violation.message.to_ascii_lowercase().contains("inferred") {
                violation.message.push_str(
                    "; entity identity is inferred and must be confirmed before PASS/FAIL",
                );
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
    let same_collection = rule.target == Some(rule.source);
    let mut violations = Vec::new();
    for (source_index, source) in sources.iter().enumerate() {
        for (target_index, target) in targets.iter().enumerate() {
            if same_collection && target_index <= source_index {
                continue;
            }
            if source.id == target.id {
                continue;
            }
            if rule.same_net_only && source.net_name != target.net_name {
                continue;
            }
            if rule.different_net_only
                && (source.net_name.is_none() || source.net_name == target.net_name)
            {
                continue;
            }
            let Some(measurement) = distance(
                design,
                source,
                target,
                rule.metric.unwrap_or(DistanceMetric::EdgeToEdge),
            ) else {
                violations.push(unmeasured_geometry_violation(
                    design,
                    rule,
                    analysis_id,
                    source,
                    target,
                    "required feature geometry is not available; no distance was measured",
                ));
                continue;
            };
            if measurement.measured_nm < rule.threshold_nm {
                violations.push(distance_violation(
                    design,
                    rule,
                    analysis_id,
                    source,
                    target,
                    measurement,
                ));
            }
        }
    }
    violations
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
                bounds: point.radius_nm.map_or(
                    BoundsNm {
                        min_x: point.center.x,
                        min_y: point.center.y,
                        max_x: point.center.x,
                        max_y: point.center.y,
                    },
                    |radius| BoundsNm {
                        min_x: point.center.x - radius,
                        min_y: point.center.y - radius,
                        max_x: point.center.x + radius,
                        max_y: point.center.y + radius,
                    },
                ),
                radius_nm: point.radius_nm,
                net_name: point.net_name.as_deref(),
                component_ref: point.component_ref.as_deref(),
                layer_id: test_point_layer_id(design, point),
                confidence: point.confidence,
                kind: EntityKind::TestPoint,
            })
            .collect(),
        EntityKind::Component => design
            .components
            .iter()
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
                confidence: component.confidence,
                kind: EntityKind::Component,
            })
            .collect(),
        EntityKind::Copper => design
            .layers
            .iter()
            .filter(|layer| is_conductive_function(&layer.function))
            .flat_map(|layer| {
                layer
                    .features
                    .iter()
                    .map(move |feature| feature_ref(feature, &layer.id, CoverageLevel::Explicit))
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
                    .map(move |feature| feature_ref(feature, &layer.id, CoverageLevel::Explicit))
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
            confidence: CoverageLevel::Explicit,
            kind: EntityKind::BoardEdge,
        }],
        EntityKind::PanelTab
        | EntityKind::BgaCsp
        | EntityKind::ShieldFence
        | EntityKind::UvGlue => Vec::new(),
    }
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
    confidence: CoverageLevel,
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
        confidence,
        kind: if matches!(feature.geometry, FeatureGeometry::Drill { .. }) {
            EntityKind::Drill
        } else {
            EntityKind::Copper
        },
    }
}

fn distance(
    design: &Design,
    source: &GeometryRef<'_>,
    target: &GeometryRef<'_>,
    metric: DistanceMetric,
) -> Option<DistanceResult> {
    if target.id == "board-edge" {
        let measurement = if source.kind == EntityKind::Component {
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
    let measured_nm = match metric {
        DistanceMetric::CenterToCenter => (source.center.distance_sq(target.center) as f64)
            .sqrt()
            .round() as i64,
        DistanceMetric::EdgeToEdge => ((source.center.distance_sq(target.center) as f64)
            .sqrt()
            .round() as i64
            - source.radius_nm?
            - target.radius_nm?)
            .max(0),
        DistanceMetric::BodyToPad => target
            .bounds
            .distance_to_point(source.center)
            .saturating_sub(source.radius_nm?)
            .max(0),
    };
    Some(DistanceResult {
        measured_nm,
        source_point: source.center,
        target_point: target.center,
        confidence: CoverageLevel::Explicit,
    })
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
        x_nm: source.center.x,
        y_nm: source.center.y,
        measured_value_nm: None,
        threshold_nm: Some(rule.threshold_nm),
        message: message.into(),
        evidence_points: vec![source.center],
        evidence_uris: Vec::new(),
        rule_citation: rule.citation.clone(),
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
        x_nm: center.x,
        y_nm: center.y,
        measured_value_nm: None,
        threshold_nm: Some(rule.threshold_nm),
        message: message.into(),
        evidence_points: Vec::new(),
        evidence_uris: Vec::new(),
        rule_citation: rule.citation.clone(),
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
                    if (same_collection && target_index <= source_index) || source.id == target.id {
                        continue;
                    }
                    if rule.same_net_only && source.net_name != target.net_name {
                        continue;
                    }
                    if rule.different_net_only
                        && (source.net_name.is_none() || source.net_name == target.net_name)
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
        EntityKind::TestPoint => design.coverage.test_points,
        EntityKind::Component => design.coverage.components,
        EntityKind::Copper | EntityKind::BoardEdge => design.coverage.layers,
        EntityKind::Drill => design.coverage.drills,
        EntityKind::PanelTab
        | EntityKind::BgaCsp
        | EntityKind::ShieldFence
        | EntityKind::UvGlue => CoverageLevel::Missing,
    }
}

fn required_coverage(design: &Design, rule: &RuleDefinition) -> CoverageLevel {
    rule.target
        .map(|target| coverage_for(design, rule.source).weakest(coverage_for(design, target)))
        .unwrap_or_else(|| coverage_for(design, rule.source))
}

fn nm_mm(value: i64) -> f64 {
    value as f64 / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DesignFormat, SemanticCoverage, Severity, TestPoint};
    use crate::rules::{RuleApproval, RulePackStatus};

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
            layers: Vec::new(),
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
                    layer_id: None,
                    source: "fixture".into(),
                    geometry_source: Some("fixture".into()),
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
                    layer_id: None,
                    source: "fixture".into(),
                    geometry_source: Some("fixture".into()),
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
            layers: Vec::new(),
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
                    layer_id: None,
                    source: "fixture".into(),
                    geometry_source: Some("fixture".into()),
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
                    layer_id: None,
                    source: "fixture".into(),
                    geometry_source: Some("fixture".into()),
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
}
