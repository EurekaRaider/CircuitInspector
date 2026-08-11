use crate::model::{BoundsNm, CoverageLevel, Design, FeatureGeometry, PointNm};

const ARC_TOLERANCE_NM: f64 = 1_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoardEdgeMeasurement {
    pub distance_nm: i64,
    pub entity_point: PointNm,
    pub edge_point: PointNm,
    pub confidence: CoverageLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoundsMeasurement {
    pub distance_nm: i64,
    pub circle_point: PointNm,
    pub bounds_point: PointNm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeMeasurement {
    pub distance_nm: i64,
    pub source_point: PointNm,
    pub target_point: PointNm,
}

#[derive(Debug, Clone, Copy)]
struct SegmentNm {
    start: PointNm,
    end: PointNm,
}

pub fn circle_to_board_edge(
    design: &Design,
    center: PointNm,
    radius_nm: i64,
) -> BoardEdgeMeasurement {
    let (segments, confidence) = board_edge_segments(design);
    let (center_distance_nm, edge_point) = segments
        .iter()
        .map(|segment| {
            let point = closest_point_on_segment(center, *segment);
            (distance(center, point), point)
        })
        .min_by_key(|(distance, _)| *distance)
        .unwrap_or((0, center));
    let entity_point = point_toward(center, edge_point, radius_nm.min(center_distance_nm));
    BoardEdgeMeasurement {
        distance_nm: center_distance_nm.saturating_sub(radius_nm).max(0),
        entity_point,
        edge_point,
        confidence,
    }
}

pub fn bounds_to_board_edge(design: &Design, bounds: BoundsNm) -> BoardEdgeMeasurement {
    let (segments, confidence) = board_edge_segments(design);
    let (distance_nm, entity_point, edge_point) = segments
        .iter()
        .map(|segment| bounds_to_segment(bounds, *segment))
        .min_by_key(|(distance, _, _)| *distance)
        .unwrap_or((0, bounds.center(), bounds.center()));
    BoardEdgeMeasurement {
        distance_nm,
        entity_point,
        edge_point,
        confidence,
    }
}

pub fn circle_to_bounds(center: PointNm, radius_nm: i64, bounds: BoundsNm) -> BoundsMeasurement {
    let bounds_point = PointNm {
        x: center.x.clamp(bounds.min_x, bounds.max_x),
        y: center.y.clamp(bounds.min_y, bounds.max_y),
    };
    let center_distance_nm = distance(center, bounds_point);
    BoundsMeasurement {
        distance_nm: center_distance_nm.saturating_sub(radius_nm).max(0),
        circle_point: point_toward(center, bounds_point, radius_nm.min(center_distance_nm)),
        bounds_point,
    }
}

pub fn bounds_to_bounds(source: BoundsNm, target: BoundsNm) -> EdgeMeasurement {
    let (source_x, target_x) =
        axis_edge_points(source.min_x, source.max_x, target.min_x, target.max_x);
    let (source_y, target_y) =
        axis_edge_points(source.min_y, source.max_y, target.min_y, target.max_y);
    let source_point = PointNm {
        x: source_x,
        y: source_y,
    };
    let target_point = PointNm {
        x: target_x,
        y: target_y,
    };
    EdgeMeasurement {
        distance_nm: distance(source_point, target_point),
        source_point,
        target_point,
    }
}

pub fn circle_to_geometry(
    center: PointNm,
    radius_nm: i64,
    geometry: &FeatureGeometry,
) -> EdgeMeasurement {
    match geometry {
        FeatureGeometry::Pad { .. } | FeatureGeometry::ComponentBody { .. } => {
            let measurement = circle_to_bounds(center, radius_nm, geometry.bounds());
            EdgeMeasurement {
                distance_nm: measurement.distance_nm,
                source_point: measurement.circle_point,
                target_point: measurement.bounds_point,
            }
        }
        FeatureGeometry::Drill {
            center: target,
            diameter_nm,
            ..
        } => circle_to_circle(center, radius_nm, *target, diameter_nm / 2),
        FeatureGeometry::Line {
            start,
            end,
            width_nm,
        } => circle_to_segments(
            center,
            radius_nm,
            &[SegmentNm {
                start: *start,
                end: *end,
            }],
            width_nm / 2,
            false,
        ),
        FeatureGeometry::Arc {
            start,
            end,
            center: arc_center,
            clockwise,
            width_nm,
        } => {
            let mut segments = Vec::new();
            append_arc_segments(&mut segments, *start, *end, *arc_center, *clockwise);
            circle_to_segments(center, radius_nm, &segments, width_nm / 2, false)
        }
        FeatureGeometry::Region { points } => {
            let mut segments = Vec::new();
            append_geometry_segments(&mut segments, geometry);
            circle_to_segments(
                center,
                radius_nm,
                &segments,
                0,
                point_in_polygon(center, points),
            )
        }
    }
}

pub fn bounds_to_geometry(bounds: BoundsNm, geometry: &FeatureGeometry) -> EdgeMeasurement {
    match geometry {
        FeatureGeometry::Pad { .. } | FeatureGeometry::ComponentBody { .. } => {
            bounds_to_bounds(bounds, geometry.bounds())
        }
        FeatureGeometry::Drill {
            center,
            diameter_nm,
            ..
        } => {
            let measurement = circle_to_bounds(*center, diameter_nm / 2, bounds);
            EdgeMeasurement {
                distance_nm: measurement.distance_nm,
                source_point: measurement.bounds_point,
                target_point: measurement.circle_point,
            }
        }
        FeatureGeometry::Line {
            start,
            end,
            width_nm,
        } => bounds_to_segments(
            bounds,
            &[SegmentNm {
                start: *start,
                end: *end,
            }],
            width_nm / 2,
            false,
        ),
        FeatureGeometry::Arc {
            start,
            end,
            center,
            clockwise,
            width_nm,
        } => {
            let mut segments = Vec::new();
            append_arc_segments(&mut segments, *start, *end, *center, *clockwise);
            bounds_to_segments(bounds, &segments, width_nm / 2, false)
        }
        FeatureGeometry::Region { points } => {
            let mut segments = Vec::new();
            append_geometry_segments(&mut segments, geometry);
            let overlaps = point_in_polygon(bounds.center(), points)
                || points.iter().any(|point| point_in_bounds(*point, bounds));
            bounds_to_segments(bounds, &segments, 0, overlaps)
        }
    }
}

fn axis_edge_points(
    source_min: i64,
    source_max: i64,
    target_min: i64,
    target_max: i64,
) -> (i64, i64) {
    if source_max < target_min {
        (source_max, target_min)
    } else if target_max < source_min {
        (source_min, target_max)
    } else {
        let overlap_min = source_min.max(target_min);
        let overlap_max = source_max.min(target_max);
        let midpoint = overlap_min.saturating_add((overlap_max - overlap_min) / 2);
        (midpoint, midpoint)
    }
}

fn circle_to_circle(
    source_center: PointNm,
    source_radius_nm: i64,
    target_center: PointNm,
    target_radius_nm: i64,
) -> EdgeMeasurement {
    let center_distance_nm = distance(source_center, target_center);
    EdgeMeasurement {
        distance_nm: center_distance_nm
            .saturating_sub(source_radius_nm)
            .saturating_sub(target_radius_nm)
            .max(0),
        source_point: point_toward(
            source_center,
            target_center,
            source_radius_nm.min(center_distance_nm),
        ),
        target_point: point_toward(
            target_center,
            source_center,
            target_radius_nm.min(center_distance_nm),
        ),
    }
}

fn circle_to_segments(
    center: PointNm,
    radius_nm: i64,
    segments: &[SegmentNm],
    target_radius_nm: i64,
    overlaps_area: bool,
) -> EdgeMeasurement {
    if overlaps_area {
        return EdgeMeasurement {
            distance_nm: 0,
            source_point: center,
            target_point: center,
        };
    }
    let (center_distance_nm, centerline_point) = segments
        .iter()
        .map(|segment| {
            let point = closest_point_on_segment(center, *segment);
            (distance(center, point), point)
        })
        .min_by_key(|(distance, _)| *distance)
        .unwrap_or((0, center));
    EdgeMeasurement {
        distance_nm: center_distance_nm
            .saturating_sub(radius_nm)
            .saturating_sub(target_radius_nm)
            .max(0),
        source_point: point_toward(center, centerline_point, radius_nm.min(center_distance_nm)),
        target_point: point_toward(
            centerline_point,
            center,
            target_radius_nm.min(center_distance_nm),
        ),
    }
}

fn bounds_to_segments(
    bounds: BoundsNm,
    segments: &[SegmentNm],
    target_radius_nm: i64,
    overlaps_area: bool,
) -> EdgeMeasurement {
    if overlaps_area {
        let point = bounds.center();
        return EdgeMeasurement {
            distance_nm: 0,
            source_point: point,
            target_point: point,
        };
    }
    let (centerline_distance_nm, source_point, centerline_point) = segments
        .iter()
        .map(|segment| bounds_to_segment(bounds, *segment))
        .min_by_key(|(distance, _, _)| *distance)
        .unwrap_or((0, bounds.center(), bounds.center()));
    EdgeMeasurement {
        distance_nm: centerline_distance_nm
            .saturating_sub(target_radius_nm)
            .max(0),
        source_point,
        target_point: point_toward(
            centerline_point,
            source_point,
            target_radius_nm.min(centerline_distance_nm),
        ),
    }
}

fn point_in_polygon(point: PointNm, polygon: &[PointNm]) -> bool {
    if polygon.len() < 3 {
        return false;
    }
    let mut inside = false;
    let mut previous = polygon[polygon.len() - 1];
    for current in polygon {
        let crosses = (current.y > point.y) != (previous.y > point.y)
            && (point.x as f64)
                < (previous.x - current.x) as f64 * (point.y - current.y) as f64
                    / (previous.y - current.y) as f64
                    + current.x as f64;
        if crosses {
            inside = !inside;
        }
        previous = *current;
    }
    inside
}

fn board_edge_segments(design: &Design) -> (Vec<SegmentNm>, CoverageLevel) {
    let mut segments = Vec::new();
    for layer in &design.layers {
        if !layer.function.to_ascii_uppercase().contains("PROFILE")
            && !layer.name.eq_ignore_ascii_case("profile")
        {
            continue;
        }
        for feature in &layer.features {
            append_geometry_segments(&mut segments, &feature.geometry);
        }
    }
    if segments.is_empty() {
        append_bounds_segments(&mut segments, design.bounds);
        (segments, CoverageLevel::Inferred)
    } else {
        (segments, CoverageLevel::Explicit)
    }
}

fn append_geometry_segments(segments: &mut Vec<SegmentNm>, geometry: &FeatureGeometry) {
    match geometry {
        FeatureGeometry::Line { start, end, .. } => segments.push(SegmentNm {
            start: *start,
            end: *end,
        }),
        FeatureGeometry::Arc {
            start,
            end,
            center,
            clockwise,
            ..
        } => append_arc_segments(segments, *start, *end, *center, *clockwise),
        FeatureGeometry::Region { points } => {
            for pair in points.windows(2) {
                segments.push(SegmentNm {
                    start: pair[0],
                    end: pair[1],
                });
            }
            if let (Some(first), Some(last)) = (points.first(), points.last()) {
                if first != last {
                    segments.push(SegmentNm {
                        start: *last,
                        end: *first,
                    });
                }
            }
        }
        _ => {}
    }
}

fn append_arc_segments(
    segments: &mut Vec<SegmentNm>,
    start: PointNm,
    end: PointNm,
    center: PointNm,
    clockwise: bool,
) {
    let radius = distance(start, center) as f64;
    if radius <= f64::EPSILON {
        return;
    }
    let start_angle = ((start.y - center.y) as f64).atan2((start.x - center.x) as f64);
    let end_angle = ((end.y - center.y) as f64).atan2((end.x - center.x) as f64);
    let mut sweep = end_angle - start_angle;
    if clockwise && sweep >= 0.0 {
        sweep -= std::f64::consts::TAU;
    } else if !clockwise && sweep <= 0.0 {
        sweep += std::f64::consts::TAU;
    }
    let max_angle = if radius <= ARC_TOLERANCE_NM {
        std::f64::consts::FRAC_PI_2
    } else {
        (2.0 * (1.0 - ARC_TOLERANCE_NM / radius).acos()).max(0.001)
    };
    let count = (sweep.abs() / max_angle).ceil().clamp(1.0, 4096.0) as usize;
    let mut previous = start;
    for index in 1..=count {
        let angle = start_angle + sweep * index as f64 / count as f64;
        let next = if index == count {
            end
        } else {
            PointNm {
                x: center.x + (angle.cos() * radius).round() as i64,
                y: center.y + (angle.sin() * radius).round() as i64,
            }
        };
        segments.push(SegmentNm {
            start: previous,
            end: next,
        });
        previous = next;
    }
}

fn append_bounds_segments(segments: &mut Vec<SegmentNm>, bounds: BoundsNm) {
    let corners = [
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
    ];
    for index in 0..corners.len() {
        segments.push(SegmentNm {
            start: corners[index],
            end: corners[(index + 1) % corners.len()],
        });
    }
}

fn bounds_to_segment(bounds: BoundsNm, segment: SegmentNm) -> (i64, PointNm, PointNm) {
    if point_in_bounds(segment.start, bounds) {
        return (0, segment.start, segment.start);
    }
    if point_in_bounds(segment.end, bounds) {
        return (0, segment.end, segment.end);
    }
    let corners = [
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
    ];
    let edges = [
        SegmentNm {
            start: corners[0],
            end: corners[1],
        },
        SegmentNm {
            start: corners[1],
            end: corners[2],
        },
        SegmentNm {
            start: corners[2],
            end: corners[3],
        },
        SegmentNm {
            start: corners[3],
            end: corners[0],
        },
    ];
    for edge in edges {
        if let Some(point) = segment_intersection(segment, edge) {
            return (0, point, point);
        }
    }

    let mut candidates = Vec::with_capacity(6);
    for corner in corners {
        let edge_point = closest_point_on_segment(corner, segment);
        candidates.push((distance(corner, edge_point), corner, edge_point));
    }
    for edge_point in [segment.start, segment.end] {
        let entity_point = closest_point_on_bounds(edge_point, bounds);
        candidates.push((distance(entity_point, edge_point), entity_point, edge_point));
    }
    candidates
        .into_iter()
        .min_by_key(|(distance, _, _)| *distance)
        .unwrap_or((0, bounds.center(), bounds.center()))
}

fn point_in_bounds(point: PointNm, bounds: BoundsNm) -> bool {
    point.x >= bounds.min_x
        && point.x <= bounds.max_x
        && point.y >= bounds.min_y
        && point.y <= bounds.max_y
}

fn closest_point_on_bounds(point: PointNm, bounds: BoundsNm) -> PointNm {
    PointNm {
        x: point.x.clamp(bounds.min_x, bounds.max_x),
        y: point.y.clamp(bounds.min_y, bounds.max_y),
    }
}

fn closest_point_on_segment(point: PointNm, segment: SegmentNm) -> PointNm {
    let dx = (segment.end.x - segment.start.x) as f64;
    let dy = (segment.end.y - segment.start.y) as f64;
    let denominator = dx * dx + dy * dy;
    if denominator <= f64::EPSILON {
        return segment.start;
    }
    let t = (((point.x - segment.start.x) as f64 * dx + (point.y - segment.start.y) as f64 * dy)
        / denominator)
        .clamp(0.0, 1.0);
    PointNm {
        x: segment.start.x + (dx * t).round() as i64,
        y: segment.start.y + (dy * t).round() as i64,
    }
}

fn segment_intersection(left: SegmentNm, right: SegmentNm) -> Option<PointNm> {
    let px = left.start.x as f64;
    let py = left.start.y as f64;
    let rx = (left.end.x - left.start.x) as f64;
    let ry = (left.end.y - left.start.y) as f64;
    let qx = right.start.x as f64;
    let qy = right.start.y as f64;
    let sx = (right.end.x - right.start.x) as f64;
    let sy = (right.end.y - right.start.y) as f64;
    let cross = rx * sy - ry * sx;
    if cross.abs() <= f64::EPSILON {
        return None;
    }
    let qpx = qx - px;
    let qpy = qy - py;
    let t = (qpx * sy - qpy * sx) / cross;
    let u = (qpx * ry - qpy * rx) / cross;
    if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
        Some(PointNm {
            x: (px + t * rx).round() as i64,
            y: (py + t * ry).round() as i64,
        })
    } else {
        None
    }
}

fn point_toward(start: PointNm, end: PointNm, distance_nm: i64) -> PointNm {
    let total = distance(start, end);
    if total == 0 || distance_nm == 0 {
        return start;
    }
    let ratio = distance_nm as f64 / total as f64;
    PointNm {
        x: start.x + ((end.x - start.x) as f64 * ratio).round() as i64,
        y: start.y + ((end.y - start.y) as f64 * ratio).round() as i64,
    }
}

fn distance(left: PointNm, right: PointNm) -> i64 {
    (left.distance_sq(right) as f64).sqrt().round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        Component, DesignFormat, Feature, Layer, Polarity, SemanticCoverage, Side, TestPoint,
    };
    use std::collections::BTreeMap;

    fn design_with_profile(points: Vec<PointNm>) -> Design {
        Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "profile".into(),
            format: DesignFormat::Odbpp,
            source_path: "fixture".into(),
            content_hash: "hash".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 20_000_000,
                max_y: 10_000_000,
            },
            layers: vec![Layer {
                id: "profile".into(),
                name: "profile".into(),
                function: "PROFILE".into(),
                side: Side::Na,
                features: vec![Feature {
                    id: "outline".into(),
                    layer_id: "profile".into(),
                    polarity: Polarity::Dark,
                    geometry: FeatureGeometry::Region { points },
                    net_name: None,
                    component_ref: None,
                    pin: None,
                    attributes: BTreeMap::new(),
                    source: "profile".into(),
                }],
            }],
            components: Vec::<Component>::new(),
            nets: Vec::new(),
            test_points: Vec::<TestPoint>::new(),
            coverage: SemanticCoverage::default(),
            diagnostics: Vec::new(),
        }
    }

    #[test]
    fn measures_circle_to_actual_irregular_profile() {
        let design = design_with_profile(vec![
            PointNm { x: 0, y: 0 },
            PointNm {
                x: 20_000_000,
                y: 0,
            },
            PointNm {
                x: 20_000_000,
                y: 10_000_000,
            },
            PointNm {
                x: 5_000_000,
                y: 10_000_000,
            },
            PointNm {
                x: 5_000_000,
                y: 5_000_000,
            },
            PointNm { x: 0, y: 5_000_000 },
        ]);
        let measurement = circle_to_board_edge(
            &design,
            PointNm {
                x: 6_000_000,
                y: 6_000_000,
            },
            200_000,
        );
        assert_eq!(measurement.distance_nm, 800_000);
        assert_eq!(measurement.edge_point.x, 5_000_000);
        assert_eq!(measurement.confidence, CoverageLevel::Explicit);
    }

    #[test]
    fn measures_component_body_to_profile() {
        let design = design_with_profile(vec![
            PointNm { x: 0, y: 0 },
            PointNm {
                x: 20_000_000,
                y: 0,
            },
            PointNm {
                x: 20_000_000,
                y: 10_000_000,
            },
            PointNm {
                x: 0,
                y: 10_000_000,
            },
        ]);
        let measurement = bounds_to_board_edge(
            &design,
            BoundsNm {
                min_x: 2_000_000,
                min_y: 3_000_000,
                max_x: 4_000_000,
                max_y: 5_000_000,
            },
        );
        assert_eq!(measurement.distance_nm, 2_000_000);
        assert_eq!(measurement.entity_point.x, 2_000_000);
        assert_eq!(measurement.edge_point.x, 0);
    }
}
