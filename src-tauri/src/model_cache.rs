use crate::settings::{DownloadMirror, MirrorId};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const DEFAULT_MODEL_FILENAME: &str = "minicpm-v-4_5-Q4_K_M.gguf";
pub const DEFAULT_MMPROJ_FILENAME: &str = "minicpm-v-4_5-mmproj-f16.gguf";

/// HuggingFace mlx-community 量化权重，首次推理时由 mlx-vlm 自动缓存到本机。
pub const DEFAULT_MLX_MODEL_ID: &str = "mlx-community/MiniCPM-V-4.6-4bit";
/// 4-bit MLX 权重约 2.3 GB，用于下载进度估算。
pub const ESTIMATED_MLX_BYTES: u64 = 2_300_000_000;

pub const DEFAULT_MODEL_URL: &str =
    "https://huggingface.co/openbmb/MiniCPM-V-4_5-gguf/resolve/main/ggml-model-Q4_K_M.gguf";
pub const DEFAULT_MMPROJ_URL: &str =
    "https://huggingface.co/openbmb/MiniCPM-V-4_5-gguf/resolve/main/mmproj-model-f16.gguf";

/// OpenBMB 官方 ModelScope 仓库，国内访问通常比 HuggingFace 快很多。
pub const MODELSCOPE_MODEL_URL: &str =
    "https://modelscope.cn/models/OpenBMB/MiniCPM-V-4_5-gguf/resolve/master/ggml-model-Q4_K_M.gguf";
pub const MODELSCOPE_MMPROJ_URL: &str =
    "https://modelscope.cn/models/OpenBMB/MiniCPM-V-4_5-gguf/resolve/master/mmproj-model-f16.gguf";

#[derive(Clone, Copy)]
pub struct DownloadSource {
    pub name: &'static str,
    pub url: &'static str,
}

const MODELSCOPE_SOURCE: DownloadSource = DownloadSource {
    name: "ModelScope（国内镜像）",
    url: MODELSCOPE_MODEL_URL,
};

const HUGGINGFACE_MODEL_SOURCE: DownloadSource = DownloadSource {
    name: "HuggingFace（海外源）",
    url: DEFAULT_MODEL_URL,
};

const MODELSCOPE_MMPROJ_SOURCE: DownloadSource = DownloadSource {
    name: "ModelScope（国内镜像）",
    url: MODELSCOPE_MMPROJ_URL,
};

const HUGGINGFACE_MMPROJ_SOURCE: DownloadSource = DownloadSource {
    name: "HuggingFace（海外源）",
    url: DEFAULT_MMPROJ_URL,
};

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

pub fn model_sources() -> Vec<DownloadSource> {
    vec![MODELSCOPE_SOURCE, HUGGINGFACE_MODEL_SOURCE]
}

pub fn mmproj_sources() -> Vec<DownloadSource> {
    vec![MODELSCOPE_MMPROJ_SOURCE, HUGGINGFACE_MMPROJ_SOURCE]
}

pub fn model_sources_for(mirror: DownloadMirror, preferred: Option<MirrorId>) -> Vec<DownloadSource> {
    order_sources(MODELSCOPE_SOURCE, HUGGINGFACE_MODEL_SOURCE, mirror, preferred)
}

pub fn mmproj_sources_for(mirror: DownloadMirror, preferred: Option<MirrorId>) -> Vec<DownloadSource> {
    order_sources(
        MODELSCOPE_MMPROJ_SOURCE,
        HUGGINGFACE_MMPROJ_SOURCE,
        mirror,
        preferred,
    )
}

/// 官方 GGUF 体积（用于完整性校验与引导页提示）。
pub const EXPECTED_MODEL_BYTES: u64 = 5_026_714_304;
pub const EXPECTED_MMPROJ_BYTES: u64 = 1_095_113_184;
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

pub fn file_is_valid(path: &std::path::Path, label: &str) -> bool {
    fs::metadata(path)
        .ok()
        .map(|meta| is_download_complete(label, meta.len()))
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

    pub fn default_model_path(&self) -> PathBuf {
        self.root.join(DEFAULT_MODEL_FILENAME)
    }

    pub fn default_mmproj_path(&self) -> PathBuf {
        self.root.join(DEFAULT_MMPROJ_FILENAME)
    }

    /// Resolve the model + mmproj pair. If `configured` points to a directory,
    /// auto-detect the two GGUF files inside it. If it points to a file, treat it
    /// as the main model and look for an mmproj sibling. Otherwise use the cache.
    pub fn resolve(&self, configured: Option<&str>) -> ModelPaths {
        if let Some(raw) = configured.filter(|p| !p.trim().is_empty()) {
            let path = PathBuf::from(raw);
            if path.is_dir() {
                if let Some(pair) = detect_pair_in_dir(&path) {
                    return pair;
                }
            } else if path.is_file() {
                let mmproj = find_mmproj_sibling(&path)
                    .unwrap_or_else(|| self.default_mmproj_path());
                return ModelPaths { model: path, mmproj };
            }
        }

        ModelPaths {
            model: self.default_model_path(),
            mmproj: self.default_mmproj_path(),
        }
    }

    pub fn model_size_bytes(&self, configured: Option<&str>) -> Option<u64> {
        let paths = self.resolve(configured);
        let model = fs::metadata(&paths.model).ok().map(|m| m.len());
        let mmproj = fs::metadata(&paths.mmproj).ok().map(|m| m.len());
        match (model, mmproj) {
            (Some(a), Some(b)) => Some(a + b),
            (Some(a), None) => Some(a),
            _ => None,
        }
    }

    pub fn default_mlx_local_dir(&self) -> PathBuf {
        self.root.join("mlx").join("MiniCPM-V-4.6-4bit")
    }

    pub fn resolve_mlx(
        &self,
        configured_path: Option<&str>,
        configured_id: Option<&str>,
    ) -> MlxModelRef {
        if let Some(raw) = configured_path.filter(|value| !value.trim().is_empty()) {
            let path = PathBuf::from(raw);
            if path.is_dir() && path.join("config.json").exists() {
                return MlxModelRef {
                    spec: path.to_string_lossy().to_string(),
                    is_local: true,
                };
            }
        }

        let local = self.default_mlx_local_dir();
        if local.join("config.json").exists() {
            return MlxModelRef {
                spec: local.to_string_lossy().to_string(),
                is_local: true,
            };
        }

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
            PathBuf::from(&self.spec)
                .join("config.json")
                .is_file()
        } else {
            mlx_hub_model_cached(&self.spec)
        }
    }

    pub fn requires_network_on_first_run(&self) -> bool {
        !self.is_local && !mlx_hub_model_cached(&self.spec)
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
    std::env::var_os("HOME").map(PathBuf::from).map(|home| {
        home.join(".cache").join("huggingface")
    })
}

fn detect_pair_in_dir(dir: &PathBuf) -> Option<ModelPaths> {
    let entries = fs::read_dir(dir).ok()?;
    let mut model: Option<PathBuf> = None;
    let mut mmproj: Option<PathBuf> = None;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name()?.to_string_lossy().to_lowercase();
        if !name.ends_with(".gguf") {
            continue;
        }
        if name.contains("mmproj") {
            mmproj = Some(path);
        } else {
            model = Some(path);
        }
    }

    match (model, mmproj) {
        (Some(model), Some(mmproj)) => Some(ModelPaths { model, mmproj }),
        _ => None,
    }
}

fn find_mmproj_sibling(model: &PathBuf) -> Option<PathBuf> {
    let dir = model.parent()?;
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name()?.to_string_lossy().to_lowercase();
        if name.ends_with(".gguf") && name.contains("mmproj") {
            return Some(path);
        }
    }
    None
}

pub fn is_model_ready(app: &AppHandle) -> Result<bool, String> {
    let settings = crate::settings::load_settings(app)?;
    let cache = ModelCache::new(app)?;
    Ok(cache.resolve(settings.model_path.as_deref()).is_complete())
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
