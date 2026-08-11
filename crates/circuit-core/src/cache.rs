use crate::model::{AnalysisSummary, Design};
use crate::{CoreError, CoreResult};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

const MEMORY_DESIGN_LIMIT: usize = 2;

struct CachedDesign {
    path: PathBuf,
    design: Arc<Design>,
}

fn design_memory_cache() -> &'static Mutex<VecDeque<CachedDesign>> {
    static CACHE: OnceLock<Mutex<VecDeque<CachedDesign>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(VecDeque::new()))
}

#[derive(Debug, Clone)]
pub struct CacheStore {
    root: PathBuf,
}

impl CacheStore {
    pub fn new(root: impl Into<PathBuf>) -> CoreResult<Self> {
        let root = root.into();
        fs::create_dir_all(root.join("designs"))?;
        fs::create_dir_all(root.join("analyses"))?;
        fs::create_dir_all(root.join("evidence"))?;
        fs::create_dir_all(root.join("tiles"))?;
        fs::create_dir_all(root.join("rules"))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn design_path(&self, id: &str) -> PathBuf {
        self.root
            .join("designs")
            .join(format!("{}.json", safe_segment(id)))
    }

    pub fn analysis_path(&self, id: &str) -> PathBuf {
        self.root
            .join("analyses")
            .join(format!("{}.json", safe_segment(id)))
    }

    pub fn evidence_dir(&self, analysis_id: &str) -> PathBuf {
        self.root.join("evidence").join(safe_segment(analysis_id))
    }

    pub fn tile_path(&self, design_id: &str, tile_key: &str) -> PathBuf {
        self.root.join("tiles").join(format!(
            "{}-{}.citl",
            safe_segment(design_id),
            safe_segment(tile_key)
        ))
    }

    pub fn load_design(&self, id: &str) -> CoreResult<Design> {
        let design: Design = self.load_json(&self.design_path(id))?;
        validate_design_schema(id, &design)?;
        Ok(design)
    }

    pub fn load_design_shared(&self, id: &str) -> CoreResult<Arc<Design>> {
        let path = self.design_path(id);
        {
            let cache = design_memory_cache()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(cached) = cache.iter().find(|cached| cached.path == path) {
                if path.exists() {
                    return Ok(Arc::clone(&cached.design));
                }
            }
        }
        let design: Design = self.load_json(&path)?;
        validate_design_schema(id, &design)?;
        let design = Arc::new(design);
        let mut cache = design_memory_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.retain(|cached| cached.path != path);
        cache.push_back(CachedDesign {
            path,
            design: Arc::clone(&design),
        });
        while cache.len() > MEMORY_DESIGN_LIMIT {
            cache.pop_front();
        }
        Ok(design)
    }

    pub fn save_design(&self, design: &Design) -> CoreResult<()> {
        let path = self.design_path(&design.id);
        self.save_json(&path, design)?;
        design_memory_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|cached| cached.path != path);
        Ok(())
    }

    pub fn load_analysis(&self, id: &str) -> CoreResult<AnalysisSummary> {
        self.load_json(&self.analysis_path(id))
    }

    pub fn save_analysis(&self, analysis: &AnalysisSummary) -> CoreResult<()> {
        self.save_json(&self.analysis_path(&analysis.id), analysis)
    }

    pub fn load_json<T: DeserializeOwned>(&self, path: &Path) -> CoreResult<T> {
        let bytes = fs::read(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                CoreError::NotFound(path.display().to_string())
            } else {
                CoreError::Io(error)
            }
        })?;
        serde_json::from_slice(&bytes).map_err(CoreError::from)
    }

    pub fn save_json<T: Serialize>(&self, path: &Path, value: &T) -> CoreResult<()> {
        let parent = path
            .parent()
            .ok_or_else(|| CoreError::Cache("cache path has no parent".into()))?;
        fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(
            ".{}.tmp",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
        let bytes = serde_json::to_vec(value)?;
        fs::write(&temporary, bytes)?;
        fs::rename(&temporary, path)?;
        Ok(())
    }
}

fn validate_design_schema(id: &str, design: &Design) -> CoreResult<()> {
    if design.schema_version != Design::SCHEMA_VERSION {
        return Err(CoreError::Cache(format!(
            "cached design {id} uses schema {}, current schema is {}; re-import the source design",
            design.schema_version,
            Design::SCHEMA_VERSION
        )));
    }
    Ok(())
}

fn safe_segment(value: &str) -> String {
    let safe = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
        })
        .take(128)
        .collect::<String>();
    if safe.is_empty() {
        "invalid".into()
    } else {
        safe
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BoundsNm, DesignFormat, SemanticCoverage};

    #[test]
    fn cache_ids_cannot_escape_the_cache_root() {
        let root = std::env::temp_dir().join("circuit-inspector-cache-path-test");
        let cache = CacheStore::new(&root).unwrap();
        let path = cache.analysis_path("../../outside");
        assert!(path.starts_with(root.join("analyses")));
        assert_eq!(path.file_name().unwrap(), "outside.json");
    }

    #[test]
    fn shared_design_load_reuses_parsed_data_and_save_invalidates_it() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = CacheStore::new(temporary.path()).unwrap();
        let mut design = Design {
            schema_version: Design::SCHEMA_VERSION,
            id: "shared-design".into(),
            format: DesignFormat::Odbpp,
            source_path: "fixture".into(),
            content_hash: "first".into(),
            bounds: BoundsNm {
                min_x: 0,
                min_y: 0,
                max_x: 1,
                max_y: 1,
            },
            layers: Vec::new(),
            components: Vec::new(),
            nets: Vec::new(),
            test_points: Vec::new(),
            coverage: SemanticCoverage::default(),
            diagnostics: Vec::new(),
        };
        cache.save_design(&design).unwrap();

        let first = cache.load_design_shared(&design.id).unwrap();
        let second = cache.load_design_shared(&design.id).unwrap();
        assert!(Arc::ptr_eq(&first, &second));

        design.content_hash = "second".into();
        cache.save_design(&design).unwrap();
        let updated = cache.load_design_shared(&design.id).unwrap();
        assert!(!Arc::ptr_eq(&first, &updated));
        assert_eq!(updated.content_hash, "second");
    }
}
