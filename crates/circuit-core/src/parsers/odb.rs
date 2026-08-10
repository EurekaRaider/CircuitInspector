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

    let relative_files = files
        .iter()
        .map(|path| {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            (path, relative)
        })
        .collect::<Vec<_>>();
    let matrix = relative_files
        .iter()
        .find(|(_, relative)| relative.eq_ignore_ascii_case("matrix/matrix"))
        .and_then(|(path, _)| fs::read_to_string(path).ok())
        .map(|text| parse_matrix(&text))
        .unwrap_or_default();
    let selected_step = select_primary_step(&relative_files, &matrix);
    if let Some(step) = selected_step.as_deref() {
        let step_count = relative_files
            .iter()
            .filter_map(|(_, relative)| odb_step_name(relative))
            .collect::<BTreeSet<_>>()
            .len();
        if step_count > 1 {
            design.diagnostics.push(diagnostic(
                "ODB_PRIMARY_STEP_SELECTED",
                Severity::Info,
                format!("selected BOARD step {step} from {step_count} ODB++ steps; panel, assembly, fabrication, and nested duplicate geometry were not merged into the board view"),
                None,
            ));
        }
    }

    for (path, relative) in relative_files {
        let lower = relative.to_ascii_lowercase();
        if selected_step.as_deref().is_some_and(|selected| {
            odb_step_name(&relative).is_some_and(|step| !step.eq_ignore_ascii_case(selected))
        }) {
            continue;
        }
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
            let matrix_layer = matrix
                .iter()
                .find(|layer| layer.name.eq_ignore_ascii_case(&layer_name));
            if matrix_layer.is_some_and(|layer| !layer.context.eq_ignore_ascii_case("BOARD")) {
                continue;
            }
            let function = if lower.ends_with("/profile") {
                "PROFILE".into()
            } else if let Some(layer) = matrix_layer {
                normalize_odb_function(&layer.layer_type, &layer.add_type)
            } else {
                infer_odb_function(&layer_name)
            };
            let side = side_from_name(&layer_name);
            let parsed =
                parse_feature_file(&text, path, &layer_id, &function, &mut design.diagnostics);
            nets.extend(parsed.nets);
            test_points.extend(parsed.test_points);
            if !parsed.features.is_empty() {
                if let Some(existing) = design.layers.iter_mut().find(|layer| layer.id == layer_id)
                {
                    existing.features.extend(parsed.features);
                } else {
                    design.layers.push(Layer {
                        id: layer_id,
                        name: layer_name,
                        function,
                        side,
                        features: parsed.features,
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
    design.coverage.test_points = test_point_coverage(&design.test_points);
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

#[derive(Debug, Clone, Default)]
struct MatrixLayer {
    name: String,
    context: String,
    layer_type: String,
    add_type: String,
}

fn parse_matrix(text: &str) -> Vec<MatrixLayer> {
    let mut layers = Vec::new();
    let mut block = String::new();
    let mut in_layer = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.eq_ignore_ascii_case("LAYER") || line.to_ascii_uppercase().starts_with("LAYER {") {
            in_layer = true;
            block.clear();
        }
        if in_layer {
            block.push(' ');
            block.push_str(line);
        }
        if in_layer && line.contains('}') {
            let value = |key: &str| matrix_value(&block, key).unwrap_or_default();
            let name = value("NAME");
            if !name.is_empty() {
                layers.push(MatrixLayer {
                    name,
                    context: value("CONTEXT"),
                    layer_type: value("TYPE"),
                    add_type: value("ADD_TYPE"),
                });
            }
            in_layer = false;
        }
    }
    layers
}

fn matrix_value(block: &str, key: &str) -> Option<String> {
    let marker = format!("{key}=");
    let upper = block.to_ascii_uppercase();
    let start = upper.find(&marker)? + marker.len();
    let rest = block[start..].trim_start();
    if let Some(quoted) = rest.strip_prefix('\'') {
        return Some(quoted.split('\'').next()?.to_owned());
    }
    Some(
        rest.split(|character: char| character.is_whitespace() || character == '}')
            .next()?
            .trim_matches('"')
            .to_owned(),
    )
}

fn select_primary_step(files: &[(&PathBuf, String)], matrix: &[MatrixLayer]) -> Option<String> {
    let mut scores = BTreeMap::<String, i32>::new();
    for (_, relative) in files {
        let Some(step) = odb_step_name(relative) else {
            continue;
        };
        let lower = relative.to_ascii_lowercase();
        let score = scores.entry(step.clone()).or_default();
        if lower.ends_with("/profile") {
            *score += 80;
        }
        if lower.ends_with("/components") {
            *score += 50;
        }
        if lower.ends_with("/features") {
            *score += 1;
        }
        let step_lower = step.to_ascii_lowercase();
        if ["pcb", "board", "unit", "1up", "single"]
            .iter()
            .any(|token| step_lower.contains(token))
        {
            *score += 20;
        }
        if ["panel", "array", "fab", "assy", "assembly"]
            .iter()
            .any(|token| step_lower.contains(token))
        {
            *score -= 20;
        }
    }
    if matrix
        .iter()
        .any(|layer| layer.context.eq_ignore_ascii_case("BOARD"))
    {
        for score in scores.values_mut() {
            *score += 5;
        }
    }
    scores
        .into_iter()
        .max_by(|left, right| left.1.cmp(&right.1).then_with(|| right.0.cmp(&left.0)))
        .map(|item| item.0)
}

fn odb_step_name(relative: &str) -> Option<String> {
    let parts = relative.split('/').collect::<Vec<_>>();
    let index = parts
        .iter()
        .position(|part| part.eq_ignore_ascii_case("steps"))?;
    parts.get(index + 1).map(|value| (*value).to_owned())
}

fn normalize_odb_function(layer_type: &str, add_type: &str) -> String {
    let value = if layer_type.eq_ignore_ascii_case("MASK") && !add_type.is_empty() {
        add_type
    } else {
        layer_type
    };
    value.trim().to_ascii_uppercase().replace('-', "_")
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

#[derive(Default)]
struct ParsedFeatures {
    features: Vec<Feature>,
    nets: BTreeSet<String>,
    test_points: Vec<TestPoint>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OdbUnits {
    Inch,
    Millimeter,
}

impl OdbUnits {
    fn coordinate_scale(self) -> f64 {
        match self {
            Self::Inch => 25_400_000.0,
            Self::Millimeter => 1_000_000.0,
        }
    }

    fn symbol_scale(self) -> f64 {
        match self {
            Self::Inch => 25_400.0,
            Self::Millimeter => 1_000.0,
        }
    }
}

fn parse_feature_file(
    text: &str,
    source: &Path,
    layer_id: &str,
    layer_function: &str,
    diagnostics: &mut Vec<crate::model::Diagnostic>,
) -> ParsedFeatures {
    let mut units = OdbUnits::Inch;
    let mut symbols = BTreeMap::<usize, (i64, i64)>::new();
    let mut parsed = ParsedFeatures::default();
    let mut attribute_names = BTreeMap::<usize, String>::new();
    let mut attribute_values = BTreeMap::<usize, String>::new();
    let mut contour = Vec::new();
    let mut in_surface = false;
    for (line_index, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.eq_ignore_ascii_case("UNITS=MM") || line.eq_ignore_ascii_case("U MM") {
            units = OdbUnits::Millimeter;
            continue;
        }
        if line.eq_ignore_ascii_case("UNITS=INCH") || line.eq_ignore_ascii_case("U INCH") {
            units = OdbUnits::Inch;
            continue;
        }
        if let Some(rest) = line.strip_prefix('$') {
            let mut parts = rest.split_whitespace();
            if let (Some(index), Some(name)) = (
                parts.next().and_then(|value| value.parse::<usize>().ok()),
                parts.next(),
            ) {
                symbols.insert(index, symbol_dimensions(name, units));
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix('@') {
            let mut parts = rest.split_whitespace();
            if let (Some(index), Some(name)) = (
                parts.next().and_then(|value| value.parse::<usize>().ok()),
                parts.next(),
            ) {
                attribute_names.insert(index, name.trim_matches('\'').to_owned());
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix('&') {
            let mut parts = rest.splitn(2, char::is_whitespace);
            if let (Some(index), Some(value)) = (
                parts.next().and_then(|value| value.parse::<usize>().ok()),
                parts.next(),
            ) {
                attribute_values.insert(index, value.trim().trim_matches('\'').to_owned());
            }
            continue;
        }
        let (record_text, attribute_text) = line.split_once(';').map_or((line, ""), |parts| parts);
        let parts = record_text.split_whitespace().collect::<Vec<_>>();
        let Some(record) = parts.first().copied() else {
            continue;
        };
        let attributes =
            parse_feature_attributes(attribute_text, &attribute_names, &attribute_values);
        let make_feature =
            |geometry: FeatureGeometry,
             polarity: Polarity,
             index: usize,
             attributes: BTreeMap<String, String>| Feature {
                id: format!("{layer_id}:{index}"),
                layer_id: layer_id.into(),
                polarity,
                geometry,
                net_name: feature_attribute(&attributes, &[".net_name", "net_name", ".net"])
                    .map(str::to_owned),
                component_ref: feature_attribute(
                    &attributes,
                    &[".comp_name", "comp_name", ".component_ref"],
                )
                .map(str::to_owned),
                pin: feature_attribute(&attributes, &[".pin_name", "pin_name", ".pin"])
                    .map(str::to_owned),
                attributes,
                source: source.display().to_string(),
            };
        match record {
            "P" if parts.len() >= 5 => {
                let center = PointNm {
                    x: number_nm(parts[1], units.coordinate_scale()),
                    y: number_nm(parts[2], units.coordinate_scale()),
                };
                let symbol = parts[3].parse::<usize>().unwrap_or_default();
                let (mut size_x_nm, mut size_y_nm) =
                    symbols.get(&symbol).copied().unwrap_or((100_000, 100_000));
                let polarity = odb_polarity(parts.get(4).copied());
                if orientation_swaps_axes(parts.get(6).copied()) {
                    std::mem::swap(&mut size_x_nm, &mut size_y_nm);
                }
                let geometry = if layer_function.contains("DRILL") {
                    FeatureGeometry::Drill {
                        center,
                        diameter_nm: size_x_nm.max(size_y_nm),
                        plated: Some(
                            !feature_attribute(&attributes, &[".drill_plated", "drill_plated"])
                                .is_some_and(|value| {
                                    matches!(
                                        value.to_ascii_lowercase().as_str(),
                                        "no" | "false" | "0" | "non_plated"
                                    )
                                }),
                        ),
                    }
                } else {
                    FeatureGeometry::Pad {
                        center,
                        size_x_nm,
                        size_y_nm,
                        rotation_deg: 0.0,
                    }
                };
                let feature = make_feature(geometry, polarity, parsed.features.len(), attributes);
                if let Some(net) = feature.net_name.as_ref() {
                    parsed.nets.insert(net.clone());
                }
                if feature_is_test_point(&feature) {
                    parsed
                        .test_points
                        .push(test_point_from_feature(&feature, CoverageLevel::Explicit));
                }
                parsed.features.push(feature);
            }
            "L" if parts.len() >= 7 => {
                let symbol = parts[5].parse::<usize>().unwrap_or_default();
                let width_nm = symbols.get(&symbol).map(|value| value.0).unwrap_or(100_000);
                let feature = make_feature(
                    FeatureGeometry::Line {
                        start: PointNm {
                            x: number_nm(parts[1], units.coordinate_scale()),
                            y: number_nm(parts[2], units.coordinate_scale()),
                        },
                        end: PointNm {
                            x: number_nm(parts[3], units.coordinate_scale()),
                            y: number_nm(parts[4], units.coordinate_scale()),
                        },
                        width_nm,
                    },
                    odb_polarity(parts.get(6).copied()),
                    parsed.features.len(),
                    attributes,
                );
                if let Some(net) = feature.net_name.as_ref() {
                    parsed.nets.insert(net.clone());
                }
                parsed.features.push(feature);
            }
            "A" if parts.len() >= 9 => {
                let symbol = parts[7].parse::<usize>().unwrap_or_default();
                let width_nm = symbols.get(&symbol).map(|value| value.0).unwrap_or(100_000);
                let feature = make_feature(
                    FeatureGeometry::Arc {
                        start: PointNm {
                            x: number_nm(parts[1], units.coordinate_scale()),
                            y: number_nm(parts[2], units.coordinate_scale()),
                        },
                        end: PointNm {
                            x: number_nm(parts[3], units.coordinate_scale()),
                            y: number_nm(parts[4], units.coordinate_scale()),
                        },
                        center: PointNm {
                            x: number_nm(parts[5], units.coordinate_scale()),
                            y: number_nm(parts[6], units.coordinate_scale()),
                        },
                        clockwise: parts
                            .get(10)
                            .is_some_and(|value| value.eq_ignore_ascii_case("Y") || *value == "CW"),
                        width_nm,
                    },
                    odb_polarity(parts.get(8).copied()),
                    parsed.features.len(),
                    attributes,
                );
                if let Some(net) = feature.net_name.as_ref() {
                    parsed.nets.insert(net.clone());
                }
                parsed.features.push(feature);
            }
            "S" => {
                contour.clear();
                in_surface = true;
            }
            "OB" | "OS" if parts.len() >= 3 && in_surface => {
                contour.push(PointNm {
                    x: number_nm(parts[1], units.coordinate_scale()),
                    y: number_nm(parts[2], units.coordinate_scale()),
                });
            }
            "OE" if in_surface => {
                if contour.len() >= 3 {
                    parsed.features.push(make_feature(
                        FeatureGeometry::Region {
                            points: contour.clone(),
                        },
                        Polarity::Dark,
                        parsed.features.len(),
                        attributes,
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
    parsed
}

fn parse_feature_attributes(
    text: &str,
    names: &BTreeMap<usize, String>,
    values: &BTreeMap<usize, String>,
) -> BTreeMap<String, String> {
    let mut attributes = BTreeMap::new();
    for token in text
        .split(|character: char| character.is_whitespace() || character == ',')
        .filter(|value| !value.is_empty())
    {
        let (name_index, value_index) = token
            .split_once('=')
            .map_or((token, None), |(left, right)| (left, Some(right)));
        let Some(name) = name_index
            .parse::<usize>()
            .ok()
            .and_then(|index| names.get(&index))
        else {
            continue;
        };
        let value = value_index
            .and_then(|index| {
                index
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| values.get(&index))
                    .cloned()
                    .or_else(|| Some(index.trim_matches('\'').to_owned()))
            })
            .unwrap_or_else(|| "true".into());
        attributes.insert(name.clone(), value);
    }
    attributes
}

fn feature_attribute<'a>(
    attributes: &'a BTreeMap<String, String>,
    names: &[&str],
) -> Option<&'a str> {
    attributes.iter().find_map(|(key, value)| {
        names
            .iter()
            .any(|name| key.eq_ignore_ascii_case(name))
            .then_some(value.as_str())
    })
}

fn feature_is_test_point(feature: &Feature) -> bool {
    feature_attribute(&feature.attributes, &[".test_point", "test_point"])
        .is_some_and(|value| !matches!(value.to_ascii_lowercase().as_str(), "no" | "false" | "0"))
        || feature
            .component_ref
            .as_deref()
            .is_some_and(is_test_point_token)
}

fn test_point_from_feature(feature: &Feature, confidence: CoverageLevel) -> TestPoint {
    let bounds = feature.geometry.bounds();
    TestPoint {
        id: format!("odb-tp-{}", sanitize_id(&feature.id)),
        center: bounds.center(),
        radius_nm: ((bounds.max_x - bounds.min_x).max(bounds.max_y - bounds.min_y) / 2).max(50_000),
        net_name: feature.net_name.clone(),
        component_ref: feature.component_ref.clone(),
        confidence,
        source: feature.source.clone(),
    }
}

fn orientation_swaps_axes(value: Option<&str>) -> bool {
    value
        .and_then(|value| value.parse::<i32>().ok())
        .is_some_and(|value| value.rem_euclid(4) % 2 == 1)
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
    let mut active_test_point: Option<usize> = None;
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
                let package = parts
                    .get(7)
                    .map(|value| value.trim_matches('\''))
                    .unwrap_or("");
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
                if is_test_point_token(&reference) || is_test_point_token(package) {
                    test_points.push(TestPoint {
                        id: format!("odb-tp-{}", test_points.len()),
                        center: PointNm { x, y },
                        radius_nm: 150_000,
                        net_name: None,
                        component_ref: Some(reference.clone()),
                        confidence: CoverageLevel::Inferred,
                        source: source.display().to_string(),
                    });
                    active_test_point = Some(test_points.len() - 1);
                } else {
                    active_test_point = None;
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
                        if let Some(point) =
                            active_test_point.and_then(|index| test_points.get_mut(index))
                        {
                            if point.net_name.is_none() {
                                point.net_name = Some((*net).trim_matches('\'').to_owned());
                            }
                        }
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

fn symbol_dimensions(name: &str, units: OdbUnits) -> (i64, i64) {
    let lower = name.to_ascii_lowercase();
    let recognized = [
        "r",
        "s",
        "rect",
        "oval",
        "di",
        "donut_r",
        "donut_s",
        "donut_rc",
        "donut_sr",
        "hex_l",
        "hex_s",
        "oct",
        "round_therm",
        "square_therm",
        "rect_therm",
        "oval_therm",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix));
    if !recognized {
        return (100_000, 100_000);
    }
    let numbers = lower
        .split(|value: char| !value.is_ascii_digit() && value != '.')
        .filter_map(|value| value.parse::<f64>().ok())
        .collect::<Vec<_>>();
    let symbol_units = if lower.split('_').next_back() == Some("i") {
        OdbUnits::Inch
    } else if lower.split('_').next_back() == Some("m") {
        OdbUnits::Millimeter
    } else {
        units
    };
    let x = numbers.first().copied().unwrap_or(100.0);
    let y = numbers.get(1).copied().unwrap_or(x);
    (
        (x * symbol_units.symbol_scale()).round() as i64,
        (y * symbol_units.symbol_scale()).round() as i64,
    )
}

fn number_nm(value: &str, scale: f64) -> i64 {
    (value.parse::<f64>().unwrap_or(0.0) * scale).round() as i64
}

fn odb_polarity(value: Option<&str>) -> Polarity {
    if value.is_some_and(|value| value.eq_ignore_ascii_case("C") || value.eq_ignore_ascii_case("N"))
    {
        Polarity::Clear
    } else {
        Polarity::Dark
    }
}

fn is_test_point_token(value: &str) -> bool {
    let upper = value.trim_matches('\'').to_ascii_uppercase();
    upper.starts_with("TP")
        || [
            "TEST_POINT",
            "TESTPOINT",
            "TEST_PAD",
            "TESTPAD",
            "PROBE_PAD",
            "PROBEPAD",
            "POGO",
        ]
        .iter()
        .any(|token| upper.contains(token))
}

fn test_point_coverage(points: &[TestPoint]) -> CoverageLevel {
    if points.is_empty() {
        CoverageLevel::Missing
    } else if points
        .iter()
        .all(|point| point.confidence == CoverageLevel::Explicit)
    {
        CoverageLevel::Explicit
    } else {
        CoverageLevel::Inferred
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
        let text = "UNITS=MM\n$0 r500\nP 1.0 2.0 0 P 0\nL 0 0 10 0 0 P 0";
        let mut diagnostics = Vec::new();
        let parsed = parse_feature_file(
            text,
            Path::new("features"),
            "top",
            "SIGNAL",
            &mut diagnostics,
        );
        assert_eq!(parsed.features.len(), 2);
        assert_eq!(
            parsed.features[0].geometry.bounds().max_x - parsed.features[0].geometry.bounds().min_x,
            500_000
        );
    }

    #[test]
    fn metric_symbol_sizes_are_microns_and_attributes_create_test_points() {
        let text = "UNITS=MM\n$0 r120\n@0 .test_point\n@1 .net_name\n&0 VDD\nP 1 2 0 P 0;0,1=0";
        let mut diagnostics = Vec::new();
        let parsed = parse_feature_file(
            text,
            Path::new("features"),
            "top",
            "SIGNAL",
            &mut diagnostics,
        );
        let bounds = parsed.features[0].geometry.bounds();
        assert_eq!(bounds.max_x - bounds.min_x, 120_000);
        assert_eq!(parsed.test_points.len(), 1);
        assert_eq!(parsed.test_points[0].net_name.as_deref(), Some("VDD"));
    }

    #[test]
    fn drill_layers_create_drill_geometry() {
        let text = "UNITS=MM\n$0 r300\nP 1 2 0 P 0";
        let mut diagnostics = Vec::new();
        let parsed = parse_feature_file(
            text,
            Path::new("features"),
            "drill",
            "DRILL",
            &mut diagnostics,
        );
        assert!(matches!(
            parsed.features[0].geometry,
            FeatureGeometry::Drill {
                diameter_nm: 300_000,
                ..
            }
        ));
    }
}
