use crate::settings::GgufModelVariant;
use serde::Serialize;
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadCancelled;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailureSeal {
    Failed,
    Canceled,
}

pub async fn cancelable<T>(
    cancellation: &mut watch::Receiver<bool>,
    operation: impl Future<Output = T>,
) -> Result<T, DownloadCancelled> {
    if *cancellation.borrow() {
        return Err(DownloadCancelled);
    }
    tokio::select! {
        biased;
        _ = cancellation.changed() => Err(DownloadCancelled),
        output = operation => Ok(output),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTaskSnapshot {
    pub task_id: u64,
    pub variant: GgufModelVariant,
    pub status: String,
    pub file: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub source: Option<String>,
}

struct ActiveTask {
    snapshot: DownloadTaskSnapshot,
    cancel: watch::Sender<bool>,
    phase: DownloadTaskPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadTaskPhase {
    Running,
    CancelRequested,
    Finalizing,
    Completed,
    Failed,
    Canceled,
}

#[derive(Default)]
struct DownloadTaskInner {
    next_task_id: u64,
    active: Option<ActiveTask>,
    latest_terminal: Option<DownloadTaskSnapshot>,
    last_terminal_task_id: Option<u64>,
}

#[derive(Clone, Default)]
pub struct DownloadTaskState {
    inner: Arc<Mutex<DownloadTaskInner>>,
}

pub struct DownloadTaskGuard {
    state: DownloadTaskState,
    task_id: u64,
    variant: GgufModelVariant,
    cancellation: watch::Receiver<bool>,
}

pub struct FinalizationLease {
    state: DownloadTaskState,
    task_id: u64,
    restore_running: bool,
}

impl DownloadTaskState {
    pub fn begin(&self, variant: GgufModelVariant) -> Result<DownloadTaskGuard, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(active) = &inner.active {
            return Err(format!(
                "已有模型下载任务正在运行（taskId: {}）",
                active.snapshot.task_id
            ));
        }

        inner.next_task_id = inner
            .next_task_id
            .checked_add(1)
            .ok_or_else(|| "模型下载任务 ID 已耗尽".to_string())?;
        let task_id = inner.next_task_id;
        let (cancel, cancellation) = watch::channel(false);
        inner.active = Some(ActiveTask {
            snapshot: DownloadTaskSnapshot {
                task_id,
                variant,
                status: "running".to_string(),
                file: None,
                downloaded: 0,
                total: None,
                source: None,
            },
            cancel,
            phase: DownloadTaskPhase::Running,
        });
        Ok(DownloadTaskGuard {
            state: self.clone(),
            task_id,
            variant,
            cancellation,
        })
    }

    pub fn snapshot(&self) -> Option<DownloadTaskSnapshot> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner
            .active
            .as_ref()
            .map(|active| active.snapshot.clone())
            .or_else(|| inner.latest_terminal.clone())
    }

    pub fn cancel(&self, task_id: u64) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if inner.active.is_none() {
            return if inner.last_terminal_task_id == Some(task_id) {
                Err("取消请求太晚：该模型下载任务已经结束".to_string())
            } else {
                Err("当前没有正在运行的模型下载任务".to_string())
            };
        }
        let active = inner.active.as_mut().expect("active task checked above");
        if active.snapshot.task_id != task_id {
            return Err(format!(
                "任务 ID 已失效：当前任务为 {}，不会取消当前下载",
                active.snapshot.task_id
            ));
        }
        match active.phase {
            DownloadTaskPhase::Running => {
                active.phase = DownloadTaskPhase::CancelRequested;
                active.snapshot.status = "cancelRequested".to_string();
                active
                    .cancel
                    .send(true)
                    .map_err(|_| "下载任务已结束".to_string())
            }
            DownloadTaskPhase::CancelRequested => Err("该模型下载任务已接受取消请求".to_string()),
            DownloadTaskPhase::Finalizing => {
                Err("取消请求太晚：模型文件正在完成安装，未接受取消".to_string())
            }
            DownloadTaskPhase::Completed
            | DownloadTaskPhase::Failed
            | DownloadTaskPhase::Canceled => {
                Err("取消请求太晚：该模型下载任务已经结束".to_string())
            }
        }
    }

    fn clear(&self, task_id: u64) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if inner.active.as_ref().map(|active| active.snapshot.task_id) == Some(task_id) {
            let terminal_snapshot = inner.active.as_ref().and_then(|active| {
                matches!(
                    active.snapshot.status.as_str(),
                    "done" | "failed" | "canceled"
                )
                .then(|| active.snapshot.clone())
            });
            if inner
                .active
                .as_ref()
                .map(|active| {
                    matches!(
                        active.phase,
                        DownloadTaskPhase::Completed
                            | DownloadTaskPhase::Failed
                            | DownloadTaskPhase::Canceled
                    )
                })
                .unwrap_or(false)
            {
                inner.last_terminal_task_id = Some(task_id);
            }
            inner.active = None;
            if terminal_snapshot.is_some() {
                inner.latest_terminal = terminal_snapshot;
            }
        }
    }
}

impl DownloadTaskGuard {
    pub fn task_id(&self) -> u64 {
        self.task_id
    }

    pub fn variant(&self) -> GgufModelVariant {
        self.variant
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancellation.borrow()
    }

    pub fn cancellation(&self) -> watch::Receiver<bool> {
        self.cancellation.clone()
    }

    pub fn checkpoint(&self) -> Result<(), DownloadCancelled> {
        let inner = self
            .state
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match inner
            .active
            .as_ref()
            .filter(|active| active.snapshot.task_id == self.task_id)
            .map(|active| active.phase)
        {
            Some(DownloadTaskPhase::Running) => Ok(()),
            _ => Err(DownloadCancelled),
        }
    }

    pub fn begin_finalization(&self) -> Result<FinalizationLease, DownloadCancelled> {
        let mut inner = self
            .state
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let active = inner
            .active
            .as_mut()
            .filter(|active| active.snapshot.task_id == self.task_id)
            .ok_or(DownloadCancelled)?;
        if active.phase != DownloadTaskPhase::Running {
            return Err(DownloadCancelled);
        }
        active.phase = DownloadTaskPhase::Finalizing;
        active.snapshot.status = "finalizing".to_string();
        Ok(FinalizationLease {
            state: self.state.clone(),
            task_id: self.task_id,
            restore_running: true,
        })
    }

    pub(crate) fn seal_failure(&self) -> Result<FailureSeal, DownloadCancelled> {
        let mut inner = self
            .state
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let active = inner
            .active
            .as_mut()
            .filter(|active| active.snapshot.task_id == self.task_id)
            .ok_or(DownloadCancelled)?;
        match active.phase {
            DownloadTaskPhase::Running => {
                active.phase = DownloadTaskPhase::Failed;
                active.snapshot.status = "failed".to_string();
                Ok(FailureSeal::Failed)
            }
            DownloadTaskPhase::CancelRequested => {
                active.phase = DownloadTaskPhase::Canceled;
                active.snapshot.status = "canceled".to_string();
                Ok(FailureSeal::Canceled)
            }
            DownloadTaskPhase::Failed => Ok(FailureSeal::Failed),
            DownloadTaskPhase::Canceled => Ok(FailureSeal::Canceled),
            DownloadTaskPhase::Finalizing | DownloadTaskPhase::Completed => Err(DownloadCancelled),
        }
    }

    pub fn update(
        &self,
        status: &str,
        file: Option<&str>,
        downloaded: u64,
        total: Option<u64>,
        source: Option<&str>,
    ) {
        let mut inner = self
            .state
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(active) = inner
            .active
            .as_mut()
            .filter(|active| active.snapshot.task_id == self.task_id)
        {
            match active.phase {
                DownloadTaskPhase::Running | DownloadTaskPhase::Finalizing => {
                    active.snapshot.status = status.to_string();
                    if status == "failed" {
                        active.phase = DownloadTaskPhase::Failed;
                    }
                }
                DownloadTaskPhase::CancelRequested if status == "canceled" => {
                    active.phase = DownloadTaskPhase::Canceled;
                    active.snapshot.status = status.to_string();
                }
                DownloadTaskPhase::Completed if status == "done" => {
                    active.snapshot.status = status.to_string();
                }
                DownloadTaskPhase::Failed
                | DownloadTaskPhase::Canceled
                | DownloadTaskPhase::CancelRequested
                | DownloadTaskPhase::Completed => {}
            }
            active.snapshot.file = file.map(str::to_string);
            active.snapshot.downloaded = downloaded;
            active.snapshot.total = total;
            active.snapshot.source = source.map(str::to_string);
        }
    }
}

impl FinalizationLease {
    pub fn commit_terminal(mut self) {
        let mut inner = self
            .state
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(active) = inner
            .active
            .as_mut()
            .filter(|active| active.snapshot.task_id == self.task_id)
        {
            if active.phase == DownloadTaskPhase::Finalizing {
                active.phase = DownloadTaskPhase::Completed;
            }
        }
        self.restore_running = false;
    }
}

impl Drop for FinalizationLease {
    fn drop(&mut self) {
        if !self.restore_running {
            return;
        }
        let mut inner = self
            .state
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(active) = inner
            .active
            .as_mut()
            .filter(|active| active.snapshot.task_id == self.task_id)
        {
            if active.phase == DownloadTaskPhase::Finalizing {
                active.phase = DownloadTaskPhase::Running;
                active.snapshot.status = "running".to_string();
            }
        }
    }
}

impl Drop for DownloadTaskGuard {
    fn drop(&mut self) {
        self.state.clear(self.task_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::GgufModelVariant;
    use std::future::pending;
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    #[test]
    fn rejects_a_second_task_and_only_matching_id_can_cancel() {
        let state = DownloadTaskState::default();
        let first = state
            .begin(GgufModelVariant::Q4KM)
            .expect("first task should start");

        assert!(state.begin(GgufModelVariant::Q5KM).is_err());
        assert!(state.cancel(first.task_id() + 1).is_err());
        assert!(!first.is_cancelled());
        state
            .cancel(first.task_id())
            .expect("matching task should cancel");
        assert!(first.is_cancelled());
    }

    #[tokio::test]
    async fn cancellation_wins_while_an_operation_is_pending() {
        let state = DownloadTaskState::default();
        let task = state.begin(GgufModelVariant::Q4KM).unwrap();
        let task_id = task.task_id();
        let mut cancellation = task.cancellation();
        let cancel_state = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancel_state.cancel(task_id).unwrap();
        });

        let result = tokio::time::timeout(
            Duration::from_millis(100),
            cancelable(&mut cancellation, pending::<()>()),
        )
        .await
        .expect("cancellation should not wait for the pending operation");

        assert_eq!(result, Err(DownloadCancelled));
    }

    #[test]
    fn guard_cleanup_preserves_monotonic_ids() {
        let state = DownloadTaskState::default();
        let first_id = {
            let first = state.begin(GgufModelVariant::Q4KM).unwrap();
            first.task_id()
        };
        assert!(state.snapshot().is_none());

        let second = state.begin(GgufModelVariant::Q5KM).unwrap();
        assert!(second.task_id() > first_id);
    }

    #[test]
    fn terminal_snapshots_remain_observable_after_guard_cleanup() {
        for status in ["done", "failed", "canceled"] {
            let state = DownloadTaskState::default();
            let task = state.begin(GgufModelVariant::Q4KM).unwrap();
            let task_id = task.task_id();
            task.update(status, Some("model"), 42, Some(100), Some("local"));
            drop(task);

            let snapshot = state.snapshot().expect("terminal snapshot should remain");
            assert_eq!(snapshot.task_id, task_id);
            assert_eq!(snapshot.status, status);
            assert_eq!(snapshot.downloaded, 42);
        }
    }

    #[test]
    fn active_task_supersedes_terminal_snapshot_without_stale_cancellation() {
        let state = DownloadTaskState::default();
        let old_task = state.begin(GgufModelVariant::Q4KM).unwrap();
        let old_task_id = old_task.task_id();
        old_task.update("failed", Some("model"), 42, Some(100), Some("local"));
        drop(old_task);

        let active = state.begin(GgufModelVariant::Q5KM).unwrap();
        assert_eq!(state.snapshot().unwrap().task_id, active.task_id());

        let error = state.cancel(old_task_id).unwrap_err();
        assert!(error.contains("失效"));
        assert!(!active.is_cancelled());
    }

    #[test]
    fn progress_snapshot_retains_task_and_variant_identity() {
        let state = DownloadTaskState::default();
        let task = state.begin(GgufModelVariant::Q6K).unwrap();
        task.update("running", Some("model"), 42, Some(100), Some("HuggingFace"));

        let snapshot = state.snapshot().unwrap();
        assert_eq!(snapshot.task_id, task.task_id());
        assert_eq!(snapshot.variant, GgufModelVariant::Q6K);
        assert_eq!(snapshot.file.as_deref(), Some("model"));
        assert_eq!(snapshot.downloaded, 42);
        assert_eq!(snapshot.total, Some(100));
        assert_eq!(snapshot.source.as_deref(), Some("HuggingFace"));
    }

    #[test]
    fn exactly_one_of_cancel_and_finalization_wins() {
        for _ in 0..100 {
            let state = DownloadTaskState::default();
            let task = Arc::new(state.begin(GgufModelVariant::Q4KM).unwrap());
            let barrier = Arc::new(Barrier::new(3));

            let cancel_state = state.clone();
            let cancel_barrier = barrier.clone();
            let task_id = task.task_id();
            let cancel = std::thread::spawn(move || {
                cancel_barrier.wait();
                cancel_state.cancel(task_id).is_ok()
            });

            let finalize_task = task.clone();
            let finalize_barrier = barrier.clone();
            let finalize = std::thread::spawn(move || {
                finalize_barrier.wait();
                finalize_task.begin_finalization().ok()
            });

            barrier.wait();
            let cancel_won = cancel.join().unwrap();
            let finalization = finalize.join().unwrap();
            assert_ne!(cancel_won, finalization.is_some());
            drop(finalization);
        }
    }

    #[test]
    fn cancellation_before_failure_seal_resolves_as_canceled() {
        let state = DownloadTaskState::default();
        let task = state.begin(GgufModelVariant::Q4KM).unwrap();
        let task_id = task.task_id();
        state.cancel(task_id).unwrap();

        assert_eq!(task.seal_failure().unwrap(), FailureSeal::Canceled);
        assert_eq!(state.snapshot().unwrap().status, "canceled");
        drop(task);

        assert_eq!(state.snapshot().unwrap().status, "canceled");
        assert!(state.cancel(task_id).unwrap_err().contains("太晚"));
    }

    #[test]
    fn failure_seal_before_cancellation_retains_failed_terminal() {
        let state = DownloadTaskState::default();
        let task = state.begin(GgufModelVariant::Q4KM).unwrap();
        let task_id = task.task_id();

        assert_eq!(task.seal_failure().unwrap(), FailureSeal::Failed);
        assert_eq!(state.snapshot().unwrap().status, "failed");
        assert!(state.cancel(task_id).unwrap_err().contains("太晚"));
        drop(task);

        assert_eq!(state.snapshot().unwrap().status, "failed");
        assert!(state.cancel(task_id).unwrap_err().contains("太晚"));
    }

    #[test]
    fn accepted_cancellation_prevents_finalization() {
        let state = DownloadTaskState::default();
        let task = state.begin(GgufModelVariant::Q4KM).unwrap();
        state.cancel(task.task_id()).unwrap();

        assert!(task.begin_finalization().is_err());
    }

    #[test]
    fn cancellation_is_rejected_as_too_late_during_finalization() {
        let state = DownloadTaskState::default();
        let task = state.begin(GgufModelVariant::Q4KM).unwrap();
        let _finalization = task.begin_finalization().unwrap();

        let error = state.cancel(task.task_id()).unwrap_err();

        assert!(error.contains("太晚"));
        assert!(!task.is_cancelled());
    }

    #[test]
    fn completed_task_id_remains_too_late_after_guard_cleanup() {
        let state = DownloadTaskState::default();
        let task = state.begin(GgufModelVariant::Q4KM).unwrap();
        let task_id = task.task_id();
        task.begin_finalization().unwrap().commit_terminal();
        drop(task);

        let error = state.cancel(task_id).unwrap_err();

        assert!(error.contains("太晚"));
    }
}
