mod drill;
mod gerber;
mod ipc356;
mod odb;

use crate::archive::prepare_input;
use crate::model::{Design, DesignFormat, Diagnostic, Severity};
use crate::{CoreError, CoreResult};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub use gerber::parse_gerber_text;

pub fn import_design(source: &Path) -> CoreResult<Design> {
    let prepared = prepare_input(source)?;
    let files = collect_files(&prepared.root);
    if files.is_empty() {
        return Err(CoreError::InvalidInput("input contains no files".into()));
    }
    let is_odb = files.iter().any(|path| is_odb_marker(&prepared.root, path));
    let mut design = if is_odb {
        odb::parse_odb(&prepared.root, &files, source, &prepared.content_hash)?
    } else {
        gerber::parse_gerber_package(&prepared.root, &files, source, &prepared.content_hash)?
    };
    design.finalize();
    if design.layers.is_empty() {
        return Err(CoreError::Parse(
            "no renderable PCB layers were found".into(),
        ));
    }
    Ok(design)
}

fn collect_files(root: &Path) -> Vec<PathBuf> {
    let mut files = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.path().to_path_buf())
        .collect::<Vec<_>>();
    files.sort();
    files
}

fn is_odb_marker(root: &Path, path: &Path) -> bool {
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    relative.ends_with("matrix/matrix")
        || relative.contains("/steps/") && relative.contains("/layers/")
        || relative.starts_with("steps/") && relative.contains("/layers/")
}

pub(crate) fn diagnostic(
    code: &str,
    severity: Severity,
    message: impl Into<String>,
    source: Option<&Path>,
) -> Diagnostic {
    Diagnostic {
        code: code.into(),
        severity,
        message: message.into(),
        source: source.map(|path| path.display().to_string()),
    }
}

pub(crate) fn empty_design(format: DesignFormat, source: &Path, content_hash: &str) -> Design {
    Design {
        schema_version: Design::SCHEMA_VERSION,
        id: content_hash[..24.min(content_hash.len())].to_owned(),
        format,
        source_path: source.display().to_string(),
        content_hash: content_hash.into(),
        bounds: Default::default(),
        layers: Vec::new(),
        components: Vec::new(),
        nets: Vec::new(),
        test_points: Vec::new(),
        coverage: Default::default(),
        diagnostics: Vec::new(),
    }
}
