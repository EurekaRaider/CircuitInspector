use crate::cache::CacheStore;
use crate::model::{
    AnalysisSummary, BoundsNm, Design, FeatureGeometry, Polarity, Verdict, Violation,
};
use crate::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceResult {
    pub violation_id: String,
    pub png_path: String,
    pub svg_path: String,
    pub width: u32,
    pub height: u32,
}

pub fn render_evidence(
    cache: &CacheStore,
    design: &Design,
    analysis: &AnalysisSummary,
    violation_ids: &[String],
    width: u32,
    height: u32,
) -> CoreResult<Vec<EvidenceResult>> {
    let width = width.clamp(256, 4096);
    let height = height.clamp(256, 4096);
    let directory = cache.evidence_dir(&analysis.id);
    fs::create_dir_all(&directory)?;
    let selected = analysis.violations.iter().filter(|violation| {
        violation_ids.is_empty() || violation_ids.iter().any(|id| id == &violation.id)
    });
    let mut results = Vec::new();
    for violation in selected {
        let safe_id = violation
            .id
            .chars()
            .map(|value| {
                if value.is_ascii_alphanumeric() {
                    value
                } else {
                    '-'
                }
            })
            .collect::<String>();
        let png_path = directory.join(format!("{safe_id}.png"));
        let svg_path = directory.join(format!("{safe_id}.svg"));
        let viewport = evidence_viewport(design, violation);
        let svg = render_svg(design, violation, viewport, width, height);
        fs::write(&svg_path, svg)?;
        render_png(design, violation, viewport, width, height, &png_path)?;
        results.push(EvidenceResult {
            violation_id: violation.id.clone(),
            png_path: png_path.display().to_string(),
            svg_path: svg_path.display().to_string(),
            width,
            height,
        });
    }
    Ok(results)
}

pub fn write_html_report(
    cache: &CacheStore,
    design: &Design,
    analysis: &AnalysisSummary,
) -> CoreResult<PathBuf> {
    let directory = cache.evidence_dir(&analysis.id);
    fs::create_dir_all(&directory)?;
    let path = directory.join("report.html");
    let rows = analysis
        .violations
        .iter()
        .map(|violation| {
            format!(
                "<tr><td>{}</td><td>{:?}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                html(&violation.rule_id),
                violation.verdict,
                html(&violation.net_names.join(", ")),
                html(&violation.component_refs.join(", ")),
                html(&violation.message),
            )
        })
        .collect::<String>();
    let document = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>CircuitInspector report</title><style>body{{font:14px system-ui;background:#f4f4f2;color:#1b1d1f;margin:40px}}table{{border-collapse:collapse;width:100%}}th,td{{padding:10px;border-bottom:1px solid #d7d8d4;text-align:left}}code{{font-family:ui-monospace}}</style><h1>CircuitInspector analysis</h1><p>Design <code>{}</code> · Rule pack <code>{}</code> · Verdict <strong>{:?}</strong></p><p>PASS {} · FAIL {} · REVIEW {} · N/A {}</p><table><thead><tr><th>Rule</th><th>Verdict</th><th>Net</th><th>Component</th><th>Details</th></tr></thead><tbody>{}</tbody></table>",
        html(&design.id),
        html(&analysis.rule_pack_id),
        analysis.verdict,
        analysis.pass_count,
        analysis.fail_count,
        analysis.review_count,
        analysis.not_applicable_count,
        rows
    );
    fs::write(&path, document)?;
    Ok(path)
}

fn evidence_viewport(design: &Design, violation: &Violation) -> BoundsNm {
    let margin = violation
        .threshold_nm
        .unwrap_or(1_000_000)
        .saturating_mul(3)
        .max(2_000_000);
    BoundsNm {
        min_x: (violation.x_nm - margin).max(design.bounds.min_x),
        min_y: (violation.y_nm - margin).max(design.bounds.min_y),
        max_x: (violation.x_nm + margin).min(design.bounds.max_x),
        max_y: (violation.y_nm + margin).min(design.bounds.max_y),
    }
    .normalized()
}

fn render_svg(
    design: &Design,
    violation: &Violation,
    viewport: BoundsNm,
    width: u32,
    height: u32,
) -> String {
    let view_width = (viewport.max_x - viewport.min_x).max(1) as f64 / 1_000_000.0;
    let view_height = (viewport.max_y - viewport.min_y).max(1) as f64 / 1_000_000.0;
    let mut geometry = String::new();
    for layer in &design.layers {
        for feature in &layer.features {
            if !feature.geometry.bounds().intersects(viewport) {
                continue;
            }
            let color = if feature.polarity == Polarity::Clear {
                "#727873"
            } else {
                "#afbd97"
            };
            geometry.push_str(&svg_geometry(&feature.geometry, viewport, color));
        }
    }
    let marker_x = (violation.x_nm - viewport.min_x) as f64 / 1_000_000.0;
    let marker_y = (viewport.max_y - violation.y_nm) as f64 / 1_000_000.0;
    let measurement = if violation.evidence_points.len() >= 2 {
        let first = violation.evidence_points[0];
        let second = violation.evidence_points[1];
        format!(
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"#55bac1\" stroke-width=\"0.06\" stroke-dasharray=\"0.18 0.12\"/><circle cx=\"{}\" cy=\"{}\" r=\"0.12\" fill=\"#55bac1\"/><circle cx=\"{}\" cy=\"{}\" r=\"0.12\" fill=\"#55bac1\"/>",
            (first.x - viewport.min_x) as f64 / 1_000_000.0,
            (viewport.max_y - first.y) as f64 / 1_000_000.0,
            (second.x - viewport.min_x) as f64 / 1_000_000.0,
            (viewport.max_y - second.y) as f64 / 1_000_000.0,
            (first.x - viewport.min_x) as f64 / 1_000_000.0,
            (viewport.max_y - first.y) as f64 / 1_000_000.0,
            (second.x - viewport.min_x) as f64 / 1_000_000.0,
            (viewport.max_y - second.y) as f64 / 1_000_000.0,
        )
    } else {
        String::new()
    };
    let labels = evidence_labels(violation);
    let panel_height = (view_height * 0.18).max(0.9).min(view_height * 0.32);
    let font_size = (view_height * 0.04).max(0.22).min(0.55);
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {view_width} {view_height}\"><rect width=\"100%\" height=\"100%\" fill=\"#16191b\"/>{geometry}{measurement}<circle cx=\"{marker_x}\" cy=\"{marker_y}\" r=\"0.55\" fill=\"none\" stroke=\"#e0644d\" stroke-width=\"0.08\"/><path d=\"M {marker_x} {} L {marker_x} {} M {} {marker_y} L {} {marker_y}\" stroke=\"#e0644d\" stroke-width=\"0.04\"/><g><rect x=\"0\" y=\"0\" width=\"{view_width}\" height=\"{panel_height}\" fill=\"#202427\" fill-opacity=\"0.96\"/><text x=\"0.22\" y=\"{}\" fill=\"#f3f2ed\" font-family=\"ui-monospace,monospace\" font-size=\"{font_size}\">{}</text><text x=\"0.22\" y=\"{}\" fill=\"#9ba4a8\" font-family=\"ui-monospace,monospace\" font-size=\"{font_size}\">{}</text><text x=\"0.22\" y=\"{}\" fill=\"#55bac1\" font-family=\"ui-monospace,monospace\" font-size=\"{font_size}\">{}</text></g></svg>",
        marker_y - 0.8,
        marker_y + 0.8,
        marker_x - 0.8,
        marker_x + 0.8,
        font_size * 1.2,
        html(&labels[0]),
        font_size * 2.35,
        html(&labels[1]),
        font_size * 3.5,
        html(&labels[2]),
    )
}

fn svg_geometry(geometry: &FeatureGeometry, viewport: BoundsNm, color: &str) -> String {
    let x = |value: i64| (value - viewport.min_x) as f64 / 1_000_000.0;
    let y = |value: i64| (viewport.max_y - value) as f64 / 1_000_000.0;
    match geometry {
        FeatureGeometry::Line {
            start,
            end,
            width_nm,
        }
        | FeatureGeometry::Arc {
            start,
            end,
            width_nm,
            ..
        } => format!(
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{color}\" stroke-width=\"{}\" stroke-linecap=\"round\"/>",
            x(start.x),
            y(start.y),
            x(end.x),
            y(end.y),
            (*width_nm as f64 / 1_000_000.0).max(0.02)
        ),
        FeatureGeometry::Pad {
            center,
            size_x_nm,
            size_y_nm,
            ..
        } => format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{color}\"/>",
            x(center.x - size_x_nm / 2),
            y(center.y + size_y_nm / 2),
            *size_x_nm as f64 / 1_000_000.0,
            *size_y_nm as f64 / 1_000_000.0,
        ),
        FeatureGeometry::Drill {
            center,
            diameter_nm,
            ..
        } => format!(
            "<circle cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"#16191b\" stroke=\"{color}\" stroke-width=\"0.04\"/>",
            x(center.x),
            y(center.y),
            *diameter_nm as f64 / 2_000_000.0
        ),
        FeatureGeometry::Region { points } => {
            let points = points
                .iter()
                .map(|point| format!("{},{}", x(point.x), y(point.y)))
                .collect::<Vec<_>>()
                .join(" ");
            format!("<polygon points=\"{points}\" fill=\"{color}\" fill-opacity=\"0.45\"/>")
        }
        FeatureGeometry::ComponentBody { bounds } => format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"0.04\"/>",
            x(bounds.min_x),
            y(bounds.max_y),
            (bounds.max_x - bounds.min_x) as f64 / 1_000_000.0,
            (bounds.max_y - bounds.min_y) as f64 / 1_000_000.0,
        ),
    }
}

fn render_png(
    design: &Design,
    violation: &Violation,
    viewport: BoundsNm,
    width: u32,
    height: u32,
    path: &PathBuf,
) -> CoreResult<()> {
    let pixels = usize::try_from(width)
        .unwrap_or(0)
        .saturating_mul(usize::try_from(height).unwrap_or(0));
    let mut image = vec![0_u8; pixels.saturating_mul(4)];
    for pixel in image.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[22, 25, 27, 255]);
    }
    for layer in &design.layers {
        for feature in &layer.features {
            if !feature.geometry.bounds().intersects(viewport) {
                continue;
            }
            let color = if feature.polarity == Polarity::Clear {
                [76, 82, 79, 255]
            } else {
                [151, 172, 123, 255]
            };
            raster_geometry(
                &mut image,
                width,
                height,
                viewport,
                &feature.geometry,
                color,
            );
        }
    }
    if violation.evidence_points.len() >= 2 {
        let first = violation.evidence_points[0];
        let second = violation.evidence_points[1];
        let (x0, y0) = to_pixel(first.x, first.y, viewport, width, height);
        let (x1, y1) = to_pixel(second.x, second.y, viewport, width, height);
        draw_thick_line(
            &mut image,
            width,
            height,
            x0,
            y0,
            x1,
            y1,
            [85, 186, 193, 255],
        );
        draw_circle(
            &mut image,
            width,
            height,
            x0,
            y0,
            5,
            [85, 186, 193, 255],
            true,
        );
        draw_circle(
            &mut image,
            width,
            height,
            x1,
            y1,
            5,
            [85, 186, 193, 255],
            true,
        );
    }
    let (marker_x, marker_y) = to_pixel(violation.x_nm, violation.y_nm, viewport, width, height);
    draw_circle(
        &mut image,
        width,
        height,
        marker_x,
        marker_y,
        18,
        [224, 100, 77, 255],
        false,
    );
    let panel_height = (height / 5).clamp(78, 180) as i32;
    fill_rect(
        &mut image,
        width,
        height,
        0,
        0,
        width as i32 - 1,
        panel_height,
        [31, 35, 38, 248],
    );
    let scale = (width / 600).clamp(2, 6) as i32;
    let labels = evidence_labels(violation);
    draw_text(
        &mut image,
        width,
        height,
        14,
        12,
        &labels[0],
        scale,
        [243, 242, 237, 255],
    );
    draw_text(
        &mut image,
        width,
        height,
        14,
        12 + 10 * scale,
        &labels[1],
        scale,
        [155, 164, 168, 255],
    );
    draw_text(
        &mut image,
        width,
        height,
        14,
        12 + 20 * scale,
        &labels[2],
        scale,
        [85, 186, 193, 255],
    );
    let file = File::create(path)?;
    let mut encoder = png::Encoder::new(BufWriter::new(file), width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|error| CoreError::Cache(error.to_string()))?;
    writer
        .write_image_data(&image)
        .map_err(|error| CoreError::Cache(error.to_string()))?;
    Ok(())
}

fn evidence_labels(violation: &Violation) -> [String; 3] {
    let nets = if violation.net_names.is_empty() {
        "-".into()
    } else {
        violation.net_names.join(",")
    };
    let refs = if violation.component_refs.is_empty() {
        "-".into()
    } else {
        violation.component_refs.join(",")
    };
    let measured = violation
        .measured_value_nm
        .map(format_nm)
        .unwrap_or_else(|| "N/A".into());
    let threshold = violation
        .threshold_nm
        .map(format_nm)
        .unwrap_or_else(|| "N/A".into());
    [
        format!(
            "ISSUE {} | {}",
            violation.id,
            _verdict_label(violation.verdict)
        ),
        format!("NET {nets} | REF {refs} | RULE {}", violation.rule_id),
        format!("MEASURED {measured} | LIMIT {threshold}"),
    ]
}

fn format_nm(value: i64) -> String {
    format!("{:.3} MM", value as f64 / 1_000_000.0)
}

fn raster_geometry(
    image: &mut [u8],
    width: u32,
    height: u32,
    viewport: BoundsNm,
    geometry: &FeatureGeometry,
    color: [u8; 4],
) {
    match geometry {
        FeatureGeometry::Line { start, end, .. } | FeatureGeometry::Arc { start, end, .. } => {
            let (x0, y0) = to_pixel(start.x, start.y, viewport, width, height);
            let (x1, y1) = to_pixel(end.x, end.y, viewport, width, height);
            draw_line(image, width, height, x0, y0, x1, y1, color);
        }
        FeatureGeometry::Pad {
            center,
            size_x_nm,
            size_y_nm,
            ..
        } => {
            let bounds = BoundsNm {
                min_x: center.x - size_x_nm / 2,
                min_y: center.y - size_y_nm / 2,
                max_x: center.x + size_x_nm / 2,
                max_y: center.y + size_y_nm / 2,
            };
            let (x0, y0) = to_pixel(bounds.min_x, bounds.max_y, viewport, width, height);
            let (x1, y1) = to_pixel(bounds.max_x, bounds.min_y, viewport, width, height);
            fill_rect(image, width, height, x0, y0, x1, y1, color);
        }
        FeatureGeometry::Drill {
            center,
            diameter_nm,
            ..
        } => {
            let (x, y) = to_pixel(center.x, center.y, viewport, width, height);
            let radius = (((*diameter_nm as f64 / (viewport.max_x - viewport.min_x).max(1) as f64)
                * width as f64)
                / 2.0)
                .round() as i32;
            draw_circle(
                image,
                width,
                height,
                x,
                y,
                radius.max(1),
                [22, 25, 27, 255],
                true,
            );
        }
        FeatureGeometry::Region { points } => {
            for pair in points.windows(2) {
                let (x0, y0) = to_pixel(pair[0].x, pair[0].y, viewport, width, height);
                let (x1, y1) = to_pixel(pair[1].x, pair[1].y, viewport, width, height);
                draw_line(image, width, height, x0, y0, x1, y1, color);
            }
        }
        FeatureGeometry::ComponentBody { bounds } => {
            let (x0, y0) = to_pixel(bounds.min_x, bounds.max_y, viewport, width, height);
            let (x1, y1) = to_pixel(bounds.max_x, bounds.min_y, viewport, width, height);
            draw_line(image, width, height, x0, y0, x1, y0, color);
            draw_line(image, width, height, x1, y0, x1, y1, color);
            draw_line(image, width, height, x1, y1, x0, y1, color);
            draw_line(image, width, height, x0, y1, x0, y0, color);
        }
    }
}

fn to_pixel(x: i64, y: i64, viewport: BoundsNm, width: u32, height: u32) -> (i32, i32) {
    let px = ((x - viewport.min_x) as f64 / (viewport.max_x - viewport.min_x).max(1) as f64
        * f64::from(width - 1))
    .round();
    let py = ((viewport.max_y - y) as f64 / (viewport.max_y - viewport.min_y).max(1) as f64
        * f64::from(height - 1))
    .round();
    (px as i32, py as i32)
}

fn set_pixel(image: &mut [u8], width: u32, height: u32, x: i32, y: i32, color: [u8; 4]) {
    if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
        return;
    }
    let index = (y as usize * width as usize + x as usize) * 4;
    if let Some(pixel) = image.get_mut(index..index + 4) {
        pixel.copy_from_slice(&color);
    }
}

fn draw_line(
    image: &mut [u8],
    width: u32,
    height: u32,
    mut x0: i32,
    mut y0: i32,
    x1: i32,
    y1: i32,
    color: [u8; 4],
) {
    let dx = (x1 - x0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let dy = -(y1 - y0).abs();
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut error = dx + dy;
    loop {
        set_pixel(image, width, height, x0, y0, color);
        if x0 == x1 && y0 == y1 {
            break;
        }
        let doubled = 2 * error;
        if doubled >= dy {
            error += dy;
            x0 += sx;
        }
        if doubled <= dx {
            error += dx;
            y0 += sy;
        }
    }
}

fn draw_thick_line(
    image: &mut [u8],
    width: u32,
    height: u32,
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
    color: [u8; 4],
) {
    for offset in -1..=1 {
        draw_line(
            image,
            width,
            height,
            x0 + offset,
            y0,
            x1 + offset,
            y1,
            color,
        );
        draw_line(
            image,
            width,
            height,
            x0,
            y0 + offset,
            x1,
            y1 + offset,
            color,
        );
    }
}

fn draw_text(
    image: &mut [u8],
    width: u32,
    height: u32,
    mut x: i32,
    y: i32,
    text: &str,
    scale: i32,
    color: [u8; 4],
) {
    for character in text.to_ascii_uppercase().chars() {
        if x + 6 * scale >= width as i32 {
            break;
        }
        let glyph = glyph(character);
        for (row, bits) in glyph.iter().enumerate() {
            for column in 0..5 {
                if bits & (1 << (4 - column)) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        set_pixel(
                            image,
                            width,
                            height,
                            x + column * scale + dx,
                            y + row as i32 * scale + dy,
                            color,
                        );
                    }
                }
            }
        }
        x += 6 * scale;
    }
}

fn glyph(value: char) -> [u8; 7] {
    match value {
        'A' => [14, 17, 17, 31, 17, 17, 17],
        'B' => [30, 17, 17, 30, 17, 17, 30],
        'C' => [14, 17, 16, 16, 16, 17, 14],
        'D' => [30, 17, 17, 17, 17, 17, 30],
        'E' => [31, 16, 16, 30, 16, 16, 31],
        'F' => [31, 16, 16, 30, 16, 16, 16],
        'G' => [14, 17, 16, 23, 17, 17, 15],
        'H' => [17, 17, 17, 31, 17, 17, 17],
        'I' => [14, 4, 4, 4, 4, 4, 14],
        'J' => [7, 2, 2, 2, 18, 18, 12],
        'K' => [17, 18, 20, 24, 20, 18, 17],
        'L' => [16, 16, 16, 16, 16, 16, 31],
        'M' => [17, 27, 21, 21, 17, 17, 17],
        'N' => [17, 25, 21, 19, 17, 17, 17],
        'O' => [14, 17, 17, 17, 17, 17, 14],
        'P' => [30, 17, 17, 30, 16, 16, 16],
        'Q' => [14, 17, 17, 17, 21, 18, 13],
        'R' => [30, 17, 17, 30, 20, 18, 17],
        'S' => [15, 16, 16, 14, 1, 1, 30],
        'T' => [31, 4, 4, 4, 4, 4, 4],
        'U' => [17, 17, 17, 17, 17, 17, 14],
        'V' => [17, 17, 17, 17, 17, 10, 4],
        'W' => [17, 17, 17, 21, 21, 21, 10],
        'X' => [17, 17, 10, 4, 10, 17, 17],
        'Y' => [17, 17, 10, 4, 4, 4, 4],
        'Z' => [31, 1, 2, 4, 8, 16, 31],
        '0' => [14, 17, 19, 21, 25, 17, 14],
        '1' => [4, 12, 4, 4, 4, 4, 14],
        '2' => [14, 17, 1, 2, 4, 8, 31],
        '3' => [30, 1, 1, 14, 1, 1, 30],
        '4' => [2, 6, 10, 18, 31, 2, 2],
        '5' => [31, 16, 16, 30, 1, 1, 30],
        '6' => [14, 16, 16, 30, 17, 17, 14],
        '7' => [31, 1, 2, 4, 8, 8, 8],
        '8' => [14, 17, 17, 14, 17, 17, 14],
        '9' => [14, 17, 17, 15, 1, 1, 14],
        '-' => [0, 0, 0, 31, 0, 0, 0],
        '_' => [0, 0, 0, 0, 0, 0, 31],
        '.' => [0, 0, 0, 0, 0, 12, 12],
        ':' => [0, 12, 12, 0, 12, 12, 0],
        '/' => [1, 2, 2, 4, 8, 8, 16],
        '|' => [4, 4, 4, 4, 4, 4, 4],
        ',' => [0, 0, 0, 0, 12, 12, 8],
        ' ' => [0; 7],
        _ => [31, 17, 1, 2, 4, 0, 4],
    }
}

fn fill_rect(
    image: &mut [u8],
    width: u32,
    height: u32,
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
    color: [u8; 4],
) {
    for y in y0.min(y1)..=y0.max(y1) {
        for x in x0.min(x1)..=x0.max(x1) {
            set_pixel(image, width, height, x, y, color);
        }
    }
}

fn draw_circle(
    image: &mut [u8],
    width: u32,
    height: u32,
    cx: i32,
    cy: i32,
    radius: i32,
    color: [u8; 4],
    filled: bool,
) {
    let radius_sq = radius * radius;
    for y in -radius..=radius {
        for x in -radius..=radius {
            let distance = x * x + y * y;
            if (filled && distance <= radius_sq)
                || (!filled && (distance - radius_sq).abs() <= radius.max(1) * 2)
            {
                set_pixel(image, width, height, cx + x, cy + y, color);
            }
        }
    }
}

fn html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[allow(dead_code)]
fn _verdict_label(verdict: Verdict) -> &'static str {
    match verdict {
        Verdict::Pass => "PASS",
        Verdict::Fail => "FAIL",
        Verdict::Review => "REVIEW",
        Verdict::NotApplicable => "NOT_APPLICABLE",
    }
}
