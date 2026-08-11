use circuit_inspector_core::cache::CacheStore;
use circuit_inspector_core::model::{CoverageLevel, Design, DesignFormat, Verdict};
use circuit_inspector_core::parsers::import_design;
use circuit_inspector_core::rules::RulePack;
use circuit_inspector_core::server::dispatch;
use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::json;
use std::fs::File;
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
    assert!(design.layers.iter().any(|layer| {
        layer.id == "odb-comp---top"
            && layer.function == "COMPONENT"
            && layer.side == circuit_inspector_core::model::Side::Top
    }));
    assert!(design.test_points.iter().all(|point| {
        point.radius_nm == Some(400_000)
            && point.layer_id.as_deref() == Some("odb-top")
            && point
                .geometry_source
                .as_deref()
                .is_some_and(|source| source.replace('\\', "/").ends_with("/layers/top/features"))
    }));
    assert!(design.components.iter().all(|component| {
        component.bounds.max_x - component.bounds.min_x == 800_000
            && component.bounds.max_y - component.bounds.min_y == 800_000
    }));
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
    assert_eq!(listed["confirmed_test_points_report"]["confirmed_count"], 0);
    let candidate_ids = listed["test_points"]
        .as_array()
        .unwrap()
        .iter()
        .map(|point| point["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    for point in listed["test_points"].as_array().unwrap() {
        assert_eq!(point["radius_nm"], 400_000);
        assert_eq!(point["layer_id"], "odb-top");
        assert_eq!(point["review_context"]["metric"], "EDGE_TO_EDGE");
        assert_eq!(
            point["review_context"]["board_edge"]["distance_nm"],
            9_600_000
        );
        assert_eq!(
            point["review_context"]["board_edge"]["confidence"],
            "EXPLICIT"
        );
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
        reviewed["test_points"][0]["confirmation"]["method"],
        "HUMAN_REVIEW"
    );
    assert_eq!(
        reviewed["confirmed_test_points_report"]["confirmed_count"],
        2
    );
    let report_path = reviewed["confirmed_test_points_report"]["report_path"]
        .as_str()
        .unwrap();
    let report = std::fs::read_to_string(report_path).unwrap();
    assert!(report.contains("kind: CONFIRMED_TEST_POINT_CATALOG"));
    assert!(report.contains("HUMAN_REVIEW"));
    assert!(report.contains("dft-owner"));
    assert!(report.contains("不表示尺寸、间距"));
    for candidate_id in candidate_ids {
        assert!(report.contains(candidate_id));
    }
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
fn source_confirmed_test_points_are_written_to_the_markdown_catalog() {
    let temporary = tempfile::tempdir().unwrap();
    let summary = dispatch(
        "import_design",
        json!({ "path": fixture("fixtures/gerber/simple"), "cache_dir": temporary.path() }),
    )
    .unwrap();
    let listed = dispatch(
        "list_test_points",
        json!({ "design_id": summary["id"], "cache_dir": temporary.path() }),
    )
    .unwrap();

    assert!(
        listed["confirmed_test_points_report"]["confirmed_count"]
            .as_u64()
            .is_some_and(|count| count >= 2)
    );
    let report = std::fs::read_to_string(
        listed["confirmed_test_points_report"]["report_path"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert!(report.contains("PROGRAM_OR_SOURCE_CONFIRMED"));
    assert!(report.contains("TP1"));
    assert!(report.contains("NET_TEST_A"));
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
fn odb_import_resolves_custom_test_point_symbols_and_tooling_hole_usage() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("odb");
    for directory in [
        "matrix",
        "symbols/tp_custom",
        "steps/pcb/eda",
        "steps/pcb/layers/comp_+_top",
        "steps/pcb/layers/top",
        "steps/pcb/layers/drill",
    ] {
        std::fs::create_dir_all(root.join(directory)).unwrap();
    }
    std::fs::write(
        root.join("matrix/matrix"),
        "UNITS=MM\nSTEP { NAME=pcb }\nLAYER { ROW=1 NAME=comp_+_top CONTEXT=BOARD TYPE=COMPONENT }\nLAYER { ROW=2 NAME=top CONTEXT=BOARD TYPE=SIGNAL }\nLAYER { ROW=3 NAME=drill CONTEXT=BOARD TYPE=DRILL }\n",
    )
    .unwrap();
    std::fs::write(
        root.join("symbols/tp_custom/features"),
        "UNITS=MM\n$0 r800\nP 0 0 0 P 0\n",
    )
    .unwrap();
    std::fs::write(
        root.join("steps/pcb/eda/data"),
        "UNITS=MM\nNET TP_NET\nPKG TEST_POINT 0 -0.4 -0.4 0.4 0.4\n",
    )
    .unwrap();
    std::fs::write(
        root.join("steps/pcb/layers/comp_+_top/components"),
        "UNITS=MM\nCMP 0 2 2 0 N MTP1 TEST_POINT\nTOP 1 2 2 0 N 0 0 TP_PAD\n",
    )
    .unwrap();
    std::fs::write(
        root.join("steps/pcb/layers/top/features"),
        "UNITS=MM\n$0 tp_custom\n$1 r1000\n@0 .pad_usage\nP 2 2 0 P 0\nP 5 5 1 P 0;0=4\n",
    )
    .unwrap();
    std::fs::write(
        root.join("steps/pcb/layers/drill/features"),
        "UNITS=MM\n$0 r1000\nP 5 5 0 P 0\n",
    )
    .unwrap();
    std::fs::write(
        root.join("steps/pcb/profile"),
        "UNITS=MM\nS P 0\nOB 0 0\nOS 10 0\nOS 10 10\nOS 0 10\nOE\n",
    )
    .unwrap();

    let design = import_design(&root).unwrap();

    assert_eq!(design.test_points.len(), 1);
    assert_eq!(design.test_points[0].radius_nm, Some(400_000));
    assert!(
        design
            .layers
            .iter()
            .all(|layer| !layer.name.starts_with("layer-"))
    );
    assert_eq!(design.tooling_hole_drills().len(), 1);

    let cache = CacheStore::new(temporary.path().join("cache")).unwrap();
    cache.save_design(&design).unwrap();
    let listed = dispatch(
        "list_test_points",
        json!({ "design_id": design.id, "cache_dir": cache.root() }),
    )
    .unwrap();
    assert_eq!(
        listed["test_points"][0]["review_context"]["nearest_tooling_hole"]["distance_nm"],
        3_342_641
    );
}

#[test]
fn nested_odb_tgz_preserves_surface_sides_and_never_compares_test_points_across_sides() {
    let temporary = tempfile::tempdir().unwrap();
    let job = temporary.path().join("source/job");
    for directory in [
        "matrix",
        "steps/pcb/layers/l1",
        "steps/pcb/layers/l2",
        "steps/pcb",
    ] {
        std::fs::create_dir_all(job.join(directory)).unwrap();
    }
    std::fs::write(
        job.join("matrix/matrix"),
        "UNITS=MM\nSTEP { NAME=pcb }\nLAYER { ROW=1 NAME=l1 CONTEXT=BOARD TYPE=SIGNAL }\nLAYER { ROW=2 NAME=l2 CONTEXT=BOARD TYPE=SIGNAL }\n",
    )
    .unwrap();
    std::fs::write(
        job.join("steps/pcb/layers/l1/features"),
        "UNITS=MM\n$0 r400\n@0 .test_point\n@1 .net_name\n&0 TOP_NET\nP 5 5 0 P 0;0,1=0\nP 8 5 0 P 0;0,1=0\n",
    )
    .unwrap();
    std::fs::write(
        job.join("steps/pcb/layers/l2/features"),
        "UNITS=MM\n$0 r400\n@0 .test_point\n@1 .net_name\n&0 BOTTOM_NET\nP 5 5 0 P 0;0,1=0\nP 8.1 5 0 P 0;0,1=0\n",
    )
    .unwrap();
    std::fs::write(
        job.join("steps/pcb/profile"),
        "UNITS=MM\nS P 0\nOB 0 0\nOS 12 0\nOS 12 10\nOS 0 10\nOE\n",
    )
    .unwrap();

    let archive_path = temporary.path().join("nested-board.tgz");
    let encoder = GzEncoder::new(File::create(&archive_path).unwrap(), Compression::default());
    let mut archive = tar::Builder::new(encoder);
    archive.append_dir_all("payload/job", &job).unwrap();
    archive.finish().unwrap();
    archive.into_inner().unwrap().finish().unwrap();

    let design = import_design(&archive_path).unwrap();
    assert_eq!(design.test_points.len(), 4);
    assert_eq!(
        design
            .layers
            .iter()
            .find(|layer| layer.id == "odb-l1")
            .unwrap()
            .side,
        circuit_inspector_core::model::Side::Top
    );
    assert_eq!(
        design
            .layers
            .iter()
            .find(|layer| layer.id == "odb-l2")
            .unwrap()
            .side,
        circuit_inspector_core::model::Side::Bottom
    );

    let cache = CacheStore::new(temporary.path().join("cache")).unwrap();
    cache.save_design(&design).unwrap();
    let rule_pack: RulePack = serde_json::from_slice(
        &std::fs::read(fixture("docs/rules/example-approved-rule-pack.json")).unwrap(),
    )
    .unwrap();
    cache
        .save_json(&cache.root().join("rules/fixture-dft-dfm.json"), &rule_pack)
        .unwrap();
    let listed = dispatch(
        "list_test_points",
        json!({ "design_id": design.id, "cache_dir": cache.root() }),
    )
    .unwrap();
    let sides = listed["test_points"]
        .as_array()
        .unwrap()
        .iter()
        .map(|point| point["side"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(sides.iter().filter(|side| **side == "TOP").count(), 2);
    assert_eq!(sides.iter().filter(|side| **side == "BOTTOM").count(), 2);

    let analysis = dispatch(
        "analyze_design",
        json!({
            "design_id": design.id,
            "rule_pack_id": "fixture-dft-dfm",
            "cache_dir": cache.root()
        }),
    )
    .unwrap();
    assert_eq!(analysis["fail_count"], 0);
    assert!(
        analysis["violations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|violation| { violation["rule_id"] != "dft-testpoint-spacing" })
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
