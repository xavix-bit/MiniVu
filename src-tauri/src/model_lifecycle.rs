use crate::inference::{wait_for_sidecar_ready, ActiveInferenceContext};
use crate::model_cache::{
    file_is_valid, gguf_model_spec, GgufVariantInventory, ModelCache, DEFAULT_MMPROJ_FILENAME,
    GGUF_MODEL_SPECS,
};
use crate::model_download::DownloadTaskState;
use crate::settings::{
    commit_gguf_model_variant, load_settings, GgufModelVariant, InferenceBackend,
};
use crate::sidecar::{lock_sidecar, SidecarState};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

const MUTATION_BUSY_ERROR: &str = "模型正在切换，请稍后重试。";
const INFERENCE_BUSY_ERROR: &str = "正在生成回答，请完成或取消后重试。";
const DOWNLOAD_BUSY_ERROR: &str = "模型正在下载，请先完成或取消下载。";

#[derive(Default)]
struct LifecycleInner {
    mutating: bool,
    active_inference: usize,
}

#[derive(Clone, Default)]
pub struct ModelLifecycleState {
    inner: Arc<Mutex<LifecycleInner>>,
}

pub struct ModelMutationLease {
    state: ModelLifecycleState,
}

pub struct InferenceLease {
    state: ModelLifecycleState,
}

impl ModelLifecycleState {
    pub fn begin_mutation(&self) -> Result<ModelMutationLease, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if inner.mutating {
            return Err(MUTATION_BUSY_ERROR.to_string());
        }
        if inner.active_inference > 0 {
            return Err(INFERENCE_BUSY_ERROR.to_string());
        }
        inner.mutating = true;
        Ok(ModelMutationLease {
            state: self.clone(),
        })
    }

    pub fn begin_inference(&self) -> Result<InferenceLease, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if inner.mutating {
            return Err(MUTATION_BUSY_ERROR.to_string());
        }
        inner.active_inference += 1;
        Ok(InferenceLease {
            state: self.clone(),
        })
    }

    #[cfg(test)]
    pub fn is_mutating(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .mutating
    }

    #[cfg(test)]
    fn active_inference(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active_inference
    }
}

impl Drop for ModelMutationLease {
    fn drop(&mut self) {
        self.state
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .mutating = false;
    }
}

impl Drop for InferenceLease {
    fn drop(&mut self) {
        let mut inner = self
            .state
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        inner.active_inference = inner.active_inference.saturating_sub(1);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMutationResult {
    pub active_variant: GgufModelVariant,
    pub model_storage_bytes: u64,
    pub cleanup_warning: Option<String>,
    pub inventory: Vec<GgufVariantInventory>,
}

fn source_metadata_path(part_path: &Path) -> PathBuf {
    let file_name = part_path
        .file_name()
        .expect("managed part paths always have a filename")
        .to_string_lossy();
    part_path.with_file_name(format!("{file_name}.source.json"))
}

fn variant_artifacts(root: &Path, variant: GgufModelVariant) -> [PathBuf; 3] {
    let final_path = root.join(gguf_model_spec(variant).filename);
    let part_path = final_path.with_extension("part");
    [
        final_path,
        part_path.clone(),
        source_metadata_path(&part_path),
    ]
}

fn mmproj_artifacts(root: &Path) -> [PathBuf; 3] {
    let final_path = root.join(DEFAULT_MMPROJ_FILENAME);
    let part_path = final_path.with_extension("part");
    [
        final_path,
        part_path.clone(),
        source_metadata_path(&part_path),
    ]
}

fn remove_regular_files(
    paths: impl IntoIterator<Item = PathBuf>,
    mut remove: impl FnMut(&Path) -> std::io::Result<()>,
) -> Vec<String> {
    let mut errors = Vec::new();
    for path in paths {
        let metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                errors.push(format!("{}: {error}", path.display()));
                continue;
            }
        };
        if !metadata.file_type().is_file() {
            continue;
        }
        if let Err(error) = remove(&path) {
            errors.push(format!("{}: {error}", path.display()));
        }
    }
    errors
}

fn cleanup_inactive_with(
    root: &Path,
    active_variant: GgufModelVariant,
    remove: impl FnMut(&Path) -> std::io::Result<()>,
) -> Vec<String> {
    let paths = GGUF_MODEL_SPECS
        .iter()
        .filter(|spec| spec.variant != active_variant)
        .flat_map(|spec| variant_artifacts(root, spec.variant));
    remove_regular_files(paths, remove)
}

pub(crate) fn cleanup_inactive_gguf(
    cache: &ModelCache,
    active_variant: GgufModelVariant,
) -> Vec<String> {
    cleanup_inactive_with(&cache.root, active_variant, |path| fs::remove_file(path))
}

fn remove_all_managed_with(
    root: &Path,
    remove: impl FnMut(&Path) -> std::io::Result<()>,
) -> Vec<String> {
    let paths = GGUF_MODEL_SPECS
        .iter()
        .flat_map(|spec| variant_artifacts(root, spec.variant))
        .chain(mmproj_artifacts(root));
    remove_regular_files(paths, remove)
}

fn remove_managed_models_with(
    cache: &ModelCache,
    active_variant: GgufModelVariant,
    remove: impl FnMut(&Path) -> std::io::Result<()>,
) -> ModelMutationResult {
    let cleanup_errors = remove_all_managed_with(&cache.root, remove);
    let warning = cleanup_warning("部分模型文件未能删除", cleanup_errors);
    mutation_result(cache, active_variant, warning)
}

fn remove_models_after_confirmed_stop(
    cache: &ModelCache,
    active_variant: GgufModelVariant,
    stop: impl FnOnce() -> Result<(), String>,
    remove: impl FnMut(&Path) -> std::io::Result<()>,
) -> Result<ModelMutationResult, String> {
    stop()?;
    Ok(remove_managed_models_with(cache, active_variant, remove))
}

fn mutation_result(
    cache: &ModelCache,
    active_variant: GgufModelVariant,
    cleanup_warning: Option<String>,
) -> ModelMutationResult {
    let inventory = cache.inventory(active_variant);
    ModelMutationResult {
        active_variant,
        model_storage_bytes: inventory.model_storage_bytes,
        cleanup_warning,
        inventory: inventory.gguf_variants,
    }
}

fn cleanup_warning(prefix: &str, errors: Vec<String>) -> Option<String> {
    (!errors.is_empty()).then(|| format!("{prefix}：{}", errors.join("；")))
}

fn ensure_no_active_download(state: &DownloadTaskState) -> Result<(), String> {
    if state.is_active() {
        Err(DOWNLOAD_BUSY_ERROR.to_string())
    } else {
        Ok(())
    }
}

fn validate_variant(cache: &ModelCache, variant: GgufModelVariant) -> Result<(), String> {
    let paths = cache.resolve(variant);
    if !file_is_valid(&paths.model, "model") {
        return Err("模型文件校验失败，请重新下载。".to_string());
    }
    if !file_is_valid(&paths.mmproj, "mmproj") {
        return Err("视觉组件校验失败，请重新下载。".to_string());
    }
    Ok(())
}

fn ensure_gguf_backend(backend: InferenceBackend) -> Result<(), String> {
    if backend == InferenceBackend::Llama {
        Ok(())
    } else {
        Err("请先切换到内置 Metal，再安装 GGUF 模型。".to_string())
    }
}

fn safe_force_download(requested: bool, previous_valid: bool) -> bool {
    requested && !previous_valid
}

#[derive(Clone, Copy)]
struct PendingSidecar {
    port: u16,
    generation: u64,
    backend: InferenceBackend,
}

fn start_sidecar(
    app: &AppHandle,
    sidecar: &SidecarState,
    context: &ActiveInferenceContext,
) -> Result<PendingSidecar, String> {
    let (port, generation) = {
        let mut guard = lock_sidecar(sidecar);
        let generation = guard.ensure_started(app, context)?;
        (guard.port, generation)
    };
    Ok(PendingSidecar {
        port,
        generation,
        backend: context.backend,
    })
}

async fn wait_for_started_sidecar(
    app: &AppHandle,
    sidecar: &SidecarState,
    pending: PendingSidecar,
) -> Result<(), String> {
    let cancel = AtomicBool::new(false);
    wait_for_sidecar_ready(
        app,
        pending.port,
        pending.backend,
        pending.generation,
        &cancel,
        sidecar,
    )
    .await?;
    if !lock_sidecar(sidecar).set_service_ready(pending.generation, true) {
        return Err("模型已切换，请重试。".to_string());
    }
    Ok(())
}

trait SwitchOperations {
    fn stop_sidecar(&mut self) -> Result<(), String>;
    fn commit_variant(&mut self, variant: GgufModelVariant) -> Result<(), String>;
    fn spawn_sidecar(&mut self, variant: GgufModelVariant) -> Result<(), String>;
    async fn health_sidecar(&mut self, variant: GgufModelVariant) -> Result<(), String>;
    fn cleanup_inactive(&mut self, active_variant: GgufModelVariant) -> Vec<String>;
}

struct AppSwitchOperations<'a> {
    app: &'a AppHandle,
    sidecar: &'a SidecarState,
    cache: &'a ModelCache,
    pending: Option<PendingSidecar>,
}

impl SwitchOperations for AppSwitchOperations<'_> {
    fn stop_sidecar(&mut self) -> Result<(), String> {
        lock_sidecar(self.sidecar).stop_and_confirm()
    }

    fn commit_variant(&mut self, variant: GgufModelVariant) -> Result<(), String> {
        commit_gguf_model_variant(self.app, variant)
    }

    fn spawn_sidecar(&mut self, variant: GgufModelVariant) -> Result<(), String> {
        let settings = load_settings(self.app)?;
        if settings.gguf_model_variant != variant {
            return Err("模型选择在启动前发生变化，请重试。".to_string());
        }
        let context = ActiveInferenceContext::from_parts(self.app, &settings, self.cache)?;
        if context.backend != InferenceBackend::Llama
            || context.paths.model != self.cache.default_model_path(variant)
        {
            return Err("当前推理模式与所选 GGUF 模型不一致。".to_string());
        }
        if !context.models_ready {
            return Err("新模型尚未就绪。".to_string());
        }
        self.pending = Some(start_sidecar(self.app, self.sidecar, &context)?);
        Ok(())
    }

    async fn health_sidecar(&mut self, _variant: GgufModelVariant) -> Result<(), String> {
        let pending = self
            .pending
            .take()
            .ok_or_else(|| "推理进程尚未启动。".to_string())?;
        wait_for_started_sidecar(self.app, self.sidecar, pending).await
    }

    fn cleanup_inactive(&mut self, active_variant: GgufModelVariant) -> Vec<String> {
        cleanup_inactive_gguf(self.cache, active_variant)
    }
}

async fn rollback_switch<O: SwitchOperations>(
    operations: &mut O,
    previous_variant: GgufModelVariant,
    previous_valid: bool,
    stop_candidate: bool,
) -> Vec<String> {
    let mut errors = Vec::new();
    if stop_candidate {
        if let Err(error) = operations.stop_sidecar() {
            errors.push(format!("停止新模型失败：{error}"));
        }
    }
    if let Err(error) = operations.commit_variant(previous_variant) {
        errors.push(format!("恢复原模型设置失败：{error}"));
        return errors;
    }
    if !previous_valid {
        return errors;
    }
    if let Err(error) = operations.spawn_sidecar(previous_variant) {
        errors.push(format!("恢复原模型失败：{error}"));
        return errors;
    }
    if let Err(error) = operations.health_sidecar(previous_variant).await {
        errors.push(format!("恢复原模型失败：{error}"));
    }
    errors
}

async fn complete_switch<O: SwitchOperations>(
    operations: &mut O,
    previous_variant: GgufModelVariant,
    target_variant: GgufModelVariant,
    previous_valid: bool,
) -> Result<Vec<String>, String> {
    operations.stop_sidecar()?;
    if let Err(error) = operations.commit_variant(target_variant) {
        let rollback = rollback_switch(operations, previous_variant, previous_valid, false).await;
        return Err(format_switch_error(error, rollback));
    }
    if let Err(error) = operations.spawn_sidecar(target_variant) {
        let rollback = rollback_switch(operations, previous_variant, previous_valid, true).await;
        return Err(format_switch_error(error, rollback));
    }
    if let Err(error) = operations.health_sidecar(target_variant).await {
        let rollback = rollback_switch(operations, previous_variant, previous_valid, true).await;
        return Err(format_switch_error(error, rollback));
    }
    Ok(operations.cleanup_inactive(target_variant))
}

async fn complete_validated_switch<O: SwitchOperations>(
    cache: &ModelCache,
    operations: &mut O,
    previous_variant: GgufModelVariant,
    target_variant: GgufModelVariant,
    previous_valid: bool,
) -> Result<Vec<String>, String> {
    validate_variant(cache, target_variant)?;
    complete_switch(operations, previous_variant, target_variant, previous_valid).await
}

pub(crate) async fn install_gguf_model_inner(
    app: AppHandle,
    sidecar: &SidecarState,
    download_state: &DownloadTaskState,
    lifecycle: &ModelLifecycleState,
    variant: GgufModelVariant,
    force: bool,
) -> Result<ModelMutationResult, String> {
    let _mutation = lifecycle.begin_mutation()?;
    let previous_settings = load_settings(&app)?;
    ensure_gguf_backend(previous_settings.inference_backend)?;
    let previous_variant = previous_settings.gguf_model_variant;
    let cache = ModelCache::new(&app)?;
    let previous_valid = cache.resolve(previous_variant).is_complete();

    crate::model_download::gguf::download_model(
        app.clone(),
        download_state,
        // A valid active model and shared mmproj must remain rollback-safe until health passes.
        Some(safe_force_download(force, previous_valid)),
        Some(variant),
    )
    .await?;
    let mut operations = AppSwitchOperations {
        app: &app,
        sidecar,
        cache: &cache,
        pending: None,
    };
    let cleanup_errors = complete_validated_switch(
        &cache,
        &mut operations,
        previous_variant,
        variant,
        previous_valid,
    )
    .await?;
    let warning = cleanup_warning("模型已切换，但部分旧文件未能删除", cleanup_errors);
    Ok(mutation_result(&cache, variant, warning))
}

fn format_switch_error(error: String, rollback_errors: Vec<String>) -> String {
    if rollback_errors.is_empty() {
        format!("新模型启动失败，已恢复原配置：{error}")
    } else {
        format!("新模型启动失败：{error}；{}", rollback_errors.join("；"))
    }
}

#[tauri::command]
pub async fn install_gguf_model(
    app: AppHandle,
    sidecar: State<'_, SidecarState>,
    download_state: State<'_, DownloadTaskState>,
    lifecycle: State<'_, ModelLifecycleState>,
    variant: GgufModelVariant,
    force: Option<bool>,
) -> Result<ModelMutationResult, String> {
    install_gguf_model_inner(
        app,
        sidecar.inner(),
        download_state.inner(),
        lifecycle.inner(),
        variant,
        force.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub fn remove_installed_models(
    app: AppHandle,
    sidecar: State<'_, SidecarState>,
    download_state: State<'_, DownloadTaskState>,
    lifecycle: State<'_, ModelLifecycleState>,
) -> Result<ModelMutationResult, String> {
    ensure_no_active_download(download_state.inner())?;
    let _mutation = lifecycle.begin_mutation()?;
    let settings = load_settings(&app)?;
    let cache = ModelCache::new(&app)?;
    remove_models_after_confirmed_stop(
        &cache,
        settings.gguf_model_variant,
        || lock_sidecar(sidecar.inner()).stop_and_confirm(),
        |path| fs::remove_file(path),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_download::DownloadTaskState;
    use std::collections::VecDeque;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct FakeSwitchOperations {
        events: Vec<String>,
        spawn_results: VecDeque<Result<(), String>>,
        health_results: VecDeque<Result<(), String>>,
        commit_results: VecDeque<Result<(), String>>,
        stop_results: VecDeque<Result<(), String>>,
        cleanup_errors: Vec<String>,
    }

    impl FakeSwitchOperations {
        fn succeeding() -> Self {
            Self {
                events: Vec::new(),
                spawn_results: VecDeque::from([Ok(())]),
                health_results: VecDeque::from([Ok(())]),
                commit_results: VecDeque::from([Ok(())]),
                stop_results: VecDeque::from([Ok(())]),
                cleanup_errors: Vec::new(),
            }
        }
    }

    impl SwitchOperations for FakeSwitchOperations {
        fn stop_sidecar(&mut self) -> Result<(), String> {
            self.events.push("stop".to_string());
            self.stop_results.pop_front().unwrap_or(Ok(()))
        }

        fn commit_variant(&mut self, variant: GgufModelVariant) -> Result<(), String> {
            self.events.push(format!("commit:{variant:?}"));
            self.commit_results.pop_front().unwrap_or(Ok(()))
        }

        fn spawn_sidecar(&mut self, variant: GgufModelVariant) -> Result<(), String> {
            self.events.push(format!("spawn:{variant:?}"));
            self.spawn_results.pop_front().unwrap_or(Ok(()))
        }

        async fn health_sidecar(&mut self, variant: GgufModelVariant) -> Result<(), String> {
            self.events.push(format!("health:{variant:?}"));
            self.health_results.pop_front().unwrap_or(Ok(()))
        }

        fn cleanup_inactive(&mut self, active_variant: GgufModelVariant) -> Vec<String> {
            self.events.push(format!("cleanup:{active_variant:?}"));
            std::mem::take(&mut self.cleanup_errors)
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "minivu-model-lifecycle-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn create_artifacts(root: &Path, variant: GgufModelVariant) -> [PathBuf; 3] {
        let paths = variant_artifacts(root, variant);
        for path in &paths {
            fs::write(path, b"managed").unwrap();
        }
        paths
    }

    #[test]
    fn active_inference_rejects_model_mutation_until_lease_drops() {
        let state = ModelLifecycleState::default();
        let inference = state.begin_inference().unwrap();

        assert_eq!(state.active_inference(), 1);
        assert_eq!(
            state.begin_mutation().err().as_deref(),
            Some(INFERENCE_BUSY_ERROR)
        );

        drop(inference);
        assert_eq!(state.active_inference(), 0);
        assert!(state.begin_mutation().is_ok());
    }

    #[test]
    fn model_mutation_rejects_inference_and_other_mutations() {
        let state = ModelLifecycleState::default();
        let mutation = state.begin_mutation().unwrap();

        assert!(state.is_mutating());
        assert_eq!(
            state.begin_inference().err().as_deref(),
            Some(MUTATION_BUSY_ERROR)
        );
        assert_eq!(
            state.begin_mutation().err().as_deref(),
            Some(MUTATION_BUSY_ERROR)
        );

        drop(mutation);
        assert!(!state.is_mutating());
        assert!(state.begin_inference().is_ok());
    }

    #[test]
    fn active_download_is_rejected_before_removal() {
        let state = DownloadTaskState::default();
        let task = state.begin(GgufModelVariant::Q4KM).unwrap();

        assert_eq!(
            ensure_no_active_download(&state).err().as_deref(),
            Some(DOWNLOAD_BUSY_ERROR)
        );
        drop(task);
        assert!(ensure_no_active_download(&state).is_ok());
    }

    #[test]
    fn gguf_install_rejects_mlx_without_touching_the_running_model() {
        assert!(ensure_gguf_backend(InferenceBackend::Llama).is_ok());
        assert!(ensure_gguf_backend(InferenceBackend::Mlx)
            .unwrap_err()
            .contains("内置 Metal"));
    }

    #[test]
    fn valid_previous_model_disables_destructive_force_until_health_passes() {
        assert!(!safe_force_download(true, true));
        assert!(safe_force_download(true, false));
        assert!(!safe_force_download(false, true));
    }

    #[tokio::test]
    async fn successful_switch_commits_health_checks_then_cleans() {
        let mut operations = FakeSwitchOperations::succeeding();

        let errors = complete_switch(
            &mut operations,
            GgufModelVariant::Q4KM,
            GgufModelVariant::Q5KM,
            true,
        )
        .await
        .unwrap();

        assert!(errors.is_empty());
        assert_eq!(
            operations.events,
            [
                "stop",
                "commit:Q5KM",
                "spawn:Q5KM",
                "health:Q5KM",
                "cleanup:Q5KM"
            ]
        );
    }

    #[tokio::test]
    async fn failed_sidecar_stop_aborts_switch_before_commit_spawn_or_cleanup() {
        let mut operations = FakeSwitchOperations::succeeding();
        operations.stop_results = VecDeque::from([Err("stop not confirmed".to_string())]);

        let error = complete_switch(
            &mut operations,
            GgufModelVariant::Q4KM,
            GgufModelVariant::Q5KM,
            true,
        )
        .await
        .unwrap_err();

        assert!(error.contains("stop not confirmed"));
        assert_eq!(operations.events, ["stop"]);
    }

    #[tokio::test]
    async fn failed_strict_validation_does_not_stop_or_change_the_old_model() {
        let root = temp_dir("failed-preflight");
        let cache = ModelCache { root: root.clone() };
        let mut operations = FakeSwitchOperations::succeeding();

        let error = complete_validated_switch(
            &cache,
            &mut operations,
            GgufModelVariant::Q4KM,
            GgufModelVariant::Q5KM,
            true,
        )
        .await
        .unwrap_err();

        assert!(error.contains("校验失败"));
        assert!(operations.events.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn failed_candidate_health_rolls_back_before_restarting_old_model() {
        let mut operations = FakeSwitchOperations::succeeding();
        operations.health_results =
            VecDeque::from([Err("candidate health failed".to_string()), Ok(())]);
        operations.commit_results = VecDeque::from([Ok(()), Ok(())]);

        let error = complete_switch(
            &mut operations,
            GgufModelVariant::Q4KM,
            GgufModelVariant::Q6K,
            true,
        )
        .await
        .unwrap_err();

        assert!(error.contains("candidate health failed"));
        assert!(error.contains("已恢复原配置"));
        assert_eq!(
            operations.events,
            [
                "stop",
                "commit:Q6K",
                "spawn:Q6K",
                "health:Q6K",
                "stop",
                "commit:Q4KM",
                "spawn:Q4KM",
                "health:Q4KM"
            ]
        );
        assert!(!operations
            .events
            .iter()
            .any(|event| event.starts_with("cleanup")));
    }

    #[tokio::test]
    async fn failed_candidate_spawn_restores_setting_restarts_old_and_skips_cleanup() {
        let mut operations = FakeSwitchOperations::succeeding();
        operations.spawn_results = VecDeque::from([Err("spawn failed".to_string()), Ok(())]);
        operations.commit_results = VecDeque::from([Ok(()), Ok(())]);

        let error = complete_switch(
            &mut operations,
            GgufModelVariant::Q4KM,
            GgufModelVariant::Q5KM,
            true,
        )
        .await
        .unwrap_err();

        assert!(error.contains("spawn failed"));
        assert_eq!(
            operations.events,
            [
                "stop",
                "commit:Q5KM",
                "spawn:Q5KM",
                "stop",
                "commit:Q4KM",
                "spawn:Q4KM",
                "health:Q4KM"
            ]
        );
        assert!(!operations
            .events
            .iter()
            .any(|event| event.starts_with("cleanup")));
    }

    #[tokio::test]
    async fn failed_target_commit_restores_old_setting_without_candidate_cleanup() {
        let mut operations = FakeSwitchOperations::succeeding();
        operations.commit_results = VecDeque::from([Err("disk full".to_string()), Ok(())]);

        complete_switch(
            &mut operations,
            GgufModelVariant::Q4KM,
            GgufModelVariant::Q5KM,
            true,
        )
        .await
        .unwrap_err();

        assert_eq!(
            operations.events,
            [
                "stop",
                "commit:Q5KM",
                "commit:Q4KM",
                "spawn:Q4KM",
                "health:Q4KM"
            ]
        );
    }

    #[tokio::test]
    async fn cleanup_failure_is_returned_after_success_without_rollback() {
        let mut operations = FakeSwitchOperations::succeeding();
        operations.cleanup_errors = vec!["old.part: permission denied".to_string()];

        let errors = complete_switch(
            &mut operations,
            GgufModelVariant::Q4KM,
            GgufModelVariant::Q5KM,
            true,
        )
        .await
        .unwrap();
        let warning = cleanup_warning("模型已切换，但部分旧文件未能删除", errors).unwrap();

        assert!(warning.contains("permission denied"));
        assert_eq!(operations.events.last().unwrap(), "cleanup:Q5KM");
        assert!(!operations.events[4..]
            .iter()
            .any(|event| event.starts_with("commit:Q4KM")));
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_removes_only_inactive_allowlisted_variant_artifacts() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("cleanup-allowlist");
        let active = create_artifacts(&root, GgufModelVariant::Q5KM);
        let inactive_q4 = create_artifacts(&root, GgufModelVariant::Q4KM);
        let inactive_q6 = create_artifacts(&root, GgufModelVariant::Q6K);
        let mmproj = mmproj_artifacts(&root);
        for path in &mmproj {
            fs::write(path, b"shared").unwrap();
        }
        let unknown = root.join("unknown.gguf");
        fs::write(&unknown, b"unknown").unwrap();
        let managed_directory = root.join("minicpm-v-4_6-Q4_K_M.part");
        fs::remove_file(&managed_directory).unwrap();
        fs::create_dir(&managed_directory).unwrap();
        let symlink_path = inactive_q6[0].clone();
        fs::remove_file(&symlink_path).unwrap();
        symlink(&unknown, &symlink_path).unwrap();

        let errors =
            cleanup_inactive_with(&root, GgufModelVariant::Q5KM, |path| fs::remove_file(path));

        assert!(errors.is_empty());
        assert!(active.iter().all(|path| path.exists()));
        assert!(mmproj.iter().all(|path| path.exists()));
        assert!(unknown.exists());
        assert!(managed_directory.is_dir());
        assert!(fs::symlink_metadata(&symlink_path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!inactive_q4[0].exists());
        assert!(!inactive_q4[2].exists());
        assert!(!inactive_q6[1].exists());
        assert!(!inactive_q6[2].exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn explicit_removal_preserves_unknown_directories_and_symlinks() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("removal-allowlist");
        let known = create_artifacts(&root, GgufModelVariant::Q4KM);
        let mmproj = mmproj_artifacts(&root);
        for path in &mmproj {
            fs::write(path, b"shared").unwrap();
        }
        let unknown = root.join("other-model.gguf");
        fs::write(&unknown, b"unknown").unwrap();
        let mlx_cache = root.join("models--mlx-community--MiniCPM");
        fs::create_dir(&mlx_cache).unwrap();
        let symlink_path = variant_artifacts(&root, GgufModelVariant::Q6K)[0].clone();
        symlink(&unknown, &symlink_path).unwrap();

        let errors = remove_all_managed_with(&root, |path| fs::remove_file(path));

        assert!(errors.is_empty());
        assert!(known.iter().all(|path| !path.exists()));
        assert!(mmproj.iter().all(|path| !path.exists()));
        assert!(unknown.exists());
        assert!(mlx_cache.is_dir());
        assert!(fs::symlink_metadata(&symlink_path)
            .unwrap()
            .file_type()
            .is_symlink());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_reports_delete_failures_and_leaves_real_files_for_rescan() {
        let root = temp_dir("cleanup-warning");
        let inactive = create_artifacts(&root, GgufModelVariant::Q4KM);

        let errors = cleanup_inactive_with(&root, GgufModelVariant::Q5KM, |path| {
            if path == inactive[0] {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "denied",
                ))
            } else {
                fs::remove_file(path)
            }
        });

        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("denied"));
        assert!(inactive[0].exists());
        assert!(!inactive[1].exists());
        assert!(!inactive[2].exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn partial_removal_result_rescans_real_inventory_and_storage() {
        let root = temp_dir("partial-removal-result");
        let cache = ModelCache { root: root.clone() };
        let q4 = create_artifacts(&root, GgufModelVariant::Q4KM);
        create_artifacts(&root, GgufModelVariant::Q5KM);
        let mmproj = mmproj_artifacts(&root);
        for path in &mmproj {
            fs::write(path, b"managed").unwrap();
        }
        let remaining_bytes = fs::metadata(&q4[0]).unwrap().len();

        let result = remove_managed_models_with(&cache, GgufModelVariant::Q5KM, |path| {
            if path == q4[0] {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "denied",
                ))
            } else {
                fs::remove_file(path)
            }
        });

        assert!(result
            .cleanup_warning
            .as_deref()
            .unwrap()
            .contains("denied"));
        assert_eq!(result.model_storage_bytes, remaining_bytes);
        assert_eq!(result.active_variant, GgufModelVariant::Q5KM);
        assert_eq!(result.inventory.len(), GGUF_MODEL_SPECS.len());
        let q4_inventory = result
            .inventory
            .iter()
            .find(|item| item.variant == GgufModelVariant::Q4KM)
            .unwrap();
        assert!(!q4_inventory.installed);
        assert_eq!(q4_inventory.installed_bytes, 0);
        assert_eq!(q4_inventory.partial_bytes, 0);
        assert!(q4[0].exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_sidecar_stop_aborts_removal_before_deleting_files() {
        let root = temp_dir("stop-aborts-removal");
        let cache = ModelCache { root: root.clone() };
        let files = create_artifacts(&root, GgufModelVariant::Q4KM);
        let removed = std::cell::Cell::new(false);

        let error = remove_models_after_confirmed_stop(
            &cache,
            GgufModelVariant::Q4KM,
            || Err("stop not confirmed".to_string()),
            |path| {
                removed.set(true);
                fs::remove_file(path)
            },
        )
        .unwrap_err();

        assert!(error.contains("stop not confirmed"));
        assert!(!removed.get());
        assert!(files.iter().all(|path| path.exists()));
        fs::remove_dir_all(root).unwrap();
    }
}
