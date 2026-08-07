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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuleKind {
    MinimumDistance,
    MinimumWidth,
    MinimumAnnularRing,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DistanceMetric {
    CenterToCenter,
    EdgeToEdge,
    BodyToPad,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleDefinition {
    pub id: String,
    pub title: String,
    pub kind: RuleKind,
    pub source: EntityKind,
    pub target: Option<EntityKind>,
    pub metric: Option<DistanceMetric>,
    pub threshold_nm: i64,
    pub severity: Severity,
    #[serde(default)]
    pub layer_functions: Vec<String>,
    #[serde(default)]
    pub same_net_only: bool,
    #[serde(default)]
    pub different_net_only: bool,
    pub citation: Option<RuleCitation>,
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
    pub approval: Option<RuleApproval>,
}

impl RulePack {
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
        for rule in &self.rules {
            if rule.threshold_nm <= 0 {
                return Err(CoreError::Rule(format!(
                    "rule {} has a non-positive threshold",
                    rule.id
                )));
            }
            if rule.kind == RuleKind::MinimumDistance
                && (rule.target.is_none() || rule.metric.is_none())
            {
                return Err(CoreError::Rule(format!(
                    "distance rule {} lacks target or metric",
                    rule.id
                )));
            }
        }
        Ok(())
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
            approval: None,
        };
        assert!(pack.validate_for_analysis().is_err());
    }
}
