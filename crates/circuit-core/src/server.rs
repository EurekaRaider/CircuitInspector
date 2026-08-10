use crate::analyze::analyze_design;
use crate::archive::hash_input;
use crate::cache::CacheStore;
use crate::evidence::{render_evidence, write_html_report};
use crate::model::{BoundsNm, DesignSummary, Verdict};
use crate::parsers::import_design;
use crate::rules::{RuleApproval, RuleDefinition, RulePack, RulePackStatus, RuleReviewItem};
use crate::tile::write_tile;
use crate::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
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
        "save_rule_pack" => save_rule_pack_request(params),
        "update_rule_pack" => update_rule_pack_request(params),
        "list_rule_packs" => list_rule_packs_request(params),
        "approve_rule_pack" => approve_rule_pack_request(params),
        "analyze_design" => analyze_request(params),
        "list_analyses" => list_analyses_request(params),
        "query_violations" => query_request(params),
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
        (cache.load_design(&id)?, true)
    } else {
        let design = import_design(&params.path)?;
        cache.save_design(&design)?;
        (design, false)
    };
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
        match cache.load_json(&path) {
            Ok(design) => {
                let design: crate::model::Design = design;
                designs.push(json!({
                    "summary": DesignSummary::from_design(&design, true, 0),
                    "updated_at_unix_ms": modified_unix_ms(&path),
                }));
            }
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
    let design = cache.load_design(&params.design_id)?;
    let tile = write_tile(
        &cache,
        &design,
        params.viewport,
        &params.layer_ids,
        params.lod,
        params.max_features.clamp(1_000, 1_000_000),
    )?;
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
    let mut results = Vec::new();
    for component in &design.components {
        let distance = component.bounds.distance_to_point(params.point);
        if distance <= tolerance {
            results.push(json!({
                "kind": "COMPONENT",
                "id": component.refdes,
                "label": component.refdes,
                "layer_id": null,
                "net_name": null,
                "component_ref": component.refdes,
                "distance_nm": distance,
            }));
        }
    }
    for point in &design.test_points {
        let distance = ((point.center.distance_sq(params.point) as f64)
            .sqrt()
            .round() as i64)
            .saturating_sub(point.radius_nm)
            .max(0);
        if distance <= tolerance {
            results.push(json!({
                "kind": "TEST_POINT",
                "id": point.id,
                "label": point.id,
                "layer_id": null,
                "net_name": point.net_name,
                "component_ref": point.component_ref,
                "distance_nm": distance,
            }));
        }
    }
    for layer in &design.layers {
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
    struct Params {
        cache_dir: PathBuf,
        rule_pack_id: String,
        rules: Vec<RuleDefinition>,
        #[serde(default)]
        acknowledged_review_item_ids: Vec<String>,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(&params.cache_dir)?;
    let path = rule_path(&cache, &params.rule_pack_id);
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
    for item in &mut pack.review_items {
        item.acknowledged = acknowledged.contains(item.id.as_str());
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
    let path = rule_path(&cache, &params.rule_pack_id);
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
    let rule_pack: RulePack = cache.load_json(&rule_path(&cache, &params.rule_pack_id))?;
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
                "acknowledged_review_item_ids": [review_id]
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
    }
}

#[allow(dead_code)]
fn _is_file(path: &Path) -> bool {
    path.is_file()
}
