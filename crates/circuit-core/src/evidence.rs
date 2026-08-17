use crate::cache::CacheStore;
use crate::model::{
    AnalysisSummary, BoundsNm, Design, FeatureGeometry, PointNm, Polarity, Verdict, Violation,
};
use crate::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::PathBuf;

const REPORT_STYLE: &str = r#"
:root {
  color-scheme: light;
  --page: #f5f5f7;
  --surface: rgba(255, 255, 255, 0.92);
  --surface-solid: #ffffff;
  --text: #1d1d1f;
  --secondary: #6e6e73;
  --tertiary: #86868b;
  --line: rgba(29, 29, 31, 0.12);
  --blue: #0071e3;
  --pass: #237a3b;
  --pass-bg: #edf8f0;
  --review: #8a6500;
  --review-bg: #fff8df;
  --fail: #b4232c;
  --fail-bg: #fff0f0;
  --na: #636366;
  --na-bg: #f0f0f2;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--page);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.report-shell {
  width: min(1440px, calc(100% - 48px));
  margin: 0 auto;
  padding: 56px 0 72px;
}
.report-header {
  padding: 8px 4px 34px;
  border-bottom: 1px solid var(--line);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--secondary);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.brand-mark {
  display: inline-grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 8px;
  background: var(--text);
  color: #ffffff;
  font-size: 10px;
  letter-spacing: 0.04em;
}
.title-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 32px;
  margin-top: 42px;
}
.kicker {
  margin: 0 0 8px;
  color: var(--blue);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h1 {
  max-width: 760px;
  margin: 0;
  font-size: clamp(32px, 4.2vw, 52px);
  font-weight: 650;
  letter-spacing: -0.045em;
  line-height: 1.02;
}
.lede {
  max-width: 760px;
  margin: 18px 0 0;
  color: var(--secondary);
  font-size: 17px;
}
.verdict-chip {
  display: inline-flex;
  min-width: 106px;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  padding: 10px 18px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.metadata {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 28px;
  margin: 34px 0 0;
}
.metadata div { min-width: 0; }
.metadata dt,
.metric dt {
  margin-bottom: 6px;
  color: var(--tertiary);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.metadata dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 13px;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 30px 0 56px;
  padding: 24px 0;
  border-bottom: 1px solid var(--line);
}
.metric {
  padding: 0 24px;
  border-left: 1px solid var(--line);
}
.metric:first-child {
  padding-left: 4px;
  border-left: 0;
}
.metric dd {
  margin: 0;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.04em;
  line-height: 1;
}
.section-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 24px;
  margin-bottom: 18px;
  padding: 0 4px;
}
h2 {
  margin: 0;
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -0.025em;
}
.section-note {
  margin: 0;
  color: var(--secondary);
  font-size: 13px;
}
.table-shell {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 22px;
  background: var(--surface);
  box-shadow: 0 18px 50px rgba(29, 29, 31, 0.06);
}
table {
  width: 100%;
  min-width: 980px;
  border-collapse: separate;
  border-spacing: 0;
}
th {
  padding: 15px 18px;
  border-bottom: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.72);
  color: var(--secondary);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.075em;
  text-align: left;
  text-transform: uppercase;
}
td {
  padding: 17px 18px;
  border-bottom: 1px solid rgba(29, 29, 31, 0.08);
  vertical-align: top;
}
tbody tr:last-child td { border-bottom: 0; }
.finding-row td { background: var(--surface-solid); }
.finding-row.status-pass td { background: var(--pass-bg); }
.finding-row.status-review td { background: var(--review-bg); }
.finding-row.status-fail td { background: var(--fail-bg); }
.finding-row.status-not-applicable td { background: var(--na-bg); }
.finding-row.status-pass td:first-child { box-shadow: inset 4px 0 var(--pass); }
.finding-row.status-review td:first-child { box-shadow: inset 4px 0 var(--review); }
.finding-row.status-fail td:first-child { box-shadow: inset 4px 0 var(--fail); }
.finding-row.status-not-applicable td:first-child { box-shadow: inset 4px 0 var(--na); }
.verdict-chip.status-pass,
.row-verdict.status-pass,
.metric.status-pass { color: var(--pass); }
.verdict-chip.status-review,
.row-verdict.status-review,
.metric.status-review { color: var(--review); }
.verdict-chip.status-fail,
.row-verdict.status-fail,
.metric.status-fail { color: var(--fail); }
.verdict-chip.status-not-applicable,
.row-verdict.status-not-applicable,
.metric.status-not-applicable { color: var(--na); }
.row-verdict {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.05em;
}
.row-verdict::before {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  content: "";
}
.rule-id,
.entity-list {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 12px;
}
.rule-id { font-weight: 600; }
.entity-list { color: #424245; }
.details {
  min-width: 300px;
  color: #424245;
}
.empty-row td {
  padding: 48px 24px;
  color: var(--secondary);
  text-align: center;
}
@media (max-width: 760px) {
  .report-shell {
    width: min(100% - 28px, 1440px);
    padding: 32px 0 48px;
  }
  .title-row,
  .section-heading { grid-template-columns: 1fr; }
  .title-row { align-items: start; }
  .verdict-chip { justify-self: start; }
  .metadata { grid-template-columns: 1fr; gap: 18px; }
  .metrics { grid-template-columns: repeat(2, 1fr); row-gap: 24px; }
  .metric:nth-child(3) { padding-left: 4px; border-left: 0; }
}
@media print {
  :root { --page: #ffffff; }
  body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .report-shell { width: 100%; padding: 0; }
  .table-shell { overflow: visible; box-shadow: none; }
  table { min-width: 0; }
  tr { break-inside: avoid; }
}
"#;

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
        let viewport = evidence_viewport(violation, width, height);
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
    let mut rows = analysis
        .violations
        .iter()
        .map(|violation| {
            let status_class = verdict_class(violation.verdict);
            format!(
                "<tr class=\"finding-row {status_class}\" data-verdict=\"{}\"><td class=\"rule-id\">{}</td><td><span class=\"row-verdict {status_class}\">{}</span></td><td class=\"entity-list\">{}</td><td class=\"entity-list\">{}</td><td class=\"details\">{}</td></tr>",
                verdict_label(violation.verdict),
                html(&violation.rule_id),
                verdict_label(violation.verdict),
                html(&violation.net_names.join(", ")),
                html(&violation.component_refs.join(", ")),
                html(&violation.message),
            )
        })
        .collect::<String>();
    if rows.is_empty() {
        rows.push_str("<tr class=\"empty-row\"><td colspan=\"5\">No rule findings were recorded for this analysis.</td></tr>");
    }
    let overall_class = verdict_class(analysis.verdict);
    let document = format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CircuitInspector analysis · {analysis_id}</title>
  <style>{style}</style>
</head>
<body>
  <main class="report-shell">
    <header class="report-header">
      <div class="brand"><span class="brand-mark">CI</span><span>CircuitInspector</span></div>
      <div class="title-row">
        <div>
          <p class="kicker">Deterministic geometry analysis</p>
          <h1>Manufacturing evidence, clearly presented.</h1>
          <p class="lede">A focused record of rule outcomes, affected entities, and the evidence retained for engineering review.</p>
        </div>
        <span class="verdict-chip {overall_class}">{overall_verdict}</span>
      </div>
      <dl class="metadata">
        <div><dt>Design</dt><dd>{design_id}</dd></div>
        <div><dt>Rule pack</dt><dd>{rule_pack_id}</dd></div>
        <div><dt>Analysis</dt><dd>{analysis_id}</dd></div>
      </dl>
    </header>
    <dl class="metrics" aria-label="Verdict summary">
      <div class="metric status-pass"><dt>Pass</dt><dd>{pass_count}</dd></div>
      <div class="metric status-review"><dt>Review</dt><dd>{review_count}</dd></div>
      <div class="metric status-fail"><dt>Fail</dt><dd>{fail_count}</dd></div>
      <div class="metric status-not-applicable"><dt>Not applicable</dt><dd>{na_count}</dd></div>
    </dl>
    <section aria-labelledby="findings-title">
      <div class="section-heading">
        <div>
          <p class="kicker">Rule results</p>
          <h2 id="findings-title">Findings</h2>
        </div>
        <p class="section-note">Rows are color-coded by verdict for fast review.</p>
      </div>
      <div class="table-shell">
        <table>
          <thead><tr><th scope="col">Rule</th><th scope="col">Verdict</th><th scope="col">Net</th><th scope="col">Component</th><th scope="col">Details</th></tr></thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
    </section>
  </main>
</body>
</html>"#,
        analysis_id = html(&analysis.id),
        style = REPORT_STYLE,
        overall_class = overall_class,
        overall_verdict = verdict_label(analysis.verdict),
        design_id = html(&design.id),
        rule_pack_id = html(&analysis.rule_pack_id),
        pass_count = analysis.pass_count,
        review_count = analysis.review_count,
        fail_count = analysis.fail_count,
        na_count = analysis.not_applicable_count,
        rows = rows,
    );
    fs::write(&path, document)?;
    Ok(path)
}

fn evidence_viewport(violation: &Violation, width: u32, height: u32) -> BoundsNm {
    let mut focus = BoundsNm::empty();
    focus.include_point(PointNm {
        x: violation.x_nm,
        y: violation.y_nm,
    });
    for point in &violation.evidence_points {
        focus.include_point(*point);
    }
    let span = (focus.max_x - focus.min_x)
        .max(focus.max_y - focus.min_y)
        .max(0);
    let margin = violation
        .threshold_nm
        .unwrap_or_default()
        .max(0)
        .saturating_mul(5)
        .saturating_div(4)
        .max(span.saturating_div(4))
        .max(750_000);
    let padded = BoundsNm {
        min_x: focus.min_x.saturating_sub(margin),
        min_y: focus.min_y.saturating_sub(margin),
        max_x: focus.max_x.saturating_add(margin),
        max_y: focus.max_y.saturating_add(margin),
    };
    fit_bounds_to_aspect(padded, evidence_plot_aspect(width, height))
}

fn evidence_panel_height(height: u32) -> u32 {
    ((f64::from(height) * 0.16).round() as u32)
        .clamp(96, 192)
        .min(height / 2)
}

fn evidence_plot_aspect(width: u32, height: u32) -> f64 {
    let plot_height = height.saturating_sub(evidence_panel_height(height)).max(1);
    f64::from(width) / f64::from(plot_height)
}

fn fit_bounds_to_aspect(bounds: BoundsNm, aspect: f64) -> BoundsNm {
    let bounds = bounds.normalized();
    let width = (bounds.max_x - bounds.min_x).max(1);
    let height = (bounds.max_y - bounds.min_y).max(1);
    let center = bounds.center();
    if width as f64 / (height as f64) < aspect {
        let target_width = (height as f64 * aspect).ceil() as i64;
        let left = target_width / 2;
        BoundsNm {
            min_x: center.x.saturating_sub(left),
            min_y: bounds.min_y,
            max_x: center.x.saturating_add(target_width - left),
            max_y: bounds.max_y,
        }
    } else {
        let target_height = (width as f64 / aspect).ceil() as i64;
        let bottom = target_height / 2;
        BoundsNm {
            min_x: bounds.min_x,
            min_y: center.y.saturating_sub(bottom),
            max_x: bounds.max_x,
            max_y: center.y.saturating_add(target_height - bottom),
        }
    }
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
    let panel_height_px = evidence_panel_height(height);
    let plot_height_px = height.saturating_sub(panel_height_px).max(1);
    let panel_height = view_height * f64::from(panel_height_px) / f64::from(plot_height_px);
    let total_height = view_height + panel_height;
    let mut geometry = String::new();
    let restrict_layers = !violation.layer_ids.is_empty()
        && design
            .layers
            .iter()
            .any(|layer| violation.layer_ids.contains(&layer.id));
    for layer in &design.layers {
        if restrict_layers && !violation.layer_ids.contains(&layer.id) {
            continue;
        }
        let mut layer_geometry = String::new();
        for feature in &layer.features {
            if !feature.geometry.bounds().intersects(viewport) {
                continue;
            }
            let color = if feature.polarity == Polarity::Clear {
                "#56615d"
            } else {
                "#40584d"
            };
            layer_geometry.push_str(&svg_geometry(&feature.geometry, viewport, color));
        }
        if !layer_geometry.is_empty() {
            geometry.push_str(&format!(
                "<g data-layer-id=\"{}\">{layer_geometry}</g>",
                html(&layer.id)
            ));
        }
    }
    let marker_x = (violation.x_nm - viewport.min_x) as f64 / 1_000_000.0;
    let marker_y = (viewport.max_y - violation.y_nm) as f64 / 1_000_000.0;
    let annotation_font = (view_height.min(view_width) * 0.035).clamp(0.12, 0.34);
    let measurement = svg_measurement_annotation(violation, viewport, annotation_font);
    let marker_radius = (view_height.min(view_width) * 0.027).clamp(0.08, 0.28);
    let marker_color = verdict_svg_color(violation.verdict);
    let labels = evidence_labels(violation);
    let font_size = (panel_height * 0.16).clamp(0.13, 0.34);
    let panel_padding = (font_size * 1.1).max(0.12);
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {view_width} {total_height}\" role=\"img\" aria-label=\"CircuitInspector evidence {}\"><defs><clipPath id=\"plot-clip\"><rect x=\"0\" y=\"0\" width=\"{view_width}\" height=\"{view_height}\"/></clipPath></defs><rect width=\"{view_width}\" height=\"{total_height}\" fill=\"#0d1215\"/><g transform=\"translate(0 {panel_height})\" clip-path=\"url(#plot-clip)\"><rect width=\"{view_width}\" height=\"{view_height}\" fill=\"#11191c\"/>{geometry}{measurement}<circle cx=\"{marker_x}\" cy=\"{marker_y}\" r=\"{marker_radius}\" fill=\"none\" stroke=\"{marker_color}\" stroke-width=\"{}\"/><path d=\"M {marker_x} {} L {marker_x} {} M {} {marker_y} L {} {marker_y}\" stroke=\"{marker_color}\" stroke-width=\"{}\"/></g><g data-role=\"evidence-header\"><rect x=\"0\" y=\"0\" width=\"{view_width}\" height=\"{panel_height}\" fill=\"#182025\"/><rect x=\"0\" y=\"0\" width=\"{}\" height=\"{panel_height}\" fill=\"{marker_color}\"/><text x=\"{panel_padding}\" y=\"{}\" fill=\"#f5f7f8\" font-family=\"ui-monospace,monospace\" font-size=\"{font_size}\" font-weight=\"700\">{}</text><text x=\"{panel_padding}\" y=\"{}\" fill=\"#aab4b9\" font-family=\"ui-monospace,monospace\" font-size=\"{font_size}\">{}</text><text x=\"{panel_padding}\" y=\"{}\" fill=\"#63c6cf\" font-family=\"ui-monospace,monospace\" font-size=\"{font_size}\">{}</text></g></svg>",
        html(&violation.id),
        (marker_radius * 0.24).max(0.018),
        marker_y - marker_radius * 1.45,
        marker_y + marker_radius * 1.45,
        marker_x - marker_radius * 1.45,
        marker_x + marker_radius * 1.45,
        (marker_radius * 0.14).max(0.012),
        (view_width * 0.006).clamp(0.025, 0.08),
        font_size * 1.35,
        html(&labels[0]),
        font_size * 2.75,
        html(&labels[1]),
        font_size * 4.15,
        html(&labels[2]),
    )
}

fn svg_measurement_annotation(violation: &Violation, viewport: BoundsNm, font_size: f64) -> String {
    let Some(measured) = violation.measured_value_nm else {
        return String::new();
    };
    let label = format_nm(measured);
    let label_width = (label.chars().count() as f64 * font_size * 0.66).max(font_size * 4.2);
    let label_height = font_size * 1.65;
    let view_width = (viewport.max_x - viewport.min_x).max(1) as f64 / 1_000_000.0;
    let view_height = (viewport.max_y - viewport.min_y).max(1) as f64 / 1_000_000.0;
    let project = |point: PointNm| {
        (
            (point.x - viewport.min_x) as f64 / 1_000_000.0,
            (viewport.max_y - point.y) as f64 / 1_000_000.0,
        )
    };
    let anchor = violation
        .evidence_points
        .first()
        .copied()
        .unwrap_or(PointNm {
            x: violation.x_nm,
            y: violation.y_nm,
        });
    if violation.evidence_points.len() >= 2 {
        let (x0, y0) = project(violation.evidence_points[0]);
        let (x1, y1) = project(violation.evidence_points[1]);
        let dx = x1 - x0;
        let dy = y1 - y0;
        let length = dx.hypot(dy).max(f64::EPSILON);
        let normal_x = -dy / length;
        let normal_y = dx / length;
        let tick = font_size * 0.75;
        let offset = font_size * 1.55;
        let label_x = ((x0 + x1) / 2.0 + normal_x * offset)
            .clamp(label_width / 2.0, view_width - label_width / 2.0);
        let label_y = ((y0 + y1) / 2.0 + normal_y * offset)
            .clamp(label_height, view_height - label_height * 0.3);
        return format!(
            "<g data-role=\"measurement\"><line data-role=\"measurement-line\" x1=\"{x0}\" y1=\"{y0}\" x2=\"{x1}\" y2=\"{y1}\" stroke=\"#63c6cf\" stroke-width=\"{}\"/><line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"#63c6cf\" stroke-width=\"{}\"/><line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"#63c6cf\" stroke-width=\"{}\"/><circle cx=\"{x0}\" cy=\"{y0}\" r=\"{}\" fill=\"#63c6cf\"/><circle cx=\"{x1}\" cy=\"{y1}\" r=\"{}\" fill=\"#63c6cf\"/><rect x=\"{}\" y=\"{}\" width=\"{label_width}\" height=\"{label_height}\" rx=\"{}\" fill=\"#10171a\" stroke=\"#63c6cf\" stroke-width=\"{}\"/><text data-role=\"measurement-label\" x=\"{label_x}\" y=\"{}\" fill=\"#eafcfd\" text-anchor=\"middle\" font-family=\"ui-monospace,monospace\" font-size=\"{font_size}\" font-weight=\"700\">{}</text></g>",
            (font_size * 0.12).max(0.012),
            x0 - normal_x * tick,
            y0 - normal_y * tick,
            x0 + normal_x * tick,
            y0 + normal_y * tick,
            (font_size * 0.09).max(0.01),
            x1 - normal_x * tick,
            y1 - normal_y * tick,
            x1 + normal_x * tick,
            y1 + normal_y * tick,
            (font_size * 0.09).max(0.01),
            (font_size * 0.18).max(0.025),
            (font_size * 0.18).max(0.025),
            label_x - label_width / 2.0,
            label_y - label_height * 0.72,
            font_size * 0.35,
            (font_size * 0.06).max(0.008),
            label_y + font_size * 0.34,
            html(&label),
        );
    }
    let (x0, y0) = project(anchor);
    let direction = if x0 < view_width * 0.62 { 1.0 } else { -1.0 };
    let label_x = (x0 + direction * view_width * 0.16)
        .clamp(label_width / 2.0, view_width - label_width / 2.0);
    let label_y = (y0 - view_height * 0.13).clamp(label_height, view_height - label_height * 0.3);
    format!(
        "<g data-role=\"measurement\"><path data-role=\"measurement-line\" d=\"M {x0} {y0} L {label_x} {label_y}\" fill=\"none\" stroke=\"#63c6cf\" stroke-width=\"{}\"/><circle cx=\"{x0}\" cy=\"{y0}\" r=\"{}\" fill=\"#63c6cf\"/><rect x=\"{}\" y=\"{}\" width=\"{label_width}\" height=\"{label_height}\" rx=\"{}\" fill=\"#10171a\" stroke=\"#63c6cf\" stroke-width=\"{}\"/><text data-role=\"measurement-label\" x=\"{label_x}\" y=\"{}\" fill=\"#eafcfd\" text-anchor=\"middle\" font-family=\"ui-monospace,monospace\" font-size=\"{font_size}\" font-weight=\"700\">{}</text></g>",
        (font_size * 0.12).max(0.012),
        (font_size * 0.2).max(0.025),
        label_x - label_width / 2.0,
        label_y - label_height * 0.72,
        font_size * 0.35,
        (font_size * 0.06).max(0.008),
        label_y + font_size * 0.34,
        html(&label),
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
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{color}\" fill-opacity=\"0.76\"/>",
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
            "<circle cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"#11191c\" stroke=\"{color}\" stroke-width=\"0.04\"/>",
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
            format!(
                "<polygon points=\"{points}\" fill=\"{color}\" fill-opacity=\"0.32\" stroke=\"{color}\" stroke-width=\"0.025\"/>"
            )
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

#[derive(Clone, Copy)]
struct RasterTransform {
    viewport: BoundsNm,
    width: u32,
    plot_top: u32,
    plot_height: u32,
}

impl RasterTransform {
    fn point(self, x: i64, y: i64) -> (i32, i32) {
        let px = ((x - self.viewport.min_x) as f64
            / (self.viewport.max_x - self.viewport.min_x).max(1) as f64
            * f64::from(self.width.saturating_sub(1)))
        .round();
        let py = ((self.viewport.max_y - y) as f64
            / (self.viewport.max_y - self.viewport.min_y).max(1) as f64
            * f64::from(self.plot_height.saturating_sub(1)))
        .round()
            + f64::from(self.plot_top);
        (px as i32, py as i32)
    }

    fn pixels_per_nm(self) -> f64 {
        f64::from(self.width.saturating_sub(1))
            / (self.viewport.max_x - self.viewport.min_x).max(1) as f64
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
        pixel.copy_from_slice(&[13, 18, 21, 255]);
    }
    let panel_height = evidence_panel_height(height);
    let transform = RasterTransform {
        viewport,
        width,
        plot_top: panel_height,
        plot_height: height.saturating_sub(panel_height).max(1),
    };
    let restrict_layers = !violation.layer_ids.is_empty()
        && design
            .layers
            .iter()
            .any(|layer| violation.layer_ids.contains(&layer.id));
    for layer in &design.layers {
        if restrict_layers && !violation.layer_ids.contains(&layer.id) {
            continue;
        }
        for feature in &layer.features {
            if !feature.geometry.bounds().intersects(viewport) {
                continue;
            }
            let color = if feature.polarity == Polarity::Clear {
                [76, 87, 82, 255]
            } else {
                [57, 79, 69, 255]
            };
            raster_geometry(
                &mut image,
                width,
                height,
                transform,
                &feature.geometry,
                color,
            );
        }
    }
    draw_raster_measurement(&mut image, width, height, transform, violation);
    let (marker_x, marker_y) = transform.point(violation.x_nm, violation.y_nm);
    let marker_color = verdict_raster_color(violation.verdict);
    draw_circle(
        &mut image,
        width,
        height,
        marker_x,
        marker_y,
        18,
        marker_color,
        false,
    );
    draw_line(
        &mut image,
        width,
        height,
        marker_x - 26,
        marker_y,
        marker_x + 26,
        marker_y,
        marker_color,
    );
    draw_line(
        &mut image,
        width,
        height,
        marker_x,
        marker_y - 26,
        marker_x,
        marker_y + 26,
        marker_color,
    );
    fill_rect(
        &mut image,
        width,
        height,
        0,
        0,
        width as i32 - 1,
        panel_height as i32 - 1,
        [24, 32, 37, 255],
    );
    fill_rect(
        &mut image,
        width,
        height,
        0,
        0,
        7,
        panel_height as i32 - 1,
        marker_color,
    );
    let scale = (width / 700).clamp(2, 5) as i32;
    let labels = evidence_labels(violation);
    draw_text(
        &mut image,
        width,
        height,
        22,
        16,
        &labels[0],
        scale,
        [243, 242, 237, 255],
    );
    draw_text(
        &mut image,
        width,
        height,
        22,
        16 + 10 * scale,
        &labels[1],
        scale,
        [155, 164, 168, 255],
    );
    draw_text(
        &mut image,
        width,
        height,
        22,
        16 + 20 * scale,
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

fn draw_raster_measurement(
    image: &mut [u8],
    width: u32,
    height: u32,
    transform: RasterTransform,
    violation: &Violation,
) {
    let Some(measured) = violation.measured_value_nm else {
        return;
    };
    let text = format_nm(measured);
    let color = [99, 198, 207, 255];
    let anchor = violation
        .evidence_points
        .first()
        .copied()
        .unwrap_or(PointNm {
            x: violation.x_nm,
            y: violation.y_nm,
        });
    let (x0, y0) = transform.point(anchor.x, anchor.y);
    if violation.evidence_points.len() >= 2 {
        let (x1, y1) = transform.point(
            violation.evidence_points[1].x,
            violation.evidence_points[1].y,
        );
        draw_thick_line(image, width, height, x0, y0, x1, y1, color);
        let dx = f64::from(x1 - x0);
        let dy = f64::from(y1 - y0);
        let length = dx.hypot(dy).max(1.0);
        let tick_x = (-dy / length * 9.0).round() as i32;
        let tick_y = (dx / length * 9.0).round() as i32;
        draw_thick_line(
            image,
            width,
            height,
            x0 - tick_x,
            y0 - tick_y,
            x0 + tick_x,
            y0 + tick_y,
            color,
        );
        draw_thick_line(
            image,
            width,
            height,
            x1 - tick_x,
            y1 - tick_y,
            x1 + tick_x,
            y1 + tick_y,
            color,
        );
        draw_circle(image, width, height, x0, y0, 5, color, true);
        draw_circle(image, width, height, x1, y1, 5, color, true);
        let label_x = (x0 + x1) / 2 + tick_x * 3;
        let label_y = (y0 + y1) / 2 + tick_y * 3;
        draw_raster_label(
            image,
            width,
            height,
            transform.plot_top,
            label_x,
            label_y,
            &text,
        );
        return;
    }
    let direction = if x0 < width as i32 * 2 / 3 { 1 } else { -1 };
    let label_x = x0 + direction * 120;
    let label_y = y0 - 64;
    draw_thick_line(image, width, height, x0, y0, label_x, label_y, color);
    draw_circle(image, width, height, x0, y0, 5, color, true);
    draw_raster_label(
        image,
        width,
        height,
        transform.plot_top,
        label_x,
        label_y,
        &text,
    );
}

fn draw_raster_label(
    image: &mut [u8],
    width: u32,
    height: u32,
    plot_top: u32,
    center_x: i32,
    center_y: i32,
    text: &str,
) {
    let scale = (width / 900).clamp(2, 4) as i32;
    let text_width = text.chars().count() as i32 * 6 * scale;
    let box_width = text_width + 20;
    let box_height = 7 * scale + 16;
    let x0 = (center_x - box_width / 2).clamp(6, width as i32 - box_width - 6);
    let y0 = (center_y - box_height / 2).clamp(plot_top as i32 + 6, height as i32 - box_height - 6);
    fill_rect(
        image,
        width,
        height,
        x0,
        y0,
        x0 + box_width,
        y0 + box_height,
        [15, 23, 26, 255],
    );
    draw_line(
        image,
        width,
        height,
        x0,
        y0,
        x0 + box_width,
        y0,
        [99, 198, 207, 255],
    );
    draw_line(
        image,
        width,
        height,
        x0,
        y0 + box_height,
        x0 + box_width,
        y0 + box_height,
        [99, 198, 207, 255],
    );
    draw_text(
        image,
        width,
        height,
        x0 + 10,
        y0 + 8,
        text,
        scale,
        [234, 252, 253, 255],
    );
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
            verdict_label(violation.verdict)
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
    transform: RasterTransform,
    geometry: &FeatureGeometry,
    color: [u8; 4],
) {
    match geometry {
        FeatureGeometry::Line { start, end, .. } | FeatureGeometry::Arc { start, end, .. } => {
            let (x0, y0) = transform.point(start.x, start.y);
            let (x1, y1) = transform.point(end.x, end.y);
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
            let (x0, y0) = transform.point(bounds.min_x, bounds.max_y);
            let (x1, y1) = transform.point(bounds.max_x, bounds.min_y);
            fill_rect(image, width, height, x0, y0, x1, y1, color);
        }
        FeatureGeometry::Drill {
            center,
            diameter_nm,
            ..
        } => {
            let (x, y) = transform.point(center.x, center.y);
            let radius = (*diameter_nm as f64 * transform.pixels_per_nm() / 2.0).round() as i32;
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
                let (x0, y0) = transform.point(pair[0].x, pair[0].y);
                let (x1, y1) = transform.point(pair[1].x, pair[1].y);
                draw_line(image, width, height, x0, y0, x1, y1, color);
            }
        }
        FeatureGeometry::ComponentBody { bounds } => {
            let (x0, y0) = transform.point(bounds.min_x, bounds.max_y);
            let (x1, y1) = transform.point(bounds.max_x, bounds.min_y);
            draw_line(image, width, height, x0, y0, x1, y0, color);
            draw_line(image, width, height, x1, y0, x1, y1, color);
            draw_line(image, width, height, x1, y1, x0, y1, color);
            draw_line(image, width, height, x0, y1, x0, y0, color);
        }
    }
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
    let min_x = x0.min(x1);
    let max_x = x0.max(x1);
    let min_y = y0.min(y1);
    let max_y = y0.max(y1);
    if max_x < 0 || max_y < 0 || min_x >= width as i32 || min_y >= height as i32 {
        return;
    }
    let min_x = min_x.max(0);
    let max_x = max_x.min(width.saturating_sub(1) as i32);
    let min_y = min_y.max(0);
    let max_y = max_y.min(height.saturating_sub(1) as i32);
    for y in min_y..=max_y {
        for x in min_x..=max_x {
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

fn verdict_label(verdict: Verdict) -> &'static str {
    match verdict {
        Verdict::Pass => "PASS",
        Verdict::Fail => "FAIL",
        Verdict::Review => "REVIEW",
        Verdict::NotApplicable => "NOT_APPLICABLE",
    }
}

fn verdict_class(verdict: Verdict) -> &'static str {
    match verdict {
        Verdict::Pass => "status-pass",
        Verdict::Fail => "status-fail",
        Verdict::Review => "status-review",
        Verdict::NotApplicable => "status-not-applicable",
    }
}

fn verdict_svg_color(verdict: Verdict) -> &'static str {
    match verdict {
        Verdict::Pass => "#55b96d",
        Verdict::Review => "#d9a52a",
        Verdict::Fail => "#e26762",
        Verdict::NotApplicable => "#9aa4a9",
    }
}

fn verdict_raster_color(verdict: Verdict) -> [u8; 4] {
    match verdict {
        Verdict::Pass => [85, 185, 109, 255],
        Verdict::Review => [217, 165, 42, 255],
        Verdict::Fail => [226, 103, 98, 255],
        Verdict::NotApplicable => [154, 164, 169, 255],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        CoverageLevel, DesignFormat, Feature, Layer, SemanticCoverage, Severity, Side,
    };
    use std::collections::BTreeMap;

    fn sample_design() -> Design {
        let feature = |id: &str, layer_id: &str, center_x: i64| Feature {
            id: id.into(),
            layer_id: layer_id.into(),
            polarity: Polarity::Dark,
            geometry: FeatureGeometry::Pad {
                center: PointNm { x: center_x, y: 0 },
                size_x_nm: 620_000,
                size_y_nm: 620_000,
                rotation_deg: 0.0,
            },
            net_name: Some("VPH_PWR".into()),
            component_ref: Some("MTP2662".into()),
            pin: None,
            attributes: BTreeMap::new(),
            source: "fixture".into(),
        };
        Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "design<&>".into(),
            format: DesignFormat::Odbpp,
            source_path: "fixture/design.tgz".into(),
            content_hash: "design-hash".into(),
            bounds: BoundsNm {
                min_x: -5_000_000,
                min_y: -5_000_000,
                max_x: 5_000_000,
                max_y: 5_000_000,
            },
            layers: vec![
                Layer {
                    id: "target-layer".into(),
                    name: "Signal Top".into(),
                    function: "SIGNAL".into(),
                    side: Side::Top,
                    features: vec![feature("target-pad", "target-layer", 0)],
                },
                Layer {
                    id: "unrelated-layer".into(),
                    name: "Signal Bottom".into(),
                    function: "SIGNAL".into(),
                    side: Side::Bottom,
                    features: vec![feature("unrelated-pad", "unrelated-layer", 400_000)],
                },
            ],
            components: Vec::new(),
            nets: vec!["VPH_PWR".into()],
            test_points: Vec::new(),
            coverage: SemanticCoverage::default(),
            diagnostics: Vec::new(),
        }
    }

    fn sample_violation(id: &str, verdict: Verdict) -> Violation {
        Violation {
            id: id.into(),
            analysis_id: "analysis-1".into(),
            rule_id: format!("rule-{id}"),
            title: "Test-point diameter".into(),
            severity: Severity::Error,
            verdict,
            source_format: DesignFormat::Odbpp,
            semantic_confidence: CoverageLevel::Explicit,
            net_names: vec!["VPH_PWR".into()],
            component_refs: vec!["MTP2662".into()],
            layer_ids: vec!["target-layer".into()],
            entity_ids: vec!["target-pad".into()],
            x_nm: 0,
            y_nm: 0,
            measured_value_nm: Some(620_000),
            threshold_nm: Some(800_000),
            message: "Measured 0.620 mm is below 0.800 mm".into(),
            evidence_points: vec![PointNm { x: -310_000, y: 0 }, PointNm { x: 310_000, y: 0 }],
            evidence_uris: Vec::new(),
            rule_citation: None,
        }
    }

    fn sample_analysis() -> AnalysisSummary {
        AnalysisSummary {
            id: "analysis-1".into(),
            design_id: "design<&>".into(),
            rule_pack_id: "factory<&>-rules".into(),
            verdict: Verdict::Fail,
            pass_count: 1,
            fail_count: 1,
            review_count: 1,
            not_applicable_count: 1,
            violations: vec![
                sample_violation("pass", Verdict::Pass),
                sample_violation("review", Verdict::Review),
                sample_violation("fail", Verdict::Fail),
                sample_violation("na", Verdict::NotApplicable),
            ],
            report_uri: "circuit://analysis/analysis-1/report".into(),
            elapsed_ms: 12,
        }
    }

    #[test]
    fn viewport_contains_measurement_and_preserves_plot_aspect() {
        let mut violation = sample_violation("distance", Verdict::Fail);
        violation.evidence_points = vec![
            PointNm {
                x: -8_000_000,
                y: -1_000_000,
            },
            PointNm {
                x: 12_000_000,
                y: 2_000_000,
            },
        ];
        let viewport = evidence_viewport(&violation, 1600, 1200);
        for point in &violation.evidence_points {
            assert!(viewport.min_x <= point.x && point.x <= viewport.max_x);
            assert!(viewport.min_y <= point.y && point.y <= viewport.max_y);
        }
        let actual =
            (viewport.max_x - viewport.min_x) as f64 / (viewport.max_y - viewport.min_y) as f64;
        assert!((actual - evidence_plot_aspect(1600, 1200)).abs() < 0.000_001);
    }

    #[test]
    fn svg_focuses_relevant_layer_and_labels_measurement() {
        let design = sample_design();
        let violation = sample_violation("diameter", Verdict::Fail);
        let viewport = evidence_viewport(&violation, 1600, 1200);
        let svg = render_svg(&design, &violation, viewport, 1600, 1200);
        assert!(svg.contains("data-layer-id=\"target-layer\""));
        assert!(!svg.contains("data-layer-id=\"unrelated-layer\""));
        assert!(svg.contains("data-role=\"measurement-line\""));
        assert!(svg.contains("data-role=\"measurement-label\""));
        assert!(svg.contains(">0.620 MM</text>"));
    }

    #[test]
    fn svg_falls_back_to_all_layers_when_violation_layer_is_unknown() {
        let design = sample_design();
        let mut violation = sample_violation("diameter", Verdict::Fail);
        violation.layer_ids = vec!["missing-layer".into()];
        violation.evidence_points = vec![PointNm { x: 0, y: 0 }];
        let viewport = evidence_viewport(&violation, 1600, 1200);
        let svg = render_svg(&design, &violation, viewport, 1600, 1200);
        assert!(svg.contains("data-layer-id=\"target-layer\""));
        assert!(svg.contains("data-layer-id=\"unrelated-layer\""));
        assert!(svg.contains("data-role=\"measurement-label\""));
    }

    #[test]
    fn render_evidence_writes_svg_and_png_at_requested_size() {
        let directory = tempfile::tempdir().unwrap();
        let cache = CacheStore::new(directory.path()).unwrap();
        let design = sample_design();
        let mut violation = sample_violation("diameter", Verdict::Fail);
        violation.evidence_points = vec![PointNm { x: 0, y: 0 }];
        let analysis = AnalysisSummary {
            violations: vec![violation],
            ..sample_analysis()
        };
        let evidence = render_evidence(&cache, &design, &analysis, &[], 800, 600).unwrap();
        assert_eq!(evidence.len(), 1);
        let svg = fs::read_to_string(&evidence[0].svg_path).unwrap();
        assert!(svg.contains("data-role=\"measurement-label\""));
        let decoder = png::Decoder::new(std::io::BufReader::new(
            File::open(&evidence[0].png_path).unwrap(),
        ));
        let reader = decoder.read_info().unwrap();
        assert_eq!(reader.info().width, 800);
        assert_eq!(reader.info().height, 600);
    }

    #[test]
    fn report_colors_entire_rows_by_verdict_and_escapes_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let cache = CacheStore::new(directory.path()).unwrap();
        let report = write_html_report(&cache, &sample_design(), &sample_analysis()).unwrap();
        let html = fs::read_to_string(report).unwrap();
        for status in ["pass", "review", "fail", "not-applicable"] {
            assert!(html.contains(&format!("class=\"finding-row status-{status}\"")));
            assert!(html.contains(&format!(".finding-row.status-{status} td {{ background:")));
        }
        assert!(html.contains("design&lt;&amp;&gt;"));
        assert!(html.contains("factory&lt;&amp;&gt;-rules"));
        assert!(html.contains("font-family: -apple-system"));
        assert!(html.contains("print-color-adjust: exact"));
    }
}
