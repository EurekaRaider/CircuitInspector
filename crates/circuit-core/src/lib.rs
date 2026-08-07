pub mod analyze;
pub mod archive;
pub mod cache;
pub mod evidence;
pub mod model;
pub mod parsers;
pub mod rules;
pub mod server;
pub mod tile;

use std::io;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("unsupported input: {0}")]
    Unsupported(String),
    #[error("archive rejected: {0}")]
    ArchiveRejected(String),
    #[error("parse failed: {0}")]
    Parse(String),
    #[error("cache failed: {0}")]
    Cache(String),
    #[error("rule pack rejected: {0}")]
    Rule(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
}

pub type CoreResult<T> = Result<T, CoreError>;
