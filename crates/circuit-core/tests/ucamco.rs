use circuit_inspector_core::parsers::import_design;
use std::path::PathBuf;

#[test]
#[ignore = "requires locally licensed Ucamco fixtures via UCAMCO_FIXTURES"]
fn imports_locally_provided_ucamco_conformance_fixtures() {
    let Ok(root) = std::env::var("UCAMCO_FIXTURES") else {
        eprintln!("UCAMCO_FIXTURES is not set; official conformance suite is NOT_RUN");
        return;
    };
    let root = PathBuf::from(root);
    assert!(root.exists(), "UCAMCO_FIXTURES does not exist");
    let design =
        import_design(&root).expect("Ucamco fixture directory must import without parser failure");
    let feature_count = design
        .layers
        .iter()
        .map(|layer| layer.features.len())
        .sum::<usize>();
    assert!(
        feature_count > 0,
        "Ucamco fixture import produced no geometry"
    );
}
