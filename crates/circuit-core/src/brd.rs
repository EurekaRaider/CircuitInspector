use crate::analyze::analyze_design_with_rule_ids;
use crate::archive::hash_input;
use crate::cache::CacheStore;
use crate::evidence::write_html_report;
use crate::model::{
    AnalysisSummary, BoundsNm, CoverageLevel, Design, DesignFormat, Diagnostic, Feature,
    FeatureGeometry, PointNm, Severity, Side, TestPoint, TestPointConfirmation,
    TestPointConfirmationMethod, Verdict,
};
use crate::rules::{EntityKind, RulePack};
use crate::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const REVIEW_CSV_HEADERS: [&str; 16] = [
    "schema_version",
    "catalog_id",
    "brd_sha256",
    "candidate_id",
    "source_kind",
    "identity_confidence",
    "refdes",
    "net_name",
    "side",
    "x_mm",
    "y_mm",
    "pad_shape",
    "pad_width_mm",
    "pad_height_mm",
    "decision",
    "comment",
];
const DEFAULT_KICAD_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_TOOL_OUTPUT_BYTES: usize = 1_048_576;
const MAX_REVIEW_CSV_BYTES: u64 = 64 * 1024 * 1024;
const BRD_CATALOG_PARSER_REVISION: u32 = 2;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ArtifactLifecycle {
    Draft,
    Approved,
    Superseded,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TestPointDecision {
    Required,
    NotRequired,
    Review,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactApproval {
    pub approved_by: String,
    pub approved_at: String,
    pub content_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConverterEvidence {
    pub name: String,
    pub version: String,
    pub executable_path: String,
    pub report_path: String,
    pub report_hash: String,
    pub intermediate_path: String,
    pub intermediate_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrdTestPointCandidate {
    pub id: String,
    pub source_kind: String,
    pub identity_confidence: CoverageLevel,
    pub refdes: Option<String>,
    pub net_name: Option<String>,
    pub side: Side,
    pub center: PointNm,
    pub pad_shape: Option<String>,
    pub pad_width_nm: Option<i64>,
    pub pad_height_nm: Option<i64>,
    pub source_evidence: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrdTestPointCatalog {
    pub schema_version: u32,
    #[serde(default)]
    pub parser_revision: u32,
    pub kind: String,
    pub id: String,
    pub source_path: String,
    pub brd_sha256: String,
    pub declared_allegro_version: Option<String>,
    pub detected_allegro_version: Option<String>,
    pub product_revision: Option<String>,
    pub bounds: BoundsNm,
    pub converter: ConverterEvidence,
    pub candidates: Vec<BrdTestPointCandidate>,
    pub diagnostics: Vec<Diagnostic>,
    pub review_csv_path: String,
    pub generated_at: String,
    pub content_hash: String,
    #[serde(default)]
    pub cache_hit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestPointSelectionDecision {
    pub candidate_id: String,
    pub decision: TestPointDecision,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestPointSelection {
    pub schema_version: u32,
    pub kind: String,
    pub id: String,
    pub catalog_id: String,
    pub catalog_content_hash: String,
    pub brd_sha256: String,
    pub lifecycle_status: ArtifactLifecycle,
    pub decisions: Vec<TestPointSelectionDecision>,
    pub imported_by: String,
    pub imported_at: String,
    pub unresolved_count: usize,
    pub approval: Option<ArtifactApproval>,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AlignmentAnchor {
    pub candidate_id: String,
    pub design_point: PointNm,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TestPointTransform {
    pub rotation_deg: i32,
    pub mirrored: bool,
    pub swap_sides: bool,
    pub translate_x_nm: i64,
    pub translate_y_nm: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlignmentScore {
    pub transform: TestPointTransform,
    pub unique_matches: usize,
    pub ambiguous_matches: usize,
    pub unmatched: usize,
    pub outline_residual_nm: i64,
    pub anchor_max_residual_nm: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestPointAlignment {
    pub schema_version: u32,
    pub kind: String,
    pub id: String,
    pub lifecycle_status: ArtifactLifecycle,
    pub selection_id: String,
    pub selection_content_hash: String,
    pub catalog_id: String,
    pub design_id: String,
    pub design_content_hash: String,
    pub selected: AlignmentScore,
    pub alternatives: Vec<AlignmentScore>,
    #[serde(default)]
    pub preview_bindings: Vec<SelectedTestPointBinding>,
    pub anchors: Vec<AlignmentAnchor>,
    pub requires_manual_anchors: bool,
    pub generated_at: String,
    pub approval: Option<ArtifactApproval>,
    pub content_hash: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BindingStatus {
    Pass,
    Review,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectedTestPointBinding {
    pub candidate_id: String,
    pub decision: TestPointDecision,
    pub status: BindingStatus,
    pub transformed_center: PointNm,
    pub side: Side,
    pub matched_feature_id: Option<String>,
    pub matched_layer_id: Option<String>,
    pub matched_net_name: Option<String>,
    pub matched_center: Option<PointNm>,
    pub matched_width_nm: Option<i64>,
    pub matched_height_nm: Option<i64>,
    #[serde(default)]
    pub shield_candidate_refdes: Option<String>,
    #[serde(default)]
    pub shield_identity_confidence: Option<CoverageLevel>,
    #[serde(default)]
    pub shield_bounds: Option<BoundsNm>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisStaleState {
    pub is_stale: bool,
    pub reason: String,
    pub invalidated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectedTestPointAnalysis {
    pub schema_version: u32,
    pub kind: String,
    pub id: String,
    pub design_id: String,
    pub design_content_hash: String,
    pub derived_design_id: String,
    pub catalog_id: String,
    pub catalog_content_hash: String,
    pub selection_id: String,
    pub selection_content_hash: String,
    pub alignment_id: String,
    pub alignment_content_hash: String,
    pub rule_pack_id: String,
    pub rule_pack_content_hash: String,
    pub geometry_analysis_id: String,
    pub verdict: Verdict,
    pub production_readiness_verdict: Verdict,
    pub pass_count: usize,
    pub fail_count: usize,
    pub review_count: usize,
    pub not_applicable_count: usize,
    pub required_count: usize,
    pub bindings: Vec<SelectedTestPointBinding>,
    pub violations: Vec<crate::model::Violation>,
    pub diagnostics: Vec<Diagnostic>,
    pub report_uri: String,
    pub report_path: String,
    pub elapsed_ms: u128,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale: Option<AnalysisStaleState>,
}

pub fn import_brd_test_points_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        path: PathBuf,
        cache_dir: PathBuf,
        declared_allegro_version: Option<String>,
        product_revision: Option<String>,
    }
    let params: Params = serde_json::from_value(params)?;
    if params
        .path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("brd"))
    {
        return Err(CoreError::InvalidInput(
            "Cadence Allegro input must use the .brd extension".into(),
        ));
    }
    let cache = CacheStore::new(&params.cache_dir)?;
    let brd_sha256 = hash_input(&params.path)?;
    let (kicad_path, kicad_version) = resolve_kicad_cli()?;
    if let Some(mut catalog) = find_cached_catalog(
        &cache,
        &brd_sha256,
        &kicad_version,
        &params.path.display().to_string(),
        params.declared_allegro_version.as_deref(),
        params.product_revision.as_deref(),
    )? {
        catalog.cache_hit = true;
        return Ok(serde_json::to_value(catalog)?);
    }
    let temporary = tempfile::Builder::new()
        .prefix("circuitinspector-brd-")
        .tempdir_in(cache.root())?;
    let intermediate = temporary.path().join("converted.kicad_pcb");
    let report = temporary.path().join("import-report.json");
    run_kicad_import(&kicad_path, &params.path, &intermediate, &report)?;
    let intermediate_hash = hash_input(&intermediate)?;
    let report_hash = hash_input(&report)?;
    let text = fs::read_to_string(&intermediate)
        .map_err(|error| CoreError::Parse(format!("KiCad output is not valid UTF-8: {error}")))?;
    let parsed = parse_kicad_board(&text)?;
    let report_text = read_capped(&report, MAX_TOOL_OUTPUT_BYTES)?;
    let report_json = parse_kicad_report(&report_text)?;
    let detected_allegro_version = detect_allegro_version(&report_text);
    let mut diagnostics = parsed.diagnostics;
    if report_has_warnings(&report_json) {
        diagnostics.push(diagnostic(
            "KICAD_IMPORT_WARNING",
            Severity::Warning,
            "KiCad reported one or more import warnings; review the cached JSON report before approving the TP catalog.",
            None,
        ));
    }
    if parsed.candidates.is_empty() {
        diagnostics.push(diagnostic(
            "NO_BRD_TEST_POINT_CANDIDATES",
            Severity::Warning,
            "No Allegro probe evidence or TP-like footprint was preserved by the KiCad import; TP completeness remains REVIEW.",
            Some(&params.path),
        ));
    }
    if let Some(version) = params.declared_allegro_version.as_deref()
        && version != "17.2"
        && version != "17.4"
    {
        diagnostics.push(diagnostic(
            "UNVALIDATED_ALLEGRO_VERSION",
            Severity::Warning,
            format!("Allegro {version} is outside the validated 17.2/17.4 first-release scope."),
            Some(&params.path),
        ));
    }
    if let (Some(declared), Some(detected)) = (
        params.declared_allegro_version.as_deref(),
        detected_allegro_version.as_deref(),
    ) && declared != detected
    {
        diagnostics.push(diagnostic(
            "ALLEGRO_VERSION_CONFLICT",
            Severity::Warning,
            format!(
                "Declared Allegro version {declared} conflicts with converter evidence {detected}."
            ),
            Some(&params.path),
        ));
    }

    let identity = json!({
        "parser_revision": BRD_CATALOG_PARSER_REVISION,
        "brd_sha256": brd_sha256,
        "source_path": params.path,
        "kicad_version": kicad_version,
        "intermediate_hash": intermediate_hash,
        "report_hash": report_hash,
        "declared_allegro_version": params.declared_allegro_version,
        "product_revision": params.product_revision,
        "bounds": parsed.bounds,
        "candidates": parsed.candidates,
        "diagnostics": diagnostics,
    });
    let content_hash = hash_json(&identity)?;
    let id = format!("brd-tp-{}", &content_hash[..20]);
    let superseded_catalog_ids = catalogs_for_source(&cache, &params.path.display().to_string())?
        .into_iter()
        .filter(|catalog| catalog.content_hash != content_hash)
        .map(|catalog| catalog.id)
        .collect::<HashSet<_>>();
    let directory = catalog_directory(&cache, &id);
    fs::create_dir_all(&directory)?;
    let stored_intermediate = directory.join("converted.kicad_pcb");
    let stored_report = directory.join("import-report.json");
    fs::copy(&intermediate, &stored_intermediate)?;
    fs::copy(&report, &stored_report)?;
    for item in &mut diagnostics {
        if item.code == "KICAD_IMPORT_WARNING" {
            item.source = Some(stored_report.display().to_string());
        }
    }
    let review_csv_path = directory.join("tp-review.csv");
    let mut catalog = BrdTestPointCatalog {
        schema_version: 1,
        parser_revision: BRD_CATALOG_PARSER_REVISION,
        kind: "BRD_TEST_POINT_CATALOG".into(),
        id: id.clone(),
        source_path: params.path.display().to_string(),
        brd_sha256,
        declared_allegro_version: params.declared_allegro_version,
        detected_allegro_version,
        product_revision: params.product_revision,
        bounds: parsed.bounds,
        converter: ConverterEvidence {
            name: "KiCad CLI".into(),
            version: kicad_version,
            executable_path: kicad_path.display().to_string(),
            report_path: stored_report.display().to_string(),
            report_hash,
            intermediate_path: stored_intermediate.display().to_string(),
            intermediate_hash,
        },
        candidates: parsed.candidates,
        diagnostics,
        review_csv_path: review_csv_path.display().to_string(),
        generated_at: timestamp(),
        content_hash,
        cache_hit: false,
    };
    write_review_csv(&review_csv_path, &catalog)?;
    cache.save_json(&directory.join("catalog.json"), &catalog)?;
    if !superseded_catalog_ids.is_empty() {
        mark_selected_analyses_stale(
            &cache,
            |analysis| superseded_catalog_ids.contains(&analysis.catalog_id),
            "The source BRD was imported as a new content version",
        )?;
    }
    catalog.review_csv_path = review_csv_path.display().to_string();
    Ok(serde_json::to_value(catalog)?)
}

pub fn query_brd_test_points_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        catalog_id: String,
        side: Option<Side>,
        confidence: Option<CoverageLevel>,
        #[serde(default)]
        offset: usize,
        #[serde(default = "default_query_limit")]
        limit: usize,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(params.cache_dir)?;
    let catalog = load_catalog(&cache, &params.catalog_id)?;
    let filtered = catalog
        .candidates
        .iter()
        .filter(|candidate| params.side.is_none_or(|side| candidate.side == side))
        .filter(|candidate| {
            params
                .confidence
                .is_none_or(|confidence| candidate.identity_confidence == confidence)
        })
        .collect::<Vec<_>>();
    let limit = params.limit.clamp(1, 1_000);
    let items = filtered
        .iter()
        .skip(params.offset)
        .take(limit)
        .copied()
        .collect::<Vec<_>>();
    Ok(json!({
        "catalog_id": catalog.id,
        "total": filtered.len(),
        "offset": params.offset,
        "limit": limit,
        "candidates": items,
    }))
}

pub fn export_test_point_review_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        catalog_id: String,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(params.cache_dir)?;
    let catalog = load_catalog(&cache, &params.catalog_id)?;
    let path = PathBuf::from(&catalog.review_csv_path);
    write_review_csv(&path, &catalog)?;
    Ok(json!({
        "catalog_id": catalog.id,
        "csv_path": path,
        "row_count": catalog.candidates.len(),
        "mime_type": "text/csv",
    }))
}

pub fn import_test_point_review_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        catalog_id: String,
        path: PathBuf,
        imported_by: String,
    }
    let params: Params = serde_json::from_value(params)?;
    if params.imported_by.trim().is_empty() {
        return Err(CoreError::InvalidInput("imported_by is required".into()));
    }
    let metadata = fs::metadata(&params.path)?;
    if metadata.len() > MAX_REVIEW_CSV_BYTES {
        return Err(CoreError::InvalidInput(
            "TP review CSV exceeds the 64 MiB limit".into(),
        ));
    }
    let cache = CacheStore::new(params.cache_dir)?;
    let catalog = load_catalog(&cache, &params.catalog_id)?;
    let csv_bytes = fs::read(&params.path)?;
    let text = std::str::from_utf8(
        csv_bytes
            .strip_prefix(&[0xef, 0xbb, 0xbf])
            .unwrap_or(&csv_bytes),
    )
    .map_err(|error| CoreError::Parse(format!("TP review CSV is not UTF-8: {error}")))?;
    let decisions = validate_review_csv(text, &catalog)?;
    let unresolved_count = decisions
        .iter()
        .filter(|row| row.decision == TestPointDecision::Review)
        .count();
    let content_hash = hash_json(&json!({
        "catalog_id": catalog.id,
        "catalog_content_hash": catalog.content_hash,
        "decisions": decisions,
    }))?;
    let selection = TestPointSelection {
        schema_version: 1,
        kind: "TEST_POINT_SELECTION".into(),
        id: format!("tp-selection-draft-{}", &content_hash[..20]),
        catalog_id: catalog.id,
        catalog_content_hash: catalog.content_hash,
        brd_sha256: catalog.brd_sha256,
        lifecycle_status: ArtifactLifecycle::Draft,
        decisions,
        imported_by: params.imported_by.trim().to_owned(),
        imported_at: timestamp(),
        unresolved_count,
        approval: None,
        content_hash,
    };
    cache.save_json(&selection_path(&cache, &selection.id), &selection)?;
    Ok(serde_json::to_value(selection)?)
}

pub fn approve_test_point_selection_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        selection_id: String,
        approved_by: String,
    }
    let params: Params = serde_json::from_value(params)?;
    if params.approved_by.trim().is_empty() {
        return Err(CoreError::InvalidInput("approved_by is required".into()));
    }
    let cache = CacheStore::new(params.cache_dir)?;
    let draft = load_selection(&cache, &params.selection_id)?;
    if draft.lifecycle_status != ArtifactLifecycle::Draft {
        return Err(CoreError::InvalidInput(
            "only a DRAFT TP selection can be approved".into(),
        ));
    }
    if draft.unresolved_count != 0 {
        return Err(CoreError::InvalidInput(format!(
            "TP selection contains {} unresolved REVIEW row(s)",
            draft.unresolved_count
        )));
    }
    let catalog = load_catalog(&cache, &draft.catalog_id)?;
    if catalog.content_hash != draft.catalog_content_hash || catalog.brd_sha256 != draft.brd_sha256
    {
        return Err(CoreError::InvalidInput(
            "TP selection catalog lineage no longer matches the controlled BRD catalog".into(),
        ));
    }
    let approval_hash = hash_json(&json!({
        "catalog_id": draft.catalog_id,
        "catalog_content_hash": draft.catalog_content_hash,
        "decisions": draft.decisions,
    }))?;
    let mut approved = draft;
    approved.id = format!("tp-selection-{}", &approval_hash[..20]);
    approved.lifecycle_status = ArtifactLifecycle::Approved;
    approved.content_hash = approval_hash.clone();
    approved.approval = Some(ArtifactApproval {
        approved_by: params.approved_by.trim().to_owned(),
        approved_at: timestamp(),
        content_hash: approval_hash,
        comment: None,
    });
    let approved_path = selection_path(&cache, &approved.id);
    if approved_path.is_file() {
        let existing: TestPointSelection = cache.load_json(&approved_path)?;
        return Ok(serde_json::to_value(existing)?);
    }
    cache.save_json(&approved_path, &approved)?;
    mark_selected_analyses_stale(
        &cache,
        |analysis| {
            analysis.catalog_id == approved.catalog_id
                && analysis.selection_content_hash != approved.content_hash
        },
        "A new TP selection was approved for the BRD catalog",
    )?;
    Ok(serde_json::to_value(approved)?)
}

pub fn propose_test_point_alignment_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        selection_id: String,
        design_id: String,
        #[serde(default)]
        anchors: Vec<AlignmentAnchor>,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(params.cache_dir)?;
    let selection = load_selection(&cache, &params.selection_id)?;
    require_approved_selection(&selection)?;
    let catalog = load_catalog(&cache, &selection.catalog_id)?;
    if catalog.content_hash != selection.catalog_content_hash
        || catalog.brd_sha256 != selection.brd_sha256
    {
        return Err(CoreError::InvalidInput(
            "approved TP selection does not match the controlled BRD catalog".into(),
        ));
    }
    let design = cache.load_design(&params.design_id)?;
    if design.format != DesignFormat::GerberPackage {
        return Err(CoreError::InvalidInput(
            "BRD TP alignment requires a Gerber manufacturing package design".into(),
        ));
    }
    let required = required_candidates(&catalog, &selection)?;
    let mut alternatives = if params.anchors.is_empty() {
        automatic_alignment_scores(&catalog, &required, &design)
    } else {
        anchored_alignment_scores(&catalog, &required, &design, &params.anchors)?
    };
    if alternatives.is_empty() {
        alternatives.push(AlignmentScore {
            transform: TestPointTransform {
                rotation_deg: 0,
                mirrored: false,
                swap_sides: false,
                translate_x_nm: design.bounds.center().x - catalog.bounds.center().x,
                translate_y_nm: design.bounds.center().y - catalog.bounds.center().y,
            },
            unique_matches: 0,
            ambiguous_matches: 0,
            unmatched: required.len(),
            outline_residual_nm: outline_residual(catalog.bounds, design.bounds, false, 0),
            anchor_max_residual_nm: None,
        });
    }
    alternatives.sort_by(alignment_order);
    let selected = alternatives[0].clone();
    let same_best = alternatives
        .get(1)
        .is_some_and(|second| alignment_rank(&selected) == alignment_rank(second));
    let missing_outline = catalog
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "BRD_OUTLINE_MISSING");
    let requires_manual_anchors =
        !required.is_empty() && params.anchors.len() < 3 && (same_best || missing_outline);
    let preview_bindings = preview_alignment_bindings(&required, &design, &selected.transform);
    let content_hash = hash_json(&json!({
        "selection": selection.content_hash,
        "design": design.content_hash,
        "selected": selected,
        "preview_bindings": preview_bindings,
        "anchors": params.anchors,
    }))?;
    let alignment = TestPointAlignment {
        schema_version: 1,
        kind: "TEST_POINT_ALIGNMENT".into(),
        id: format!("tp-alignment-draft-{}", &content_hash[..20]),
        lifecycle_status: ArtifactLifecycle::Draft,
        selection_id: selection.id,
        selection_content_hash: selection.content_hash,
        catalog_id: catalog.id,
        design_id: design.id,
        design_content_hash: design.content_hash,
        selected,
        alternatives: alternatives.into_iter().take(8).collect(),
        preview_bindings,
        anchors: params.anchors,
        requires_manual_anchors,
        generated_at: timestamp(),
        approval: None,
        content_hash,
    };
    cache.save_json(&alignment_path(&cache, &alignment.id), &alignment)?;
    Ok(serde_json::to_value(alignment)?)
}

pub fn approve_test_point_alignment_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        alignment_id: String,
        approved_by: String,
        comment: String,
    }
    let params: Params = serde_json::from_value(params)?;
    if params.approved_by.trim().is_empty() || params.comment.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "alignment approval requires approved_by and comment".into(),
        ));
    }
    let cache = CacheStore::new(params.cache_dir)?;
    let draft = load_alignment(&cache, &params.alignment_id)?;
    if draft.lifecycle_status != ArtifactLifecycle::Draft {
        return Err(CoreError::InvalidInput(
            "only a DRAFT alignment can be approved".into(),
        ));
    }
    if draft.requires_manual_anchors {
        return Err(CoreError::InvalidInput(
            "alignment proposal is ambiguous; provide three non-collinear anchors before approval"
                .into(),
        ));
    }
    let selection = load_selection(&cache, &draft.selection_id)?;
    require_approved_selection(&selection)?;
    let design = cache.load_design(&draft.design_id)?;
    if selection.content_hash != draft.selection_content_hash
        || selection.catalog_id != draft.catalog_id
        || design.content_hash != draft.design_content_hash
    {
        return Err(CoreError::InvalidInput(
            "alignment draft lineage no longer matches its approved selection and Gerber design"
                .into(),
        ));
    }
    let approval_hash = hash_json(&json!({
        "selection_content_hash": draft.selection_content_hash,
        "design_content_hash": draft.design_content_hash,
        "selected": draft.selected,
        "preview_bindings": draft.preview_bindings,
        "anchors": draft.anchors,
    }))?;
    let mut approved = draft;
    approved.id = format!("tp-alignment-{}", &approval_hash[..20]);
    approved.lifecycle_status = ArtifactLifecycle::Approved;
    approved.content_hash = approval_hash.clone();
    approved.approval = Some(ArtifactApproval {
        approved_by: params.approved_by.trim().to_owned(),
        approved_at: timestamp(),
        content_hash: approval_hash,
        comment: Some(params.comment.trim().to_owned()),
    });
    let approved_path = alignment_path(&cache, &approved.id);
    if approved_path.is_file() {
        let existing: TestPointAlignment = cache.load_json(&approved_path)?;
        return Ok(serde_json::to_value(existing)?);
    }
    cache.save_json(&approved_path, &approved)?;
    mark_selected_analyses_stale(
        &cache,
        |analysis| {
            analysis.selection_id == approved.selection_id
                && analysis.alignment_content_hash != approved.content_hash
        },
        "A new BRD-to-Gerber alignment was approved for the TP selection",
    )?;
    Ok(serde_json::to_value(approved)?)
}

pub fn analyze_selected_test_points_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        design_id: String,
        selection_id: String,
        alignment_id: String,
        rule_pack_id: String,
    }
    let params: Params = serde_json::from_value(params)?;
    let started = Instant::now();
    let cache = CacheStore::new(params.cache_dir)?;
    let selection = load_selection(&cache, &params.selection_id)?;
    require_approved_selection(&selection)?;
    let alignment = load_alignment(&cache, &params.alignment_id)?;
    require_approved_alignment(&alignment)?;
    let catalog = load_catalog(&cache, &selection.catalog_id)?;
    let design = cache.load_design(&params.design_id)?;
    if design.format != DesignFormat::GerberPackage {
        return Err(CoreError::InvalidInput(
            "selected BRD TP analysis requires a Gerber manufacturing package design".into(),
        ));
    }
    if alignment.selection_id != selection.id
        || alignment.selection_content_hash != selection.content_hash
        || alignment.design_id != design.id
        || alignment.design_content_hash != design.content_hash
    {
        return Err(CoreError::InvalidInput(
            "approved selection/alignment does not match the requested Gerber design".into(),
        ));
    }
    if catalog.content_hash != selection.catalog_content_hash || alignment.catalog_id != catalog.id
    {
        return Err(CoreError::InvalidInput(
            "approved BRD catalog lineage does not match the selection/alignment".into(),
        ));
    }
    let rule_pack = load_rule_pack(&cache, &params.rule_pack_id)?;
    rule_pack.validate_for_analysis()?;
    let approved_rule_hash = rule_pack
        .approval
        .as_ref()
        .map(|approval| approval.content_hash.as_str());
    let current_rule_hash = hash_json(&rule_pack.rules)?;
    if approved_rule_hash != Some(current_rule_hash.as_str()) {
        return Err(CoreError::Rule(
            "approved rule-pack rules no longer match their frozen content hash".into(),
        ));
    }
    let rule_ids = rule_pack
        .rules
        .iter()
        .filter(|rule| {
            rule.source == EntityKind::TestPoint || rule.target == Some(EntityKind::TestPoint)
        })
        .map(|rule| rule.id.clone())
        .collect::<HashSet<_>>();
    let required = required_candidates(&catalog, &selection)?;
    let net_sensitive = rule_pack
        .rules
        .iter()
        .filter(|rule| rule_ids.contains(&rule.id))
        .any(|rule| rule.same_net_only || rule.different_net_only);
    let mut derived = design.clone();
    derived.test_points.clear();
    let mut bindings = Vec::new();
    for (candidate, decision) in &required {
        let transformed_center = apply_transform(candidate.center, &alignment.selected.transform);
        let side = map_side(candidate.side, &alignment.selected.transform);
        let matches = contact_features(&design, transformed_center, side);
        let (status, matched, message) = match matches.as_slice() {
            [] => (
                BindingStatus::Review,
                None,
                "No same-side Gerber copper pad contains the approved BRD TP coordinate."
                    .to_owned(),
            ),
            [feature] => {
                let net_conflict = candidate.net_name.is_some()
                    && feature.net_name.is_some()
                    && !candidate
                        .net_name
                        .as_deref()
                        .unwrap_or_default()
                        .eq_ignore_ascii_case(feature.net_name.as_deref().unwrap_or_default());
                let net_missing_for_filter = net_sensitive && feature.net_name.is_none();
                let mask_evidence = contact_mask_evidence(&design, transformed_center, side);
                if net_conflict {
                    (
                        BindingStatus::Review,
                        Some(*feature),
                        "BRD and Gerber/IPC-356 NET evidence conflicts; geometry remains REVIEW."
                            .to_owned(),
                    )
                } else if net_missing_for_filter {
                    (BindingStatus::Review, Some(*feature), "The contact geometry is unique, but NET-filtered TP rules lack Gerber/IPC-356 NET evidence.".to_owned())
                } else if let Err(reason) = mask_evidence {
                    (BindingStatus::Review, Some(*feature), reason)
                } else {
                    (BindingStatus::Pass, Some(*feature), "A unique same-side Gerber copper pad and solder-mask opening contain the approved BRD TP coordinate.".to_owned())
                }
            }
            _ => (
                BindingStatus::Review,
                None,
                format!(
                    "{} same-side Gerber copper pads contain the approved BRD TP coordinate; the binding is ambiguous.",
                    matches.len()
                ),
            ),
        };
        let (status, message, shield_candidate_refdes, shield_identity_confidence, shield_bounds) =
            apply_shield_review(&design, transformed_center, side, status, message);
        if let Some(feature) = matched {
            let radius_nm = match feature.geometry {
                FeatureGeometry::Pad {
                    size_x_nm,
                    size_y_nm,
                    ..
                } => Some(size_x_nm.min(size_y_nm) / 2),
                _ => None,
            };
            derived.test_points.push(TestPoint {
                id: format!("selected-{}", candidate.id),
                center: feature.geometry.bounds().center(),
                radius_nm,
                // The BRD NET is design intent used for conflict detection; only
                // Gerber/IPC-356 NET evidence may populate manufacturing geometry.
                net_name: feature.net_name.clone(),
                component_ref: candidate
                    .refdes
                    .clone()
                    .or_else(|| feature.component_ref.clone()),
                confidence: if status == BindingStatus::Pass {
                    CoverageLevel::Supplemented
                } else {
                    CoverageLevel::Inferred
                },
                layer_id: Some(feature.layer_id.clone()),
                source: format!("brd-selection:{}:{}", selection.id, candidate.id),
                geometry_source: Some(feature.source.clone()),
                confirmation: selection
                    .approval
                    .as_ref()
                    .map(|approval| TestPointConfirmation {
                        method: TestPointConfirmationMethod::HumanReview,
                        confirmed_by: approval.approved_by.clone(),
                        confirmed_at: approval.approved_at.clone(),
                    }),
            });
        }
        bindings.push(SelectedTestPointBinding {
            candidate_id: candidate.id.clone(),
            decision: decision.decision,
            status,
            transformed_center,
            side,
            matched_feature_id: matched.map(|feature| feature.id.clone()),
            matched_layer_id: matched.map(|feature| feature.layer_id.clone()),
            matched_net_name: matched.and_then(|feature| feature.net_name.clone()),
            matched_center: matched.map(|feature| feature.geometry.bounds().center()),
            matched_width_nm: matched.map(|feature| {
                let bounds = feature.geometry.bounds();
                bounds.max_x - bounds.min_x
            }),
            matched_height_nm: matched.map(|feature| {
                let bounds = feature.geometry.bounds();
                bounds.max_y - bounds.min_y
            }),
            shield_candidate_refdes,
            shield_identity_confidence,
            shield_bounds,
            message,
        });
    }
    let binding_review_count = bindings
        .iter()
        .filter(|binding| binding.status == BindingStatus::Review)
        .count();
    let required_count = required.len();
    derived.coverage.test_points = if required_count == 0 {
        CoverageLevel::Missing
    } else if binding_review_count > 0 {
        CoverageLevel::Inferred
    } else {
        CoverageLevel::Supplemented
    };
    for point in &derived.test_points {
        if let Some(net) = &point.net_name {
            derived.nets.push(net.clone());
        }
    }
    if design.coverage.nets == CoverageLevel::Missing
        && derived
            .test_points
            .iter()
            .any(|point| point.net_name.is_some())
    {
        derived.coverage.nets = CoverageLevel::Supplemented;
    }
    derived.diagnostics.push(diagnostic(
        "BRD_TEST_POINT_SELECTION_BOUND",
        if binding_review_count > 0 { Severity::Warning } else { Severity::Info },
        format!("Bound {required_count} REQUIRED BRD TP(s) to Gerber geometry; {binding_review_count} require review."),
        Some(Path::new(&catalog.source_path)),
    ));
    derived.finalize();
    let derived_hash = hash_json(&json!({
        "gerber": design.content_hash,
        "selection": selection.content_hash,
        "alignment": alignment.content_hash,
        "test_points": derived.test_points,
    }))?;
    derived.id = format!("selected-design-{}", &derived_hash[..20]);
    derived.content_hash = derived_hash;
    derived.source_path = format!("{} + {}", design.source_path, catalog.source_path);
    cache.save_design(&derived)?;

    let analysis_identity = hash_json(&json!({
        "derived_design": derived.content_hash,
        "rule_pack": rule_pack.approval.as_ref().map(|approval| &approval.content_hash),
        "rule_ids": &rule_ids,
    }))?;
    let analysis_id = format!("selected-tp-{}", &analysis_identity[..20]);
    let mut geometry = if required_count == 0 || rule_ids.is_empty() {
        AnalysisSummary {
            id: analysis_id.clone(),
            design_id: derived.id.clone(),
            rule_pack_id: rule_pack.id.clone(),
            verdict: Verdict::NotApplicable,
            pass_count: 0,
            fail_count: 0,
            review_count: 0,
            not_applicable_count: rule_ids.len(),
            violations: Vec::new(),
            report_uri: format!("circuit://analysis/{analysis_id}/report"),
            elapsed_ms: 0,
        }
    } else {
        analyze_design_with_rule_ids(&derived, &rule_pack, Some(&rule_ids), Some(&analysis_id))?
    };
    let overall = if geometry.fail_count > 0 {
        Verdict::Fail
    } else if required_count == 0 || rule_ids.is_empty() {
        Verdict::NotApplicable
    } else if binding_review_count > 0 || geometry.review_count > 0 {
        Verdict::Review
    } else if geometry.pass_count > 0 {
        Verdict::Pass
    } else {
        Verdict::Review
    };
    geometry.verdict = overall;
    geometry.review_count += binding_review_count;
    cache.save_analysis(&geometry)?;
    let _ = write_html_report(&cache, &derived, &geometry)?;
    let report_path = cache.evidence_dir(&analysis_id).join("report.html");
    let rule_pack_content_hash = rule_pack
        .approval
        .as_ref()
        .map(|approval| approval.content_hash.clone())
        .unwrap_or_default();
    let selected = SelectedTestPointAnalysis {
        schema_version: 1,
        kind: "SELECTED_TEST_POINT_ANALYSIS".into(),
        id: analysis_id.clone(),
        design_id: design.id,
        design_content_hash: design.content_hash,
        derived_design_id: derived.id,
        catalog_id: catalog.id,
        catalog_content_hash: catalog.content_hash,
        selection_id: selection.id,
        selection_content_hash: selection.content_hash,
        alignment_id: alignment.id,
        alignment_content_hash: alignment.content_hash,
        rule_pack_id: rule_pack.id,
        rule_pack_content_hash,
        geometry_analysis_id: geometry.id.clone(),
        verdict: overall,
        production_readiness_verdict: Verdict::Review,
        pass_count: geometry.pass_count,
        fail_count: geometry.fail_count,
        review_count: geometry.review_count,
        not_applicable_count: geometry.not_applicable_count,
        required_count,
        bindings,
        violations: geometry.violations,
        diagnostics: derived.diagnostics,
        report_uri: format!("circuit://analysis/{analysis_id}/report"),
        report_path: report_path.display().to_string(),
        elapsed_ms: started.elapsed().as_millis(),
        stale: None,
    };
    fs::create_dir_all(cache.root().join("selected-analyses"))?;
    cache.save_json(&selected_analysis_path(&cache, &selected.id), &selected)?;
    cache.save_json(
        &cache
            .evidence_dir(&selected.id)
            .join("selected-analysis.json"),
        &selected,
    )?;
    fs::write(&report_path, render_selected_report(&selected))?;
    Ok(serde_json::to_value(selected)?)
}

pub fn read_selected_test_point_analysis_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        analysis_id: String,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(params.cache_dir)?;
    let mut analysis: SelectedTestPointAnalysis =
        cache.load_json(&selected_analysis_path(&cache, &params.analysis_id))?;
    if analysis.stale.is_none() {
        let reason = selected_analysis_lineage_error(&cache, &analysis);
        if let Some(reason) = reason {
            analysis.stale = Some(AnalysisStaleState {
                is_stale: true,
                reason,
                invalidated_at: timestamp(),
            });
            cache.save_json(&selected_analysis_path(&cache, &analysis.id), &analysis)?;
            cache.save_json(
                &cache
                    .evidence_dir(&analysis.id)
                    .join("selected-analysis.json"),
                &analysis,
            )?;
        }
    }
    Ok(serde_json::to_value(analysis)?)
}

pub fn read_brd_test_point_catalog_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        catalog_id: String,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(params.cache_dir)?;
    Ok(serde_json::to_value(load_catalog(
        &cache,
        &params.catalog_id,
    )?)?)
}

pub fn read_test_point_selection_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        selection_id: String,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(params.cache_dir)?;
    Ok(serde_json::to_value(load_selection(
        &cache,
        &params.selection_id,
    )?)?)
}

pub fn read_test_point_alignment_request(params: Value) -> CoreResult<Value> {
    #[derive(Deserialize)]
    struct Params {
        cache_dir: PathBuf,
        alignment_id: String,
    }
    let params: Params = serde_json::from_value(params)?;
    let cache = CacheStore::new(params.cache_dir)?;
    Ok(serde_json::to_value(load_alignment(
        &cache,
        &params.alignment_id,
    )?)?)
}

fn default_query_limit() -> usize {
    100
}

fn require_approved_selection(selection: &TestPointSelection) -> CoreResult<()> {
    if selection.lifecycle_status != ArtifactLifecycle::Approved
        || selection
            .approval
            .as_ref()
            .is_none_or(|approval| approval.content_hash != selection.content_hash)
    {
        return Err(CoreError::InvalidInput(
            "TP selection must be APPROVED".into(),
        ));
    }
    Ok(())
}

fn require_approved_alignment(alignment: &TestPointAlignment) -> CoreResult<()> {
    if alignment.lifecycle_status != ArtifactLifecycle::Approved
        || alignment
            .approval
            .as_ref()
            .is_none_or(|approval| approval.content_hash != alignment.content_hash)
    {
        return Err(CoreError::InvalidInput(
            "TP alignment must be APPROVED".into(),
        ));
    }
    Ok(())
}

fn required_candidates<'a>(
    catalog: &'a BrdTestPointCatalog,
    selection: &'a TestPointSelection,
) -> CoreResult<Vec<(&'a BrdTestPointCandidate, &'a TestPointSelectionDecision)>> {
    let candidates = catalog
        .candidates
        .iter()
        .map(|candidate| (candidate.id.as_str(), candidate))
        .collect::<HashMap<_, _>>();
    selection
        .decisions
        .iter()
        .filter(|decision| decision.decision == TestPointDecision::Required)
        .map(|decision| {
            candidates
                .get(decision.candidate_id.as_str())
                .copied()
                .map(|candidate| (candidate, decision))
                .ok_or_else(|| {
                    CoreError::InvalidInput(format!(
                        "selection references unknown candidate {}",
                        decision.candidate_id
                    ))
                })
        })
        .collect()
}

fn resolve_kicad_cli() -> CoreResult<(PathBuf, String)> {
    let mut candidates = Vec::new();
    if let Some(configured) = env::var_os("CIRCUIT_INSPECTOR_KICAD_CLI") {
        candidates.push(PathBuf::from(configured));
    }
    if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from(
            "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli",
        ));
    }
    if cfg!(target_os = "windows") {
        for variable in ["ProgramFiles", "ProgramW6432"] {
            if let Some(program_files) = env::var_os(variable) {
                candidates.push(PathBuf::from(program_files).join("KiCad/10.0/bin/kicad-cli.exe"));
            }
        }
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
            candidates
                .push(PathBuf::from(local_app_data).join("Programs/KiCad/10.0/bin/kicad-cli.exe"));
        }
    }
    candidates.push(PathBuf::from("/usr/bin/kicad-cli"));
    candidates.push(PathBuf::from("/usr/local/bin/kicad-cli"));
    candidates.push(PathBuf::from("kicad-cli"));
    let mut unsupported_versions = Vec::new();
    for candidate in candidates {
        let output = Command::new(&candidate).arg("version").output();
        let Ok(output) = output else { continue };
        if !output.status.success() {
            continue;
        }
        let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let normalized = version.trim_start_matches('v');
        if normalized.split('.').next() != Some("10") {
            unsupported_versions.push(format!("{} ({version})", candidate.display()));
            continue;
        }
        return Ok((candidate, version));
    }
    if unsupported_versions.is_empty() {
        Err(CoreError::Unsupported(
            "KICAD_NOT_FOUND: KiCad 10 kicad-cli was not found. Install KiCad 10 or set CIRCUIT_INSPECTOR_KICAD_CLI.".into(),
        ))
    } else {
        Err(CoreError::Unsupported(format!(
            "KICAD_VERSION_UNSUPPORTED: KiCad 10.x is required; found {}",
            unsupported_versions.join(", ")
        )))
    }
}

pub fn detect_kicad_cli_request(_params: Value) -> CoreResult<Value> {
    Ok(match resolve_kicad_cli() {
        Ok((executable_path, version)) => json!({
            "available": true,
            "supported": true,
            "version": version,
            "executable_path": executable_path,
            "diagnostic": null,
        }),
        Err(error) => {
            let diagnostic = error.to_string();
            json!({
                "available": diagnostic.contains("KICAD_VERSION_UNSUPPORTED"),
                "supported": false,
                "version": null,
                "executable_path": null,
                "diagnostic": diagnostic,
            })
        }
    })
}

fn run_kicad_import(
    executable: &Path,
    source: &Path,
    output: &Path,
    report: &Path,
) -> CoreResult<()> {
    run_kicad_import_with_timeout(executable, source, output, report, kicad_timeout())
}

fn run_kicad_import_with_timeout(
    executable: &Path,
    source: &Path,
    output: &Path,
    report: &Path,
    timeout: Duration,
) -> CoreResult<()> {
    let directory = output
        .parent()
        .ok_or_else(|| CoreError::InvalidInput("KiCad output has no parent directory".into()))?;
    fs::create_dir_all(directory)?;
    let stdout_path = directory.join("kicad-stdout.log");
    let stderr_path = directory.join("kicad-stderr.log");
    let stdout = File::create(&stdout_path)?;
    let stderr = File::create(&stderr_path)?;
    let mut child = Command::new(executable)
        .args([
            "pcb",
            "import",
            "--format",
            "auto",
            "--report-format",
            "json",
            "--report-file",
        ])
        .arg(report)
        .arg("--output")
        .arg(output)
        .arg(source)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| CoreError::Unsupported(format!("failed to start KiCad 10: {error}")))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CoreError::Parse(format!(
                "KiCad import timed out after {} ms",
                timeout.as_millis()
            )));
        }
        thread::sleep(Duration::from_millis(50));
    };
    if !status.success() {
        let stderr = read_capped(&stderr_path, MAX_TOOL_OUTPUT_BYTES)?;
        return Err(CoreError::Parse(format!(
            "KiCad import failed with {status}: {}",
            stderr.trim()
        )));
    }
    if !output.is_file() || !report.is_file() {
        return Err(CoreError::Parse(
            "KiCad import completed without the required output and JSON report".into(),
        ));
    }
    Ok(())
}

fn kicad_timeout() -> Duration {
    env::var("CIRCUIT_INSPECTOR_KICAD_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_KICAD_TIMEOUT)
}

fn find_cached_catalog(
    cache: &CacheStore,
    brd_sha256: &str,
    kicad_version: &str,
    source_path: &str,
    declared_allegro_version: Option<&str>,
    product_revision: Option<&str>,
) -> CoreResult<Option<BrdTestPointCatalog>> {
    let directory = cache.root().join("brd-catalogs");
    let Ok(entries) = fs::read_dir(directory) else {
        return Ok(None);
    };
    for entry in entries {
        let path = entry?.path().join("catalog.json");
        if !path.is_file() {
            continue;
        }
        let Ok(catalog) = cache.load_json::<BrdTestPointCatalog>(&path) else {
            continue;
        };
        if catalog.brd_sha256 != brd_sha256
            || catalog.parser_revision != BRD_CATALOG_PARSER_REVISION
            || catalog.converter.version != kicad_version
            || catalog.source_path != source_path
            || catalog.declared_allegro_version.as_deref() != declared_allegro_version
            || catalog.product_revision.as_deref() != product_revision
        {
            continue;
        }
        let report = Path::new(&catalog.converter.report_path);
        let intermediate = Path::new(&catalog.converter.intermediate_path);
        if report.is_file()
            && intermediate.is_file()
            && hash_input(report)? == catalog.converter.report_hash
            && hash_input(intermediate)? == catalog.converter.intermediate_hash
        {
            return Ok(Some(catalog));
        }
    }
    Ok(None)
}

fn catalogs_for_source(
    cache: &CacheStore,
    source_path: &str,
) -> CoreResult<Vec<BrdTestPointCatalog>> {
    let directory = cache.root().join("brd-catalogs");
    let Ok(entries) = fs::read_dir(directory) else {
        return Ok(Vec::new());
    };
    let mut catalogs = Vec::new();
    for entry in entries {
        let path = entry?.path().join("catalog.json");
        if !path.is_file() {
            continue;
        }
        if let Ok(catalog) = cache.load_json::<BrdTestPointCatalog>(&path)
            && catalog.source_path == source_path
        {
            catalogs.push(catalog);
        }
    }
    Ok(catalogs)
}

fn mark_selected_analyses_stale(
    cache: &CacheStore,
    predicate: impl Fn(&SelectedTestPointAnalysis) -> bool,
    reason: &str,
) -> CoreResult<()> {
    let directory = cache.root().join("selected-analyses");
    let Ok(entries) = fs::read_dir(directory) else {
        return Ok(());
    };
    for entry in entries {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(mut analysis) = cache.load_json::<SelectedTestPointAnalysis>(&path) else {
            continue;
        };
        if analysis.stale.is_some() || !predicate(&analysis) {
            continue;
        }
        analysis.stale = Some(AnalysisStaleState {
            is_stale: true,
            reason: reason.to_owned(),
            invalidated_at: timestamp(),
        });
        cache.save_json(&path, &analysis)?;
        cache.save_json(
            &cache
                .evidence_dir(&analysis.id)
                .join("selected-analysis.json"),
            &analysis,
        )?;
    }
    Ok(())
}

fn selected_analysis_lineage_error(
    cache: &CacheStore,
    analysis: &SelectedTestPointAnalysis,
) -> Option<String> {
    let Ok(design) = cache.load_design(&analysis.design_id) else {
        return Some("Frozen Gerber design input is missing from the local cache".into());
    };
    if design.content_hash != analysis.design_content_hash {
        return Some("Gerber design content no longer matches the frozen analysis lineage".into());
    }
    let Ok(selection) = load_selection(cache, &analysis.selection_id) else {
        return Some("Frozen TP selection input is missing from the local cache".into());
    };
    if selection.content_hash != analysis.selection_content_hash {
        return Some("TP selection content no longer matches the frozen analysis lineage".into());
    }
    let Ok(alignment) = load_alignment(cache, &analysis.alignment_id) else {
        return Some("Frozen BRD-to-Gerber alignment input is missing from the local cache".into());
    };
    if alignment.content_hash != analysis.alignment_content_hash {
        return Some(
            "BRD-to-Gerber alignment no longer matches the frozen analysis lineage".into(),
        );
    }
    let Ok(rule_pack) = load_rule_pack(cache, &analysis.rule_pack_id) else {
        return Some("Frozen approved rule-pack input is missing from the local cache".into());
    };
    let current_rule_hash = hash_json(&rule_pack.rules).ok();
    if rule_pack
        .approval
        .as_ref()
        .map(|approval| approval.content_hash.as_str())
        != Some(analysis.rule_pack_content_hash.as_str())
        || current_rule_hash.as_deref() != Some(analysis.rule_pack_content_hash.as_str())
    {
        return Some(
            "Approved rule-pack content no longer matches the frozen analysis lineage".into(),
        );
    }
    None
}

fn read_capped(path: &Path, limit: usize) -> CoreResult<String> {
    let mut bytes = fs::read(path)?;
    if bytes.len() > limit {
        bytes.truncate(limit);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn detect_allegro_version(report: &str) -> Option<String> {
    ["17.4", "17.2", "23.0", "22.1", "16.6", "16.5"]
        .into_iter()
        .find(|version| report.contains(version))
        .map(str::to_owned)
}

fn parse_kicad_report(report: &str) -> CoreResult<Value> {
    serde_json::from_str(report).map_err(|error| {
        CoreError::Parse(format!("KiCad import report is not valid JSON: {error}"))
    })
}

fn report_has_warnings(value: &Value) -> bool {
    match value {
        Value::Object(values) => values.iter().any(|(key, value)| {
            let key = key.to_ascii_lowercase();
            ((key.contains("warning") || key == "warnings") && meaningful_report_value(value))
                || (key == "severity"
                    && value
                        .as_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case("warning")))
                || report_has_warnings(value)
        }),
        Value::Array(values) => values.iter().any(report_has_warnings),
        _ => false,
    }
}

fn meaningful_report_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_i64().unwrap_or(1) != 0,
        Value::String(value) => !value.trim().is_empty() && value.trim() != "0",
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
    }
}

struct ParsedKicadBoard {
    bounds: BoundsNm,
    candidates: Vec<BrdTestPointCandidate>,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone)]
struct ParsedKicadPad {
    center: PointNm,
    shape: Option<String>,
    width_nm: Option<i64>,
    height_nm: Option<i64>,
    net_name: Option<String>,
}

#[derive(Debug, Clone)]
enum SExpr {
    Atom(String),
    List(Vec<SExpr>),
}

fn parse_kicad_board(text: &str) -> CoreResult<ParsedKicadBoard> {
    let root = SExprParser::new(text).parse()?;
    let root_items = root
        .as_list()
        .ok_or_else(|| CoreError::Parse("KiCad PCB root is not an S-expression list".into()))?;
    if root_items.first().and_then(SExpr::as_text) != Some("kicad_pcb") {
        return Err(CoreError::Parse("converted file is not a KiCad PCB".into()));
    }
    let mut nets = HashMap::<String, String>::new();
    for item in root_items.iter().filter(|item| item.head() == Some("net")) {
        if let Some(parts) = item.as_list()
            && let (Some(id), Some(name)) = (
                parts.get(1).and_then(SExpr::as_text),
                parts.get(2).and_then(SExpr::as_text),
            )
        {
            nets.insert(id.to_owned(), name.to_owned());
        }
    }
    let mut bounds = BoundsNm::empty();
    for item in root_items {
        include_edge_cuts(item, &mut bounds);
    }
    let mut candidates = Vec::new();
    for item in root_items {
        if item.head() == Some("footprint")
            && let Some(candidate) = footprint_candidate(item, &nets)?
        {
            candidates.push(candidate);
        }
        if item.head() == Some("via")
            && contains_explicit_probe_evidence(item)
            && let Some(candidate) = via_candidate(item, &nets)?
        {
            candidates.push(candidate);
        }
    }
    candidates.sort_by(|left, right| left.id.cmp(&right.id));
    candidates.dedup_by(|left, right| left.id == right.id);
    if bounds.is_empty() {
        for candidate in &candidates {
            bounds.include_point(candidate.center);
        }
    }
    let mut diagnostics = Vec::new();
    if bounds.is_empty() {
        diagnostics.push(diagnostic("BRD_OUTLINE_MISSING", Severity::Warning, "KiCad output did not preserve a usable Edge.Cuts outline; automatic alignment remains REVIEW.", None));
    }
    if candidates
        .iter()
        .any(|candidate| candidate.identity_confidence == CoverageLevel::Inferred)
    {
        diagnostics.push(diagnostic("INFERRED_BRD_TEST_POINTS", Severity::Warning, "TP-like references or footprints were found without preserved Allegro Probe/Testprep evidence; identity requires human review.", None));
    }
    if candidates.iter().any(|candidate| {
        candidate
            .source_evidence
            .iter()
            .any(|evidence| evidence.starts_with("Multiple KiCad pads"))
    }) {
        diagnostics.push(diagnostic(
            "BRD_TEST_POINT_PAD_AMBIGUOUS",
            Severity::Warning,
            "One or more TP footprints contain multiple pads without a unique contact geometry; affected candidates remain REVIEW.",
            None,
        ));
    }
    if candidates
        .iter()
        .any(|candidate| candidate.net_name.is_none())
    {
        diagnostics.push(diagnostic(
            "BRD_TEST_POINT_NET_MISSING",
            Severity::Warning,
            "One or more TP candidates do not have a uniquely resolved KiCad net; affected candidates remain REVIEW.",
            None,
        ));
    }
    Ok(ParsedKicadBoard {
        bounds: bounds.normalized(),
        candidates,
        diagnostics,
    })
}

fn footprint_candidate(
    item: &SExpr,
    nets: &HashMap<String, String>,
) -> CoreResult<Option<BrdTestPointCandidate>> {
    let parts = item
        .as_list()
        .ok_or_else(|| CoreError::Parse("invalid footprint".into()))?;
    let footprint_name = parts.get(1).and_then(SExpr::as_text).unwrap_or_default();
    let reference = find_property(item, "Reference").or_else(|| find_fp_text_reference(item));
    let explicit = contains_explicit_probe_evidence(item);
    let inferred = reference.as_deref().is_some_and(is_tp_reference) || is_tp_name(footprint_name);
    if !explicit && !inferred {
        return Ok(None);
    }
    let side = side_from_layer(find_direct_child_text(item, "layer", 1));
    let footprint_at = find_direct_child(item, "at")
        .map(parse_at)
        .transpose()?
        .unwrap_or((0.0, 0.0, 0.0));
    let pads = parts
        .iter()
        .filter(|child| child.head() == Some("pad"))
        .map(|pad| parse_kicad_pad(pad, footprint_at, side, nets))
        .collect::<CoreResult<Vec<_>>>()?;
    let netted_pads = pads
        .iter()
        .filter(|pad| pad.net_name.is_some())
        .collect::<Vec<_>>();
    let unique_nets = netted_pads
        .iter()
        .filter_map(|pad| pad.net_name.as_deref())
        .collect::<HashSet<_>>();
    let selected_pad = if pads.len() == 1 {
        pads.first()
    } else if netted_pads.len() == 1 {
        netted_pads.first().copied()
    } else {
        None
    };
    let unique_net_name = (unique_nets.len() == 1)
        .then(|| unique_nets.iter().next().map(|name| (*name).to_owned()))
        .flatten();
    let (center, shape, width_nm, height_nm, net_name, evidence) = if let Some(pad) = selected_pad {
        let mut evidence = vec![if pads.len() == 1 {
            "KiCad imported footprint pad".into()
        } else {
            "Selected the sole net-assigned pad from a multi-pad KiCad footprint".into()
        }];
        evidence.extend(probe_evidence(item));
        (
            pad.center,
            pad.shape.clone(),
            pad.width_nm,
            pad.height_nm,
            pad.net_name.clone(),
            evidence,
        )
    } else if !pads.is_empty() {
        let mut evidence = vec![if unique_net_name.is_some() {
            "Multiple KiCad pads share one net, but contact geometry is ambiguous".into()
        } else {
            "Multiple KiCad pads have missing or conflicting nets; contact identity is ambiguous"
                .into()
        }];
        evidence.extend(probe_evidence(item));
        (
            PointNm {
                x: mm_to_nm(footprint_at.0),
                y: mm_to_nm(footprint_at.1),
            },
            None,
            None,
            None,
            unique_net_name,
            evidence,
        )
    } else {
        let mut evidence = vec!["KiCad imported footprint without pad geometry".into()];
        evidence.extend(probe_evidence(item));
        (
            PointNm {
                x: mm_to_nm(footprint_at.0),
                y: mm_to_nm(footprint_at.1),
            },
            None,
            None,
            None,
            None,
            evidence,
        )
    };
    let source_kind = if explicit {
        "ALLEGRO_PROBE"
    } else {
        "TP_FOOTPRINT"
    };
    let id_hash = hash_text(&format!(
        "{source_kind}|{}|{}|{:?}|{}|{}",
        reference.as_deref().unwrap_or(footprint_name),
        net_name.as_deref().unwrap_or_default(),
        side,
        center.x,
        center.y
    ));
    Ok(Some(BrdTestPointCandidate {
        id: format!("brd-tp-{}", &id_hash[..16]),
        source_kind: source_kind.into(),
        identity_confidence: if explicit {
            CoverageLevel::Explicit
        } else {
            CoverageLevel::Inferred
        },
        refdes: reference,
        net_name,
        side,
        center,
        pad_shape: shape,
        pad_width_nm: width_nm,
        pad_height_nm: height_nm,
        source_evidence: evidence,
    }))
}

fn parse_kicad_pad(
    pad: &SExpr,
    footprint_at: (f64, f64, f64),
    side: Side,
    nets: &HashMap<String, String>,
) -> CoreResult<ParsedKicadPad> {
    let parts = pad.as_list().unwrap_or_default();
    let local = find_direct_child(pad, "at")
        .map(parse_at)
        .transpose()?
        .unwrap_or((0.0, 0.0, 0.0));
    let size = find_direct_child(pad, "size").map(parse_pair).transpose()?;
    Ok(ParsedKicadPad {
        center: transform_footprint_point(footprint_at, local, side),
        shape: parts.get(3).and_then(SExpr::as_text).map(str::to_owned),
        width_nm: size.map(|size| mm_to_nm(size.0)),
        height_nm: size.map(|size| mm_to_nm(size.1)),
        net_name: find_direct_child(pad, "net").and_then(|net| parse_kicad_net_name(net, nets)),
    })
}

fn parse_kicad_net_name(net: &SExpr, nets: &HashMap<String, String>) -> Option<String> {
    let parts = net.as_list()?;
    if let Some(name) = parts.get(2).and_then(SExpr::as_text) {
        return (!name.is_empty()).then(|| name.to_owned());
    }
    let name_or_id = parts.get(1).and_then(SExpr::as_text)?;
    nets.get(name_or_id).cloned().or_else(|| {
        (!name_or_id.is_empty() && name_or_id.parse::<u64>().is_err())
            .then(|| name_or_id.to_owned())
    })
}

fn via_candidate(
    item: &SExpr,
    nets: &HashMap<String, String>,
) -> CoreResult<Option<BrdTestPointCandidate>> {
    let at = find_direct_child(item, "at")
        .map(parse_at)
        .transpose()?
        .unwrap_or((0.0, 0.0, 0.0));
    let size = find_direct_child_text(item, "size", 1).and_then(|value| value.parse::<f64>().ok());
    let net_name = find_direct_child(item, "net").and_then(|net| parse_kicad_net_name(net, nets));
    let side = if expression_text(item)
        .to_ascii_uppercase()
        .contains("PROBE_BOTTOM")
    {
        Side::Bottom
    } else {
        Side::Top
    };
    let center = PointNm {
        x: mm_to_nm(at.0),
        y: mm_to_nm(at.1),
    };
    let id_hash = hash_text(&format!(
        "ALLEGRO_PROBE_VIA|{}|{:?}|{}|{}",
        net_name.as_deref().unwrap_or_default(),
        side,
        center.x,
        center.y
    ));
    Ok(Some(BrdTestPointCandidate {
        id: format!("brd-tp-{}", &id_hash[..16]),
        source_kind: "ALLEGRO_PROBE_VIA".into(),
        identity_confidence: CoverageLevel::Explicit,
        refdes: None,
        net_name,
        side,
        center,
        pad_shape: Some("circle".into()),
        pad_width_nm: size.map(mm_to_nm),
        pad_height_nm: size.map(mm_to_nm),
        source_evidence: vec![
            "KiCad imported via with preserved Allegro Probe/Testprep evidence".into(),
        ],
    }))
}

fn include_edge_cuts(item: &SExpr, bounds: &mut BoundsNm) {
    let head = item.head();
    if matches!(
        head,
        Some("gr_line") | Some("gr_rect") | Some("gr_arc") | Some("gr_circle")
    ) && find_direct_child_text(item, "layer", 1)
        .is_some_and(|layer| layer.eq_ignore_ascii_case("Edge.Cuts"))
    {
        for name in ["start", "end", "mid", "center"] {
            if let Some(point) =
                find_direct_child(item, name).and_then(|value| parse_pair(value).ok())
            {
                bounds.include_point(PointNm {
                    x: mm_to_nm(point.0),
                    y: mm_to_nm(point.1),
                });
            }
        }
    }
}

fn find_property(item: &SExpr, name: &str) -> Option<String> {
    item.as_list()?.iter().find_map(|child| {
        let parts = child.as_list()?;
        (parts.first()?.as_text() == Some("property") && parts.get(1)?.as_text() == Some(name))
            .then(|| parts.get(2)?.as_text().map(str::to_owned))?
    })
}

fn find_fp_text_reference(item: &SExpr) -> Option<String> {
    item.as_list()?.iter().find_map(|child| {
        let parts = child.as_list()?;
        (parts.first()?.as_text() == Some("fp_text")
            && parts.get(1)?.as_text() == Some("reference"))
        .then(|| parts.get(2)?.as_text().map(str::to_owned))?
    })
}

fn contains_explicit_probe_evidence(item: &SExpr) -> bool {
    let value = expression_text(item)
        .to_ascii_uppercase()
        .replace(['/', '-', ' '], "_");
    ["PROBE_TOP", "PROBE_BOTTOM", "TESTPREP", "TEST_PREP"]
        .iter()
        .any(|token| value.contains(token))
}

fn probe_evidence(item: &SExpr) -> Vec<String> {
    item.as_list()
        .unwrap_or_default()
        .iter()
        .filter_map(|child| {
            let parts = child.as_list()?;
            if parts.first()?.as_text() != Some("property") {
                return None;
            }
            let name = parts.get(1)?.as_text()?;
            let value = parts.get(2)?.as_text()?;
            let normalized = format!("{name} {value}").to_ascii_uppercase();
            contains_explicit_probe_evidence(child)
                .then(|| {
                    format!(
                        "Preserved Allegro property {name}={}",
                        value.chars().take(160).collect::<String>()
                    )
                })
                .or_else(|| {
                    normalized
                        .contains("TESTPREP")
                        .then(|| format!("Preserved Allegro property {name}"))
                })
        })
        .collect()
}

fn is_tp_reference(value: &str) -> bool {
    let value = value.trim().to_ascii_uppercase();
    ["TP", "MTP"].iter().any(|prefix| {
        value.strip_prefix(prefix).is_some_and(|tail| {
            !tail.is_empty()
                && tail.chars().all(|character| {
                    character.is_ascii_alphanumeric() || character == '_' || character == '-'
                })
        })
    })
}

fn is_tp_name(value: &str) -> bool {
    let value = value.to_ascii_uppercase().replace([' ', '-'], "_");
    [
        "TEST_POINT",
        "TESTPOINT",
        "TEST_PAD",
        "TESTPAD",
        "PROBE_PAD",
        "PROBEPAD",
    ]
    .iter()
    .any(|token| value.contains(token))
}

fn side_from_layer(layer: Option<&str>) -> Side {
    match layer.unwrap_or_default() {
        value if value.starts_with("F.") => Side::Top,
        value if value.starts_with("B.") => Side::Bottom,
        _ => Side::Na,
    }
}

fn transform_footprint_point(
    footprint: (f64, f64, f64),
    pad: (f64, f64, f64),
    side: Side,
) -> PointNm {
    let local_x = if side == Side::Bottom { -pad.0 } else { pad.0 };
    let radians = footprint.2.to_radians();
    let x = footprint.0 + local_x * radians.cos() - pad.1 * radians.sin();
    let y = footprint.1 + local_x * radians.sin() + pad.1 * radians.cos();
    PointNm {
        x: mm_to_nm(x),
        y: mm_to_nm(y),
    }
}

fn parse_at(value: &SExpr) -> CoreResult<(f64, f64, f64)> {
    let parts = value
        .as_list()
        .ok_or_else(|| CoreError::Parse("invalid at expression".into()))?;
    let x = parse_number(parts.get(1))?;
    let y = parse_number(parts.get(2))?;
    let rotation = parts
        .get(3)
        .and_then(SExpr::as_text)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0.0);
    Ok((x, y, rotation))
}

fn parse_pair(value: &SExpr) -> CoreResult<(f64, f64)> {
    let parts = value
        .as_list()
        .ok_or_else(|| CoreError::Parse("invalid coordinate expression".into()))?;
    Ok((parse_number(parts.get(1))?, parse_number(parts.get(2))?))
}

fn parse_number(value: Option<&SExpr>) -> CoreResult<f64> {
    value
        .and_then(SExpr::as_text)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| CoreError::Parse("invalid numeric field in KiCad output".into()))
}

fn find_direct_child<'a>(item: &'a SExpr, head: &str) -> Option<&'a SExpr> {
    item.as_list()?
        .iter()
        .find(|child| child.head() == Some(head))
}

fn find_direct_child_text<'a>(item: &'a SExpr, head: &str, index: usize) -> Option<&'a str> {
    find_direct_child(item, head)?
        .as_list()?
        .get(index)?
        .as_text()
}

fn expression_text(item: &SExpr) -> String {
    match item {
        SExpr::Atom(value) => value.clone(),
        SExpr::List(values) => values
            .iter()
            .map(expression_text)
            .collect::<Vec<_>>()
            .join(" "),
    }
}

impl SExpr {
    fn as_list(&self) -> Option<&[SExpr]> {
        match self {
            Self::List(values) => Some(values),
            Self::Atom(_) => None,
        }
    }

    fn as_text(&self) -> Option<&str> {
        match self {
            Self::Atom(value) => Some(value),
            Self::List(_) => None,
        }
    }

    fn head(&self) -> Option<&str> {
        self.as_list()?.first()?.as_text()
    }
}

struct SExprParser<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> SExprParser<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            bytes: text.as_bytes(),
            offset: 0,
        }
    }

    fn parse(mut self) -> CoreResult<SExpr> {
        self.skip_space();
        let value = self.value()?;
        self.skip_space();
        if self.offset != self.bytes.len() {
            return Err(CoreError::Parse(
                "unexpected trailing KiCad S-expression content".into(),
            ));
        }
        Ok(value)
    }

    fn value(&mut self) -> CoreResult<SExpr> {
        self.skip_space();
        match self.bytes.get(self.offset).copied() {
            Some(b'(') => self.list(),
            Some(b'\"') => self.string(),
            Some(_) => self.atom(),
            None => Err(CoreError::Parse(
                "unexpected end of KiCad S-expression".into(),
            )),
        }
    }

    fn list(&mut self) -> CoreResult<SExpr> {
        self.offset += 1;
        let mut values = Vec::new();
        loop {
            self.skip_space();
            match self.bytes.get(self.offset).copied() {
                Some(b')') => {
                    self.offset += 1;
                    return Ok(SExpr::List(values));
                }
                Some(_) => values.push(self.value()?),
                None => {
                    return Err(CoreError::Parse(
                        "unterminated KiCad S-expression list".into(),
                    ));
                }
            }
        }
    }

    fn string(&mut self) -> CoreResult<SExpr> {
        self.offset += 1;
        let mut value = String::new();
        while let Some(byte) = self.bytes.get(self.offset).copied() {
            self.offset += 1;
            match byte {
                b'\"' => return Ok(SExpr::Atom(value)),
                b'\\' => {
                    let escaped = self
                        .bytes
                        .get(self.offset)
                        .copied()
                        .ok_or_else(|| CoreError::Parse("unterminated KiCad escape".into()))?;
                    self.offset += 1;
                    value.push(match escaped {
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        other => other as char,
                    });
                }
                other => value.push(other as char),
            }
        }
        Err(CoreError::Parse("unterminated KiCad string".into()))
    }

    fn atom(&mut self) -> CoreResult<SExpr> {
        let start = self.offset;
        while let Some(byte) = self.bytes.get(self.offset).copied() {
            if byte.is_ascii_whitespace() || byte == b'(' || byte == b')' {
                break;
            }
            self.offset += 1;
        }
        if start == self.offset {
            return Err(CoreError::Parse("empty KiCad atom".into()));
        }
        Ok(SExpr::Atom(
            String::from_utf8_lossy(&self.bytes[start..self.offset]).into_owned(),
        ))
    }

    fn skip_space(&mut self) {
        loop {
            while self
                .bytes
                .get(self.offset)
                .is_some_and(u8::is_ascii_whitespace)
            {
                self.offset += 1;
            }
            if self.bytes.get(self.offset) == Some(&b';') {
                while self
                    .bytes
                    .get(self.offset)
                    .is_some_and(|byte| *byte != b'\n')
                {
                    self.offset += 1;
                }
            } else {
                break;
            }
        }
    }
}

fn write_review_csv(path: &Path, catalog: &BrdTestPointCatalog) -> CoreResult<()> {
    let mut output = String::from("\u{feff}");
    output.push_str(&REVIEW_CSV_HEADERS.join(","));
    output.push_str("\r\n");
    for candidate in &catalog.candidates {
        let row = [
            "1".to_owned(),
            catalog.id.clone(),
            catalog.brd_sha256.clone(),
            candidate.id.clone(),
            candidate.source_kind.clone(),
            coverage_name(candidate.identity_confidence).into(),
            candidate.refdes.clone().unwrap_or_default(),
            candidate.net_name.clone().unwrap_or_default(),
            side_name(candidate.side).into(),
            format_nm_mm(candidate.center.x),
            format_nm_mm(candidate.center.y),
            candidate.pad_shape.clone().unwrap_or_default(),
            candidate.pad_width_nm.map(format_nm_mm).unwrap_or_default(),
            candidate
                .pad_height_nm
                .map(format_nm_mm)
                .unwrap_or_default(),
            "REVIEW".into(),
            String::new(),
        ];
        output.push_str(
            &row.into_iter()
                .map(|value| csv_cell(&value))
                .collect::<Vec<_>>()
                .join(","),
        );
        output.push_str("\r\n");
    }
    let parent = path
        .parent()
        .ok_or_else(|| CoreError::Cache("CSV path has no parent".into()))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(".tp-review.csv.tmp");
    fs::write(&temporary, output)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn validate_review_csv(
    text: &str,
    catalog: &BrdTestPointCatalog,
) -> CoreResult<Vec<TestPointSelectionDecision>> {
    let rows = parse_csv(text)?;
    let Some(headers) = rows.first() else {
        return Err(CoreError::Parse("TP review CSV is empty".into()));
    };
    if headers.iter().map(String::as_str).collect::<Vec<_>>() != REVIEW_CSV_HEADERS {
        return Err(CoreError::Parse(format!(
            "TP review CSV headers must be exactly {}",
            REVIEW_CSV_HEADERS.join(",")
        )));
    }
    if rows.len() - 1 != catalog.candidates.len() {
        return Err(CoreError::Parse(format!(
            "TP review CSV must contain all {} candidates exactly once",
            catalog.candidates.len()
        )));
    }
    let expected = catalog
        .candidates
        .iter()
        .map(|candidate| (candidate.id.as_str(), candidate))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let mut decisions = Vec::new();
    for (index, row) in rows.iter().enumerate().skip(1) {
        if row.len() != REVIEW_CSV_HEADERS.len() {
            return Err(CoreError::Parse(format!(
                "row {} has {} column(s); expected {}",
                index + 1,
                row.len(),
                REVIEW_CSV_HEADERS.len()
            )));
        }
        let candidate_id = unsanitize_csv_cell(&row[3]);
        if !seen.insert(candidate_id.clone()) {
            return Err(CoreError::Parse(format!(
                "row {} duplicates candidate {}",
                index + 1,
                candidate_id
            )));
        }
        let candidate = expected.get(candidate_id.as_str()).ok_or_else(|| {
            CoreError::Parse(format!(
                "row {} contains unknown candidate {}",
                index + 1,
                candidate_id
            ))
        })?;
        let immutable = [
            "1".to_owned(),
            catalog.id.clone(),
            catalog.brd_sha256.clone(),
            candidate.id.clone(),
            candidate.source_kind.clone(),
            coverage_name(candidate.identity_confidence).into(),
            candidate.refdes.clone().unwrap_or_default(),
            candidate.net_name.clone().unwrap_or_default(),
            side_name(candidate.side).into(),
            format_nm_mm(candidate.center.x),
            format_nm_mm(candidate.center.y),
            candidate.pad_shape.clone().unwrap_or_default(),
            candidate.pad_width_nm.map(format_nm_mm).unwrap_or_default(),
            candidate
                .pad_height_nm
                .map(format_nm_mm)
                .unwrap_or_default(),
        ];
        for (column, expected_value) in immutable.iter().enumerate() {
            if unsanitize_csv_cell(&row[column]) != *expected_value {
                return Err(CoreError::Parse(format!(
                    "row {} modifies immutable column {}",
                    index + 1,
                    REVIEW_CSV_HEADERS[column]
                )));
            }
        }
        let decision = match row[14].trim().to_ascii_uppercase().as_str() {
            "REQUIRED" => TestPointDecision::Required,
            "NOT_REQUIRED" => TestPointDecision::NotRequired,
            "REVIEW" => TestPointDecision::Review,
            other => {
                return Err(CoreError::Parse(format!(
                    "row {} uses invalid decision {other}",
                    index + 1
                )));
            }
        };
        decisions.push(TestPointSelectionDecision {
            candidate_id,
            decision,
            comment: row[15].trim().to_owned(),
        });
    }
    decisions.sort_by(|left, right| left.candidate_id.cmp(&right.candidate_id));
    Ok(decisions)
}

fn parse_csv(text: &str) -> CoreResult<Vec<Vec<String>>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if quoted {
            if character == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(character);
            }
            continue;
        }
        match character {
            '"' if field.is_empty() => quoted = true,
            ',' => {
                row.push(std::mem::take(&mut field));
            }
            '\n' => {
                if field.ends_with('\r') {
                    field.pop();
                }
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            other => field.push(other),
        }
    }
    if quoted {
        return Err(CoreError::Parse("unterminated quoted CSV field".into()));
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    Ok(rows)
}

fn csv_cell(value: &str) -> String {
    let sanitized = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if sanitized.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", sanitized.replace('"', "\"\""))
    } else {
        sanitized
    }
}

fn unsanitize_csv_cell(value: &str) -> String {
    value
        .strip_prefix('\'')
        .filter(|rest| rest.starts_with(['=', '+', '-', '@', '\t', '\r']))
        .unwrap_or(value)
        .to_owned()
}

fn automatic_alignment_scores(
    catalog: &BrdTestPointCatalog,
    required: &[(&BrdTestPointCandidate, &TestPointSelectionDecision)],
    design: &Design,
) -> Vec<AlignmentScore> {
    let mut scores = Vec::new();
    for mirrored in [false, true] {
        for rotation in [0, 90, 180, 270] {
            for swap_sides in [false, true] {
                let oriented = transformed_bounds(catalog.bounds, mirrored, rotation);
                let transform = TestPointTransform {
                    rotation_deg: rotation,
                    mirrored,
                    swap_sides,
                    translate_x_nm: design.bounds.center().x - oriented.center().x,
                    translate_y_nm: design.bounds.center().y - oriented.center().y,
                };
                scores.push(score_transform(
                    catalog.bounds,
                    required,
                    design,
                    transform,
                    None,
                ));
            }
        }
    }
    scores
}

fn anchored_alignment_scores(
    catalog: &BrdTestPointCatalog,
    required: &[(&BrdTestPointCandidate, &TestPointSelectionDecision)],
    design: &Design,
    anchors: &[AlignmentAnchor],
) -> CoreResult<Vec<AlignmentScore>> {
    if anchors.len() < 3 {
        return Err(CoreError::InvalidInput(
            "manual alignment requires at least three anchors".into(),
        ));
    }
    let candidate_map = catalog
        .candidates
        .iter()
        .map(|candidate| (candidate.id.as_str(), candidate))
        .collect::<HashMap<_, _>>();
    let points = anchors
        .iter()
        .map(|anchor| {
            candidate_map
                .get(anchor.candidate_id.as_str())
                .copied()
                .ok_or_else(|| {
                    CoreError::InvalidInput(format!(
                        "unknown alignment anchor {}",
                        anchor.candidate_id
                    ))
                })
        })
        .collect::<CoreResult<Vec<_>>>()?;
    if collinear(points[0].center, points[1].center, points[2].center) {
        return Err(CoreError::InvalidInput(
            "alignment anchors must be non-collinear".into(),
        ));
    }
    let mut scores = Vec::new();
    for mirrored in [false, true] {
        for rotation in [0, 90, 180, 270] {
            for swap_sides in [false, true] {
                let offsets = points
                    .iter()
                    .zip(anchors)
                    .map(|(candidate, anchor)| {
                        let oriented = orient_point(candidate.center, mirrored, rotation);
                        (
                            anchor.design_point.x - oriented.x,
                            anchor.design_point.y - oriented.y,
                        )
                    })
                    .collect::<Vec<_>>();
                let translate_x_nm =
                    offsets.iter().map(|value| value.0).sum::<i64>() / offsets.len() as i64;
                let translate_y_nm =
                    offsets.iter().map(|value| value.1).sum::<i64>() / offsets.len() as i64;
                let max_residual = offsets
                    .iter()
                    .map(|offset| {
                        (offset.0 - translate_x_nm)
                            .abs()
                            .max((offset.1 - translate_y_nm).abs())
                    })
                    .max()
                    .unwrap_or_default();
                let transform = TestPointTransform {
                    rotation_deg: rotation,
                    mirrored,
                    swap_sides,
                    translate_x_nm,
                    translate_y_nm,
                };
                scores.push(score_transform(
                    catalog.bounds,
                    required,
                    design,
                    transform,
                    Some(max_residual),
                ));
            }
        }
    }
    Ok(scores)
}

fn collinear(first: PointNm, second: PointNm, third: PointNm) -> bool {
    i128::from(second.x - first.x) * i128::from(third.y - first.y)
        == i128::from(second.y - first.y) * i128::from(third.x - first.x)
}

fn score_transform(
    catalog_bounds: BoundsNm,
    required: &[(&BrdTestPointCandidate, &TestPointSelectionDecision)],
    design: &Design,
    transform: TestPointTransform,
    anchor_max_residual_nm: Option<i64>,
) -> AlignmentScore {
    let mut unique_matches = 0;
    let mut ambiguous_matches = 0;
    let mut unmatched = 0;
    for (candidate, _) in required {
        let center = apply_transform(candidate.center, &transform);
        match contact_features(design, center, map_side(candidate.side, &transform)).len() {
            0 => unmatched += 1,
            1 => unique_matches += 1,
            _ => ambiguous_matches += 1,
        }
    }
    AlignmentScore {
        transform: transform.clone(),
        unique_matches,
        ambiguous_matches,
        unmatched,
        outline_residual_nm: outline_residual(
            catalog_bounds,
            design.bounds,
            transform.mirrored,
            transform.rotation_deg,
        ),
        anchor_max_residual_nm,
    }
}

fn alignment_rank(score: &AlignmentScore) -> (usize, usize, std::cmp::Reverse<usize>, i64, i64) {
    (
        score.unmatched,
        score.ambiguous_matches,
        std::cmp::Reverse(score.unique_matches),
        score.anchor_max_residual_nm.unwrap_or_default(),
        score.outline_residual_nm,
    )
}

fn alignment_order(left: &AlignmentScore, right: &AlignmentScore) -> std::cmp::Ordering {
    alignment_rank(left).cmp(&alignment_rank(right))
}

fn outline_residual(source: BoundsNm, target: BoundsNm, mirrored: bool, rotation: i32) -> i64 {
    let source = transformed_bounds(source, mirrored, rotation);
    ((source.max_x - source.min_x) - (target.max_x - target.min_x)).abs()
        + ((source.max_y - source.min_y) - (target.max_y - target.min_y)).abs()
}

fn transformed_bounds(bounds: BoundsNm, mirrored: bool, rotation: i32) -> BoundsNm {
    let mut transformed = BoundsNm::empty();
    for point in [
        PointNm {
            x: bounds.min_x,
            y: bounds.min_y,
        },
        PointNm {
            x: bounds.min_x,
            y: bounds.max_y,
        },
        PointNm {
            x: bounds.max_x,
            y: bounds.min_y,
        },
        PointNm {
            x: bounds.max_x,
            y: bounds.max_y,
        },
    ] {
        transformed.include_point(orient_point(point, mirrored, rotation));
    }
    transformed.normalized()
}

fn orient_point(mut point: PointNm, mirrored: bool, rotation: i32) -> PointNm {
    if mirrored {
        point.x = -point.x;
    }
    match rotation.rem_euclid(360) {
        0 => point,
        90 => PointNm {
            x: -point.y,
            y: point.x,
        },
        180 => PointNm {
            x: -point.x,
            y: -point.y,
        },
        270 => PointNm {
            x: point.y,
            y: -point.x,
        },
        _ => point,
    }
}

fn apply_transform(point: PointNm, transform: &TestPointTransform) -> PointNm {
    let point = orient_point(point, transform.mirrored, transform.rotation_deg);
    PointNm {
        x: point.x + transform.translate_x_nm,
        y: point.y + transform.translate_y_nm,
    }
}

fn map_side(side: Side, transform: &TestPointTransform) -> Side {
    if !transform.swap_sides {
        return side;
    }
    match side {
        Side::Top => Side::Bottom,
        Side::Bottom => Side::Top,
        other => other,
    }
}

fn preview_alignment_bindings(
    required: &[(&BrdTestPointCandidate, &TestPointSelectionDecision)],
    design: &Design,
    transform: &TestPointTransform,
) -> Vec<SelectedTestPointBinding> {
    required
        .iter()
        .map(|(candidate, decision)| {
            let transformed_center = apply_transform(candidate.center, transform);
            let side = map_side(candidate.side, transform);
            let matches = contact_features(design, transformed_center, side);
            let (status, matched, message) = match matches.as_slice() {
                [] => (
                    BindingStatus::Review,
                    None,
                    "No same-side Gerber copper pad contains the proposed BRD TP coordinate."
                        .to_owned(),
                ),
                [feature] => {
                    let net_conflict = candidate.net_name.is_some()
                        && feature.net_name.is_some()
                        && !candidate
                            .net_name
                            .as_deref()
                            .unwrap_or_default()
                            .eq_ignore_ascii_case(feature.net_name.as_deref().unwrap_or_default());
                    if net_conflict {
                        (
                            BindingStatus::Review,
                            Some(*feature),
                            "BRD and Gerber/IPC-356 NET evidence conflicts.".to_owned(),
                        )
                    } else if let Err(reason) =
                        contact_mask_evidence(design, transformed_center, side)
                    {
                        (BindingStatus::Review, Some(*feature), reason)
                    } else {
                        (
                            BindingStatus::Pass,
                            Some(*feature),
                            "Unique same-side Gerber copper and solder-mask geometry match the proposed BRD TP coordinate."
                                .to_owned(),
                        )
                    }
                }
                _ => (
                    BindingStatus::Review,
                    None,
                    format!(
                        "{} same-side Gerber copper pads contain the proposed BRD TP coordinate.",
                        matches.len()
                    ),
                ),
            };
            let (
                status,
                message,
                shield_candidate_refdes,
                shield_identity_confidence,
                shield_bounds,
            ) = apply_shield_review(design, transformed_center, side, status, message);
            SelectedTestPointBinding {
                candidate_id: candidate.id.clone(),
                decision: decision.decision,
                status,
                transformed_center,
                side,
                matched_feature_id: matched.map(|feature| feature.id.clone()),
                matched_layer_id: matched.map(|feature| feature.layer_id.clone()),
                matched_net_name: matched.and_then(|feature| feature.net_name.clone()),
                matched_center: matched.map(|feature| feature.geometry.bounds().center()),
                matched_width_nm: matched.map(|feature| {
                    let bounds = feature.geometry.bounds();
                    bounds.max_x - bounds.min_x
                }),
                matched_height_nm: matched.map(|feature| {
                    let bounds = feature.geometry.bounds();
                    bounds.max_y - bounds.min_y
                }),
                shield_candidate_refdes,
                shield_identity_confidence,
                shield_bounds,
                message,
            }
        })
        .collect()
}

fn apply_shield_review(
    design: &Design,
    point: PointNm,
    side: Side,
    status: BindingStatus,
    mut message: String,
) -> (
    BindingStatus,
    String,
    Option<String>,
    Option<CoverageLevel>,
    Option<BoundsNm>,
) {
    let Some(shield) = design.covering_shield_candidate(point, side) else {
        return (status, message, None, None, None);
    };
    if !message.is_empty() {
        message.push(' ');
    }
    message.push_str(&format!(
        "The approved TP is inside same-side inferred shield candidate {}; physical probe access remains REVIEW.",
        shield.refdes
    ));
    (
        BindingStatus::Review,
        message,
        Some(shield.refdes.clone()),
        Some(CoverageLevel::Inferred),
        Some(shield.bounds),
    )
}

fn contact_features(design: &Design, point: PointNm, side: Side) -> Vec<&Feature> {
    design
        .layers
        .iter()
        .filter(|layer| layer.side == side && is_copper_layer(&layer.name, &layer.function))
        .flat_map(|layer| &layer.features)
        .filter(|feature| {
            matches!(feature.geometry, FeatureGeometry::Pad { .. })
                && feature.geometry.bounds().distance_to_point(point) == 0
        })
        .collect()
}

fn is_copper_layer(name: &str, function: &str) -> bool {
    let value = format!("{name} {function}").to_ascii_uppercase();
    value.contains("COPPER")
        || value.contains("CONDUCTOR")
        || value.contains("SIGNAL")
        || value.contains("POWER_GROUND")
        || value.contains("MIXED")
        || name.to_ascii_uppercase().ends_with(".GTL")
        || name.to_ascii_uppercase().ends_with(".GBL")
}

fn contact_mask_evidence(design: &Design, point: PointNm, side: Side) -> Result<(), String> {
    let mask_layers = design
        .layers
        .iter()
        .filter(|layer| layer.side == side && is_solder_mask_layer(&layer.name, &layer.function))
        .collect::<Vec<_>>();
    if mask_layers.is_empty() {
        return Err(
            "The copper binding is unique, but same-side solder-mask semantics are missing; physical contact remains REVIEW."
                .into(),
        );
    }
    let opening = mask_layers.iter().any(|layer| {
        layer.features.iter().any(|feature| {
            matches!(
                feature.geometry,
                FeatureGeometry::Pad { .. } | FeatureGeometry::Region { .. }
            ) && feature.geometry.bounds().distance_to_point(point) == 0
        })
    });
    if opening {
        Ok(())
    } else {
        Err(
            "No same-side Gerber solder-mask opening contains the approved TP coordinate; accessibility remains REVIEW rather than an inferred FAIL."
                .into(),
        )
    }
}

fn is_solder_mask_layer(name: &str, function: &str) -> bool {
    let value = format!("{name} {function}").to_ascii_uppercase();
    (value.contains("SOLDERMASK") || value.contains("SOLDER_MASK")) && !value.contains("PASTE")
}

fn render_selected_report(analysis: &SelectedTestPointAnalysis) -> String {
    let binding_rows = analysis.bindings.iter().map(|binding| {
        let size = match (binding.matched_width_nm, binding.matched_height_nm) {
            (Some(width), Some(height)) => format!("{:.6} × {:.6} mm", width as f64 / 1_000_000.0, height as f64 / 1_000_000.0),
            _ => "N/A".into(),
        };
        let shield = binding.shield_candidate_refdes.as_deref().map(|reference| {
            format!("{} · {:?}", html(reference), binding.shield_identity_confidence.unwrap_or(CoverageLevel::Inferred))
        }).unwrap_or_else(|| "-".into());
        format!(
            "<tr class=\"{}\"><td>{}</td><td><code>{}</code></td><td>{}</td><td>{:?}</td><td>{:.6}</td><td>{:.6}</td><td>{size}</td><td><code>{}</code></td><td>{shield}</td><td>{}</td></tr>",
            if binding.status == BindingStatus::Pass { "pass" } else { "review" },
            if binding.status == BindingStatus::Pass { "PASS" } else { "REVIEW" },
            html(&binding.candidate_id),
            decision_name(binding.decision),
            binding.side,
            binding.transformed_center.x as f64 / 1_000_000.0,
            binding.transformed_center.y as f64 / 1_000_000.0,
            html(binding.matched_feature_id.as_deref().unwrap_or("-")),
            html(&binding.message),
        )
    }).collect::<String>();
    let violations = analysis.violations.iter().map(|violation| format!(
        "<tr class=\"{}\"><td>{:?}</td><td><code>{}</code></td><td>{}</td><td>{}</td><td>{}</td></tr>",
        format!("{:?}", violation.verdict).to_ascii_lowercase(), violation.verdict,
        html(&violation.rule_id),
        violation.measured_value_nm.map(|value| format!("{:.6} mm", value as f64 / 1_000_000.0)).unwrap_or_else(|| "N/A".into()),
        violation.threshold_nm.map(|value| format!("{:.6} mm", value as f64 / 1_000_000.0)).unwrap_or_else(|| "N/A".into()),
        html(&violation.message),
    )).collect::<String>();
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Selected TP DFT {verdict:?}</title><style>:root{{font-family:Inter,system-ui;color-scheme:dark;background:#111416;color:#ecebe7}}body{{margin:0}}main{{max-width:1500px;margin:auto;padding:36px}}header{{display:flex;justify-content:space-between;border-bottom:1px solid #2d3234;padding-bottom:22px}}h1{{margin:6px 0}}p,li{{color:#a4aaa7;line-height:1.6}}.badge{{padding:9px 15px;border:1px solid #5c5140;border-radius:999px;height:max-content}}.metrics{{display:flex;gap:10px;margin:22px 0}}.metrics div{{flex:1;padding:16px;border:1px solid #2d3234;border-radius:10px}}table{{width:100%;border-collapse:collapse;font-size:11px}}th,td{{padding:9px;text-align:left;vertical-align:top;border-bottom:1px solid #2a2f31}}tr.fail{{background:#2c1e1b}}tr.review{{background:#292419}}code{{color:#b7c7c3}}footer{{margin-top:26px;padding-top:18px;border-top:1px solid #2d3234;color:#9a8870}}</style></head><body><main><header><div><small>CircuitInspector · SELECTED TP DFT</small><h1>BRD selection → Gerber geometry</h1><code>{id}</code></div><strong class="badge">{verdict:?}</strong></header><section class="metrics"><div><b>{pass}</b> PASS</div><div><b>{fail}</b> FAIL</div><div><b>{review}</b> REVIEW</div><div><b>{na}</b> N/A</div></section><section><h2>Controlled inputs</h2><ul><li>Gerber design: <code>{design}</code> · {design_hash}</li><li>TP selection: <code>{selection}</code> · {selection_hash}</li><li>Alignment: <code>{alignment}</code> · {alignment_hash}</li><li>Approved rule pack: <code>{rules}</code> · {rules_hash}</li></ul></section><section><h2>Required TP binding</h2><table><thead><tr><th>Status</th><th>Candidate</th><th>Decision</th><th>Side</th><th>X mm</th><th>Y mm</th><th>Actual size</th><th>Gerber feature</th><th>Shield candidate</th><th>Evidence</th></tr></thead><tbody>{binding_rows}</tbody></table></section><section><h2>Automated TP geometry</h2><table><thead><tr><th>Verdict</th><th>Rule</th><th>Actual</th><th>Threshold</th><th>Finding</th></tr></thead><tbody>{violations}</tbody></table></section><footer>Production readiness remains REVIEW. Static geometry does not establish probe reach, fixture mechanics, contact reliability, tester capacity, powered safety, throughput, pilot yield, or factory release.</footer></main></body></html>"#,
        verdict = analysis.verdict,
        id = html(&analysis.id),
        pass = analysis.pass_count,
        fail = analysis.fail_count,
        review = analysis.review_count,
        na = analysis.not_applicable_count,
        design = html(&analysis.design_id),
        design_hash = html(&analysis.design_content_hash),
        selection = html(&analysis.selection_id),
        selection_hash = html(&analysis.selection_content_hash),
        alignment = html(&analysis.alignment_id),
        alignment_hash = html(&analysis.alignment_content_hash),
        rules = html(&analysis.rule_pack_id),
        rules_hash = html(&analysis.rule_pack_content_hash),
        binding_rows = binding_rows,
        violations = violations
    )
}

fn load_rule_pack(cache: &CacheStore, id: &str) -> CoreResult<RulePack> {
    for entry in fs::read_dir(cache.root().join("rules"))? {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let pack: RulePack = cache.load_json(&path)?;
        if pack.id == id {
            return Ok(pack);
        }
    }
    Err(CoreError::NotFound(id.into()))
}

fn load_catalog(cache: &CacheStore, id: &str) -> CoreResult<BrdTestPointCatalog> {
    cache.load_json(&catalog_directory(cache, id).join("catalog.json"))
}
fn load_selection(cache: &CacheStore, id: &str) -> CoreResult<TestPointSelection> {
    cache.load_json(&selection_path(cache, id))
}
fn load_alignment(cache: &CacheStore, id: &str) -> CoreResult<TestPointAlignment> {
    cache.load_json(&alignment_path(cache, id))
}
fn catalog_directory(cache: &CacheStore, id: &str) -> PathBuf {
    cache.root().join("brd-catalogs").join(safe_segment(id))
}
fn selection_path(cache: &CacheStore, id: &str) -> PathBuf {
    cache
        .root()
        .join("test-point-selections")
        .join(format!("{}.json", safe_segment(id)))
}
fn alignment_path(cache: &CacheStore, id: &str) -> PathBuf {
    cache
        .root()
        .join("test-point-alignments")
        .join(format!("{}.json", safe_segment(id)))
}
fn selected_analysis_path(cache: &CacheStore, id: &str) -> PathBuf {
    cache
        .root()
        .join("selected-analyses")
        .join(format!("{}.json", safe_segment(id)))
}

fn safe_segment(value: &str) -> String {
    let safe = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
        })
        .take(128)
        .collect::<String>();
    if safe.is_empty() {
        "invalid".into()
    } else {
        safe
    }
}

fn hash_json<T: Serialize>(value: &T) -> CoreResult<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}
fn hash_text(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn timestamp() -> String {
    format!(
        "unix:{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    )
}
fn mm_to_nm(value: f64) -> i64 {
    (value * 1_000_000.0).round() as i64
}
fn format_nm_mm(value: i64) -> String {
    format!("{:.6}", value as f64 / 1_000_000.0)
}
fn coverage_name(value: CoverageLevel) -> &'static str {
    match value {
        CoverageLevel::Explicit => "EXPLICIT",
        CoverageLevel::Supplemented => "SUPPLEMENTED",
        CoverageLevel::Inferred => "INFERRED",
        CoverageLevel::Missing => "MISSING",
    }
}
fn side_name(value: Side) -> &'static str {
    match value {
        Side::Top => "TOP",
        Side::Bottom => "BOTTOM",
        Side::Inner => "INNER",
        Side::Na => "NA",
    }
}
fn decision_name(value: TestPointDecision) -> &'static str {
    match value {
        TestPointDecision::Required => "REQUIRED",
        TestPointDecision::NotRequired => "NOT_REQUIRED",
        TestPointDecision::Review => "REVIEW",
    }
}
fn html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn diagnostic(
    code: &str,
    severity: Severity,
    message: impl Into<String>,
    source: Option<&Path>,
) -> Diagnostic {
    Diagnostic {
        code: code.into(),
        severity,
        message: message.into(),
        source: source.map(|path| path.display().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Component, Layer, Polarity, SemanticCoverage};
    use std::collections::BTreeMap;

    fn sample_catalog() -> BrdTestPointCatalog {
        BrdTestPointCatalog {
            schema_version: 1,
            parser_revision: BRD_CATALOG_PARSER_REVISION,
            kind: "BRD_TEST_POINT_CATALOG".into(),
            id: "brd-tp-catalog".into(),
            source_path: "fixture.brd".into(),
            brd_sha256: "abc".into(),
            declared_allegro_version: Some("17.4".into()),
            detected_allegro_version: None,
            product_revision: Some("A".into()),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 10_000_000,
                max_y: 10_000_000,
            },
            converter: ConverterEvidence {
                name: "KiCad CLI".into(),
                version: "10.0.3".into(),
                executable_path: "kicad-cli".into(),
                report_path: "report.json".into(),
                report_hash: "r".into(),
                intermediate_path: "converted.kicad_pcb".into(),
                intermediate_hash: "i".into(),
            },
            candidates: vec![BrdTestPointCandidate {
                id: "tp1".into(),
                source_kind: "TP_FOOTPRINT".into(),
                identity_confidence: CoverageLevel::Inferred,
                refdes: Some("TP1".into()),
                net_name: Some("GND".into()),
                side: Side::Top,
                center: PointNm {
                    x: 1_000_000,
                    y: 2_000_000,
                },
                pad_shape: Some("circle".into()),
                pad_width_nm: Some(800_000),
                pad_height_nm: Some(800_000),
                source_evidence: vec!["fixture".into()],
            }],
            diagnostics: Vec::new(),
            review_csv_path: "review.csv".into(),
            generated_at: "unix:1".into(),
            content_hash: "catalog-hash".into(),
            cache_hit: false,
        }
    }

    #[test]
    fn parses_kicad_tp_footprint_without_promoting_identity() {
        let board = r#"(kicad_pcb
          (net 1 "GND")
          (gr_rect (start 0 0) (end 20 10) (layer "Edge.Cuts"))
          (footprint "TestPoint:TestPoint_Pad_D0.8mm" (layer "F.Cu") (at 5 6)
            (property "Reference" "TP1")
            (pad "1" smd circle (at 0 0) (size 0.8 0.8) (layers "F.Cu" "F.Mask") (net 1 "GND"))))"#;
        let parsed = parse_kicad_board(board).unwrap();
        assert_eq!(parsed.candidates.len(), 1);
        assert_eq!(
            parsed.candidates[0].identity_confidence,
            CoverageLevel::Inferred
        );
        assert_eq!(
            parsed.candidates[0].center,
            PointNm {
                x: 5_000_000,
                y: 6_000_000
            }
        );
        assert_eq!(parsed.candidates[0].net_name.as_deref(), Some("GND"));
        assert_eq!(parsed.bounds.max_x, 20_000_000);
    }

    #[test]
    fn parses_kicad_10_name_only_nets_for_footprints_and_vias() {
        let board = r#"(kicad_pcb
          (footprint "Imported" (layer "F.Cu") (at 5 6)
            (property "Reference" "TP403")
            (pad "1" smd circle (at 0 0) (size 0.475 0.475) (layers "F.Cu" "F.Mask") (net "SXR_RESOUT_N")))
          (via (at 8 9) (size 0.7) (layers "F.Cu" "B.Cu") (net "VIA_TEST_NET")
            (property "AllegroSubclass" "MANUFACTURING/PROBE_BOTTOM")))"#;
        let parsed = parse_kicad_board(board).unwrap();
        let footprint = parsed
            .candidates
            .iter()
            .find(|candidate| candidate.refdes.as_deref() == Some("TP403"))
            .unwrap();
        assert_eq!(footprint.net_name.as_deref(), Some("SXR_RESOUT_N"));
        let via = parsed
            .candidates
            .iter()
            .find(|candidate| candidate.source_kind == "ALLEGRO_PROBE_VIA")
            .unwrap();
        assert_eq!(via.net_name.as_deref(), Some("VIA_TEST_NET"));
    }

    #[test]
    fn multi_pad_footprints_select_only_unique_electrical_contacts() {
        let board = r#"(kicad_pcb
          (footprint "Imported" (layer "F.Cu") (at 10 20)
            (property "Reference" "TP1")
            (pad "" smd circle (at 0 0) (size 0.2 0.2) (layers "F.Cu"))
            (pad "1" smd circle (at 1 2) (size 0.8 0.7) (layers "F.Cu" "F.Mask") (net "NET_A")))
          (footprint "Imported" (layer "F.Cu") (at 30 40)
            (property "Reference" "TP2")
            (pad "1" smd circle (at 0 0) (size 0.8 0.8) (layers "F.Cu") (net "NET_A"))
            (pad "2" smd circle (at 2 0) (size 0.8 0.8) (layers "F.Cu") (net "NET_B"))))"#;
        let parsed = parse_kicad_board(board).unwrap();
        let unique = parsed
            .candidates
            .iter()
            .find(|candidate| candidate.refdes.as_deref() == Some("TP1"))
            .unwrap();
        assert_eq!(unique.net_name.as_deref(), Some("NET_A"));
        assert_eq!(
            unique.center,
            PointNm {
                x: 11_000_000,
                y: 22_000_000
            }
        );
        assert_eq!(unique.pad_width_nm, Some(800_000));

        let ambiguous = parsed
            .candidates
            .iter()
            .find(|candidate| candidate.refdes.as_deref() == Some("TP2"))
            .unwrap();
        assert_eq!(ambiguous.net_name, None);
        assert_eq!(ambiguous.pad_width_nm, None);
        assert!(
            parsed
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "BRD_TEST_POINT_PAD_AMBIGUOUS")
        );
    }

    #[test]
    fn preserved_probe_property_is_explicit() {
        let board = r#"(kicad_pcb
          (footprint "Imported" (layer "B.Cu") (at 4 3)
            (property "Reference" "X1") (property "AllegroSubclass" "MANUFACTURING/PROBE_BOTTOM")
            (pad "1" smd circle (at 0 0) (size 1 1) (layers "B.Cu"))))"#;
        let parsed = parse_kicad_board(board).unwrap();
        assert_eq!(
            parsed.candidates[0].identity_confidence,
            CoverageLevel::Explicit
        );
        assert_eq!(parsed.candidates[0].side, Side::Bottom);
    }

    #[test]
    fn csv_round_trip_rejects_immutable_changes_and_accepts_closed_decision() {
        let temporary = tempfile::tempdir().unwrap();
        let catalog = sample_catalog();
        let path = temporary.path().join("review.csv");
        write_review_csv(&path, &catalog).unwrap();
        let original = fs::read_to_string(&path).unwrap();
        let closed = original.replace(",REVIEW,\r\n", ",REQUIRED,needed\r\n");
        let decisions =
            validate_review_csv(closed.trim_start_matches('\u{feff}'), &catalog).unwrap();
        assert_eq!(decisions[0].decision, TestPointDecision::Required);
        let changed = closed.replace(",TP1,", ",TP9,");
        assert!(validate_review_csv(changed.trim_start_matches('\u{feff}'), &catalog).is_err());
    }

    #[test]
    fn alignment_transform_supports_rotation_mirror_and_translation() {
        let transform = TestPointTransform {
            rotation_deg: 90,
            mirrored: true,
            swap_sides: true,
            translate_x_nm: 10,
            translate_y_nm: 20,
        };
        assert_eq!(
            apply_transform(PointNm { x: 2, y: 3 }, &transform),
            PointNm { x: 7, y: 18 }
        );
        assert_eq!(map_side(Side::Top, &transform), Side::Bottom);
    }

    #[test]
    fn synthetic_fixture_covers_explicit_inferred_via_and_missing_geometry() {
        let parsed =
            parse_kicad_board(include_str!("../../../fixtures/brd/minimal-tp.kicad_pcb")).unwrap();
        assert_eq!(parsed.candidates.len(), 4);
        assert_eq!(
            parsed
                .candidates
                .iter()
                .filter(|candidate| candidate.identity_confidence == CoverageLevel::Explicit)
                .count(),
            2
        );
        assert_eq!(
            parsed
                .candidates
                .iter()
                .filter(|candidate| candidate.identity_confidence == CoverageLevel::Inferred)
                .count(),
            2
        );
        assert!(
            parsed
                .candidates
                .iter()
                .any(|candidate| candidate.source_kind == "ALLEGRO_PROBE_VIA"
                    && candidate.side == Side::Bottom)
        );
        assert!(
            parsed
                .candidates
                .iter()
                .any(|candidate| candidate.refdes.as_deref() == Some("TP3")
                    && candidate.pad_width_nm.is_none())
        );
        assert!(
            parsed
                .candidates
                .iter()
                .any(|candidate| candidate.refdes.as_deref() == Some("TP2")
                    && candidate.net_name.as_deref() == Some("RESET_N"))
        );
        assert!(
            parsed
                .candidates
                .iter()
                .any(|candidate| candidate.source_kind == "ALLEGRO_PROBE_VIA"
                    && candidate.net_name.as_deref() == Some("GND"))
        );
        assert!(
            !parsed
                .candidates
                .iter()
                .any(|candidate| candidate.refdes.as_deref() == Some("R1"))
        );
        assert_eq!(
            parsed.bounds,
            BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 40_000_000,
                max_y: 25_000_000
            }
        );
    }

    #[test]
    fn malformed_kicad_and_report_are_rejected() {
        assert!(parse_kicad_board("(kicad_pcb (footprint").is_err());
        assert!(parse_kicad_board("(not_a_board)").is_err());
        assert!(parse_kicad_report("warning: not json").is_err());
        assert!(!report_has_warnings(&json!({ "warnings": [] })));
        assert!(report_has_warnings(
            &json!({ "messages": [{ "severity": "warning", "text": "loss" }] })
        ));
    }

    #[test]
    fn cached_catalog_requires_current_parser_revision() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = CacheStore::new(temporary.path()).unwrap();
        let directory = cache.root().join("brd-catalogs").join("catalog-a");
        fs::create_dir_all(&directory).unwrap();
        let report = directory.join("import-report.json");
        let intermediate = directory.join("converted.kicad_pcb");
        fs::write(&report, "{}").unwrap();
        fs::write(&intermediate, "(kicad_pcb)").unwrap();

        let mut catalog = sample_catalog();
        catalog.source_path = "fixture.brd".into();
        catalog.brd_sha256 = "brd-hash".into();
        catalog.converter.report_path = report.display().to_string();
        catalog.converter.report_hash = hash_input(&report).unwrap();
        catalog.converter.intermediate_path = intermediate.display().to_string();
        catalog.converter.intermediate_hash = hash_input(&intermediate).unwrap();
        catalog.parser_revision = BRD_CATALOG_PARSER_REVISION - 1;
        cache
            .save_json(&directory.join("catalog.json"), &catalog)
            .unwrap();
        assert!(
            find_cached_catalog(
                &cache,
                "brd-hash",
                "10.0.3",
                "fixture.brd",
                Some("17.4"),
                Some("A")
            )
            .unwrap()
            .is_none()
        );

        catalog.parser_revision = BRD_CATALOG_PARSER_REVISION;
        cache
            .save_json(&directory.join("catalog.json"), &catalog)
            .unwrap();
        assert!(
            find_cached_catalog(
                &cache,
                "brd-hash",
                "10.0.3",
                "fixture.brd",
                Some("17.4"),
                Some("A")
            )
            .unwrap()
            .is_some()
        );
    }

    #[test]
    fn csv_is_excel_safe_and_rejects_missing_duplicate_or_tampered_rows() {
        let temporary = tempfile::tempdir().unwrap();
        let mut catalog = sample_catalog();
        catalog.candidates[0].refdes = Some("=SUM(1,1)".into());
        catalog.candidates[0].net_name = Some("中文,\"网络\"".into());
        let path = temporary.path().join("review.csv");
        write_review_csv(&path, &catalog).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert!(bytes.starts_with(&[0xef, 0xbb, 0xbf]));
        let original = String::from_utf8(bytes[3..].to_vec()).unwrap();
        assert!(original.contains("\r\n"));
        assert!(original.contains("\"'=SUM(1,1)\""));
        assert!(original.contains("\"中文,\"\"网络\"\"\""));

        let closed = original.replace(",REVIEW,\r\n", ",REQUIRED,\"人工,确认\"\r\n");
        let decisions = validate_review_csv(&closed, &catalog).unwrap();
        assert_eq!(decisions[0].comment, "人工,确认");

        let header = closed.lines().next().unwrap();
        assert!(validate_review_csv(&format!("{header}\r\n"), &catalog).is_err());
        let data = closed.lines().nth(1).unwrap();
        assert!(validate_review_csv(&format!("{closed}{data}\r\n"), &catalog).is_err());
        assert!(
            validate_review_csv(&closed.replace(&catalog.brd_sha256, "wrong-hash"), &catalog)
                .is_err()
        );
        assert!(validate_review_csv(&closed.replace("REQUIRED", "=REQUIRED"), &catalog).is_err());
    }

    #[test]
    fn copper_binding_requires_same_side_solder_mask_evidence() {
        let point = PointNm {
            x: 5_000_000,
            y: 6_000_000,
        };
        let mut design = gerber_design(vec![layer(
            "top.gtl",
            "COPPER_TOP",
            Side::Top,
            vec![pad("cu", "top.gtl", point, 900_000)],
        )]);
        assert_eq!(contact_features(&design, point, Side::Top).len(), 1);
        assert!(contact_features(&design, point, Side::Bottom).is_empty());
        assert!(
            contact_mask_evidence(&design, point, Side::Top)
                .unwrap_err()
                .contains("missing")
        );
        design.layers.push(layer(
            "top.gts",
            "SOLDERMASK_TOP",
            Side::Top,
            vec![pad("mask", "top.gts", point, 1_000_000)],
        ));
        assert!(contact_mask_evidence(&design, point, Side::Top).is_ok());
        let candidate = candidate("tp-preview", point.x, point.y, Side::Top);
        let decision = TestPointSelectionDecision {
            candidate_id: candidate.id.clone(),
            decision: TestPointDecision::Required,
            comment: String::new(),
        };
        let preview = preview_alignment_bindings(
            &[(&candidate, &decision)],
            &design,
            &TestPointTransform {
                rotation_deg: 0,
                mirrored: false,
                swap_sides: false,
                translate_x_nm: 0,
                translate_y_nm: 0,
            },
        );
        assert_eq!(preview[0].status, BindingStatus::Pass);
        assert_eq!(preview[0].matched_feature_id.as_deref(), Some("cu"));
        assert_eq!(preview[0].matched_width_nm, Some(900_000));
        design.components.push(Component {
            refdes: "SH1".into(),
            package_name: Some("EMI_SHIELD".into()),
            center: point,
            bounds: BoundsNm {
                min_x: point.x - 2_000_000,
                min_y: point.y - 2_000_000,
                max_x: point.x + 2_000_000,
                max_y: point.y + 2_000_000,
            },
            side: Side::Top,
            pins: Vec::new(),
            confidence: CoverageLevel::Explicit,
        });
        let shielded = preview_alignment_bindings(
            &[(&candidate, &decision)],
            &design,
            &TestPointTransform {
                rotation_deg: 0,
                mirrored: false,
                swap_sides: false,
                translate_x_nm: 0,
                translate_y_nm: 0,
            },
        );
        assert_eq!(shielded[0].status, BindingStatus::Review);
        assert_eq!(shielded[0].shield_candidate_refdes.as_deref(), Some("SH1"));
        assert_eq!(
            shielded[0].shield_identity_confidence,
            Some(CoverageLevel::Inferred)
        );
        assert!(shielded[0].message.contains("physical probe access"));
        design.components[0].side = Side::Bottom;
        let opposite_side = preview_alignment_bindings(
            &[(&candidate, &decision)],
            &design,
            &TestPointTransform {
                rotation_deg: 0,
                mirrored: false,
                swap_sides: false,
                translate_x_nm: 0,
                translate_y_nm: 0,
            },
        );
        assert_eq!(opposite_side[0].status, BindingStatus::Pass);
        assert!(opposite_side[0].shield_candidate_refdes.is_none());
        assert!(
            contact_mask_evidence(
                &design,
                PointNm {
                    x: 8_000_000,
                    y: 8_000_000
                },
                Side::Top
            )
            .is_err()
        );
    }

    #[test]
    fn alignment_scores_rotation_mirror_side_mapping_unique_ambiguous_and_unmatched() {
        let mut catalog = sample_catalog();
        catalog.bounds = BoundsNm {
            min_x: 0,
            min_y: 0,
            max_x: 20_000_000,
            max_y: 10_000_000,
        };
        catalog.candidates = vec![
            candidate("a", 2_000_000, 3_000_000, Side::Top),
            candidate("b", 11_000_000, 4_000_000, Side::Top),
            candidate("c", 17_000_000, 8_000_000, Side::Top),
        ];
        let decisions = catalog
            .candidates
            .iter()
            .map(|candidate| TestPointSelectionDecision {
                candidate_id: candidate.id.clone(),
                decision: TestPointDecision::Required,
                comment: String::new(),
            })
            .collect::<Vec<_>>();
        let required = catalog
            .candidates
            .iter()
            .zip(&decisions)
            .collect::<Vec<_>>();
        let expected = TestPointTransform {
            rotation_deg: 90,
            mirrored: true,
            swap_sides: true,
            translate_x_nm: 100_000_000,
            translate_y_nm: 200_000_000,
        };
        let features = catalog
            .candidates
            .iter()
            .map(|candidate| {
                pad(
                    &candidate.id,
                    "bottom.gbl",
                    apply_transform(candidate.center, &expected),
                    800_000,
                )
            })
            .collect();
        let mut design = gerber_design(vec![layer(
            "bottom.gbl",
            "COPPER_BOTTOM",
            Side::Bottom,
            features,
        )]);
        let oriented = transformed_bounds(catalog.bounds, true, 90);
        design.bounds = BoundsNm {
            min_x: oriented.min_x + expected.translate_x_nm,
            min_y: oriented.min_y + expected.translate_y_nm,
            max_x: oriented.max_x + expected.translate_x_nm,
            max_y: oriented.max_y + expected.translate_y_nm,
        };
        let scores = automatic_alignment_scores(&catalog, &required, &design);
        let score = scores
            .iter()
            .find(|score| score.transform == expected)
            .unwrap();
        assert_eq!(
            (
                score.unique_matches,
                score.ambiguous_matches,
                score.unmatched
            ),
            (3, 0, 0)
        );
        assert_eq!(
            scores
                .iter()
                .filter(|score| [0, 90, 180, 270].contains(&score.transform.rotation_deg))
                .count(),
            16
        );

        design.layers[0].features.push(pad(
            "duplicate",
            "bottom.gbl",
            apply_transform(catalog.candidates[0].center, &expected),
            800_000,
        ));
        let ambiguous = score_transform(catalog.bounds, &required, &design, expected.clone(), None);
        assert_eq!(
            (ambiguous.unique_matches, ambiguous.ambiguous_matches),
            (2, 1)
        );
        design.layers[0]
            .features
            .retain(|feature| feature.id != "b");
        let unmatched = score_transform(catalog.bounds, &required, &design, expected, None);
        assert_eq!(unmatched.unmatched, 1);
    }

    #[test]
    fn manual_alignment_requires_three_known_non_collinear_anchors() {
        let mut catalog = sample_catalog();
        catalog.candidates = vec![
            candidate("a", 0, 0, Side::Top),
            candidate("b", 1_000_000, 0, Side::Top),
            candidate("c", 2_000_000, 0, Side::Top),
        ];
        let decisions = catalog
            .candidates
            .iter()
            .map(|candidate| TestPointSelectionDecision {
                candidate_id: candidate.id.clone(),
                decision: TestPointDecision::Required,
                comment: String::new(),
            })
            .collect::<Vec<_>>();
        let required = catalog
            .candidates
            .iter()
            .zip(&decisions)
            .collect::<Vec<_>>();
        let anchors = catalog
            .candidates
            .iter()
            .map(|candidate| AlignmentAnchor {
                candidate_id: candidate.id.clone(),
                design_point: candidate.center,
            })
            .collect::<Vec<_>>();
        assert!(
            anchored_alignment_scores(&catalog, &required, &gerber_design(Vec::new()), &anchors)
                .is_err()
        );
        catalog.candidates[2].center.y = 1_000_000;
        let required = catalog
            .candidates
            .iter()
            .zip(&decisions)
            .collect::<Vec<_>>();
        assert_eq!(
            anchored_alignment_scores(&catalog, &required, &gerber_design(Vec::new()), &anchors)
                .unwrap()
                .len(),
            16
        );
    }

    #[cfg(unix)]
    #[test]
    fn kicad_process_uses_argument_paths_with_spaces_and_handles_exit_and_timeout() {
        use std::os::unix::fs::PermissionsExt;
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("kicad cli");
        fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("fake kicad-cli");
        fs::write(&executable, "#!/bin/sh\nreport=''\noutput=''\nwhile [ \"$#\" -gt 0 ]; do\n case \"$1\" in\n  --report-file) shift; report=\"$1\";;\n  --output) shift; output=\"$1\";;\n esac\n shift\ndone\nprintf '%s' '{\"warnings\":[]}' > \"$report\"\nprintf '%s' '(kicad_pcb)' > \"$output\"\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let source = directory.join("board with spaces.brd");
        fs::write(&source, "fixture").unwrap();
        let output = directory.join("board with spaces.kicad_pcb");
        let report = directory.join("report with spaces.json");
        run_kicad_import_with_timeout(
            &executable,
            &source,
            &output,
            &report,
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&output).unwrap(), "(kicad_pcb)");
        assert!(parse_kicad_report(&fs::read_to_string(&report).unwrap()).is_ok());

        let failing = directory.join("failing kicad-cli");
        fs::write(&failing, "#!/bin/sh\necho controlled-error >&2\nexit 7\n").unwrap();
        fs::set_permissions(&failing, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            run_kicad_import_with_timeout(
                &failing,
                &source,
                &output,
                &report,
                Duration::from_secs(2)
            )
            .unwrap_err()
            .to_string()
            .contains("controlled-error")
        );

        let hanging = directory.join("hanging kicad-cli");
        fs::write(&hanging, "#!/bin/sh\nwhile :; do :; done\n").unwrap();
        fs::set_permissions(&hanging, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            run_kicad_import_with_timeout(
                &hanging,
                &source,
                &output,
                &report,
                Duration::from_millis(25)
            )
            .unwrap_err()
            .to_string()
            .contains("timed out")
        );
    }

    #[test]
    fn selected_tp_analysis_is_content_addressed_filters_rules_and_preserves_original_design() {
        use crate::rules::{RuleApproval, RuleDefinition, RuleKind, RulePackStatus};
        let temporary = tempfile::tempdir().unwrap();
        let cache = CacheStore::new(temporary.path()).unwrap();
        let center = PointNm {
            x: 1_000_000,
            y: 2_000_000,
        };
        let mut design = gerber_design(vec![
            layer(
                "top.gtl",
                "COPPER_TOP",
                Side::Top,
                vec![pad("copper", "top.gtl", center, 900_000)],
            ),
            layer(
                "top.gts",
                "SOLDERMASK_TOP",
                Side::Top,
                vec![pad("mask", "top.gts", center, 1_000_000)],
            ),
        ]);
        design.id = "gerber-design".into();
        design.content_hash = "gerber-content".into();
        design.finalize();
        cache.save_design(&design).unwrap();

        let mut catalog = sample_catalog();
        catalog.id = "catalog".into();
        catalog.content_hash = "catalog-content".into();
        catalog.candidates[0].center = center;
        catalog.candidates[0].identity_confidence = CoverageLevel::Explicit;
        cache
            .save_json(
                &catalog_directory(&cache, &catalog.id).join("catalog.json"),
                &catalog,
            )
            .unwrap();
        let selection = TestPointSelection {
            schema_version: 1,
            kind: "TEST_POINT_SELECTION".into(),
            id: "selection".into(),
            catalog_id: catalog.id.clone(),
            catalog_content_hash: catalog.content_hash.clone(),
            brd_sha256: catalog.brd_sha256.clone(),
            lifecycle_status: ArtifactLifecycle::Approved,
            decisions: vec![TestPointSelectionDecision {
                candidate_id: catalog.candidates[0].id.clone(),
                decision: TestPointDecision::Required,
                comment: "fixture".into(),
            }],
            imported_by: "operator".into(),
            imported_at: "unix:1".into(),
            unresolved_count: 0,
            approval: Some(ArtifactApproval {
                approved_by: "approver".into(),
                approved_at: "unix:2".into(),
                content_hash: "selection-content".into(),
                comment: None,
            }),
            content_hash: "selection-content".into(),
        };
        cache
            .save_json(&selection_path(&cache, &selection.id), &selection)
            .unwrap();
        let alignment = TestPointAlignment {
            schema_version: 1,
            kind: "TEST_POINT_ALIGNMENT".into(),
            id: "alignment".into(),
            lifecycle_status: ArtifactLifecycle::Approved,
            selection_id: selection.id.clone(),
            selection_content_hash: selection.content_hash.clone(),
            catalog_id: catalog.id.clone(),
            design_id: design.id.clone(),
            design_content_hash: design.content_hash.clone(),
            selected: AlignmentScore {
                transform: TestPointTransform {
                    rotation_deg: 0,
                    mirrored: false,
                    swap_sides: false,
                    translate_x_nm: 0,
                    translate_y_nm: 0,
                },
                unique_matches: 1,
                ambiguous_matches: 0,
                unmatched: 0,
                outline_residual_nm: 0,
                anchor_max_residual_nm: None,
            },
            alternatives: Vec::new(),
            preview_bindings: Vec::new(),
            anchors: Vec::new(),
            requires_manual_anchors: false,
            generated_at: "unix:2".into(),
            approval: Some(ArtifactApproval {
                approved_by: "approver".into(),
                approved_at: "unix:2".into(),
                content_hash: "alignment-content".into(),
                comment: Some("fixture".into()),
            }),
            content_hash: "alignment-content".into(),
        };
        cache
            .save_json(&alignment_path(&cache, &alignment.id), &alignment)
            .unwrap();

        let rules = vec![
            RuleDefinition {
                id: "tp-diameter".into(),
                title: "TP diameter".into(),
                kind: RuleKind::MinimumDiameter,
                source: EntityKind::TestPoint,
                target: None,
                metric: None,
                threshold_nm: 800_000,
                severity: Some(Severity::Error),
                layer_functions: Vec::new(),
                same_net_only: false,
                different_net_only: false,
                citation: None,
            },
            RuleDefinition {
                id: "unrelated-copper-width".into(),
                title: "Copper width".into(),
                kind: RuleKind::MinimumWidth,
                source: EntityKind::Copper,
                target: None,
                metric: None,
                threshold_nm: 2_000_000,
                severity: Some(Severity::Error),
                layer_functions: Vec::new(),
                same_net_only: false,
                different_net_only: false,
                citation: None,
            },
        ];
        let pack = RulePack {
            id: "approved-rules".into(),
            version: "1".into(),
            title: "Approved".into(),
            status: RulePackStatus::Approved,
            approval: Some(RuleApproval {
                approved_by: "approver".into(),
                approved_at: "unix:2".into(),
                content_hash: hash_json(&rules).unwrap(),
            }),
            review_items: Vec::new(),
            rules,
        };
        cache
            .save_json(&cache.root().join("rules/approved-rules.json"), &pack)
            .unwrap();

        let value = analyze_selected_test_points_request(json!({ "cache_dir": cache.root(), "design_id": design.id, "selection_id": selection.id, "alignment_id": alignment.id, "rule_pack_id": pack.id })).unwrap();
        let analysis: SelectedTestPointAnalysis = serde_json::from_value(value).unwrap();
        assert_eq!(analysis.verdict, Verdict::Pass);
        assert_eq!(
            (
                analysis.required_count,
                analysis.pass_count,
                analysis.fail_count,
                analysis.review_count
            ),
            (1, 1, 0, 0)
        );
        assert_eq!(analysis.bindings[0].matched_width_nm, Some(900_000));
        assert!(
            analysis
                .violations
                .iter()
                .all(|violation| violation.rule_id != "unrelated-copper-width")
        );
        assert!(analysis.derived_design_id.starts_with("selected-design-"));
        assert!(Path::new(&analysis.report_path).is_file());
        assert!(
            cache
                .load_design(&analysis.derived_design_id)
                .unwrap()
                .test_points[0]
                .net_name
                .is_none()
        );
        assert!(
            cache
                .load_design("gerber-design")
                .unwrap()
                .test_points
                .is_empty()
        );

        let mut shielded_design = design.clone();
        shielded_design.id = "gerber-design-shielded".into();
        shielded_design.content_hash = "gerber-content-shielded".into();
        shielded_design.components.push(Component {
            refdes: "SH1".into(),
            package_name: Some("SHIELD_CAN".into()),
            center,
            bounds: BoundsNm {
                min_x: center.x - 2_000_000,
                min_y: center.y - 2_000_000,
                max_x: center.x + 2_000_000,
                max_y: center.y + 2_000_000,
            },
            side: Side::Top,
            pins: Vec::new(),
            confidence: CoverageLevel::Explicit,
        });
        cache.save_design(&shielded_design).unwrap();
        let mut shielded_alignment = alignment.clone();
        shielded_alignment.id = "alignment-shielded".into();
        shielded_alignment.design_id = shielded_design.id.clone();
        shielded_alignment.design_content_hash = shielded_design.content_hash.clone();
        shielded_alignment.content_hash = "alignment-content-shielded".into();
        shielded_alignment.approval.as_mut().unwrap().content_hash =
            shielded_alignment.content_hash.clone();
        cache
            .save_json(
                &alignment_path(&cache, &shielded_alignment.id),
                &shielded_alignment,
            )
            .unwrap();
        let shielded: SelectedTestPointAnalysis = serde_json::from_value(
            analyze_selected_test_points_request(json!({
                "cache_dir": cache.root(),
                "design_id": shielded_design.id,
                "selection_id": selection.id,
                "alignment_id": shielded_alignment.id,
                "rule_pack_id": pack.id,
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(shielded.verdict, Verdict::Review);
        assert_eq!(shielded.bindings[0].status, BindingStatus::Review);
        assert_eq!(
            shielded.bindings[0].shield_candidate_refdes.as_deref(),
            Some("SH1")
        );
        assert!(
            fs::read_to_string(&shielded.report_path)
                .unwrap()
                .contains("Shield candidate")
        );
    }

    #[test]
    fn selection_review_blocks_approval_and_first_approved_object_is_immutable() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = CacheStore::new(temporary.path()).unwrap();
        let catalog = sample_catalog();
        cache
            .save_json(
                &catalog_directory(&cache, &catalog.id).join("catalog.json"),
                &catalog,
            )
            .unwrap();
        let mut draft = TestPointSelection {
            schema_version: 1,
            kind: "TEST_POINT_SELECTION".into(),
            id: "draft-selection".into(),
            catalog_id: catalog.id.clone(),
            catalog_content_hash: catalog.content_hash.clone(),
            brd_sha256: catalog.brd_sha256.clone(),
            lifecycle_status: ArtifactLifecycle::Draft,
            decisions: vec![TestPointSelectionDecision {
                candidate_id: "tp1".into(),
                decision: TestPointDecision::Review,
                comment: String::new(),
            }],
            imported_by: "operator".into(),
            imported_at: "unix:1".into(),
            unresolved_count: 1,
            approval: None,
            content_hash: "draft".into(),
        };
        cache
            .save_json(&selection_path(&cache, &draft.id), &draft)
            .unwrap();
        assert!(approve_test_point_selection_request(json!({ "cache_dir": cache.root(), "selection_id": draft.id, "approved_by": "first" })).is_err());
        draft.decisions[0].decision = TestPointDecision::Required;
        draft.unresolved_count = 0;
        cache
            .save_json(&selection_path(&cache, &draft.id), &draft)
            .unwrap();
        let first: TestPointSelection = serde_json::from_value(approve_test_point_selection_request(json!({ "cache_dir": cache.root(), "selection_id": draft.id, "approved_by": "first" })).unwrap()).unwrap();
        let second: TestPointSelection = serde_json::from_value(approve_test_point_selection_request(json!({ "cache_dir": cache.root(), "selection_id": draft.id, "approved_by": "second" })).unwrap()).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(second.approval.unwrap().approved_by, "first");
        assert!(selection_path(&cache, &draft.id).is_file());
    }

    fn candidate(id: &str, x: i64, y: i64, side: Side) -> BrdTestPointCandidate {
        BrdTestPointCandidate {
            id: id.into(),
            source_kind: "TP_FOOTPRINT".into(),
            identity_confidence: CoverageLevel::Inferred,
            refdes: Some(id.into()),
            net_name: None,
            side,
            center: PointNm { x, y },
            pad_shape: Some("circle".into()),
            pad_width_nm: Some(800_000),
            pad_height_nm: Some(800_000),
            source_evidence: vec!["fixture".into()],
        }
    }

    fn pad(id: &str, layer_id: &str, center: PointNm, size: i64) -> Feature {
        Feature {
            id: id.into(),
            layer_id: layer_id.into(),
            polarity: Polarity::Dark,
            geometry: FeatureGeometry::Pad {
                center,
                size_x_nm: size,
                size_y_nm: size,
                rotation_deg: 0.0,
            },
            net_name: None,
            component_ref: None,
            pin: None,
            attributes: BTreeMap::new(),
            source: "fixture".into(),
        }
    }

    fn layer(id: &str, function: &str, side: Side, features: Vec<Feature>) -> Layer {
        Layer {
            id: id.into(),
            name: id.into(),
            function: function.into(),
            side,
            features,
        }
    }

    fn gerber_design(layers: Vec<Layer>) -> Design {
        Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "gerber".into(),
            format: DesignFormat::GerberPackage,
            source_path: "fixture.zip".into(),
            content_hash: "design-hash".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 1,
                max_y: 1,
            },
            layers,
            components: Vec::new(),
            nets: Vec::new(),
            test_points: Vec::new(),
            coverage: SemanticCoverage {
                layers: CoverageLevel::Explicit,
                ..SemanticCoverage::default()
            },
            diagnostics: Vec::new(),
        }
    }
}
