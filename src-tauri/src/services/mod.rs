use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::app_error::{AppError, AppResult};

pub mod engines;
pub mod library;

pub fn app_data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::AppDataDirUnavailable)?;

    fs::create_dir_all(&data_dir)?;

    Ok(data_dir)
}
