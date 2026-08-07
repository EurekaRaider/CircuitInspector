use crate::model::{AnalysisSummary, Design};
use crate::{CoreError, CoreResult};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::fs;
use std::path::{Path, PathBuf};

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
        self.load_json(&self.design_path(id))
    }

    pub fn save_design(&self, design: &Design) -> CoreResult<()> {
        self.save_json(&self.design_path(&design.id), design)
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

    #[test]
    fn cache_ids_cannot_escape_the_cache_root() {
        let root = std::env::temp_dir().join("circuit-inspector-cache-path-test");
        let cache = CacheStore::new(&root).unwrap();
        let path = cache.analysis_path("../../outside");
        assert!(path.starts_with(root.join("analyses")));
        assert_eq!(path.file_name().unwrap(), "outside.json");
    }
}
