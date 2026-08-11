use super::{diagnostic, empty_design};
use crate::model::{
    BoundsNm, Component, CoverageLevel, Design, DesignFormat, Feature, FeatureGeometry, Layer,
    PointNm, Polarity, Severity, Side, TestPoint,
};
use crate::{CoreError, CoreResult};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const UNRESOLVED_SYMBOL_GEOMETRY: &str = "__circuit_inspector_unresolved_symbol_geometry";

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
    let matrix_source = relative_files
        .iter()
        .find(|(_, relative)| is_odb_matrix_path(relative));
    let matrix = matrix_source
        .and_then(|(path, _)| fs::read_to_string(path).ok())
        .map(|text| parse_matrix(&text))
        .unwrap_or_default();
    if matrix_source.is_none() {
        design.diagnostics.push(diagnostic(
            "ODB_MATRIX_MISSING",
            Severity::Warning,
            "ODB++ matrix/matrix was not found; layer sides cannot be trusted and surface-bound distance checks will remain REVIEW",
            None,
        ));
    }
    let selected_step = select_primary_step(&relative_files, &matrix);
    let custom_symbol_dimensions =
        load_custom_symbol_dimensions(&relative_files, &mut design.diagnostics);
    let mut eda = EdaData::default();
    for (path, relative) in &relative_files {
        let lower = relative.to_ascii_lowercase();
        if !lower.ends_with("eda/data")
            || selected_step.as_deref().is_some_and(|selected| {
                odb_step_name(relative).is_some_and(|step| !step.eq_ignore_ascii_case(selected))
            })
        {
            continue;
        }
        let text = read_text(path, &mut design)?;
        eda.merge(parse_eda_data(&text));
    }
    nets.extend(eda.net_names.iter().cloned());
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
        if odb_symbol_name(&relative).is_some() {
            continue;
        }
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
            let side = odb_layer_side(&layer_name, matrix_layer, &matrix);
            let parsed = parse_feature_file_with_symbols(
                &text,
                path,
                &layer_id,
                &function,
                &custom_symbol_dimensions,
                &mut design.diagnostics,
            );
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
            let layer_name = odb_layer_name(&relative).unwrap_or_default();
            let layer_id = format!("odb-{}", sanitize_id(&layer_name));
            let matrix_layer = matrix
                .iter()
                .find(|layer| layer.name.eq_ignore_ascii_case(&layer_name));
            if matrix_layer.is_some_and(|layer| !layer.context.eq_ignore_ascii_case("BOARD")) {
                continue;
            }
            let side = odb_layer_side(&layer_name, matrix_layer, &matrix);
            parse_components(
                &text,
                path,
                &layer_id,
                side,
                &eda.package_bounds,
                &eda.net_names,
                &mut components,
                &mut nets,
                &mut test_points,
                &mut design.diagnostics,
            );
            if !design.layers.iter().any(|layer| layer.id == layer_id) {
                design.layers.push(Layer {
                    id: layer_id,
                    name: layer_name,
                    function: "COMPONENT".into(),
                    side,
                    features: Vec::new(),
                });
            }
        } else if lower.ends_with("/netlists/cadnet/netlist") {
            let text = read_text(path, &mut design)?;
            parse_nets(&text, &mut nets);
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
    reconcile_test_point_geometry(&design.layers, &mut test_points, &mut design.diagnostics);
    design.test_points = test_points;
    design.coverage.layers = CoverageLevel::Explicit;
    design.coverage.nets = if design.nets.is_empty() {
        CoverageLevel::Missing
    } else {
        CoverageLevel::Explicit
    };
    design.coverage.components = component_coverage(&design.components);
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
    row: i32,
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
                    row: value("ROW").parse().unwrap_or_default(),
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

#[derive(Default)]
struct EdaData {
    net_names: Vec<String>,
    package_bounds: Vec<BoundsNm>,
}

impl EdaData {
    fn merge(&mut self, other: Self) {
        if self.net_names.is_empty() {
            self.net_names = other.net_names;
        }
        if self.package_bounds.is_empty() {
            self.package_bounds = other.package_bounds;
        }
    }
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

fn odb_symbol_name(relative: &str) -> Option<&str> {
    let parts = relative.split('/').collect::<Vec<_>>();
    let index = parts
        .iter()
        .position(|part| part.eq_ignore_ascii_case("symbols"))?;
    let name = *parts.get(index + 1)?;
    parts
        .get(index + 2)
        .is_some_and(|part| part.eq_ignore_ascii_case("features"))
        .then_some(name)
}

fn load_custom_symbol_dimensions(
    files: &[(&PathBuf, String)],
    diagnostics: &mut Vec<crate::model::Diagnostic>,
) -> BTreeMap<String, (i64, i64)> {
    let sources = files
        .iter()
        .filter_map(|(path, relative)| {
            odb_symbol_name(relative).map(|name| (name.to_ascii_lowercase(), path.as_path()))
        })
        .collect::<Vec<_>>();
    let mut dimensions = BTreeMap::new();
    for _ in 0..sources.len().max(1) {
        let mut changed = false;
        for (name, path) in &sources {
            let Ok(text) = fs::read_to_string(path) else {
                continue;
            };
            let mut symbol_diagnostics = Vec::new();
            let parsed = parse_feature_file_with_symbols(
                &text,
                path,
                "odb-custom-symbol",
                "SYMBOL",
                &dimensions,
                &mut symbol_diagnostics,
            );
            if parsed.features.is_empty()
                || parsed
                    .features
                    .iter()
                    .any(|feature| feature.attributes.contains_key(UNRESOLVED_SYMBOL_GEOMETRY))
            {
                continue;
            }
            let mut bounds = parsed.features[0].geometry.bounds();
            for feature in parsed.features.iter().skip(1) {
                bounds.include_bounds(feature.geometry.bounds());
            }
            let candidate = (
                (bounds.max_x - bounds.min_x).max(1),
                (bounds.max_y - bounds.min_y).max(1),
            );
            if dimensions.get(name) != Some(&candidate) {
                dimensions.insert(name.clone(), candidate);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let unresolved = sources
        .iter()
        .filter(|(name, _)| !dimensions.contains_key(name))
        .count();
    if unresolved > 0 {
        diagnostics.push(diagnostic(
            "ODB_CUSTOM_SYMBOL_GEOMETRY_UNRESOLVED",
            Severity::Warning,
            format!(
                "{unresolved} custom ODB++ symbols could not be reduced to deterministic bounds"
            ),
            None,
        ));
    }
    dimensions
}

#[cfg(test)]
fn parse_feature_file(
    text: &str,
    source: &Path,
    layer_id: &str,
    layer_function: &str,
    diagnostics: &mut Vec<crate::model::Diagnostic>,
) -> ParsedFeatures {
    parse_feature_file_with_symbols(
        text,
        source,
        layer_id,
        layer_function,
        &BTreeMap::new(),
        diagnostics,
    )
}

fn parse_feature_file_with_symbols(
    text: &str,
    source: &Path,
    layer_id: &str,
    layer_function: &str,
    custom_symbol_dimensions: &BTreeMap<String, (i64, i64)>,
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
                if let Some(dimensions) = custom_symbol_dimensions
                    .get(&name.to_ascii_lowercase())
                    .copied()
                    .or_else(|| symbol_dimensions(name, units))
                {
                    symbols.insert(index, dimensions);
                }
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
        let mut attributes =
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
                let resolved_dimensions = symbols.get(&symbol).copied();
                let (mut size_x_nm, mut size_y_nm) =
                    resolved_dimensions.unwrap_or((100_000, 100_000));
                let polarity = odb_polarity(parts.get(4).copied());
                if orientation_swaps_axes(parts.get(6).copied()) {
                    std::mem::swap(&mut size_x_nm, &mut size_y_nm);
                }
                if resolved_dimensions.is_none() {
                    attributes.insert(UNRESOLVED_SYMBOL_GEOMETRY.into(), "true".into());
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
                    let mut point = test_point_from_feature(&feature, CoverageLevel::Explicit);
                    if resolved_dimensions.is_none() {
                        point.radius_nm = None;
                        point.geometry_source = None;
                    }
                    parsed.test_points.push(point);
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
        attributes.insert(name.clone(), normalize_feature_attribute(name, &value));
    }
    attributes
}

fn normalize_feature_attribute(name: &str, value: &str) -> String {
    if name
        .trim_start_matches('.')
        .eq_ignore_ascii_case("pad_usage")
    {
        return match value {
            "0" => "toeprint",
            "1" => "via",
            "2" => "g_fiducial",
            "3" => "l_fiducial",
            "4" => "tooling_hole",
            _ => value,
        }
        .to_owned();
    }
    value.to_owned()
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
    let radius_nm = match feature.geometry {
        FeatureGeometry::Pad {
            size_x_nm,
            size_y_nm,
            ..
        } => Some(size_x_nm.min(size_y_nm).max(2) / 2),
        _ => None,
    };
    TestPoint {
        id: format!("odb-tp-{}", sanitize_id(&feature.id)),
        center: bounds.center(),
        radius_nm,
        net_name: feature.net_name.clone(),
        component_ref: feature.component_ref.clone(),
        confidence,
        layer_id: Some(feature.layer_id.clone()),
        source: feature.source.clone(),
        geometry_source: radius_nm.map(|_| feature.source.clone()),
        confirmation: None,
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
    layer_id: &str,
    side: Side,
    package_bounds: &[BoundsNm],
    net_names: &[String],
    components: &mut BTreeMap<String, Component>,
    nets: &mut BTreeSet<String>,
    test_points: &mut Vec<TestPoint>,
    diagnostics: &mut Vec<crate::model::Diagnostic>,
) {
    let mut scale = 25_400_000.0;
    let mut active_ref: Option<String> = None;
    let mut active_test_point: Option<usize> = None;
    let mut active_test_point_toeprints = 0_usize;
    for raw in text.lines() {
        let line = raw.trim();
        if line.eq_ignore_ascii_case("UNITS=MM") || line.eq_ignore_ascii_case("U MM") {
            scale = 1_000_000.0;
            continue;
        }
        if line.eq_ignore_ascii_case("UNITS=INCH") || line.eq_ignore_ascii_case("U INCH") {
            scale = 25_400_000.0;
            continue;
        }
        let parts = line.split_whitespace().collect::<Vec<_>>();
        match parts.first().copied() {
            Some("CMP") if parts.len() >= 7 => {
                let package_ref = parts[1].parse::<usize>().ok();
                let x = number_nm(parts[2], scale);
                let y = number_nm(parts[3], scale);
                let rotation_deg = parts[4].parse::<f64>().unwrap_or_default();
                let mirrored = parts[5].eq_ignore_ascii_case("M");
                let reference = parts[6].trim_matches('\'').to_owned();
                let package = parts
                    .get(7)
                    .map(|value| value.trim_matches('\''))
                    .unwrap_or("");
                let transformed_package = package_ref
                    .and_then(|index| package_bounds.get(index).copied())
                    .map(|bounds| {
                        transform_package_bounds(bounds, PointNm { x, y }, rotation_deg, mirrored)
                    });
                components.insert(
                    reference.clone(),
                    Component {
                        refdes: reference.clone(),
                        package_name: (!package.is_empty()).then(|| package.to_owned()),
                        center: PointNm { x, y },
                        bounds: transformed_package.unwrap_or(BoundsNm {
                            min_x: x,
                            min_y: y,
                            max_x: x,
                            max_y: y,
                        }),
                        side,
                        pins: Vec::new(),
                        confidence: if transformed_package.is_some() {
                            CoverageLevel::Explicit
                        } else {
                            CoverageLevel::Inferred
                        },
                    },
                );
                if is_test_point_token(&reference) || is_test_point_token(package) {
                    test_points.push(TestPoint {
                        id: format!("odb-tp-{}", test_points.len()),
                        center: PointNm { x, y },
                        radius_nm: None,
                        net_name: None,
                        component_ref: Some(reference.clone()),
                        confidence: CoverageLevel::Inferred,
                        layer_id: Some(layer_id.to_owned()),
                        source: source.display().to_string(),
                        geometry_source: None,
                        confirmation: None,
                    });
                    active_test_point = Some(test_points.len() - 1);
                } else {
                    active_test_point = None;
                }
                active_test_point_toeprints = 0;
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
                    if let Some(net) = parts.get(6) {
                        let net_name = net
                            .parse::<usize>()
                            .ok()
                            .and_then(|index| net_names.get(index).cloned())
                            .or_else(|| {
                                (*net != "0").then(|| (*net).trim_matches('\'').to_owned())
                            });
                        if let Some(net_name) = net_name.as_ref() {
                            nets.insert(net_name.clone());
                        }
                        if let Some(point) =
                            active_test_point.and_then(|index| test_points.get_mut(index))
                        {
                            if active_test_point_toeprints == 0 {
                                point.center = PointNm {
                                    x: number_nm(parts[2], scale),
                                    y: number_nm(parts[3], scale),
                                };
                            }
                            if point.net_name.is_none() {
                                point.net_name = net_name;
                            }
                        }
                    }
                    active_test_point_toeprints += 1;
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

fn parse_nets(text: &str, nets: &mut BTreeSet<String>) {
    for raw in text.lines() {
        let line = raw.trim();
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.first().is_some_and(|value| *value == "NET") && parts.len() >= 2 {
            let net = parts[1].trim_matches('\'').to_owned();
            nets.insert(net.clone());
        }
    }
}

fn parse_eda_data(text: &str) -> EdaData {
    let mut data = EdaData::default();
    let mut units = OdbUnits::Inch;
    for raw in text.lines() {
        let line = raw.trim();
        if line.eq_ignore_ascii_case("UNITS=MM") || line.eq_ignore_ascii_case("U MM") {
            units = OdbUnits::Millimeter;
            continue;
        }
        if line.eq_ignore_ascii_case("UNITS=INCH") || line.eq_ignore_ascii_case("U INCH") {
            units = OdbUnits::Inch;
            continue;
        }
        let record = line.split_once(';').map_or(line, |(record, _)| record);
        let parts = record.split_whitespace().collect::<Vec<_>>();
        match parts.first().copied() {
            Some("NET") if parts.len() >= 2 => {
                data.net_names.push(parts[1].trim_matches('\'').to_owned());
            }
            Some("PKG") if parts.len() >= 7 => {
                data.package_bounds.push(BoundsNm {
                    min_x: number_nm(parts[3], units.coordinate_scale()),
                    min_y: number_nm(parts[4], units.coordinate_scale()),
                    max_x: number_nm(parts[5], units.coordinate_scale()),
                    max_y: number_nm(parts[6], units.coordinate_scale()),
                });
            }
            _ => {}
        }
    }
    data
}

fn transform_package_bounds(
    bounds: BoundsNm,
    origin: PointNm,
    rotation_deg: f64,
    mirrored: bool,
) -> BoundsNm {
    let angle = rotation_deg.to_radians();
    let cosine = angle.cos();
    let sine = angle.sin();
    let mut transformed = BoundsNm::empty();
    for point in [
        PointNm {
            x: bounds.min_x,
            y: bounds.min_y,
        },
        PointNm {
            x: bounds.max_x,
            y: bounds.min_y,
        },
        PointNm {
            x: bounds.max_x,
            y: bounds.max_y,
        },
        PointNm {
            x: bounds.min_x,
            y: bounds.max_y,
        },
    ] {
        let local_x = if mirrored { -point.x } else { point.x } as f64;
        let local_y = point.y as f64;
        transformed.include_point(PointNm {
            x: origin.x + (local_x * cosine - local_y * sine).round() as i64,
            y: origin.y + (local_x * sine + local_y * cosine).round() as i64,
        });
    }
    transformed.normalized()
}

fn reconcile_test_point_geometry(
    layers: &[Layer],
    test_points: &mut Vec<TestPoint>,
    diagnostics: &mut Vec<crate::model::Diagnostic>,
) {
    const MATCH_TOLERANCE_NM: i64 = 25_000;
    let mut unresolved = 0_usize;
    let mut ambiguous = 0_usize;
    for point in test_points
        .iter_mut()
        .filter(|point| point.radius_nm.is_none())
    {
        let expected_side = point.layer_id.as_deref().and_then(|id| {
            layers
                .iter()
                .find(|layer| layer.id == id)
                .map(|layer| layer.side)
        });
        let mut candidates = Vec::new();
        for layer in layers {
            let correct_side = match expected_side {
                Some(Side::Top | Side::Bottom) => expected_side == Some(layer.side),
                _ => matches!(layer.side, Side::Top | Side::Bottom),
            };
            if !is_conductive_function(&layer.function) || !correct_side {
                continue;
            }
            for feature in &layer.features {
                let FeatureGeometry::Pad {
                    center,
                    size_x_nm,
                    size_y_nm,
                    ..
                } = feature.geometry
                else {
                    continue;
                };
                if feature.polarity == Polarity::Clear
                    || feature.attributes.contains_key(UNRESOLVED_SYMBOL_GEOMETRY)
                    || center.distance_sq(point.center) > i128::from(MATCH_TOLERANCE_NM).pow(2)
                {
                    continue;
                }
                let identity_score = i32::from(
                    point.component_ref.is_some() && point.component_ref == feature.component_ref,
                ) * 4
                    + i32::from(point.net_name.is_some() && point.net_name == feature.net_name) * 2;
                candidates.push((
                    identity_score,
                    center.distance_sq(point.center),
                    size_x_nm.min(size_y_nm).max(2) / 2,
                    layer.id.as_str(),
                    feature.source.as_str(),
                ));
            }
        }
        candidates.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| left.1.cmp(&right.1))
                .then_with(|| left.3.cmp(right.3))
        });
        let Some(best) = candidates.first().copied() else {
            unresolved += 1;
            continue;
        };
        let conflicting = candidates.iter().skip(1).any(|candidate| {
            candidate.0 == best.0 && candidate.1 == best.1 && candidate.2 != best.2
        });
        if conflicting {
            ambiguous += 1;
            continue;
        }
        point.radius_nm = Some(best.2);
        point.layer_id = Some(best.3.to_owned());
        point.geometry_source = Some(best.4.to_owned());
    }
    deduplicate_test_points(layers, test_points);
    if unresolved > 0 {
        diagnostics.push(diagnostic(
            "ODB_TEST_POINT_GEOMETRY_UNRESOLVED",
            Severity::Warning,
            format!(
                "{unresolved} inferred test-point identities could not be bound to a unique external-copper pad; diameter and edge-clearance checks require review"
            ),
            None,
        ));
    }
    if ambiguous > 0 {
        diagnostics.push(diagnostic(
            "ODB_TEST_POINT_GEOMETRY_AMBIGUOUS",
            Severity::Warning,
            format!(
                "{ambiguous} inferred test-point identities matched conflicting external-copper pad sizes; no diameter was selected"
            ),
            None,
        ));
    }
}

fn deduplicate_test_points(layers: &[Layer], points: &mut Vec<TestPoint>) {
    points.sort_by_key(|point| match point.confidence {
        CoverageLevel::Explicit => 0,
        CoverageLevel::Supplemented => 1,
        CoverageLevel::Inferred => 2,
        CoverageLevel::Missing => 3,
    });
    let mut deduplicated = Vec::<TestPoint>::new();
    for point in points.drain(..) {
        let point_side = test_point_side_from_layers(layers, &point);
        let duplicate = deduplicated.iter_mut().find(|known| {
            let known_side = test_point_side_from_layers(layers, known);
            let same_surface = match (known_side, point_side) {
                (Side::Top | Side::Bottom, Side::Top | Side::Bottom) => known_side == point_side,
                _ => known.layer_id.is_some() && known.layer_id == point.layer_id,
            };
            same_surface
                && known.center.distance_sq(point.center) <= 25_000_i128.pow(2)
                && (known.component_ref == point.component_ref
                    || known.net_name == point.net_name
                    || known.component_ref.is_none()
                    || point.component_ref.is_none())
        });
        if let Some(known) = duplicate {
            if known.net_name.is_none() {
                known.net_name = point.net_name;
            }
            if known.component_ref.is_none() {
                known.component_ref = point.component_ref;
            }
            if known.radius_nm.is_none() {
                known.radius_nm = point.radius_nm;
                known.layer_id = point.layer_id;
                known.geometry_source = point.geometry_source;
            }
        } else {
            deduplicated.push(point);
        }
    }
    *points = deduplicated;
}

fn test_point_side_from_layers(layers: &[Layer], point: &TestPoint) -> Side {
    point
        .layer_id
        .as_deref()
        .and_then(|layer_id| layers.iter().find(|layer| layer.id == layer_id))
        .map_or(Side::Na, |layer| layer.side)
}

fn is_odb_matrix_path(relative: &str) -> bool {
    let normalized = relative.replace('\\', "/").to_ascii_lowercase();
    normalized == "matrix/matrix" || normalized.ends_with("/matrix/matrix")
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

fn odb_layer_side(name: &str, layer: Option<&MatrixLayer>, matrix: &[MatrixLayer]) -> Side {
    let named = side_from_name(name);
    if named != Side::Na {
        return named;
    }
    let Some(layer) = layer else {
        return Side::Na;
    };
    let function = normalize_odb_function(&layer.layer_type, &layer.add_type);
    if function.contains("PROFILE") || function.contains("DRILL") || function.contains("ROUT") {
        return Side::Na;
    }
    let mut conductive_rows = matrix
        .iter()
        .filter(|candidate| {
            candidate.context.eq_ignore_ascii_case("BOARD")
                && is_conductive_function(&normalize_odb_function(
                    &candidate.layer_type,
                    &candidate.add_type,
                ))
        })
        .map(|candidate| candidate.row)
        .filter(|row| *row > 0)
        .collect::<Vec<_>>();
    conductive_rows.sort_unstable();
    let (Some(first), Some(last)) = (conductive_rows.first(), conductive_rows.last()) else {
        return Side::Na;
    };
    if layer.row <= *first {
        Side::Top
    } else if layer.row >= *last {
        Side::Bottom
    } else {
        Side::Inner
    }
}

fn is_conductive_function(function: &str) -> bool {
    let upper = function.to_ascii_uppercase();
    ["SIGNAL", "POWER_GROUND", "MIXED", "COPPER"]
        .iter()
        .any(|kind| upper.contains(kind))
}

fn side_from_name(name: &str) -> Side {
    let lower = name.to_ascii_lowercase();
    if lower.contains("top") || lower.contains("+_top") {
        Side::Top
    } else if lower.contains("bottom") || lower.contains("+_bot") {
        Side::Bottom
    } else {
        Side::Na
    }
}

fn symbol_dimensions(name: &str, units: OdbUnits) -> Option<(i64, i64)> {
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
        return None;
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
    let x = numbers.first().copied()?;
    let y = numbers.get(1).copied().unwrap_or(x);
    Some((
        (x * symbol_units.symbol_scale()).round() as i64,
        (y * symbol_units.symbol_scale()).round() as i64,
    ))
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

fn component_coverage(components: &[Component]) -> CoverageLevel {
    components
        .iter()
        .map(|component| component.confidence)
        .reduce(CoverageLevel::weakest)
        .unwrap_or(CoverageLevel::Missing)
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
    fn unresolved_custom_test_point_symbols_do_not_create_fake_diameters() {
        let text = "UNITS=MM\n$0 custom_tp_land\n@0 .test_point\nP 1 2 0 P 0;0";
        let mut diagnostics = Vec::new();
        let parsed = parse_feature_file(
            text,
            Path::new("features"),
            "top",
            "SIGNAL",
            &mut diagnostics,
        );
        assert_eq!(parsed.test_points.len(), 1);
        assert_eq!(parsed.test_points[0].radius_nm, None);
        assert_eq!(parsed.test_points[0].geometry_source, None);
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
