use circuit_inspector_core::cache::CacheStore;
use circuit_inspector_core::model::{CoverageLevel, DesignFormat, Verdict};
use circuit_inspector_core::parsers::import_design;
use circuit_inspector_core::rules::RulePack;
use circuit_inspector_core::server::dispatch;
use serde_json::json;
use std::path::{Path, PathBuf};

fn fixture(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}

#[test]
fn imports_gerber_package_with_x2_and_drill_semantics() {
    let design = import_design(&fixture("fixtures/gerber/simple")).unwrap();
    assert_eq!(design.format, DesignFormat::GerberPackage);
    assert_eq!(design.coverage.layers, CoverageLevel::Explicit);
    assert_eq!(design.coverage.drills, CoverageLevel::Explicit);
    assert!(design.nets.iter().any(|net| net == "NET_TEST_A"));
    assert!(design.test_points.len() >= 2);
}

#[test]
fn imports_odb_directory() {
    let design = import_design(&fixture("fixtures/odb/simple")).unwrap();
    assert_eq!(design.format, DesignFormat::Odbpp);
    assert_eq!(design.coverage.components, CoverageLevel::Explicit);
    assert_eq!(design.components.len(), 2);
}

#[test]
fn core_protocol_imports_analyzes_and_renders_evidence() {
    let temporary = tempfile::tempdir().unwrap();
    let cache = CacheStore::new(temporary.path()).unwrap();
    let rule_pack: RulePack = serde_json::from_slice(
        &std::fs::read(fixture("docs/rules/example-approved-rule-pack.json")).unwrap(),
    )
    .unwrap();
    cache
        .save_json(
            &temporary.path().join("rules/fixture-dft-dfm.json"),
            &rule_pack,
        )
        .unwrap();
    let summary = dispatch(
        "import_design",
        json!({ "path": fixture("fixtures/gerber/simple"), "cache_dir": temporary.path() }),
    )
    .unwrap();
    let design_id = summary["id"].as_str().unwrap();
    let analysis = dispatch(
        "analyze_design",
        json!({
            "design_id": design_id,
            "rule_pack_id": "fixture-dft-dfm",
            "cache_dir": temporary.path()
        }),
    )
    .unwrap();
    assert_eq!(
        analysis["verdict"],
        serde_json::to_value(Verdict::Fail).unwrap()
    );
    let analysis_id = analysis["id"].as_str().unwrap();
    let evidence = dispatch(
        "render_evidence",
        json!({
            "analysis_id": analysis_id,
            "cache_dir": temporary.path(),
            "width": 512,
            "height": 512
        }),
    )
    .unwrap();
    assert!(
        evidence["evidence"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    );
}
