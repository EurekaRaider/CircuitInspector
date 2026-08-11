use circuit_inspector_core::cache::CacheStore;
use circuit_inspector_core::model::{CoverageLevel, Design, DesignFormat, Verdict};
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
    assert_eq!(design.test_points.len(), 2);
    assert_eq!(design.coverage.test_points, CoverageLevel::Inferred);
}

#[test]
fn stale_cached_design_is_reparsed_on_import() {
    let temporary = tempfile::tempdir().unwrap();
    let source = fixture("fixtures/odb/simple");
    let first = dispatch(
        "import_design",
        json!({ "path": source, "cache_dir": temporary.path() }),
    )
    .unwrap();
    let design_id = first["id"].as_str().unwrap();
    let cache = CacheStore::new(temporary.path()).unwrap();
    let mut stale = cache.load_design(design_id).unwrap();
    stale.schema_version = Design::SCHEMA_VERSION - 1;
    cache.save_design(&stale).unwrap();
    let listed = dispatch("list_designs", json!({ "cache_dir": temporary.path() })).unwrap();
    assert_eq!(listed["designs"].as_array().unwrap().len(), 0);
    assert_eq!(listed["diagnostics"][0]["code"], "STALE_CACHED_DESIGN");

    let reparsed = dispatch(
        "import_design",
        json!({ "path": source, "cache_dir": temporary.path() }),
    )
    .unwrap();
    assert_eq!(reparsed["cache_hit"], false);
    assert_eq!(
        cache.load_design(design_id).unwrap().schema_version,
        Design::SCHEMA_VERSION
    );
}

#[test]
fn inferred_odb_test_points_can_be_confirmed_without_reexport() {
    let temporary = tempfile::tempdir().unwrap();
    let summary = dispatch(
        "import_design",
        json!({ "path": fixture("fixtures/odb/simple"), "cache_dir": temporary.path() }),
    )
    .unwrap();
    let design_id = summary["id"].as_str().unwrap();
    let listed = dispatch(
        "list_test_points",
        json!({ "design_id": design_id, "cache_dir": temporary.path() }),
    )
    .unwrap();
    let candidate_ids = listed["test_points"]
        .as_array()
        .unwrap()
        .iter()
        .map(|point| point["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    for point in listed["test_points"].as_array().unwrap() {
        assert_eq!(point["review_context"]["metric"], "EDGE_TO_EDGE");
        assert!(point["review_context"]["board_edge"]["distance_nm"].is_i64());
        assert!(point["review_context"]["board_edge"]["point"]["x"].is_i64());
        let nearest = &point["review_context"]["nearest_test_point"];
        assert!(nearest["distance_nm"].is_i64());
        assert_ne!(nearest["id"], point["id"]);
    }
    let reviewed = dispatch(
        "review_test_points",
        json!({
            "design_id": design_id,
            "cache_dir": temporary.path(),
            "reviewed_by": "dft-owner",
            "confirm_ids": candidate_ids,
            "reject_ids": [],
            "additions": []
        }),
    )
    .unwrap();
    assert_eq!(reviewed["test_points"][0]["confidence"], "EXPLICIT");
    assert_eq!(
        reviewed["test_points"][0]["review_context"]["metric"],
        "EDGE_TO_EDGE"
    );
    assert_eq!(
        reviewed["summary"]["semantic_coverage"]["test_points"],
        "EXPLICIT"
    );
}

#[test]
fn odb_import_selects_the_board_step_instead_of_merging_panel_geometry() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("odb");
    std::fs::create_dir_all(root.join("matrix")).unwrap();
    std::fs::write(root.join("matrix/matrix"), "UNITS=MM\nSTEP { NAME=pcb }\nSTEP { NAME=panel }\nLAYER { NAME=top CONTEXT=BOARD TYPE=SIGNAL }\n").unwrap();
    for (step, reference) in [("pcb", "U1"), ("panel", "U99")] {
        let layer = root.join("steps").join(step).join("layers/top");
        std::fs::create_dir_all(&layer).unwrap();
        std::fs::write(layer.join("features"), "UNITS=MM\n$0 r500\nP 1 1 0 P 0\n").unwrap();
        std::fs::write(
            layer.join("profile"),
            "UNITS=MM\nS P 0\nOB 0 0\nOS 10 0\nOS 10 10\nOS 0 10\nOE\n",
        )
        .unwrap();
        std::fs::write(
            layer.join("components"),
            format!("UNITS=MM\nCMP 0 1 1 0 N {reference} PACKAGE\n"),
        )
        .unwrap();
    }

    let design = import_design(&root).unwrap();

    assert_eq!(design.components.len(), 1);
    assert_eq!(design.components[0].refdes, "U1");
    assert!(
        design
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "ODB_PRIMARY_STEP_SELECTED")
    );
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
    let listed_designs =
        dispatch("list_designs", json!({ "cache_dir": temporary.path() })).unwrap();
    assert_eq!(listed_designs["designs"][0]["summary"]["id"], design_id);
    assert!(
        listed_designs["designs"][0]["updated_at_unix_ms"]
            .as_u64()
            .is_some()
    );
    let listed_analyses =
        dispatch("list_analyses", json!({ "cache_dir": temporary.path() })).unwrap();
    assert_eq!(listed_analyses["analyses"][0]["summary"]["id"], analysis_id);
    assert_eq!(listed_analyses["analyses"][0]["summary"]["verdict"], "FAIL");
    std::fs::write(
        temporary.path().join("designs").join("broken.json"),
        b"{not-json",
    )
    .unwrap();
    let designs_with_diagnostic =
        dispatch("list_designs", json!({ "cache_dir": temporary.path() })).unwrap();
    assert_eq!(
        designs_with_diagnostic["designs"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        designs_with_diagnostic["diagnostics"][0]["code"],
        "INVALID_CACHED_DESIGN"
    );
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
