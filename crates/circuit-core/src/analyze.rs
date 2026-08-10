use crate::CoreResult;
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
    radius_nm: i64,
    net_name: Option<&'a str>,
    component_ref: Option<&'a str>,
    layer_id: Option<&'a str>,
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
    let mut review_count = 0;
    let mut not_applicable_count = 0;
    for outcome in per_rule {
        match outcome.verdict {
            Verdict::Pass => pass_count += 1,
            Verdict::Review => review_count += 1,
            Verdict::NotApplicable => not_applicable_count += 1,
            Verdict::Fail => {}
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
            verdict: Verdict::NotApplicable,
            violations: vec![review_violation(
                design,
                rule,
                analysis_id,
                Verdict::NotApplicable,
                "required semantic data is missing",
            )],
        };
    }
    if matches!(coverage, CoverageLevel::Inferred) {
        return RuleOutcome {
            verdict: Verdict::Review,
            violations: vec![review_violation(
                design,
                rule,
                analysis_id,
                Verdict::Review,
                "required entities are inferred and must be confirmed before PASS/FAIL",
            )],
        };
    }
    let violations = match rule.kind {
        RuleKind::MinimumDistance => evaluate_distance(design, rule, analysis_id),
        RuleKind::MinimumWidth => evaluate_width(design, rule, analysis_id),
        RuleKind::MinimumAnnularRing => evaluate_annular_ring(design, rule, analysis_id),
    };
    RuleOutcome {
        verdict: if violations.is_empty() {
            Verdict::Pass
        } else {
            Verdict::Fail
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
            let measured = distance(
                source,
                target,
                rule.metric.unwrap_or(DistanceMetric::EdgeToEdge),
            );
            if measured < rule.threshold_nm {
                violations.push(distance_violation(
                    design,
                    rule,
                    analysis_id,
                    source,
                    target,
                    measured,
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
        let ring = pad.radius_nm - drill.radius_nm;
        if ring < rule.threshold_nm {
            violations.push(distance_violation(
                design,
                rule,
                analysis_id,
                &drill,
                pad,
                ring,
            ));
        }
    }
    violations
}

fn entities(design: &Design, kind: EntityKind) -> Vec<GeometryRef<'_>> {
    match kind {
        EntityKind::TestPoint => design
            .test_points
            .iter()
            .map(|point| GeometryRef {
                id: &point.id,
                center: point.center,
                bounds: BoundsNm {
                    min_x: point.center.x - point.radius_nm,
                    min_y: point.center.y - point.radius_nm,
                    max_x: point.center.x + point.radius_nm,
                    max_y: point.center.y + point.radius_nm,
                },
                radius_nm: point.radius_nm,
                net_name: point.net_name.as_deref(),
                component_ref: point.component_ref.as_deref(),
                layer_id: None,
                confidence: point.confidence,
            })
            .collect(),
        EntityKind::Component => design
            .components
            .iter()
            .map(|component| GeometryRef {
                id: &component.refdes,
                center: component.center,
                bounds: component.bounds,
                radius_nm: ((component.bounds.max_x - component.bounds.min_x)
                    .max(component.bounds.max_y - component.bounds.min_y))
                    / 2,
                net_name: None,
                component_ref: Some(&component.refdes),
                layer_id: None,
                confidence: component.confidence,
            })
            .collect(),
        EntityKind::Copper => design
            .layers
            .iter()
            .filter(|layer| layer.function.to_ascii_uppercase().contains("COPPER"))
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
            radius_nm: 0,
            net_name: None,
            component_ref: None,
            layer_id: None,
            confidence: CoverageLevel::Explicit,
        }],
    }
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
        } => size_x_nm.min(size_y_nm) / 2,
        FeatureGeometry::Drill { diameter_nm, .. } => diameter_nm / 2,
        FeatureGeometry::Line { width_nm, .. } | FeatureGeometry::Arc { width_nm, .. } => {
            width_nm / 2
        }
        _ => 0,
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
    }
}

fn distance(source: &GeometryRef<'_>, target: &GeometryRef<'_>, metric: DistanceMetric) -> i64 {
    if target.id == "board-edge" {
        let horizontal =
            (source.center.x - target.bounds.min_x).min(target.bounds.max_x - source.center.x);
        let vertical =
            (source.center.y - target.bounds.min_y).min(target.bounds.max_y - source.center.y);
        return horizontal
            .min(vertical)
            .saturating_sub(source.radius_nm)
            .max(0);
    }
    match metric {
        DistanceMetric::CenterToCenter => (source.center.distance_sq(target.center) as f64)
            .sqrt()
            .round() as i64,
        DistanceMetric::EdgeToEdge => ((source.center.distance_sq(target.center) as f64)
            .sqrt()
            .round() as i64
            - source.radius_nm
            - target.radius_nm)
            .max(0),
        DistanceMetric::BodyToPad => target
            .bounds
            .distance_to_point(source.center)
            .saturating_sub(source.radius_nm)
            .max(0),
    }
}

fn distance_violation(
    design: &Design,
    rule: &RuleDefinition,
    analysis_id: &str,
    source: &GeometryRef<'_>,
    target: &GeometryRef<'_>,
    measured: i64,
) -> Violation {
    let midpoint = PointNm {
        x: source
            .center
            .x
            .saturating_add((target.center.x - source.center.x) / 2),
        y: source
            .center
            .y
            .saturating_add((target.center.y - source.center.y) / 2),
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
        verdict: if matches!(
            source.confidence.weakest(target.confidence),
            CoverageLevel::Inferred
        ) {
            Verdict::Review
        } else {
            Verdict::Fail
        },
        source_format: design.format.clone(),
        semantic_confidence: source.confidence.weakest(target.confidence),
        net_names: nets,
        component_refs: components,
        layer_ids: layers,
        x_nm: midpoint.x,
        y_nm: midpoint.y,
        measured_value_nm: Some(measured),
        threshold_nm: Some(rule.threshold_nm),
        message: format!(
            "measured {:.3} mm is below {:.3} mm",
            nm_mm(measured),
            nm_mm(rule.threshold_nm)
        ),
        evidence_points: vec![source.center, target.center],
        evidence_uris: Vec::new(),
        rule_citation: rule.citation.clone(),
    }
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
    fn finds_testpoint_spacing_failure() {
        let design = Design {
            schema_version: 1,
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
                    radius_nm: 100_000,
                    net_name: Some("A".into()),
                    component_ref: None,
                    confidence: CoverageLevel::Explicit,
                    source: "fixture".into(),
                },
                TestPoint {
                    id: "b".into(),
                    center: PointNm {
                        x: 1_400_000,
                        y: 1_000_000,
                    },
                    radius_nm: 100_000,
                    net_name: Some("B".into()),
                    component_ref: None,
                    confidence: CoverageLevel::Explicit,
                    source: "fixture".into(),
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
            rules: vec![RuleDefinition {
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
            }],
            review_items: Vec::new(),
            approval: Some(RuleApproval {
                approved_by: "fixture".into(),
                approved_at: "2026-08-07T00:00:00Z".into(),
                content_hash: "approved".into(),
            }),
        };
        let analysis = analyze_design(&design, &pack).unwrap();
        assert_eq!(analysis.fail_count, 1);
    }

    #[test]
    fn missing_target_semantics_cannot_be_reported_as_pass() {
        let mut design = Design {
            schema_version: 1,
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
                radius_nm: 100_000,
                net_name: Some("A".into()),
                component_ref: None,
                confidence: CoverageLevel::Explicit,
                source: "fixture".into(),
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
        assert_eq!(analysis.verdict, Verdict::NotApplicable);
        assert_eq!(analysis.fail_count, 0);
        assert_eq!(analysis.not_applicable_count, 1);
        assert_eq!(
            analysis.violations[0].semantic_confidence,
            CoverageLevel::Missing
        );
    }
}
