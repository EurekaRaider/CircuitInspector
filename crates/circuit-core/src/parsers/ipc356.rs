use crate::model::{Component, CoverageLevel, Diagnostic, PointNm, Severity, Side, TestPoint};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

#[derive(Debug, Default)]
pub struct Ipc356Data {
    pub nets: BTreeSet<String>,
    pub components: BTreeMap<String, Component>,
    pub test_points: Vec<TestPoint>,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn is_ipc356_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "ipc" | "356" | "net"
    ) || name.contains("ipc356")
}

pub fn parse_ipc356(text: &str, source: &Path) -> Ipc356Data {
    let mut data = Ipc356Data::default();
    let mut units_mm = false;
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim_end();
        if line.starts_with("P  UNITS CUST 0") || line.contains("UNITS CUST 0") {
            units_mm = true;
            continue;
        }
        if !line.starts_with("317") && !line.starts_with("327") && !line.starts_with("367") {
            continue;
        }
        let net_name = field(line, 3, 17).trim().trim_matches('-').to_owned();
        let component_pin = field(line, 20, 34).trim();
        let (component_ref, pin) = component_pin.split_once('-').unwrap_or((component_pin, ""));
        let x = parse_axis(line, 'X', units_mm);
        let y = parse_axis(line, 'Y', units_mm);
        if !net_name.is_empty() {
            data.nets.insert(net_name.clone());
        }
        if !component_ref.is_empty() {
            data.components
                .entry(component_ref.into())
                .or_insert_with(|| Component {
                    refdes: component_ref.into(),
                    package_name: None,
                    center: PointNm { x, y },
                    bounds: crate::model::BoundsNm {
                        min_x: x,
                        min_y: y,
                        max_x: x,
                        max_y: y,
                    },
                    side: Side::Na,
                    pins: Vec::new(),
                    confidence: CoverageLevel::Supplemented,
                });
            if !pin.is_empty() {
                let component = data
                    .components
                    .get_mut(component_ref)
                    .expect("component exists");
                if !component.pins.iter().any(|known| known == pin) {
                    component.pins.push(pin.into());
                }
            }
        }
        let is_test_point =
            line.starts_with("367") || component_ref.to_ascii_uppercase().starts_with("TP");
        if is_test_point {
            data.test_points.push(TestPoint {
                id: format!("ipc356:{}", index + 1),
                center: PointNm { x, y },
                radius_nm: None,
                net_name: (!net_name.is_empty()).then_some(net_name),
                component_ref: (!component_ref.is_empty()).then_some(component_ref.into()),
                confidence: if line.starts_with("367") {
                    CoverageLevel::Explicit
                } else {
                    CoverageLevel::Inferred
                },
                layer_id: None,
                source: source.display().to_string(),
                geometry_source: None,
            });
        }
    }
    if data.nets.is_empty() {
        data.diagnostics.push(Diagnostic {
            code: "IPC356_NO_NETS".into(),
            severity: Severity::Warning,
            message: "IPC-356 file was detected but no supported net records were found".into(),
            source: Some(source.display().to_string()),
        });
    }
    data
}

fn field(value: &str, start: usize, end: usize) -> &str {
    value
        .get(start.min(value.len())..end.min(value.len()))
        .unwrap_or_default()
}

fn parse_axis(line: &str, axis: char, units_mm: bool) -> i64 {
    let Some(start) = line.find(axis).map(|index| index + 1) else {
        return 0;
    };
    let rest = &line[start..];
    let end = rest
        .find(|value: char| !value.is_ascii_digit() && value != '-' && value != '+')
        .unwrap_or(rest.len());
    let raw = rest[..end].parse::<i64>().unwrap_or(0);
    let unit = if units_mm { 1_000.0 } else { 2_540.0 };
    (raw as f64 * unit).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_net_component_and_testpoint() {
        let text = "P  UNITS CUST 0\n367NET_A           TP1-1          X001000Y002000";
        let data = parse_ipc356(text, Path::new("board.ipc"));
        assert!(data.nets.contains("NET_A"));
        assert_eq!(data.test_points.len(), 1);
    }
}
