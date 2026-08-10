use crate::model::{RuleCitation, Severity};
use crate::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RulePackStatus {
    Draft,
    Approved,
    Deprecated,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EntityKind {
    TestPoint,
    Component,
    Copper,
    BoardEdge,
    Drill,
    PanelTab,
    BgaCsp,
    ShieldFence,
    UvGlue,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuleKind {
    MinimumDistance,
    MinimumWidth,
    MinimumAnnularRing,
    MinimumDiameter,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DistanceMetric {
    CenterToCenter,
    EdgeToEdge,
    BodyToPad,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleDefinition {
    pub id: String,
    pub title: String,
    pub kind: RuleKind,
    pub source: EntityKind,
    pub target: Option<EntityKind>,
    pub metric: Option<DistanceMetric>,
    pub threshold_nm: i64,
    pub severity: Option<Severity>,
    #[serde(default)]
    pub layer_functions: Vec<String>,
    #[serde(default)]
    pub same_net_only: bool,
    #[serde(default)]
    pub different_net_only: bool,
    pub citation: Option<RuleCitation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleReviewItem {
    pub id: String,
    pub code: String,
    pub message: String,
    pub acknowledged: bool,
    pub citation: RuleCitation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleApproval {
    pub approved_by: String,
    pub approved_at: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RulePack {
    pub id: String,
    pub version: String,
    pub title: String,
    pub status: RulePackStatus,
    pub rules: Vec<RuleDefinition>,
    #[serde(default)]
    pub review_items: Vec<RuleReviewItem>,
    pub approval: Option<RuleApproval>,
}

impl RulePack {
    pub fn validate_for_approval(&self) -> CoreResult<()> {
        if self.rules.is_empty() {
            return Err(CoreError::Rule(format!(
                "rule pack {} has no executable rules",
                self.id
            )));
        }
        if self.review_items.iter().any(|item| !item.acknowledged) {
            return Err(CoreError::Rule(format!(
                "rule pack {} has unacknowledged extraction review items",
                self.id
            )));
        }
        for rule in &self.rules {
            if rule.severity.is_none() {
                return Err(CoreError::Rule(format!(
                    "rule {} has no confirmed severity",
                    rule.id
                )));
            }
            if rule.threshold_nm <= 0 {
                return Err(CoreError::Rule(format!(
                    "rule {} has a non-positive threshold",
                    rule.id
                )));
            }
            match rule.kind {
                RuleKind::MinimumDistance if rule.target.is_none() || rule.metric.is_none() => {
                    return Err(CoreError::Rule(format!(
                        "distance rule {} lacks target or metric",
                        rule.id
                    )));
                }
                RuleKind::MinimumWidth
                    if rule.source != EntityKind::Copper
                        || rule.target.is_some()
                        || rule.metric.is_some() =>
                {
                    return Err(CoreError::Rule(format!(
                        "width rule {} must measure COPPER without a target or distance metric",
                        rule.id
                    )));
                }
                RuleKind::MinimumAnnularRing
                    if rule.source != EntityKind::Drill
                        || rule.target != Some(EntityKind::Copper)
                        || rule.metric.is_some() =>
                {
                    return Err(CoreError::Rule(format!(
                        "annular-ring rule {} must measure DRILL to COPPER without a distance metric",
                        rule.id
                    )));
                }
                RuleKind::MinimumDiameter
                    if rule.source != EntityKind::TestPoint
                        || rule.target.is_some()
                        || rule.metric.is_some() =>
                {
                    return Err(CoreError::Rule(format!(
                        "diameter rule {} must measure TEST_POINT without a target or distance metric",
                        rule.id
                    )));
                }
                _ => {}
            }
            if rule.same_net_only && rule.different_net_only {
                return Err(CoreError::Rule(format!(
                    "rule {} cannot require both same-net and different-net filtering",
                    rule.id
                )));
            }
        }
        Ok(())
    }

    pub fn validate_for_analysis(&self) -> CoreResult<()> {
        if self.status != RulePackStatus::Approved {
            return Err(CoreError::Rule(format!(
                "rule pack {} is not approved",
                self.id
            )));
        }
        if self.approval.is_none() {
            return Err(CoreError::Rule(format!(
                "rule pack {} has no approval record",
                self.id
            )));
        }
        self.validate_for_approval()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_pack_cannot_run() {
        let pack = RulePack {
            id: "draft".into(),
            version: "1".into(),
            title: "Draft".into(),
            status: RulePackStatus::Draft,
            rules: Vec::new(),
            review_items: Vec::new(),
            approval: None,
        };
        assert!(pack.validate_for_analysis().is_err());
    }

    #[test]
    fn approval_requires_confirmed_severity_and_review_acknowledgement() {
        let citation = RuleCitation {
            source_path: "rules.pdf".into(),
            source_hash: "hash".into(),
            page: Some(1),
            paragraph: Some(1),
            excerpt: "At least 1.2 mm".into(),
        };
        let mut pack = RulePack {
            id: "draft".into(),
            version: "0.2.0-draft".into(),
            title: "Draft".into(),
            status: RulePackStatus::Draft,
            rules: vec![RuleDefinition {
                id: "tp-edge".into(),
                title: "Test point to board edge".into(),
                kind: RuleKind::MinimumDistance,
                source: EntityKind::TestPoint,
                target: Some(EntityKind::BoardEdge),
                metric: Some(DistanceMetric::EdgeToEdge),
                threshold_nm: 1_200_000,
                severity: None,
                layer_functions: Vec::new(),
                same_net_only: false,
                different_net_only: false,
                citation: Some(citation.clone()),
            }],
            review_items: vec![RuleReviewItem {
                id: "review-1".into(),
                code: "NON_EXECUTABLE_GUIDANCE".into(),
                message: "Not executable".into(),
                acknowledged: false,
                citation,
            }],
            approval: None,
        };

        assert!(pack.validate_for_approval().is_err());
        pack.rules[0].severity = Some(Severity::Error);
        pack.review_items[0].acknowledged = true;
        assert!(pack.validate_for_approval().is_ok());
    }
}
