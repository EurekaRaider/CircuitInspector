use crate::{CoreError, CoreResult};
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use tempfile::TempDir;
use walkdir::WalkDir;

const MAX_ENTRIES: usize = 200_000;
const MAX_UNCOMPRESSED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub struct PreparedInput {
    pub root: PathBuf,
    pub content_hash: String,
    _temporary: Option<TempDir>,
}

pub fn prepare_input(source: &Path) -> CoreResult<PreparedInput> {
    if !source.exists() {
        return Err(CoreError::InvalidInput(format!(
            "{} does not exist",
            source.display()
        )));
    }
    let content_hash = hash_input(source)?;
    if source.is_dir() {
        return Ok(PreparedInput {
            root: source.to_path_buf(),
            content_hash,
            _temporary: None,
        });
    }

    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name.ends_with(".tgz") || name.ends_with(".tar.gz") {
        let temporary = tempfile::tempdir()?;
        extract_tgz(source, temporary.path())?;
        return Ok(PreparedInput {
            root: temporary.path().to_path_buf(),
            content_hash,
            _temporary: Some(temporary),
        });
    }
    if name.ends_with(".zip") {
        let temporary = tempfile::tempdir()?;
        extract_zip(source, temporary.path())?;
        return Ok(PreparedInput {
            root: temporary.path().to_path_buf(),
            content_hash,
            _temporary: Some(temporary),
        });
    }

    let temporary = tempfile::tempdir()?;
    let file_name = source
        .file_name()
        .ok_or_else(|| CoreError::InvalidInput("input has no file name".into()))?;
    fs::copy(source, temporary.path().join(file_name))?;
    Ok(PreparedInput {
        root: temporary.path().to_path_buf(),
        content_hash,
        _temporary: Some(temporary),
    })
}

pub fn hash_input(source: &Path) -> CoreResult<String> {
    let mut hasher = Sha256::new();
    if source.is_file() {
        hash_file(source, &mut hasher)?;
    } else {
        let mut files = WalkDir::new(source)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| entry.path().to_path_buf())
            .collect::<Vec<_>>();
        files.sort();
        for path in files {
            let relative = path.strip_prefix(source).unwrap_or(&path);
            hasher.update(relative.to_string_lossy().as_bytes());
            hash_file(&path, &mut hasher)?;
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

fn hash_file(path: &Path, hasher: &mut Sha256) -> CoreResult<()> {
    let mut file = File::open(path)?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(())
}

fn extract_tgz(source: &Path, destination: &Path) -> CoreResult<()> {
    let archive = File::open(source)?;
    let decoder = GzDecoder::new(archive);
    let mut archive = tar::Archive::new(decoder);
    let mut entries = 0_usize;
    let mut total_bytes = 0_u64;
    for item in archive.entries()? {
        let mut entry = item?;
        entries += 1;
        if entries > MAX_ENTRIES {
            return Err(CoreError::ArchiveRejected(format!(
                "more than {MAX_ENTRIES} entries"
            )));
        }
        let header = entry.header();
        let size = header.size()?;
        total_bytes = total_bytes.saturating_add(size);
        validate_archive_limits(size, total_bytes)?;
        if header.entry_type().is_symlink() || header.entry_type().is_hard_link() {
            return Err(CoreError::ArchiveRejected(
                "links are not allowed in archives".into(),
            ));
        }
        if !(header.entry_type().is_file() || header.entry_type().is_dir()) {
            continue;
        }
        let relative = entry.path()?.into_owned();
        let output = safe_output_path(destination, &relative)?;
        if header.entry_type().is_dir() {
            fs::create_dir_all(&output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut target = File::create(output)?;
        io::copy(&mut entry, &mut target)?;
    }
    Ok(())
}

fn extract_zip(source: &Path, destination: &Path) -> CoreResult<()> {
    let file = File::open(source)?;
    let mut archive = zip::ZipArchive::new(file)?;
    if archive.len() > MAX_ENTRIES {
        return Err(CoreError::ArchiveRejected(format!(
            "more than {MAX_ENTRIES} entries"
        )));
    }
    let mut total_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let size = entry.size();
        total_bytes = total_bytes.saturating_add(size);
        validate_archive_limits(size, total_bytes)?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(CoreError::ArchiveRejected(
                "symbolic links are not allowed in archives".into(),
            ));
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| CoreError::ArchiveRejected(format!("unsafe path {}", entry.name())))?;
        let output = safe_output_path(destination, &enclosed)?;
        if entry.is_dir() {
            fs::create_dir_all(output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut target = File::create(output)?;
        io::copy(&mut entry, &mut target)?;
    }
    Ok(())
}

fn validate_archive_limits(file_bytes: u64, total_bytes: u64) -> CoreResult<()> {
    if file_bytes > MAX_SINGLE_FILE_BYTES {
        return Err(CoreError::ArchiveRejected(format!(
            "single file exceeds {MAX_SINGLE_FILE_BYTES} bytes"
        )));
    }
    if total_bytes > MAX_UNCOMPRESSED_BYTES {
        return Err(CoreError::ArchiveRejected(format!(
            "uncompressed data exceeds {MAX_UNCOMPRESSED_BYTES} bytes"
        )));
    }
    Ok(())
}

fn safe_output_path(root: &Path, relative: &Path) -> CoreResult<PathBuf> {
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(CoreError::ArchiveRejected(format!(
            "unsafe path {}",
            relative.display()
        )));
    }
    Ok(root.join(relative))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_traversal_is_rejected() {
        let result = safe_output_path(Path::new("/tmp/safe"), Path::new("../escape"));
        assert!(matches!(result, Err(CoreError::ArchiveRejected(_))));
    }
}
