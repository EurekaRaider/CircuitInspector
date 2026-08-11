use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoverageLevel {
    Explicit,
    Supplemented,
    Inferred,
    #[default]
    Missing,
}

impl CoverageLevel {
    pub fn combine(self, other: Self) -> Self {
        use CoverageLevel::*;
        match (self, other) {
            (Explicit, _) | (_, Explicit) => Explicit,
            (Supplemented, _) | (_, Supplemented) => Supplemented,
            (Inferred, _) | (_, Inferred) => Inferred,
            _ => Missing,
        }
    }

    /// Returns the weakest evidence level when multiple entities are required
    /// for one rule result. This is intentionally different from `combine`,
    /// which merges alternative semantic sources and keeps the strongest one.
    pub fn weakest(self, other: Self) -> Self {
        use CoverageLevel::*;
        match (self, other) {
            (Missing, _) | (_, Missing) => Missing,
            (Inferred, _) | (_, Inferred) => Inferred,
            (Supplemented, _) | (_, Supplemented) => Supplemented,
            _ => Explicit,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DesignFormat {
    Odbpp,
    GerberPackage,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Side {
    Top,
    Bottom,
    Inner,
    #[default]
    Na,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Polarity {
    #[default]
    Dark,
    Clear,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct PointNm {
    pub x: i64,
    pub y: i64,
}

impl PointNm {
    pub fn distance_sq(self, other: Self) -> i128 {
        let dx = i128::from(self.x) - i128::from(other.x);
        let dy = i128::from(self.y) - i128::from(other.y);
        dx * dx + dy * dy
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct BoundsNm {
    pub min_x: i64,
    pub min_y: i64,
    pub max_x: i64,
    pub max_y: i64,
}

impl Default for BoundsNm {
    fn default() -> Self {
        Self::empty()
    }
}

impl BoundsNm {
    pub fn empty() -> Self {
        Self {
            min_x: i64::MAX,
            min_y: i64::MAX,
            max_x: i64::MIN,
            max_y: i64::MIN,
        }
    }

    pub fn is_empty(self) -> bool {
        self.min_x > self.max_x || self.min_y > self.max_y
    }

    pub fn include_point(&mut self, point: PointNm) {
        self.min_x = self.min_x.min(point.x);
        self.min_y = self.min_y.min(point.y);
        self.max_x = self.max_x.max(point.x);
        self.max_y = self.max_y.max(point.y);
    }

    pub fn include_bounds(&mut self, other: Self) {
        if other.is_empty() {
            return;
        }
        self.include_point(PointNm {
            x: other.min_x,
            y: other.min_y,
        });
        self.include_point(PointNm {
            x: other.max_x,
            y: other.max_y,
        });
    }

    pub fn normalized(self) -> Self {
        if self.is_empty() {
            Self {
                min_x: 0,
                min_y: 0,
                max_x: 1,
                max_y: 1,
            }
        } else {
            self
        }
    }

    pub fn intersects(self, other: Self) -> bool {
        self.min_x <= other.max_x
            && self.max_x >= other.min_x
            && self.min_y <= other.max_y
            && self.max_y >= other.min_y
    }

    pub fn center(self) -> PointNm {
        PointNm {
            x: self.min_x.saturating_add((self.max_x - self.min_x) / 2),
            y: self.min_y.saturating_add((self.max_y - self.min_y) / 2),
        }
    }

    pub fn distance_to_point(self, point: PointNm) -> i64 {
        let dx = if point.x < self.min_x {
            self.min_x - point.x
        } else if point.x > self.max_x {
            point.x - self.max_x
        } else {
            0
        };
        let dy = if point.y < self.min_y {
            self.min_y - point.y
        } else if point.y > self.max_y {
            point.y - self.max_y
        } else {
            0
        };
        ((dx as f64).hypot(dy as f64)).round() as i64
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FeatureGeometry {
    Line {
        start: PointNm,
        end: PointNm,
        width_nm: i64,
    },
    Arc {
        start: PointNm,
        end: PointNm,
        center: PointNm,
        clockwise: bool,
        width_nm: i64,
    },
    Pad {
        center: PointNm,
        size_x_nm: i64,
        size_y_nm: i64,
        rotation_deg: f64,
    },
    Region {
        points: Vec<PointNm>,
    },
    Drill {
        center: PointNm,
        diameter_nm: i64,
        plated: Option<bool>,
    },
    ComponentBody {
        bounds: BoundsNm,
    },
}

impl FeatureGeometry {
    pub fn bounds(&self) -> BoundsNm {
        match self {
            Self::Line {
                start,
                end,
                width_nm,
            } => {
                let radius = width_nm / 2;
                BoundsNm {
                    min_x: start.x.min(end.x) - radius,
                    min_y: start.y.min(end.y) - radius,
                    max_x: start.x.max(end.x) + radius,
                    max_y: start.y.max(end.y) + radius,
                }
            }
            Self::Arc {
                start,
                end,
                center,
                width_nm,
                ..
            } => {
                let radius =
                    (((start.distance_sq(*center)) as f64).sqrt().round() as i64) + width_nm / 2;
                BoundsNm {
                    min_x: center.x - radius,
                    min_y: center.y - radius,
                    max_x: center.x + radius,
                    max_y: center.y + radius,
                }
                .with_endpoints(*start, *end)
            }
            Self::Pad {
                center,
                size_x_nm,
                size_y_nm,
                ..
            } => BoundsNm {
                min_x: center.x - size_x_nm / 2,
                min_y: center.y - size_y_nm / 2,
                max_x: center.x + size_x_nm / 2,
                max_y: center.y + size_y_nm / 2,
            },
            Self::Region { points } => {
                let mut bounds = BoundsNm::empty();
                for point in points {
                    bounds.include_point(*point);
                }
                bounds.normalized()
            }
            Self::Drill {
                center,
                diameter_nm,
                ..
            } => {
                let radius = diameter_nm / 2;
                BoundsNm {
                    min_x: center.x - radius,
                    min_y: center.y - radius,
                    max_x: center.x + radius,
                    max_y: center.y + radius,
                }
            }
            Self::ComponentBody { bounds } => *bounds,
        }
    }
}

impl BoundsNm {
    fn with_endpoints(mut self, start: PointNm, end: PointNm) -> Self {
        self.include_point(start);
        self.include_point(end);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Feature {
    pub id: String,
    pub layer_id: String,
    pub polarity: Polarity,
    pub geometry: FeatureGeometry,
    pub net_name: Option<String>,
    pub component_ref: Option<String>,
    pub pin: Option<String>,
    pub attributes: BTreeMap<String, String>,
    pub source: String,
}

impl Feature {
    pub fn has_tooling_hole_usage(&self) -> bool {
        self.attributes.iter().any(|(key, value)| {
            key.trim_start_matches('.')
                .eq_ignore_ascii_case("pad_usage")
                && value.eq_ignore_ascii_case("tooling_hole")
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layer {
    pub id: String,
    pub name: String,
    pub function: String,
    pub side: Side,
    pub features: Vec<Feature>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Component {
    pub refdes: String,
    #[serde(default)]
    pub package_name: Option<String>,
    pub center: PointNm,
    pub bounds: BoundsNm,
    pub side: Side,
    pub pins: Vec<String>,
    pub confidence: CoverageLevel,
}

impl Component {
    pub fn is_test_point_marker(&self) -> bool {
        let reference = self.refdes.to_ascii_uppercase();
        let reference_match = ["MTP", "TP"].iter().any(|prefix| {
            reference.strip_prefix(prefix).is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix
                        .chars()
                        .all(|value| value.is_ascii_digit() || value == '_')
            })
        });
        let package_match = self.package_name.as_deref().is_some_and(|value| {
            let normalized = value.to_ascii_uppercase();
            [
                "TEST_POINT",
                "TESTPOINT",
                "TEST_PAD",
                "TESTPAD",
                "PROBE_PAD",
                "PROBEPAD",
            ]
            .iter()
            .any(|token| normalized.contains(token))
        });
        reference_match || package_match
    }

    pub fn is_shield_candidate(&self) -> bool {
        let reference = self.refdes.to_ascii_uppercase();
        let reference_match = reference.starts_with("SHIELD")
            || reference.strip_prefix("SH").is_some_and(|suffix| {
                !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_digit())
            });
        let package_match = self.package_name.as_deref().is_some_and(|value| {
            let normalized = value
                .to_ascii_uppercase()
                .replace(|character: char| !character.is_ascii_alphanumeric(), "_");
            [
                "EMI_SHIELD",
                "RF_SHIELD",
                "SHIELD_CAN",
                "SHIELD_FRAME",
                "SHIELD_FENCE",
                "SHIELD_COVER",
                "EMI_CAN",
                "RF_CAN",
            ]
            .iter()
            .any(|token| normalized.contains(token))
        });
        reference_match || package_match
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestPoint {
    pub id: String,
    pub center: PointNm,
    pub radius_nm: Option<i64>,
    pub net_name: Option<String>,
    pub component_ref: Option<String>,
    pub confidence: CoverageLevel,
    pub layer_id: Option<String>,
    pub source: String,
    pub geometry_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SemanticCoverage {
    pub layers: CoverageLevel,
    pub nets: CoverageLevel,
    pub components: CoverageLevel,
    pub pins: CoverageLevel,
    pub test_points: CoverageLevel,
    pub drills: CoverageLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Design {
    pub schema_version: u32,
    pub id: String,
    pub format: DesignFormat,
    pub source_path: String,
    pub content_hash: String,
    pub bounds: BoundsNm,
    pub layers: Vec<Layer>,
    pub components: Vec<Component>,
    pub nets: Vec<String>,
    pub test_points: Vec<TestPoint>,
    pub coverage: SemanticCoverage,
    pub diagnostics: Vec<Diagnostic>,
}

impl Design {
    pub const SCHEMA_VERSION: u32 = 4;

    pub fn finalize(&mut self) {
        let mut bounds = BoundsNm::empty();
        for layer in &self.layers {
            for feature in &layer.features {
                bounds.include_bounds(feature.geometry.bounds());
            }
        }
        for component in &self.components {
            bounds.include_bounds(component.bounds);
        }
        self.bounds = bounds.normalized();
        self.nets.sort();
        self.nets.dedup();
    }

    pub fn tooling_hole_drills(&self) -> Vec<(&Layer, &Feature)> {
        const SEMANTIC_MATCH_TOLERANCE_NM: i64 = 25_000;
        let markers = self
            .layers
            .iter()
            .flat_map(|layer| &layer.features)
            .filter(|feature| feature.has_tooling_hole_usage())
            .map(|feature| feature.geometry.bounds().center())
            .collect::<Vec<_>>();
        self.layers
            .iter()
            .flat_map(|layer| {
                let markers = &markers;
                layer.features.iter().filter_map(move |feature| {
                    let FeatureGeometry::Drill { center, .. } = feature.geometry else {
                        return None;
                    };
                    (feature.has_tooling_hole_usage()
                        || markers.iter().any(|marker| {
                            marker.distance_sq(center)
                                <= i128::from(SEMANTIC_MATCH_TOLERANCE_NM).pow(2)
                        }))
                    .then_some((layer, feature))
                })
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignSummary {
    pub id: String,
    pub format: DesignFormat,
    pub source_path: String,
    pub content_hash: String,
    pub bounds: BoundsNm,
    pub layers: Vec<LayerSummary>,
    pub component_count: usize,
    pub net_count: usize,
    pub test_point_count: usize,
    pub drill_count: usize,
    pub semantic_coverage: SemanticCoverage,
    pub diagnostics: Vec<Diagnostic>,
    pub cache_hit: bool,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerSummary {
    pub id: String,
    pub name: String,
    pub function: String,
    pub side: Side,
    pub feature_count: usize,
}

impl DesignSummary {
    pub fn from_design(design: &Design, cache_hit: bool, elapsed_ms: u128) -> Self {
        let drill_count = design
            .layers
            .iter()
            .flat_map(|layer| &layer.features)
            .filter(|feature| matches!(feature.geometry, FeatureGeometry::Drill { .. }))
            .count();
        Self {
            id: design.id.clone(),
            format: design.format.clone(),
            source_path: design.source_path.clone(),
            content_hash: design.content_hash.clone(),
            bounds: design.bounds,
            layers: design
                .layers
                .iter()
                .map(|layer| LayerSummary {
                    id: layer.id.clone(),
                    name: layer.name.clone(),
                    function: layer.function.clone(),
                    side: layer.side,
                    feature_count: layer.features.len(),
                })
                .collect(),
            component_count: design.components.len(),
            net_count: design.nets.len(),
            test_point_count: design.test_points.len(),
            drill_count,
            semantic_coverage: design.coverage.clone(),
            diagnostics: design.diagnostics.clone(),
            cache_hit,
            elapsed_ms,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Verdict {
    Pass,
    Fail,
    Review,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleCitation {
    pub source_path: String,
    pub source_hash: String,
    pub page: Option<u32>,
    pub paragraph: Option<u32>,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Violation {
    pub id: String,
    pub analysis_id: String,
    pub rule_id: String,
    pub title: String,
    pub severity: Severity,
    pub verdict: Verdict,
    pub source_format: DesignFormat,
    pub semantic_confidence: CoverageLevel,
    pub net_names: Vec<String>,
    pub component_refs: Vec<String>,
    pub layer_ids: Vec<String>,
    pub x_nm: i64,
    pub y_nm: i64,
    pub measured_value_nm: Option<i64>,
    pub threshold_nm: Option<i64>,
    pub message: String,
    #[serde(default)]
    pub evidence_points: Vec<PointNm>,
    pub evidence_uris: Vec<String>,
    pub rule_citation: Option<RuleCitation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisSummary {
    pub id: String,
    pub design_id: String,
    pub rule_pack_id: String,
    pub verdict: Verdict,
    pub pass_count: usize,
    pub fail_count: usize,
    pub review_count: usize,
    pub not_applicable_count: usize,
    pub violations: Vec<Violation>,
    pub report_uri: String,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileDescriptor {
    pub path: String,
    pub feature_count: usize,
    pub bounds: BoundsNm,
    pub lod: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_distance_is_edge_to_point() {
        let bounds = BoundsNm {
            min_x: 0,
            min_y: 0,
            max_x: 10,
            max_y: 10,
        };
        assert_eq!(bounds.distance_to_point(PointNm { x: 5, y: 5 }), 0);
        assert_eq!(bounds.distance_to_point(PointNm { x: 13, y: 14 }), 5);
    }
}
