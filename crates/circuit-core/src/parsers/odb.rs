use super::{diagnostic, empty_design};
use crate::model::{
    BoundsNm, Component, CoverageLevel, Design, DesignFormat, Feature, FeatureGeometry, Layer,
    PointNm, Polarity, Severity, Side, TestPoint,
};
use crate::{CoreError, CoreResult};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

pub fn parse_odb(
    root: &Path,
    files: &[PathBuf],
    source: &Path,
    content_hash: &str,
) -> CoreResult<Design> {
    let mut design = empty_design(DesignFormat::Odbpp, source, content_hash);
    let mut nets = BTreeSet::new();
    let mut components = BTreeMap::<String, Component>::new();
    let mut test_points = Vec::new();

    for path in files {
        let relative = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let lower = relative.to_ascii_lowercase();
        if lower.ends_with("/features") || lower.ends_with("/profile") {
            let text = read_text(path, &mut design)?;
            let layer_name = odb_layer_name(&relative).unwrap_or_else(|| {
                if lower.ends_with("/profile") {
                    "profile".into()
                } else {
                    format!("layer-{}", design.layers.len())
                }
            });
            let layer_id = format!("odb-{}", sanitize_id(&layer_name));
            let function = if lower.ends_with("/profile") {
                "PROFILE".into()
            } else {
                infer_odb_function(&layer_name)
            };
            let side = side_from_name(&layer_name);
            let features = parse_feature_file(&text, path, &layer_id, &mut design.diagnostics);
            if !features.is_empty() {
                if let Some(existing) = design.layers.iter_mut().find(|layer| layer.id == layer_id)
                {
                    existing.features.extend(features);
                } else {
                    design.layers.push(Layer {
                        id: layer_id,
                        name: layer_name,
                        function,
                        side,
                        features,
                    });
                }
            }
        } else if lower.ends_with("/components") {
            let text = read_text(path, &mut design)?;
            parse_components(
                &text,
                path,
                &mut components,
                &mut nets,
                &mut test_points,
                &mut design.diagnostics,
            );
        } else if lower.ends_with("eda/data") || lower.ends_with("/netlists/cadnet/netlist") {
            let text = read_text(path, &mut design)?;
            parse_nets(&text, path, &mut nets, &mut test_points);
        } else if lower.ends_with("stephdr") || lower.contains("step_repeat") {
            design.diagnostics.push(diagnostic(
                "ODB_STEP_REPEAT_DETECTED",
                Severity::Info,
                "ODB++ step-repeat metadata was detected; child-step geometry is preserved as source hierarchy diagnostics in this build",
                Some(path),
            ));
        }
    }

    if design.layers.is_empty() {
        return Err(CoreError::Parse(
            "ODB++ archive contains no supported feature or profile files".into(),
        ));
    }
    design.nets = nets.into_iter().collect();
    design.components = components.into_values().collect();
    design.test_points = test_points;
    design.coverage.layers = CoverageLevel::Explicit;
    design.coverage.nets = if design.nets.is_empty() {
        CoverageLevel::Missing
    } else {
        CoverageLevel::Explicit
    };
    design.coverage.components = if design.components.is_empty() {
        CoverageLevel::Missing
    } else {
        CoverageLevel::Explicit
    };
    design.coverage.pins = if design
        .components
        .iter()
        .any(|component| !component.pins.is_empty())
    {
        CoverageLevel::Explicit
    } else {
        CoverageLevel::Missing
    };
    design.coverage.test_points = design
        .test_points
        .iter()
        .map(|point| point.confidence)
        .fold(CoverageLevel::Missing, CoverageLevel::combine);
    design.coverage.drills =
        if design
            .layers
            .iter()
            .flat_map(|layer| &layer.features)
            .any(|feature| {
                matches!(feature.geometry, FeatureGeometry::Drill { .. })
                    || feature.layer_id.to_ascii_lowercase().contains("drill")
            })
        {
            CoverageLevel::Explicit
        } else {
            CoverageLevel::Missing
        };
    Ok(design)
}

fn read_text(path: &Path, design: &mut Design) -> CoreResult<String> {
    match fs::read_to_string(path) {
        Ok(value) => Ok(value),
        Err(error) => {
            design.diagnostics.push(diagnostic(
                "ODB_TEXT_READ_FAILED",
                Severity::Warning,
                format!("{} could not be read: {error}", path.display()),
                Some(path),
            ));
            Ok(String::new())
        }
    }
}

fn parse_feature_file(
    text: &str,
    source: &Path,
    layer_id: &str,
    diagnostics: &mut Vec<crate::model::Diagnostic>,
) -> Vec<Feature> {
    let mut units_scale = 25_400_000.0;
    let mut symbols = BTreeMap::<usize, (i64, i64)>::new();
    let mut features = Vec::new();
    let mut contour = Vec::new();
    let mut in_surface = false;
    for (line_index, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.eq_ignore_ascii_case("UNITS=MM") || line.eq_ignore_ascii_case("U MM") {
            units_scale = 1_000_000.0;
            continue;
        }
        if line.eq_ignore_ascii_case("UNITS=INCH") || line.eq_ignore_ascii_case("U INCH") {
            units_scale = 25_400_000.0;
            continue;
        }
        if let Some(rest) = line.strip_prefix('$') {
            let mut parts = rest.split_whitespace();
            if let (Some(index), Some(name)) = (
                parts.next().and_then(|value| value.parse::<usize>().ok()),
                parts.next(),
            ) {
                symbols.insert(index, symbol_dimensions(name, units_scale));
            }
            continue;
        }
        let parts = line.split_whitespace().collect::<Vec<_>>();
        let Some(record) = parts.first().copied() else {
            continue;
        };
        let make_feature = |geometry: FeatureGeometry, polarity: Polarity, index: usize| Feature {
            id: format!("{layer_id}:{index}"),
            layer_id: layer_id.into(),
            polarity,
            geometry,
            net_name: None,
            component_ref: None,
            pin: None,
            attributes: BTreeMap::new(),
            source: source.display().to_string(),
        };
        match record {
            "P" if parts.len() >= 5 => {
                let center = PointNm {
                    x: number_nm(parts[1], units_scale),
                    y: number_nm(parts[2], units_scale),
                };
                let symbol = parts[3].parse::<usize>().unwrap_or_default();
                let (size_x_nm, size_y_nm) =
                    symbols.get(&symbol).copied().unwrap_or((100_000, 100_000));
                let polarity = odb_polarity(parts.get(4).copied());
                features.push(make_feature(
                    FeatureGeometry::Pad {
                        center,
                        size_x_nm,
                        size_y_nm,
                        rotation_deg: 0.0,
                    },
                    polarity,
                    features.len(),
                ));
            }
            "L" if parts.len() >= 7 => {
                let symbol = parts[5].parse::<usize>().unwrap_or_default();
                let width_nm = symbols.get(&symbol).map(|value| value.0).unwrap_or(100_000);
                features.push(make_feature(
                    FeatureGeometry::Line {
                        start: PointNm {
                            x: number_nm(parts[1], units_scale),
                            y: number_nm(parts[2], units_scale),
                        },
                        end: PointNm {
                            x: number_nm(parts[3], units_scale),
                            y: number_nm(parts[4], units_scale),
                        },
                        width_nm,
                    },
                    odb_polarity(parts.get(6).copied()),
                    features.len(),
                ));
            }
            "A" if parts.len() >= 9 => {
                let symbol = parts[7].parse::<usize>().unwrap_or_default();
                let width_nm = symbols.get(&symbol).map(|value| value.0).unwrap_or(100_000);
                features.push(make_feature(
                    FeatureGeometry::Arc {
                        start: PointNm {
                            x: number_nm(parts[1], units_scale),
                            y: number_nm(parts[2], units_scale),
                        },
                        end: PointNm {
                            x: number_nm(parts[3], units_scale),
                            y: number_nm(parts[4], units_scale),
                        },
                        center: PointNm {
                            x: number_nm(parts[5], units_scale),
                            y: number_nm(parts[6], units_scale),
                        },
                        clockwise: parts
                            .get(9)
                            .is_some_and(|value| value.eq_ignore_ascii_case("Y") || *value == "CW"),
                        width_nm,
                    },
                    odb_polarity(parts.get(8).copied()),
                    features.len(),
                ));
            }
            "S" => {
                contour.clear();
                in_surface = true;
            }
            "OB" | "OS" if parts.len() >= 3 && in_surface => {
                contour.push(PointNm {
                    x: number_nm(parts[1], units_scale),
                    y: number_nm(parts[2], units_scale),
                });
            }
            "OE" if in_surface => {
                if contour.len() >= 3 {
                    features.push(make_feature(
                        FeatureGeometry::Region {
                            points: contour.clone(),
                        },
                        Polarity::Dark,
                        features.len(),
                    ));
                }
                contour.clear();
                in_surface = false;
            }
            _ => {
                if record
                    .chars()
                    .next()
                    .is_some_and(|value| value.is_ascii_alphabetic())
                    && !matches!(record, "F" | "ID" | "IN")
                    && line_index < 20
                {
                    diagnostics.push(diagnostic(
                        "ODB_RECORD_SKIPPED",
                        Severity::Info,
                        format!("unsupported ODB++ feature record {record}"),
                        Some(source),
                    ));
                }
            }
        }
    }
    features
}

fn parse_components(
    text: &str,
    source: &Path,
    components: &mut BTreeMap<String, Component>,
    nets: &mut BTreeSet<String>,
    test_points: &mut Vec<TestPoint>,
    diagnostics: &mut Vec<crate::model::Diagnostic>,
) {
    let mut scale = 25_400_000.0;
    let mut active_ref: Option<String> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.eq_ignore_ascii_case("UNITS=MM") {
            scale = 1_000_000.0;
            continue;
        }
        let parts = line.split_whitespace().collect::<Vec<_>>();
        match parts.first().copied() {
            Some("CMP") if parts.len() >= 7 => {
                let x = number_nm(parts[2], scale);
                let y = number_nm(parts[3], scale);
                let reference = parts[6].trim_matches('\'').to_owned();
                let side = if source
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .contains("bottom")
                {
                    Side::Bottom
                } else {
                    Side::Top
                };
                components.insert(
                    reference.clone(),
                    Component {
                        refdes: reference.clone(),
                        center: PointNm { x, y },
                        bounds: BoundsNm {
                            min_x: x,
                            min_y: y,
                            max_x: x,
                            max_y: y,
                        },
                        side,
                        pins: Vec::new(),
                        confidence: CoverageLevel::Explicit,
                    },
                );
                if reference.to_ascii_uppercase().starts_with("TP") {
                    test_points.push(TestPoint {
                        id: format!("odb-tp-{}", test_points.len()),
                        center: PointNm { x, y },
                        radius_nm: 150_000,
                        net_name: None,
                        component_ref: Some(reference.clone()),
                        confidence: CoverageLevel::Inferred,
                        source: source.display().to_string(),
                    });
                }
                active_ref = Some(reference);
            }
            Some("TOP") if parts.len() >= 8 => {
                if let Some(reference) = active_ref.as_ref() {
                    let pin = parts[1].trim_matches('\'').to_owned();
                    if let Some(component) = components.get_mut(reference) {
                        component.pins.push(pin);
                        let point = PointNm {
                            x: number_nm(parts[2], scale),
                            y: number_nm(parts[3], scale),
                        };
                        component.bounds.include_point(point);
                        component.center = component.bounds.center();
                    }
                    if let Some(net) = parts.get(6).filter(|value| **value != "0") {
                        nets.insert((*net).to_owned());
                    }
                }
            }
            _ => {}
        }
    }
    if components.is_empty() {
        diagnostics.push(diagnostic(
            "ODB_COMPONENTS_EMPTY",
            Severity::Warning,
            "ODB++ components file was present but no CMP records were recognized",
            Some(source),
        ));
    }
}

fn parse_nets(
    text: &str,
    source: &Path,
    nets: &mut BTreeSet<String>,
    test_points: &mut Vec<TestPoint>,
) {
    let mut current_net = None::<String>;
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim();
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.first().is_some_and(|value| *value == "NET") && parts.len() >= 2 {
            let net = parts[1].trim_matches('\'').to_owned();
            nets.insert(net.clone());
            current_net = Some(net);
        }
        if line.to_ascii_uppercase().contains("TEST") {
            let x = named_number(line, 'X');
            let y = named_number(line, 'Y');
            if let (Some(x), Some(y)) = (x, y) {
                test_points.push(TestPoint {
                    id: format!("odb-net-tp-{index}"),
                    center: PointNm {
                        x: (x * 1_000_000.0) as i64,
                        y: (y * 1_000_000.0) as i64,
                    },
                    radius_nm: 150_000,
                    net_name: current_net.clone(),
                    component_ref: None,
                    confidence: CoverageLevel::Explicit,
                    source: source.display().to_string(),
                });
            }
        }
    }
}

fn odb_layer_name(relative: &str) -> Option<String> {
    let normalized = relative.replace('\\', "/");
    let marker = "/layers/";
    let start = normalized.to_ascii_lowercase().find(marker)? + marker.len();
    Some(normalized[start..].split('/').next()?.to_owned())
}

fn infer_odb_function(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.contains("drill") {
        "DRILL"
    } else if lower.contains("comp") {
        "COMPONENT"
    } else if lower.contains("mask") {
        "SOLDERMASK"
    } else if lower.contains("silk") || lower.contains("legend") {
        "LEGEND"
    } else if lower.contains("outline") || lower.contains("profile") {
        "PROFILE"
    } else {
        "COPPER"
    }
    .into()
}

fn side_from_name(name: &str) -> Side {
    let lower = name.to_ascii_lowercase();
    if lower.contains("top") || lower.contains("+_top") {
        Side::Top
    } else if lower.contains("bottom") || lower.contains("+_bot") {
        Side::Bottom
    } else {
        Side::Inner
    }
}

fn symbol_dimensions(name: &str, scale: f64) -> (i64, i64) {
    let lower = name.to_ascii_lowercase();
    let numbers = lower
        .split(|value: char| !value.is_ascii_digit() && value != '.')
        .filter_map(|value| value.parse::<f64>().ok())
        .collect::<Vec<_>>();
    let divisor = if scale > 10_000_000.0 { 1_000.0 } else { 1.0 };
    let x = numbers.first().copied().unwrap_or(0.1) / divisor;
    let y = numbers.get(1).copied().unwrap_or(x) / divisor;
    ((x * scale).round() as i64, (y * scale).round() as i64)
}

fn number_nm(value: &str, scale: f64) -> i64 {
    (value.parse::<f64>().unwrap_or(0.0) * scale).round() as i64
}

fn odb_polarity(value: Option<&str>) -> Polarity {
    if value.is_some_and(|value| value.eq_ignore_ascii_case("C")) {
        Polarity::Clear
    } else {
        Polarity::Dark
    }
}

fn sanitize_id(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn named_number(value: &str, marker: char) -> Option<f64> {
    let start = value.find(marker)? + 1;
    let rest = &value[start..];
    let end = rest
        .find(|character: char| {
            !character.is_ascii_digit() && character != '.' && character != '-' && character != '+'
        })
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_feature_records() {
        let text = "UNITS=MM\n$0 r0.5\nP 1.0 2.0 0 P 0\nL 0 0 10 0 0 P 0";
        let mut diagnostics = Vec::new();
        let features = parse_feature_file(text, Path::new("features"), "top", &mut diagnostics);
        assert_eq!(features.len(), 2);
    }
}
