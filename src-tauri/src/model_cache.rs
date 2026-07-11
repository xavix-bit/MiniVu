use crate::settings::{DownloadMirror, GgufModelVariant, MirrorId};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const DEFAULT_MMPROJ_FILENAME: &str = "minicpm-v-4_6-mmproj-f16.gguf";

/// HuggingFace mlx-community 量化权重，首次推理时由 mlx-vlm 自动缓存到本机。
pub const DEFAULT_MLX_MODEL_ID: &str = "mlx-community/MiniCPM-V-4.6-4bit";
/// 4-bit MLX 权重约 2.3 GB，用于下载进度估算。
pub const ESTIMATED_MLX_BYTES: u64 = 2_300_000_000;

pub const DEFAULT_MODEL_URL: &str =
    "https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf/resolve/main/MiniCPM-V-4_6-Q4_K_M.gguf";
pub const DEFAULT_MMPROJ_URL: &str =
    "https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf/resolve/main/mmproj-model-f16.gguf";

/// OpenBMB 官方 ModelScope 仓库，国内访问通常比 HuggingFace 快很多。
pub const MODELSCOPE_MODEL_URL: &str =
    "https://modelscope.cn/models/OpenBMB/MiniCPM-V-4.6-gguf/resolve/master/MiniCPM-V-4_6-Q4_K_M.gguf";
pub const MODELSCOPE_MMPROJ_URL: &str =
    "https://modelscope.cn/models/OpenBMB/MiniCPM-V-4.6-gguf/resolve/master/mmproj-model-f16.gguf";

#[derive(Clone, Copy)]
pub struct DownloadSource {
    pub name: &'static str,
    pub url: &'static str,
}

const MODELSCOPE_MMPROJ_SOURCE: DownloadSource = DownloadSource {
    name: "ModelScope（国内镜像）",
    url: MODELSCOPE_MMPROJ_URL,
};

const HUGGINGFACE_MMPROJ_SOURCE: DownloadSource = DownloadSource {
    name: "HuggingFace（海外源）",
    url: DEFAULT_MMPROJ_URL,
};

#[derive(Clone, Copy)]
pub struct GgufModelSpec {
    pub variant: GgufModelVariant,
    pub filename: &'static str,
    pub model_bytes: u64,
    pub huggingface_url: &'static str,
    pub modelscope_url: &'static str,
}

pub const GGUF_MODEL_SPECS: &[GgufModelSpec] = &[
    GgufModelSpec {
        variant: GgufModelVariant::Q4KM,
        filename: "minicpm-v-4_6-Q4_K_M.gguf",
        model_bytes: 529_101_504,
        huggingface_url: DEFAULT_MODEL_URL,
        modelscope_url: MODELSCOPE_MODEL_URL,
    },
    GgufModelSpec {
        variant: GgufModelVariant::Q5KM,
        filename: "minicpm-v-4_6-Q5_K_M.gguf",
        model_bytes: 577_802_944,
        huggingface_url:
            "https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf/resolve/main/MiniCPM-V-4_6-Q5_K_M.gguf",
        modelscope_url:
            "https://modelscope.cn/models/OpenBMB/MiniCPM-V-4.6-gguf/resolve/master/MiniCPM-V-4_6-Q5_K_M.gguf",
    },
    GgufModelSpec {
        variant: GgufModelVariant::Q6K,
        filename: "minicpm-v-4_6-Q6_K.gguf",
        model_bytes: 629_548_224,
        huggingface_url:
            "https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf/resolve/main/MiniCPM-V-4_6-Q6_K.gguf",
        modelscope_url:
            "https://modelscope.cn/models/OpenBMB/MiniCPM-V-4.6-gguf/resolve/master/MiniCPM-V-4_6-Q6_K.gguf",
    },
];

pub fn gguf_model_spec(variant: GgufModelVariant) -> &'static GgufModelSpec {
    GGUF_MODEL_SPECS
        .iter()
        .find(|spec| spec.variant == variant)
        .unwrap_or(&GGUF_MODEL_SPECS[0])
}

fn modelscope_model_source(variant: GgufModelVariant) -> DownloadSource {
    DownloadSource {
        name: "ModelScope（国内镜像）",
        url: gguf_model_spec(variant).modelscope_url,
    }
}

fn huggingface_model_source(variant: GgufModelVariant) -> DownloadSource {
    DownloadSource {
        name: "HuggingFace（海外源）",
        url: gguf_model_spec(variant).huggingface_url,
    }
}

fn order_sources(
    primary: DownloadSource,
    secondary: DownloadSource,
    mirror: DownloadMirror,
    preferred: Option<MirrorId>,
) -> Vec<DownloadSource> {
    match mirror {
        DownloadMirror::Modelscope => vec![primary],
        DownloadMirror::Huggingface => vec![secondary],
        DownloadMirror::Auto => match preferred {
            Some(MirrorId::Huggingface) => vec![secondary, primary],
            Some(MirrorId::Modelscope) | None => vec![primary, secondary],
        },
    }
}

pub fn model_sources(variant: GgufModelVariant) -> Vec<DownloadSource> {
    vec![
        modelscope_model_source(variant),
        huggingface_model_source(variant),
    ]
}

pub fn mmproj_sources() -> Vec<DownloadSource> {
    vec![MODELSCOPE_MMPROJ_SOURCE, HUGGINGFACE_MMPROJ_SOURCE]
}

pub fn model_sources_for(
    variant: GgufModelVariant,
    mirror: DownloadMirror,
    preferred: Option<MirrorId>,
) -> Vec<DownloadSource> {
    order_sources(
        modelscope_model_source(variant),
        huggingface_model_source(variant),
        mirror,
        preferred,
    )
}

pub fn mmproj_sources_for(
    mirror: DownloadMirror,
    preferred: Option<MirrorId>,
) -> Vec<DownloadSource> {
    order_sources(
        MODELSCOPE_MMPROJ_SOURCE,
        HUGGINGFACE_MMPROJ_SOURCE,
        mirror,
        preferred,
    )
}

/// 默认 GGUF 体积（用于兼容旧的进度估算；实际下载按所选档位校验）。
pub const EXPECTED_MODEL_BYTES: u64 = 529_101_504;
pub const EXPECTED_MMPROJ_BYTES: u64 = 1_108_746_944;
pub const ESTIMATED_DOWNLOAD_BYTES: u64 = EXPECTED_MODEL_BYTES + EXPECTED_MMPROJ_BYTES;

const COMPLETE_RATIO_PERCENT: u64 = 99;

pub fn expected_bytes_for_label(label: &str) -> Option<u64> {
    match label {
        "model" => Some(EXPECTED_MODEL_BYTES),
        "mmproj" => Some(EXPECTED_MMPROJ_BYTES),
        _ => None,
    }
}

pub fn minimum_complete_bytes(label: &str) -> Option<u64> {
    expected_bytes_for_label(label)
        .map(|expected| expected.saturating_mul(COMPLETE_RATIO_PERCENT) / 100)
}

pub fn is_download_complete(label: &str, bytes: u64) -> bool {
    minimum_complete_bytes(label)
        .map(|minimum| bytes >= minimum)
        .unwrap_or(bytes > 0)
}

fn expected_bytes_for_path(path: &std::path::Path, label: &str) -> Option<u64> {
    match label {
        "model" => {
            let filename = path.file_name()?.to_string_lossy().to_lowercase();
            GGUF_MODEL_SPECS
                .iter()
                .find(|spec| filename == spec.filename.to_lowercase())
                .map(|spec| spec.model_bytes)
                .or(Some(EXPECTED_MODEL_BYTES))
        }
        "mmproj" => Some(EXPECTED_MMPROJ_BYTES),
        _ => None,
    }
}

pub fn is_complete_size(expected: u64, bytes: u64) -> bool {
    bytes >= expected.saturating_mul(COMPLETE_RATIO_PERCENT) / 100
}

pub fn file_is_valid(path: &std::path::Path, label: &str) -> bool {
    fs::metadata(path)
        .ok()
        .map(|meta| {
            expected_bytes_for_path(path, label)
                .map(|expected| is_complete_size(expected, meta.len()))
                .unwrap_or(meta.len() > 0)
        })
        .unwrap_or(false)
}

/// Resolved pair of files required for vision inference.
#[derive(Debug, Clone)]
pub struct ModelPaths {
    pub model: PathBuf,
    pub mmproj: PathBuf,
}

impl ModelPaths {
    pub fn is_complete(&self) -> bool {
        file_is_valid(&self.model, "model") && file_is_valid(&self.mmproj, "mmproj")
    }
}

pub struct ModelCache {
    pub root: PathBuf,
}

impl ModelCache {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("models");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(Self { root })
    }

    pub fn default_model_path(&self, variant: GgufModelVariant) -> PathBuf {
        self.root.join(gguf_model_spec(variant).filename)
    }

    pub fn default_mmproj_path(&self) -> PathBuf {
        self.root.join(DEFAULT_MMPROJ_FILENAME)
    }

    pub fn resolve(&self, variant: GgufModelVariant) -> ModelPaths {
        ModelPaths {
            model: self.default_model_path(variant),
            mmproj: self.default_mmproj_path(),
        }
    }

    pub fn model_size_bytes(&self, variant: GgufModelVariant) -> Option<u64> {
        let paths = self.resolve(variant);
        let model = fs::metadata(&paths.model).ok().map(|m| m.len());
        let mmproj = fs::metadata(&paths.mmproj).ok().map(|m| m.len());
        match (model, mmproj) {
            (Some(a), Some(b)) => Some(a + b),
            (Some(a), None) => Some(a),
            _ => None,
        }
    }

    pub fn resolve_mlx(&self, configured_id: Option<&str>) -> MlxModelRef {
        let hub_id = configured_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(DEFAULT_MLX_MODEL_ID);
        MlxModelRef {
            spec: hub_id.to_string(),
            is_local: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MlxModelRef {
    pub spec: String,
    pub is_local: bool,
}

impl MlxModelRef {
    pub fn is_ready(&self) -> bool {
        if self.is_local {
            PathBuf::from(&self.spec).join("config.json").is_file()
        } else {
            mlx_hub_model_cached(&self.spec)
                || mlx_hub_cache_bytes(&self.spec) >= ESTIMATED_MLX_BYTES * 3 / 4
        }
    }

    pub fn requires_network_on_first_run(&self) -> bool {
        !self.is_local && !self.is_ready()
    }
}

pub fn mlx_hub_model_cached(model_id: &str) -> bool {
    mlx_hub_snapshot_dir(model_id).is_some()
}

pub fn mlx_hub_cache_bytes(model_id: &str) -> u64 {
    let Some(snapshot) = mlx_hub_snapshot_dir(model_id) else {
        return 0;
    };
    dir_size_bytes(&snapshot)
}

fn mlx_hub_snapshot_dir(model_id: &str) -> Option<PathBuf> {
    let hub_root = huggingface_hub_dir()?;
    let repo_dir = hub_root.join(format!("models--{}", model_id.replace('/', "--")));
    let snapshots = repo_dir.join("snapshots");
    let entries = fs::read_dir(snapshots).ok()?;
    entries.flatten().find_map(|entry| {
        let path = entry.path();
        if path.join("config.json").is_file()
            && (path.join("model.safetensors").is_file()
                || path.join("weights.safetensors").is_file()
                || dir_has_safetensors(&path))
        {
            Some(path)
        } else {
            None
        }
    })
}

fn dir_has_safetensors(dir: &Path) -> bool {
    fs::read_dir(dir)
        .ok()
        .map(|entries| {
            entries.flatten().any(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext == "safetensors")
            })
        })
        .unwrap_or(false)
}

fn dir_size_bytes(dir: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Ok(meta) = fs::metadata(&path) {
                    total += meta.len();
                }
            } else if path.is_dir() {
                total += dir_size_bytes(&path);
            }
        }
    }
    total
}

fn huggingface_hub_dir() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("HF_HOME") {
        let hub = PathBuf::from(raw).join("hub");
        if hub.is_dir() {
            return Some(hub);
        }
    }
    dirs_home_cache().map(|home| home.join("hub"))
}

fn dirs_home_cache() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".cache").join("huggingface"))
}

pub fn is_model_ready(app: &AppHandle) -> Result<bool, String> {
    let settings = crate::settings::load_settings(app)?;
    let cache = ModelCache::new(app)?;
    Ok(cache.resolve(settings.gguf_model_variant).is_complete())
}

pub fn format_bytes(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let value = bytes as f64;
    if value >= GB {
        format!("{:.1} GB", value / GB)
    } else {
        format!("{:.0} MB", value / MB)
    }
}
