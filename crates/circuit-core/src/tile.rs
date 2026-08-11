use crate::CoreResult;
use crate::cache::CacheStore;
use crate::model::{BoundsNm, Design, FeatureGeometry, PointNm, Polarity, TileDescriptor};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;

pub fn cached_tile(
    cache: &CacheStore,
    design_id: &str,
    viewport: BoundsNm,
    layer_ids: &[String],
    lod: u8,
    max_features: usize,
) -> CoreResult<Option<TileDescriptor>> {
    let key = tile_cache_key(viewport, layer_ids, lod, max_features)?;
    let path = cache.tile_path(design_id, &key[..16]);
    if !path.exists() {
        return Ok(None);
    }
    let mut header = [0_u8; 10];
    let valid_header = fs::File::open(&path)
        .and_then(|mut file| file.read_exact(&mut header))
        .is_ok()
        && &header[..4] == b"CITL"
        && u16::from_le_bytes(header[4..6].try_into().unwrap()) == 1;
    let feature_count = u32::from_le_bytes(header[6..10].try_into().unwrap()) as usize;
    let valid_length = fs::metadata(&path).is_ok_and(|metadata| {
        metadata.len() >= (42_usize.saturating_add(feature_count.saturating_mul(24))) as u64
    });
    if !valid_header || !valid_length {
        return Ok(None);
    }
    Ok(Some(TileDescriptor {
        path: path.display().to_string(),
        feature_count,
        bounds: viewport,
        lod,
    }))
}

fn tile_cache_key(
    viewport: BoundsNm,
    layer_ids: &[String],
    lod: u8,
    max_features: usize,
) -> CoreResult<String> {
    let mut canonical_layers = layer_ids.to_vec();
    canonical_layers.sort();
    canonical_layers.dedup();
    let mut key_hash = Sha256::new();
    key_hash.update(b"tile-selection-v4-shared-design-cache");
    key_hash.update(Design::SCHEMA_VERSION.to_le_bytes());
    key_hash.update(serde_json::to_vec(&(
        viewport,
        canonical_layers,
        lod,
        max_features,
    ))?);
    Ok(hex::encode(key_hash.finalize()))
}

pub fn write_tile(
    cache: &CacheStore,
    design: &Design,
    viewport: BoundsNm,
    layer_ids: &[String],
    lod: u8,
    max_features: usize,
) -> CoreResult<TileDescriptor> {
    if let Some(tile) = cached_tile(cache, &design.id, viewport, layer_ids, lod, max_features)? {
        return Ok(tile);
    }
    let key = tile_cache_key(viewport, layer_ids, lod, max_features)?;
    let path = cache.tile_path(&design.id, &key[..16]);

    let mut records = Vec::<TileRecord>::new();
    let layer_filter =
        |id: &str| layer_ids.is_empty() || layer_ids.iter().any(|candidate| candidate == id);
    for (layer_index, layer) in design.layers.iter().enumerate().filter(|(_, layer)| {
        layer_filter(&layer.id) && layer.function.to_ascii_uppercase().contains("COMPONENT")
    }) {
        for component in design.components.iter().filter(|component| {
            component.side == layer.side && component.bounds.intersects(viewport)
        }) {
            append_geometry(
                &mut records,
                &FeatureGeometry::ComponentBody {
                    bounds: component.bounds,
                },
                Polarity::Dark,
                layer_index.min(u16::MAX as usize) as u16,
                lod,
            );
            if records.len() >= max_features {
                break;
            }
        }
        if records.len() >= max_features {
            break;
        }
    }
    let mut cursors = design
        .layers
        .iter()
        .enumerate()
        .filter(|(_, layer)| layer_filter(&layer.id))
        .map(|(layer_index, layer)| (layer_index, layer, 0_usize))
        .collect::<Vec<_>>();
    while records.len() < max_features {
        let mut progressed = false;
        for (layer_index, layer, cursor) in &mut cursors {
            let feature = loop {
                let Some(candidate) = layer.features.get(*cursor) else {
                    break None;
                };
                *cursor += 1;
                if candidate.geometry.bounds().intersects(viewport) {
                    break Some(candidate);
                }
            };
            let Some(feature) = feature else { continue };
            progressed = true;
            append_geometry(
                &mut records,
                &feature.geometry,
                feature.polarity,
                (*layer_index).min(u16::MAX as usize) as u16,
                lod,
            );
            if records.len() >= max_features {
                break;
            }
        }
        if !progressed {
            break;
        }
    }
    records.truncate(max_features);

    let mut bytes = Vec::with_capacity(42 + records.len() * TileRecord::BYTE_LEN);
    bytes.extend_from_slice(b"CITL");
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&(records.len() as u32).to_le_bytes());
    for value in [
        viewport.min_x,
        viewport.min_y,
        viewport.max_x,
        viewport.max_y,
    ] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    for record in &records {
        record.write(&mut bytes);
    }
    fs::write(&path, bytes)?;
    Ok(TileDescriptor {
        path: path.display().to_string(),
        feature_count: records.len(),
        bounds: viewport,
        lod,
    })
}

#[derive(Debug, Clone, Copy)]
struct TileRecord {
    kind: u8,
    polarity: u8,
    layer: u16,
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    width: f32,
}

impl TileRecord {
    const BYTE_LEN: usize = 24;

    fn write(self, bytes: &mut Vec<u8>) {
        bytes.push(self.kind);
        bytes.push(self.polarity);
        bytes.extend_from_slice(&self.layer.to_le_bytes());
        for value in [self.x1, self.y1, self.x2, self.y2, self.width] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
}

fn append_geometry(
    records: &mut Vec<TileRecord>,
    geometry: &FeatureGeometry,
    polarity: Polarity,
    layer: u16,
    lod: u8,
) {
    let polarity = u8::from(matches!(polarity, Polarity::Clear));
    let mm = |value: i64| (value as f64 / 1_000_000.0) as f32;
    match geometry {
        FeatureGeometry::Line {
            start,
            end,
            width_nm,
        } => records.push(TileRecord {
            kind: 1,
            polarity,
            layer,
            x1: mm(start.x),
            y1: mm(start.y),
            x2: mm(end.x),
            y2: mm(end.y),
            width: mm(*width_nm),
        }),
        FeatureGeometry::Arc {
            start,
            end,
            center,
            clockwise,
            width_nm,
        } => {
            let radius = ((start.distance_sq(*center) as f64).sqrt() / 1_000_000.0) as f32;
            let start_angle = ((start.y - center.y) as f64).atan2((start.x - center.x) as f64);
            let mut end_angle = ((end.y - center.y) as f64).atan2((end.x - center.x) as f64);
            let mut sweep = end_angle - start_angle;
            if *clockwise && sweep > 0.0 {
                sweep -= std::f64::consts::TAU;
            } else if !*clockwise && sweep < 0.0 {
                sweep += std::f64::consts::TAU;
            }
            end_angle = start_angle + sweep;
            let segments = ((sweep.abs() * f64::from(radius).sqrt()) as usize)
                .clamp(4, if lod > 1 { 24 } else { 96 });
            let mut previous = *start;
            for index in 1..=segments {
                let ratio = index as f64 / segments as f64;
                let angle = start_angle + (end_angle - start_angle) * ratio;
                let next = PointNm {
                    x: center.x + (angle.cos() * f64::from(radius) * 1_000_000.0).round() as i64,
                    y: center.y + (angle.sin() * f64::from(radius) * 1_000_000.0).round() as i64,
                };
                append_geometry(
                    records,
                    &FeatureGeometry::Line {
                        start: previous,
                        end: next,
                        width_nm: *width_nm,
                    },
                    if polarity == 1 {
                        Polarity::Clear
                    } else {
                        Polarity::Dark
                    },
                    layer,
                    lod,
                );
                previous = next;
            }
        }
        FeatureGeometry::Pad {
            center,
            size_x_nm,
            size_y_nm,
            ..
        } => records.push(TileRecord {
            kind: 2,
            polarity,
            layer,
            x1: mm(center.x),
            y1: mm(center.y),
            x2: mm(*size_x_nm),
            y2: mm(*size_y_nm),
            width: 0.0,
        }),
        FeatureGeometry::Drill {
            center,
            diameter_nm,
            ..
        } => records.push(TileRecord {
            kind: 3,
            polarity,
            layer,
            x1: mm(center.x),
            y1: mm(center.y),
            x2: mm(*diameter_nm),
            y2: mm(*diameter_nm),
            width: 0.0,
        }),
        FeatureGeometry::Region { points } => {
            for pair in points.windows(2) {
                append_geometry(
                    records,
                    &FeatureGeometry::Line {
                        start: pair[0],
                        end: pair[1],
                        width_nm: 20_000,
                    },
                    if polarity == 1 {
                        Polarity::Clear
                    } else {
                        Polarity::Dark
                    },
                    layer,
                    lod,
                );
            }
            if let (Some(first), Some(last)) = (points.first(), points.last()) {
                append_geometry(
                    records,
                    &FeatureGeometry::Line {
                        start: *last,
                        end: *first,
                        width_nm: 20_000,
                    },
                    if polarity == 1 {
                        Polarity::Clear
                    } else {
                        Polarity::Dark
                    },
                    layer,
                    lod,
                );
            }
        }
        FeatureGeometry::ComponentBody { bounds } => records.push(TileRecord {
            kind: 4,
            polarity,
            layer,
            x1: mm(bounds.min_x),
            y1: mm(bounds.min_y),
            x2: mm(bounds.max_x),
            y2: mm(bounds.max_y),
            width: 0.0,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        Component, CoverageLevel, DesignFormat, Feature, Layer, SemanticCoverage, Side,
    };
    use std::collections::BTreeMap;

    #[test]
    fn record_has_stable_binary_size() {
        let mut bytes = Vec::new();
        TileRecord {
            kind: 1,
            polarity: 0,
            layer: 0,
            x1: 0.0,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
            width: 0.1,
        }
        .write(&mut bytes);
        assert_eq!(bytes.len(), TileRecord::BYTE_LEN);
    }

    #[test]
    fn feature_limit_is_shared_across_enabled_layers() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = CacheStore::new(temporary.path()).unwrap();
        let feature = |id: &str, layer_id: &str, x: i64| Feature {
            id: id.into(),
            layer_id: layer_id.into(),
            polarity: Polarity::Dark,
            geometry: FeatureGeometry::Pad {
                center: PointNm { x, y: 1_000_000 },
                size_x_nm: 100_000,
                size_y_nm: 100_000,
                rotation_deg: 0.0,
            },
            net_name: None,
            component_ref: None,
            pin: None,
            attributes: BTreeMap::new(),
            source: "fixture".into(),
        };
        let design = Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "fair-layers".into(),
            format: DesignFormat::Odbpp,
            source_path: "fixture".into(),
            content_hash: "hash".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 10_000_000,
                max_y: 10_000_000,
            },
            layers: vec![
                Layer {
                    id: "a".into(),
                    name: "a".into(),
                    function: "SIGNAL".into(),
                    side: Side::Top,
                    features: vec![feature("a1", "a", 1_000_000), feature("a2", "a", 2_000_000)],
                },
                Layer {
                    id: "b".into(),
                    name: "b".into(),
                    function: "DRILL".into(),
                    side: Side::Inner,
                    features: vec![feature("b1", "b", 3_000_000)],
                },
            ],
            components: Vec::new(),
            nets: Vec::new(),
            test_points: Vec::new(),
            coverage: SemanticCoverage {
                layers: CoverageLevel::Explicit,
                ..Default::default()
            },
            diagnostics: Vec::new(),
        };
        let tile = write_tile(&cache, &design, design.bounds, &[], 0, 2).unwrap();
        let bytes = fs::read(&tile.path).unwrap();
        assert_eq!(u16::from_le_bytes(bytes[44..46].try_into().unwrap()), 0);
        assert_eq!(u16::from_le_bytes(bytes[68..70].try_into().unwrap()), 1);
    }

    #[test]
    fn selected_component_layers_emit_package_bodies() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = CacheStore::new(temporary.path()).unwrap();
        let bounds = BoundsNm {
            min_x: 0,
            min_y: 0,
            max_x: 10_000_000,
            max_y: 10_000_000,
        };
        let design = Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "component-bodies".into(),
            format: DesignFormat::Odbpp,
            source_path: "fixture".into(),
            content_hash: "hash".into(),
            bounds,
            layers: vec![Layer {
                id: "top-components".into(),
                name: "top-components".into(),
                function: "COMPONENT".into(),
                side: Side::Top,
                features: Vec::new(),
            }],
            components: vec![Component {
                refdes: "U1".into(),
                package_name: None,
                center: PointNm {
                    x: 5_000_000,
                    y: 5_000_000,
                },
                bounds: BoundsNm {
                    min_x: 4_000_000,
                    min_y: 4_000_000,
                    max_x: 6_000_000,
                    max_y: 6_000_000,
                },
                side: Side::Top,
                pins: Vec::new(),
                confidence: CoverageLevel::Explicit,
            }],
            nets: Vec::new(),
            test_points: Vec::new(),
            coverage: SemanticCoverage::default(),
            diagnostics: Vec::new(),
        };

        let tile = write_tile(&cache, &design, bounds, &["top-components".into()], 0, 10).unwrap();
        let bytes = fs::read(&tile.path).unwrap();
        assert_eq!(tile.feature_count, 1);
        assert_eq!(bytes[42], 4);
        assert_eq!(u16::from_le_bytes(bytes[44..46].try_into().unwrap()), 0);

        let canonical = write_tile(
            &cache,
            &design,
            bounds,
            &["top-components".into(), "top-components".into()],
            0,
            10,
        )
        .unwrap();
        assert_eq!(canonical.path, tile.path);
    }
}
