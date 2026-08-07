use crate::model::{Feature, FeatureGeometry, Layer, PointNm, Polarity, Side};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Copy)]
enum DrillUnits {
    Inch,
    Millimeter,
}

impl DrillUnits {
    fn scale(self) -> f64 {
        match self {
            Self::Inch => 25_400_000.0,
            Self::Millimeter => 1_000_000.0,
        }
    }
}

pub fn is_drill_file(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(extension.as_str(), "drl" | "xnc" | "exc" | "ncd" | "tap")
}

pub fn parse_drill_text(text: &str, source: &Path, layer_id: &str) -> Layer {
    let mut units = DrillUnits::Inch;
    let mut decimals = 4_u32;
    let mut tools = BTreeMap::<String, i64>::new();
    let mut active_tool = String::new();
    let mut current = PointNm::default();
    let mut features = Vec::new();

    for raw in text.lines() {
        let line = raw.trim().trim_end_matches('*').to_ascii_uppercase();
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        if line.contains("METRIC") {
            units = DrillUnits::Millimeter;
            decimals = parse_declared_decimals(&line).unwrap_or(3);
            continue;
        }
        if line.contains("INCH") {
            units = DrillUnits::Inch;
            decimals = parse_declared_decimals(&line).unwrap_or(4);
            continue;
        }
        if line.starts_with('T') && line.contains('C') {
            let (tool, diameter) = line.split_once('C').unwrap_or((&line, "0"));
            if let Ok(value) = diameter
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .parse::<f64>()
            {
                tools.insert(tool.to_owned(), (value * units.scale()).round() as i64);
            }
            continue;
        }
        if line.starts_with('T') && line[1..].chars().all(|value| value.is_ascii_digit()) {
            active_tool = line;
            continue;
        }
        if line.starts_with('X') || line.starts_with('Y') {
            if let Some(value) = coordinate_after(&line, 'X', units.scale(), decimals) {
                current.x = value;
            }
            if let Some(value) = coordinate_after(&line, 'Y', units.scale(), decimals) {
                current.y = value;
            }
            let diameter_nm = tools.get(&active_tool).copied().unwrap_or(250_000);
            features.push(Feature {
                id: format!("{layer_id}:drill:{}", features.len()),
                layer_id: layer_id.into(),
                polarity: Polarity::Dark,
                geometry: FeatureGeometry::Drill {
                    center: current,
                    diameter_nm,
                    plated: None,
                },
                net_name: None,
                component_ref: None,
                pin: None,
                attributes: BTreeMap::new(),
                source: source.display().to_string(),
            });
        }
    }

    Layer {
        id: layer_id.into(),
        name: source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(layer_id)
            .into(),
        function: "DRILL".into(),
        side: Side::Na,
        features,
    }
}

fn parse_declared_decimals(line: &str) -> Option<u32> {
    let (_, format) = line.split_once(',')?;
    let (_, decimal) = format.split_once('.')?;
    Some(
        decimal
            .chars()
            .take_while(|value| value.is_ascii_digit())
            .count() as u32,
    )
}

fn coordinate_after(line: &str, axis: char, scale: f64, decimals: u32) -> Option<i64> {
    let start = line.find(axis)? + 1;
    let rest = &line[start..];
    let end = rest
        .find(|value: char| !value.is_ascii_digit() && value != '-' && value != '+' && value != '.')
        .unwrap_or(rest.len());
    let raw = &rest[..end];
    if raw.contains('.') {
        return raw
            .parse::<f64>()
            .ok()
            .map(|value| (value * scale).round() as i64);
    }
    let value = raw.parse::<i64>().ok()?;
    Some(((value as f64 / 10_f64.powi(decimals as i32)) * scale).round() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_metric_drill_file() {
        let layer = parse_drill_text(
            "M48\nMETRIC,TZ,000.000\nT01C0.300\n%\nT01\nX010000Y020000\nM30",
            Path::new("board.drl"),
            "drill",
        );
        assert_eq!(layer.features.len(), 1);
        match layer.features[0].geometry {
            FeatureGeometry::Drill {
                center,
                diameter_nm,
                ..
            } => {
                assert_eq!(
                    center,
                    PointNm {
                        x: 10_000_000,
                        y: 20_000_000
                    }
                );
                assert_eq!(diameter_nm, 300_000);
            }
            _ => panic!("expected drill"),
        }
    }
}
