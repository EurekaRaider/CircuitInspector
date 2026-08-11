use super::drill::{is_drill_file, parse_drill_text};
use super::ipc356::{is_ipc356_file, parse_ipc356};
use super::{diagnostic, empty_design};
use crate::model::{
    BoundsNm, Component, CoverageLevel, Design, DesignFormat, Feature, FeatureGeometry, Layer,
    PointNm, Polarity, Severity, Side, TestPoint,
};
use crate::{CoreError, CoreResult};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy)]
enum Units {
    Inch,
    Millimeter,
}

impl Units {
    fn scale(self) -> f64 {
        match self {
            Self::Inch => 25_400_000.0,
            Self::Millimeter => 1_000_000.0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Interpolation {
    Linear,
    Clockwise,
    CounterClockwise,
}

#[derive(Debug, Clone)]
enum ApertureShape {
    Circle,
    Rectangle,
    Obround,
    Polygon,
    Macro(String),
}

impl ApertureShape {
    fn name(&self) -> &str {
        match self {
            Self::Circle => "CIRCLE",
            Self::Rectangle => "RECTANGLE",
            Self::Obround => "OBROUND",
            Self::Polygon => "POLYGON",
            Self::Macro(name) => name,
        }
    }
}

#[derive(Debug, Clone)]
struct Aperture {
    shape: ApertureShape,
    x_nm: i64,
    y_nm: i64,
    attributes: BTreeMap<String, String>,
}

impl Default for Aperture {
    fn default() -> Self {
        Self {
            shape: ApertureShape::Circle,
            x_nm: 100_000,
            y_nm: 100_000,
            attributes: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct StepRepeat {
    x_count: u32,
    y_count: u32,
    x_step_nm: i64,
    y_step_nm: i64,
}

impl Default for StepRepeat {
    fn default() -> Self {
        Self {
            x_count: 1,
            y_count: 1,
            x_step_nm: 0,
            y_step_nm: 0,
        }
    }
}

struct GerberState {
    units: Units,
    x_decimals: u32,
    y_decimals: u32,
    current: PointNm,
    aperture_code: Option<u32>,
    apertures: BTreeMap<u32, Aperture>,
    pending_aperture_attributes: BTreeMap<String, String>,
    object_attributes: BTreeMap<String, String>,
    file_attributes: BTreeMap<String, String>,
    polarity: Polarity,
    interpolation: Interpolation,
    region: Option<Vec<PointNm>>,
    step_repeat: StepRepeat,
    saw_attributes: bool,
    saw_component_attributes: bool,
    diagnostics: Vec<String>,
}

impl Default for GerberState {
    fn default() -> Self {
        Self {
            units: Units::Inch,
            x_decimals: 6,
            y_decimals: 6,
            current: PointNm::default(),
            aperture_code: None,
            apertures: BTreeMap::new(),
            pending_aperture_attributes: BTreeMap::new(),
            object_attributes: BTreeMap::new(),
            file_attributes: BTreeMap::new(),
            polarity: Polarity::Dark,
            interpolation: Interpolation::Linear,
            region: None,
            step_repeat: StepRepeat::default(),
            saw_attributes: false,
            saw_component_attributes: false,
            diagnostics: Vec::new(),
        }
    }
}

pub struct ParsedGerber {
    pub layer: Layer,
    pub file_attributes: BTreeMap<String, String>,
    pub saw_attributes: bool,
    pub saw_component_attributes: bool,
    pub diagnostics: Vec<String>,
}

pub fn parse_gerber_package(
    root: &Path,
    files: &[PathBuf],
    source: &Path,
    content_hash: &str,
) -> CoreResult<Design> {
    let mut design = empty_design(DesignFormat::GerberPackage, source, content_hash);
    let job_functions = load_job_functions(root, files, &mut design);
    let mut gerber_index = 0_usize;
    let mut drill_index = 0_usize;
    let mut x2 = false;
    let mut x3 = false;

    for path in files {
        if is_ipc356_file(path) || is_job_file(path) {
            continue;
        }
        let text = match fs::read_to_string(path) {
            Ok(value) => value,
            Err(error) => {
                design.diagnostics.push(diagnostic(
                    "TEXT_READ_FAILED",
                    Severity::Warning,
                    format!("{} could not be read as text: {error}", path.display()),
                    Some(path),
                ));
                continue;
            }
        };
        if is_drill_file(path) || looks_like_drill(&text) {
            let layer_id = format!("drill-{drill_index}");
            design.layers.push(parse_drill_text(&text, path, &layer_id));
            drill_index += 1;
            continue;
        }
        if !is_gerber_file(path) && !looks_like_gerber(&text) {
            continue;
        }
        let layer_id = format!("gerber-{gerber_index}");
        let job_function = path
            .strip_prefix(root)
            .ok()
            .and_then(|relative| job_functions.get(&normalize_path(relative)))
            .cloned();
        match parse_gerber_text(&text, path, &layer_id, job_function.as_deref()) {
            Ok(parsed) => {
                x2 |= parsed.saw_attributes;
                x3 |= parsed.saw_component_attributes;
                for message in parsed.diagnostics {
                    design.diagnostics.push(diagnostic(
                        "GERBER_PARTIAL_SUPPORT",
                        Severity::Warning,
                        message,
                        Some(path),
                    ));
                }
                design.layers.push(parsed.layer);
                gerber_index += 1;
            }
            Err(error) => design.diagnostics.push(diagnostic(
                "GERBER_PARSE_FAILED",
                Severity::Error,
                error.to_string(),
                Some(path),
            )),
        }
    }

    merge_feature_semantics(&mut design, x2, x3);
    merge_ipc356(&mut design, files);
    design.coverage.layers = if design.layers.is_empty() {
        CoverageLevel::Missing
    } else {
        CoverageLevel::Explicit
    };
    design.coverage.drills = if drill_index > 0 {
        CoverageLevel::Explicit
    } else {
        CoverageLevel::Missing
    };
    if !x2 {
        design.diagnostics.push(diagnostic(
            "GERBER_X1_SEMANTICS",
            Severity::Warning,
            "Gerber package has no X2/X3 attributes; net and component DFT rules will remain REVIEW or NOT_APPLICABLE",
            None,
        ));
    }
    Ok(design)
}

pub fn parse_gerber_text(
    text: &str,
    source: &Path,
    layer_id: &str,
    job_function: Option<&str>,
) -> CoreResult<ParsedGerber> {
    let commands = tokenize(text);
    if commands.is_empty() {
        return Err(CoreError::Parse("Gerber file contains no commands".into()));
    }
    let mut state = GerberState::default();
    let mut features = Vec::new();
    for command in commands {
        parse_command(&command, layer_id, source, &mut state, &mut features)?;
    }
    if let Some(points) = state.region.take() {
        if points.len() >= 3 {
            push_repeated_feature(
                &mut features,
                &state,
                layer_id,
                source,
                FeatureGeometry::Region { points },
                &Aperture::default(),
            );
        }
    }
    let function = job_function
        .map(ToOwned::to_owned)
        .or_else(|| state.file_attributes.get("FileFunction").cloned())
        .unwrap_or_else(|| infer_layer_function(source));
    let side = side_from_function(&function);
    Ok(ParsedGerber {
        layer: Layer {
            id: layer_id.into(),
            name: source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(layer_id)
                .into(),
            function,
            side,
            features,
        },
        file_attributes: state.file_attributes,
        saw_attributes: state.saw_attributes,
        saw_component_attributes: state.saw_component_attributes,
        diagnostics: state.diagnostics,
    })
}

fn parse_command(
    raw: &str,
    layer_id: &str,
    source: &Path,
    state: &mut GerberState,
    features: &mut Vec<Feature>,
) -> CoreResult<()> {
    let command = raw.trim();
    if command.is_empty() || command.starts_with("G04") || command == "M02" {
        return Ok(());
    }
    if command.starts_with("FS") {
        parse_format(command, state);
        return Ok(());
    }
    if command == "MOIN" || command == "G70" {
        state.units = Units::Inch;
        return Ok(());
    }
    if command == "MOMM" || command == "G71" {
        state.units = Units::Millimeter;
        return Ok(());
    }
    if command.starts_with("ADD") {
        parse_aperture(command, state);
        return Ok(());
    }
    if command.starts_with("AM") {
        let name = command[2..].split(',').next().unwrap_or_default();
        if !name.is_empty() {
            state.diagnostics.push(format!(
                "aperture macro {name} is bounded for display; primitive-level macro semantics are not yet exposed"
            ));
        }
        return Ok(());
    }
    if command.starts_with("TF.")
        || command.starts_with("TA.")
        || command.starts_with("TO.")
        || command.starts_with("TD")
    {
        parse_attribute(command, state);
        return Ok(());
    }
    if command.starts_with("LP") {
        state.polarity = if command.contains('C') {
            Polarity::Clear
        } else {
            Polarity::Dark
        };
        return Ok(());
    }
    if command.starts_with("SR") {
        state.step_repeat = parse_step_repeat(command, state.units.scale());
        return Ok(());
    }
    if command.contains("G36") {
        state.region = Some(Vec::new());
    }
    if command.contains("G37") {
        if let Some(points) = state.region.take() {
            if points.len() >= 3 {
                push_repeated_feature(
                    features,
                    state,
                    layer_id,
                    source,
                    FeatureGeometry::Region { points },
                    &Aperture::default(),
                );
            }
        }
        return Ok(());
    }
    if command.contains("G01") {
        state.interpolation = Interpolation::Linear;
    } else if command.contains("G02") {
        state.interpolation = Interpolation::Clockwise;
    } else if command.contains("G03") {
        state.interpolation = Interpolation::CounterClockwise;
    }

    if let Some(code) = aperture_selection(command) {
        state.aperture_code = Some(code);
        if command == format!("D{code}") {
            return Ok(());
        }
    }

    let operation = operation_code(command);
    let has_coordinate = command.contains('X') || command.contains('Y');
    if !has_coordinate && operation.is_none() {
        return Ok(());
    }
    let next = PointNm {
        x: coordinate(
            command,
            'X',
            state.current.x,
            state.x_decimals,
            state.units.scale(),
        ),
        y: coordinate(
            command,
            'Y',
            state.current.y,
            state.y_decimals,
            state.units.scale(),
        ),
    };
    match operation.unwrap_or(1) {
        2 => {
            state.current = next;
            if let Some(region) = state.region.as_mut() {
                region.push(next);
            }
        }
        3 => {
            let aperture = active_aperture(state);
            let geometry = FeatureGeometry::Pad {
                center: next,
                size_x_nm: aperture.x_nm.max(1),
                size_y_nm: aperture.y_nm.max(1),
                rotation_deg: 0.0,
            };
            push_repeated_feature(features, state, layer_id, source, geometry, &aperture);
            state.current = next;
        }
        _ => {
            if let Some(region) = state.region.as_mut() {
                if region.is_empty() {
                    region.push(state.current);
                }
                region.push(next);
                state.current = next;
                return Ok(());
            }
            let aperture = active_aperture(state);
            let geometry = match state.interpolation {
                Interpolation::Linear => FeatureGeometry::Line {
                    start: state.current,
                    end: next,
                    width_nm: aperture.x_nm.max(1),
                },
                Interpolation::Clockwise | Interpolation::CounterClockwise => {
                    let i = coordinate(command, 'I', 0, state.x_decimals, state.units.scale());
                    let j = coordinate(command, 'J', 0, state.y_decimals, state.units.scale());
                    FeatureGeometry::Arc {
                        start: state.current,
                        end: next,
                        center: PointNm {
                            x: state.current.x + i,
                            y: state.current.y + j,
                        },
                        clockwise: matches!(state.interpolation, Interpolation::Clockwise),
                        width_nm: aperture.x_nm.max(1),
                    }
                }
            };
            push_repeated_feature(features, state, layer_id, source, geometry, &aperture);
            state.current = next;
        }
    }
    Ok(())
}

fn push_repeated_feature(
    features: &mut Vec<Feature>,
    state: &GerberState,
    layer_id: &str,
    source: &Path,
    geometry: FeatureGeometry,
    aperture: &Aperture,
) {
    for x_index in 0..state.step_repeat.x_count {
        for y_index in 0..state.step_repeat.y_count {
            let offset = PointNm {
                x: i64::from(x_index) * state.step_repeat.x_step_nm,
                y: i64::from(y_index) * state.step_repeat.y_step_nm,
            };
            let geometry = translate_geometry(&geometry, offset);
            let mut attributes = aperture.attributes.clone();
            attributes.insert("_ApertureShape".into(), aperture.shape.name().into());
            attributes.extend(state.object_attributes.clone());
            let net_name = attributes.get("N").cloned();
            let component_ref = attributes.get("C").cloned().or_else(|| {
                attributes
                    .get("P")
                    .and_then(|value| value.split(',').next().map(ToOwned::to_owned))
            });
            let pin = attributes
                .get("P")
                .and_then(|value| value.split(',').nth(1))
                .map(ToOwned::to_owned);
            features.push(Feature {
                id: format!("{layer_id}:{}", features.len()),
                layer_id: layer_id.into(),
                polarity: state.polarity,
                geometry,
                net_name,
                component_ref,
                pin,
                attributes,
                source: source.display().to_string(),
            });
        }
    }
}

fn translate_geometry(geometry: &FeatureGeometry, offset: PointNm) -> FeatureGeometry {
    let point = |value: PointNm| PointNm {
        x: value.x + offset.x,
        y: value.y + offset.y,
    };
    match geometry {
        FeatureGeometry::Line {
            start,
            end,
            width_nm,
        } => FeatureGeometry::Line {
            start: point(*start),
            end: point(*end),
            width_nm: *width_nm,
        },
        FeatureGeometry::Arc {
            start,
            end,
            center,
            clockwise,
            width_nm,
        } => FeatureGeometry::Arc {
            start: point(*start),
            end: point(*end),
            center: point(*center),
            clockwise: *clockwise,
            width_nm: *width_nm,
        },
        FeatureGeometry::Pad {
            center,
            size_x_nm,
            size_y_nm,
            rotation_deg,
        } => FeatureGeometry::Pad {
            center: point(*center),
            size_x_nm: *size_x_nm,
            size_y_nm: *size_y_nm,
            rotation_deg: *rotation_deg,
        },
        FeatureGeometry::Region { points } => FeatureGeometry::Region {
            points: points.iter().map(|value| point(*value)).collect(),
        },
        FeatureGeometry::Drill {
            center,
            diameter_nm,
            plated,
        } => FeatureGeometry::Drill {
            center: point(*center),
            diameter_nm: *diameter_nm,
            plated: *plated,
        },
        FeatureGeometry::ComponentBody { bounds } => FeatureGeometry::ComponentBody {
            bounds: BoundsNm {
                min_x: bounds.min_x + offset.x,
                min_y: bounds.min_y + offset.y,
                max_x: bounds.max_x + offset.x,
                max_y: bounds.max_y + offset.y,
            },
        },
    }
}

fn parse_format(command: &str, state: &mut GerberState) {
    if let Some(index) = command.find('X') {
        let digits = command[index + 1..]
            .chars()
            .filter(|value| value.is_ascii_digit())
            .take(2)
            .collect::<String>();
        state.x_decimals = digits
            .chars()
            .nth(1)
            .and_then(|value| value.to_digit(10))
            .unwrap_or(6);
    }
    if let Some(index) = command.find('Y') {
        let digits = command[index + 1..]
            .chars()
            .filter(|value| value.is_ascii_digit())
            .take(2)
            .collect::<String>();
        state.y_decimals = digits
            .chars()
            .nth(1)
            .and_then(|value| value.to_digit(10))
            .unwrap_or(6);
    }
}

fn parse_aperture(command: &str, state: &mut GerberState) {
    let rest = &command[3..];
    let digits = rest
        .chars()
        .take_while(|value| value.is_ascii_digit())
        .collect::<String>();
    let Ok(code) = digits.parse::<u32>() else {
        return;
    };
    let shape_and_modifiers = &rest[digits.len()..];
    let (shape_name, modifiers) = shape_and_modifiers
        .split_once(',')
        .unwrap_or((shape_and_modifiers, ""));
    let mut dimensions = modifiers
        .split(['X', 'x'])
        .filter_map(|value| value.parse::<f64>().ok());
    let x_nm = (dimensions.next().unwrap_or(0.1) * state.units.scale()).round() as i64;
    let y_nm = (dimensions
        .next()
        .unwrap_or(x_nm as f64 / state.units.scale())
        * state.units.scale())
    .round() as i64;
    let shape = match shape_name {
        "C" => ApertureShape::Circle,
        "R" => ApertureShape::Rectangle,
        "O" => ApertureShape::Obround,
        "P" => ApertureShape::Polygon,
        custom => ApertureShape::Macro(custom.into()),
    };
    state.apertures.insert(
        code,
        Aperture {
            shape,
            x_nm: x_nm.max(1),
            y_nm: y_nm.max(1),
            attributes: state.pending_aperture_attributes.clone(),
        },
    );
}

fn parse_attribute(command: &str, state: &mut GerberState) {
    state.saw_attributes = true;
    if command.starts_with("TD") {
        let name = command.trim_start_matches("TD").trim_start_matches('.');
        if name.is_empty() {
            state.object_attributes.clear();
        } else {
            state.object_attributes.remove(name);
        }
        return;
    }
    let scope = &command[..2];
    let content = command[3..].to_owned();
    let (name, value) = content.split_once(',').unwrap_or((&content, ""));
    let short_name = name.trim_start_matches('.').to_owned();
    if matches!(
        short_name.as_str(),
        "C" | "P" | "N" | "CRot" | "CMfr" | "CMPN"
    ) {
        state.saw_component_attributes = true;
    }
    match scope {
        "TF" => {
            state.file_attributes.insert(short_name, value.into());
        }
        "TA" => {
            state
                .pending_aperture_attributes
                .insert(short_name, value.into());
        }
        "TO" => {
            state.object_attributes.insert(short_name, value.into());
        }
        _ => {}
    }
}

fn parse_step_repeat(command: &str, scale: f64) -> StepRepeat {
    if command == "SR" {
        return StepRepeat::default();
    }
    StepRepeat {
        x_count: integer_after(command, 'X').unwrap_or(1).max(1) as u32,
        y_count: integer_after(command, 'Y').unwrap_or(1).max(1) as u32,
        x_step_nm: decimal_after(command, 'I')
            .map(|value| (value * scale).round() as i64)
            .unwrap_or(0),
        y_step_nm: decimal_after(command, 'J')
            .map(|value| (value * scale).round() as i64)
            .unwrap_or(0),
    }
}

fn active_aperture(state: &GerberState) -> Aperture {
    state
        .aperture_code
        .and_then(|code| state.apertures.get(&code))
        .cloned()
        .unwrap_or_default()
}

fn aperture_selection(command: &str) -> Option<u32> {
    if command.contains('X')
        || command.contains('Y')
        || command.ends_with("D01")
        || command.ends_with("D02")
        || command.ends_with("D03")
    {
        return None;
    }
    let index = command.rfind('D')?;
    let code = command[index + 1..].parse::<u32>().ok()?;
    (code >= 10).then_some(code)
}

fn operation_code(command: &str) -> Option<u32> {
    for code in [1_u32, 2, 3] {
        if command.ends_with(&format!("D{code:02}")) {
            return Some(code);
        }
    }
    None
}

fn coordinate(command: &str, axis: char, previous: i64, decimals: u32, scale: f64) -> i64 {
    let Some(start) = command.find(axis).map(|index| index + 1) else {
        return previous;
    };
    let rest = &command[start..];
    let end = rest
        .find(|value: char| !value.is_ascii_digit() && value != '-' && value != '+' && value != '.')
        .unwrap_or(rest.len());
    let raw = &rest[..end];
    if raw.is_empty() {
        return previous;
    }
    let value = if raw.contains('.') {
        raw.parse::<f64>().unwrap_or(0.0)
    } else {
        raw.parse::<i64>().unwrap_or(0) as f64 / 10_f64.powi(decimals as i32)
    };
    (value * scale).round() as i64
}

fn tokenize(text: &str) -> Vec<String> {
    let mut commands = Vec::new();
    let mut buffer = String::new();
    let mut extended = false;
    for character in text.chars() {
        match character {
            '%' => {
                if extended {
                    if !buffer.trim().is_empty() {
                        commands.push(buffer.trim().to_owned());
                    }
                    buffer.clear();
                    extended = false;
                } else {
                    if !buffer.trim().is_empty() {
                        commands.push(buffer.trim().to_owned());
                        buffer.clear();
                    }
                    extended = true;
                }
            }
            '*' => {
                if !buffer.trim().is_empty() {
                    commands.push(buffer.trim().to_owned());
                }
                buffer.clear();
            }
            '\r' | '\n' => {}
            _ => buffer.push(character),
        }
    }
    if !buffer.trim().is_empty() {
        commands.push(buffer.trim().to_owned());
    }
    commands
}

fn is_gerber_file(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "gbr"
            | "ger"
            | "pho"
            | "art"
            | "gtl"
            | "gbl"
            | "gto"
            | "gbo"
            | "gts"
            | "gbs"
            | "gko"
            | "gm1"
            | "cmp"
            | "sol"
            | "stc"
            | "sts"
    )
}

fn looks_like_gerber(text: &str) -> bool {
    let head = &text[..text.len().min(4096)];
    head.contains("%FS") || head.contains("%MO") || head.contains("%ADD")
}

fn looks_like_drill(text: &str) -> bool {
    let head = &text[..text.len().min(2048)];
    head.contains("M48") && (head.contains("INCH") || head.contains("METRIC"))
}

fn infer_layer_function(path: &Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "gtl" | "cmp" => "COPPER_TOP",
        "gbl" | "sol" => "COPPER_BOTTOM",
        "gto" => "LEGEND_TOP",
        "gbo" => "LEGEND_BOTTOM",
        "gts" | "stc" => "SOLDERMASK_TOP",
        "gbs" | "sts" => "SOLDERMASK_BOTTOM",
        "gko" | "gm1" => "PROFILE",
        _ => "OTHER",
    }
    .into()
}

fn side_from_function(function: &str) -> Side {
    let upper = function.to_ascii_uppercase();
    if upper.contains("TOP") {
        Side::Top
    } else if upper.contains("BOTTOM") || upper.contains("BOT") {
        Side::Bottom
    } else if upper.contains("INNER") || upper.contains("LAYER") {
        Side::Inner
    } else {
        Side::Na
    }
}

fn load_job_functions(
    root: &Path,
    files: &[PathBuf],
    design: &mut Design,
) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for path in files.iter().filter(|path| is_job_file(path)) {
        let Ok(bytes) = fs::read(path) else { continue };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            design.diagnostics.push(diagnostic(
                "GERBER_JOB_INVALID",
                Severity::Warning,
                "invalid Gerber Job JSON",
                Some(path),
            ));
            continue;
        };
        collect_job_paths(&value, &mut result);
        if result.is_empty() {
            design.diagnostics.push(diagnostic(
                "GERBER_JOB_PARTIAL",
                Severity::Warning,
                "Gerber Job was read but no file-function mappings were recognized",
                Some(path),
            ));
        }
    }
    let _ = root;
    result
}

fn collect_job_paths(value: &Value, result: &mut BTreeMap<String, String>) {
    match value {
        Value::Object(map) => {
            let path = map
                .get("Path")
                .or_else(|| map.get("path"))
                .and_then(Value::as_str);
            let function = map
                .get("FileFunction")
                .or_else(|| map.get("fileFunction"))
                .and_then(|value| {
                    value.as_str().map(ToOwned::to_owned).or_else(|| {
                        value.as_array().map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(",")
                        })
                    })
                });
            if let (Some(path), Some(function)) = (path, function) {
                result.insert(normalize_path(Path::new(path)), function);
            }
            for child in map.values() {
                collect_job_paths(child, result);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_job_paths(item, result);
            }
        }
        _ => {}
    }
}

fn is_job_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .eq_ignore_ascii_case("gbrjob")
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_ascii_lowercase()
}

fn merge_feature_semantics(design: &mut Design, x2: bool, x3: bool) {
    let mut nets = BTreeSet::new();
    let mut components = BTreeMap::<String, Component>::new();
    let mut test_points = Vec::new();
    for layer in &design.layers {
        for feature in &layer.features {
            if let Some(net) = &feature.net_name {
                nets.insert(net.clone());
            }
            if let Some(reference) = &feature.component_ref {
                let bounds = feature.geometry.bounds();
                let component = components.entry(reference.clone()).or_insert(Component {
                    refdes: reference.clone(),
                    package_name: None,
                    center: bounds.center(),
                    bounds,
                    side: layer.side,
                    pins: Vec::new(),
                    confidence: if x3 {
                        CoverageLevel::Explicit
                    } else {
                        CoverageLevel::Supplemented
                    },
                });
                component.bounds.include_bounds(bounds);
                component.center = component.bounds.center();
                if let Some(pin) = &feature.pin {
                    if !component.pins.contains(pin) {
                        component.pins.push(pin.clone());
                    }
                }
            }
            let aperture_function = feature
                .attributes
                .get("AperFunction")
                .map(String::as_str)
                .unwrap_or_default();
            let explicit = aperture_function.to_ascii_uppercase().contains("TEST")
                || feature.attributes.get("TP").is_some();
            let inferred = feature
                .component_ref
                .as_ref()
                .is_some_and(|reference| reference.to_ascii_uppercase().starts_with("TP"));
            if explicit || inferred {
                let bounds = feature.geometry.bounds();
                test_points.push(TestPoint {
                    id: format!("gerber-tp-{}", test_points.len()),
                    center: bounds.center(),
                    radius_nm: Some(
                        ((bounds.max_x - bounds.min_x).min(bounds.max_y - bounds.min_y) / 2).max(1),
                    ),
                    net_name: feature.net_name.clone(),
                    component_ref: feature.component_ref.clone(),
                    confidence: if explicit {
                        CoverageLevel::Explicit
                    } else {
                        CoverageLevel::Inferred
                    },
                    layer_id: Some(feature.layer_id.clone()),
                    source: feature.source.clone(),
                    geometry_source: Some(feature.source.clone()),
                });
            }
        }
    }
    design.nets = nets.into_iter().collect();
    design.components = components.into_values().collect();
    design.test_points = test_points;
    design.coverage.nets = if !design.nets.is_empty() {
        CoverageLevel::Explicit
    } else {
        CoverageLevel::Missing
    };
    design.coverage.components = if !design.components.is_empty() {
        if x3 {
            CoverageLevel::Explicit
        } else {
            CoverageLevel::Supplemented
        }
    } else {
        CoverageLevel::Missing
    };
    design.coverage.pins = if design
        .components
        .iter()
        .any(|component| !component.pins.is_empty())
    {
        if x3 {
            CoverageLevel::Explicit
        } else {
            CoverageLevel::Supplemented
        }
    } else {
        CoverageLevel::Missing
    };
    design.coverage.test_points = design
        .test_points
        .iter()
        .map(|test_point| test_point.confidence)
        .fold(CoverageLevel::Missing, CoverageLevel::combine);
    if x2 && design.coverage.nets == CoverageLevel::Missing {
        design.diagnostics.push(diagnostic(
            "GERBER_X2_WITHOUT_NETS",
            Severity::Info,
            "X2 attributes are present, but no net attributes were found",
            None,
        ));
    }
}

fn merge_ipc356(design: &mut Design, files: &[PathBuf]) {
    for path in files.iter().filter(|path| is_ipc356_file(path)) {
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        let parsed = parse_ipc356(&text, path);
        let existing_nets = design.nets.iter().cloned().collect::<BTreeSet<_>>();
        for net in &parsed.nets {
            if !existing_nets.contains(net) {
                design.nets.push(net.clone());
            }
        }
        for (_, incoming) in parsed.components {
            if let Some(existing) = design
                .components
                .iter_mut()
                .find(|component| component.refdes == incoming.refdes)
            {
                for pin in incoming.pins {
                    if !existing.pins.contains(&pin) {
                        existing.pins.push(pin);
                    }
                }
            } else {
                design.components.push(incoming);
            }
        }
        for incoming in parsed.test_points {
            if let Some(existing) = design
                .test_points
                .iter()
                .find(|point| point.center.distance_sq(incoming.center) < 25_000_i128.pow(2))
            {
                if existing.net_name.is_some()
                    && incoming.net_name.is_some()
                    && existing.net_name != incoming.net_name
                {
                    design.diagnostics.push(diagnostic(
                        "DATA_CONFLICT",
                        Severity::Warning,
                        format!(
                            "Gerber and IPC-356 disagree on test point net at ({}, {})",
                            incoming.center.x, incoming.center.y
                        ),
                        Some(path),
                    ));
                }
            } else {
                design.test_points.push(incoming);
            }
        }
        design.diagnostics.extend(parsed.diagnostics);
        if !parsed.nets.is_empty() {
            design.coverage.nets = design.coverage.nets.combine(CoverageLevel::Supplemented);
        }
        if !design.components.is_empty() {
            design.coverage.components = design
                .coverage
                .components
                .combine(CoverageLevel::Supplemented);
            design.coverage.pins = design.coverage.pins.combine(CoverageLevel::Supplemented);
        }
        if !design.test_points.is_empty() {
            design.coverage.test_points = design
                .coverage
                .test_points
                .combine(CoverageLevel::Supplemented);
        }
    }
}

fn integer_after(value: &str, marker: char) -> Option<i64> {
    decimal_after(value, marker).map(|number| number.round() as i64)
}

fn decimal_after(value: &str, marker: char) -> Option<f64> {
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
    fn parses_x2_flash_and_line() {
        let text = "%FSLAX26Y26*%\n%MOMM*%\n%TF.FileFunction,Copper,L1,Top*%\n%TA.AperFunction,TestPad*%\n%ADD10C,0.500*%\nD10*\n%TO.N,NET_A*%\n%TO.C,TP1*%\nX1000000Y1000000D03*\nX1000000Y1000000D02*\nX2000000Y1000000D01*\nM02*";
        let parsed = parse_gerber_text(text, Path::new("top.gbr"), "top", None).unwrap();
        assert_eq!(parsed.layer.features.len(), 2);
        assert!(parsed.saw_attributes);
        assert_eq!(parsed.layer.side, Side::Top);
        assert_eq!(parsed.layer.features[0].net_name.as_deref(), Some("NET_A"));
    }

    #[test]
    fn expands_step_repeat() {
        let text = "%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.0*%\n%SRX2Y2I10J20*%\nD10*\nX010000Y010000D03*\n%SR*%\nM02*";
        let parsed = parse_gerber_text(text, Path::new("array.gbr"), "array", None).unwrap();
        assert_eq!(parsed.layer.features.len(), 4);
    }
}
