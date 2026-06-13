use std::collections::HashMap;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

fn default_engine_registration_source() -> String {
    "legacy".into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineId {
    RealCugan,
    Waifu2x,
    RealEsrgan,
}

impl EngineId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RealCugan => "real-cugan",
            Self::Waifu2x => "waifu2x",
            Self::RealEsrgan => "real-esrgan",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::RealCugan => "Real-CUGAN-ncnn-vulkan",
            Self::Waifu2x => "waifu2x-ncnn-vulkan",
            Self::RealEsrgan => "Real-ESRGAN-ncnn-vulkan",
        }
    }
}

impl FromStr for EngineId {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "real-cugan" => Ok(Self::RealCugan),
            "waifu2x" => Ok(Self::Waifu2x),
            "real-esrgan" => Ok(Self::RealEsrgan),
            _ => Err(format!("未対応の AI エンジンです: {value}")),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedBook {
    pub id: String,
    pub file_name: String,
    pub source_path: String,
    pub stored_path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineRegistration {
    pub executable_path: String,
    pub model_name: Option<String>,
    pub model_path: String,
    pub registered_at: u64,
    #[serde(default = "default_engine_registration_source")]
    pub source: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct EngineRegistry {
    pub engines: HashMap<EngineId, EngineRegistration>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub id: EngineId,
    pub label: String,
    pub configured: bool,
    pub ready: bool,
    pub executable_path: Option<String>,
    pub model_path: Option<String>,
    pub model_name: Option<String>,
    pub source: Option<String>,
    pub warning: Option<String>,
    pub download_url: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCandidate {
    pub id: EngineId,
    pub label: String,
    pub directory_path: String,
    pub executable_path: String,
    pub model_path: String,
    pub model_name: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInstallOption {
    pub engine_id: EngineId,
    pub label: String,
    pub release_name: String,
    pub release_tag: String,
    pub asset_name: String,
    pub download_url: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInstallWarning {
    pub engine_id: EngineId,
    pub label: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInstallOptionsResponse {
    pub options: Vec<EngineInstallOption>,
    pub warnings: Vec<EngineInstallWarning>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceImageRequest {
    pub engine_id: EngineId,
    pub image_data_url: String,
    pub scale: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceImageResponse {
    pub image_data_url: String,
}
