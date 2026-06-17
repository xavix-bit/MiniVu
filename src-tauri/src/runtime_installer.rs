use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager};

const LLAMA_RELEASE_TAG: &str = "b9264";

pub fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("runtime");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn managed_llama_server_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_dir(app)?.join("llama-server"))
}

pub fn resolve_llama_server(app: &AppHandle) -> Option<PathBuf> {
    let managed = managed_llama_server_path(app).ok()?;
    if is_executable(&managed) {
        return Some(managed);
    }

    for name in ["llama-server", "llama-server.exe"] {
        if Command::new(name)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return Some(PathBuf::from(name));
        }
    }

    None
}

fn is_executable(path: &Path) -> bool {
    path.is_file()
        && Command::new(path)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn macos_asset_suffix() -> Result<&'static str, String> {
    match std::env::consts::ARCH {
        "aarch64" => Ok("macos-arm64"),
        "x86_64" => Ok("macos-x64"),
        other => Err(format!("暂不支持该架构: {other}")),
    }
}

#[cfg(not(target_os = "macos"))]
fn macos_asset_suffix() -> Result<&'static str, String> {
    Err("自动安装推理引擎目前仅支持 macOS".to_string())
}

fn llama_download_url() -> Result<String, String> {
    let suffix = macos_asset_suffix()?;
    Ok(format!(
        "https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_RELEASE_TAG}/llama-{LLAMA_RELEASE_TAG}-bin-{suffix}.tar.gz"
    ))
}

pub fn emit_setup_progress(app: &AppHandle, phase: &str, status: &str, message: &str, percent: u8) {
    let _ = app.emit(
        "setup-progress",
        serde_json::json!({
            "phase": phase,
            "status": status,
            "message": message,
            "percent": percent,
        }),
    );
}

pub async fn install_llama_runtime(app: &AppHandle) -> Result<(), String> {
    if resolve_llama_server(app).is_some() {
        emit_setup_progress(app, "runtime", "done", "推理引擎已就绪", 100);
        return Ok(());
    }

    emit_setup_progress(
        app,
        "runtime",
        "running",
        "正在从 GitHub 下载推理引擎（约 8 MB）…",
        5,
    );

    let runtime = runtime_dir(app)?;
    let archive_path = runtime.join("llama-runtime.tar.gz");
    let extract_dir = runtime.join("extract");

    if extract_dir.exists() {
        fs::remove_dir_all(&extract_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;

    let url = llama_download_url()?;
    download_file_with_progress(app, &url, &archive_path, "runtime", 5, 45).await?;

    emit_setup_progress(app, "runtime", "running", "正在解压推理引擎…", 50);
    extract_tar_gz(&archive_path, &extract_dir)?;

    let discovered = find_binary_in_dir(&extract_dir, "llama-server")
        .ok_or_else(|| "解压包中未找到 llama-server".to_string())?;

    let managed = managed_llama_server_path(app)?;
    if managed.exists() {
        fs::remove_file(&managed).ok();
    }
    fs::copy(&discovered, &managed).map_err(|e| e.to_string())?;
    make_executable(&managed)?;

    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("xattr")
            .args(["-dr", "com.apple.quarantine"])
            .arg(&runtime)
            .status();
    }

    let _ = fs::remove_file(&archive_path);
    let _ = fs::remove_dir_all(&extract_dir);

    if !is_executable(&managed) {
        return try_brew_install(app);
    }

    emit_setup_progress(app, "runtime", "done", "推理引擎安装完成", 100);
    Ok(())
}

fn try_brew_install(app: &AppHandle) -> Result<(), String> {
    emit_setup_progress(app, "runtime", "running", "正在通过 Homebrew 安装推理引擎…", 60);

    let brew = which_brew().ok_or_else(|| {
        "推理引擎安装失败，请检查网络后重试".to_string()
    })?;

    let status = Command::new(&brew)
        .args(["install", "llama.cpp"])
        .status()
        .map_err(|e| format!("Homebrew 安装失败: {e}"))?;

    if !status.success() {
        return Err("Homebrew 安装 llama.cpp 失败".to_string());
    }

    if resolve_llama_server(app).is_some() {
        emit_setup_progress(app, "runtime", "done", "推理引擎安装完成", 100);
        Ok(())
    } else {
        Err("推理引擎安装后仍未检测到 llama-server".to_string())
    }
}

fn which_brew() -> Option<PathBuf> {
    for candidate in ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "brew"] {
        let path = PathBuf::from(candidate);
        if Command::new(&path)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    None
}

async fn download_file_with_progress(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    phase: &str,
    percent_start: u8,
    percent_end: u8,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use reqwest::Client;
    use tokio::io::AsyncWriteExt;

    let client = Client::new();
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("下载失败: HTTP {}", response.status()));
    }

    let total = response.content_length();
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        let percent = if let Some(total) = total.filter(|value| *value > 0) {
            percent_start as u64
                + (downloaded * (percent_end - percent_start) as u64) / total
        } else {
            percent_start as u64
        };

        emit_setup_progress(
            app,
            phase,
            "running",
            "正在下载推理引擎…",
            percent.min(percent_end as u64) as u8,
        );
    }

    Ok(())
}

fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    let status = Command::new("tar")
        .args(["-xzf"])
        .arg(archive)
        .arg("-C")
        .arg(dest)
        .status()
        .map_err(|e| format!("解压失败: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("解压推理引擎失败".to_string())
    }
}

fn find_binary_in_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_binary_in_dir(&path, name) {
                return Some(found);
            }
        } else if path.file_name().and_then(|value| value.to_str()) == Some(name) {
            return Some(path);
        }
    }
    None
}

#[tauri::command]
pub async fn install_llama_runtime_command(app: AppHandle) -> Result<(), String> {
    install_llama_runtime(&app).await
}

pub fn mlx_venv_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_dir(app)?.join("mlx-venv"))
}

fn mlx_ready_marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(mlx_venv_dir(app)?.join(".minivu_mlx_ready"))
}

fn write_mlx_ready_marker(app: &AppHandle) {
    if let Ok(path) = mlx_ready_marker_path(app) {
        let _ = fs::write(path, "ok");
    }
}

pub fn resolve_mlx_python(app: &AppHandle) -> Option<PathBuf> {
    let venv_dir = mlx_venv_dir(app).ok()?;
    let venv_python = venv_dir.join("bin").join("python3");
    let marker = mlx_ready_marker_path(app).ok()?;

    if venv_python.is_file() && marker.is_file() {
        return Some(venv_python);
    }

    if mlx_python_ready(&venv_python) {
        write_mlx_ready_marker(app);
        return Some(venv_python);
    }
    None
}

fn mlx_python_ready(python: &Path) -> bool {
    python.is_file()
        && Command::new(python)
            .args(["-c", "import mlx_vlm"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
}

fn resolve_system_python3() -> Option<PathBuf> {
    for candidate in ["python3", "/usr/bin/python3", "/opt/homebrew/bin/python3"] {
        let path = PathBuf::from(candidate);
        if Command::new(&path)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    None
}

pub async fn install_mlx_runtime(app: &AppHandle) -> Result<(), String> {
    if resolve_mlx_python(app).is_some() {
        emit_setup_progress(app, "runtime", "done", "MLX 推理引擎已就绪", 100);
        return Ok(());
    }

    emit_setup_progress(
        app,
        "runtime",
        "running",
        "正在创建 MLX 虚拟环境（约 300 MB）…",
        5,
    );

    let venv_dir = mlx_venv_dir(app)?;
    if venv_dir.exists() {
        fs::remove_dir_all(&venv_dir).map_err(|e| e.to_string())?;
    }

    let system_python = resolve_system_python3()
        .ok_or_else(|| "未找到 python3，请先安装 Xcode Command Line Tools 或 Homebrew Python。".to_string())?;

    let status = Command::new(&system_python)
        .args(["-m", "venv"])
        .arg(&venv_dir)
        .status()
        .map_err(|e| format!("创建虚拟环境失败: {e}"))?;
    if !status.success() {
        return Err("创建 MLX 虚拟环境失败".to_string());
    }

    let venv_python = venv_dir.join("bin").join("python3");
    emit_setup_progress(app, "runtime", "running", "正在安装 mlx-vlm…", 20);

    let pip_upgrade = Command::new(&venv_python)
        .args(["-m", "pip", "install", "--upgrade", "pip"])
        .status()
        .map_err(|e| format!("pip 升级失败: {e}"))?;
    if !pip_upgrade.success() {
        return Err("pip 升级失败".to_string());
    }

    emit_setup_progress(app, "runtime", "running", "正在下载 MLX 依赖（需联网）…", 35);

    let pip_install = Command::new(&venv_python)
        .args([
            "-m",
            "pip",
            "install",
            "mlx>=0.25",
            "mlx-vlm>=0.6.2",
            "fastapi",
            "uvicorn",
        ])
        .status()
        .map_err(|e| format!("安装 mlx-vlm 失败: {e}"))?;
    if !pip_install.success() {
        return Err("安装 mlx-vlm 失败，请检查网络后重试".to_string());
    }

    if !mlx_python_ready(&venv_python) {
        return Err("MLX 安装完成但无法导入 mlx_vlm".to_string());
    }

    write_mlx_ready_marker(app);
    emit_setup_progress(app, "runtime", "done", "MLX 推理引擎安装完成", 100);
    Ok(())
}

#[tauri::command]
pub async fn install_mlx_runtime_command(app: AppHandle) -> Result<(), String> {
    install_mlx_runtime(&app).await
}

fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path).map_err(|e| e.to_string())?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).map_err(|e| e.to_string())?;
    }
    Ok(())
}
