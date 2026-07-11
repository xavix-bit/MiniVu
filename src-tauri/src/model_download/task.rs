use crate::settings::GgufModelVariant;
use serde::Serialize;
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadCancelled;

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
}

#[derive(Default)]
struct DownloadTaskInner {
    next_task_id: u64,
    active: Option<ActiveTask>,
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
        });
        Ok(DownloadTaskGuard {
            state: self.clone(),
            task_id,
            variant,
            cancellation,
        })
    }

    pub fn snapshot(&self) -> Option<DownloadTaskSnapshot> {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active
            .as_ref()
            .map(|active| active.snapshot.clone())
    }

    pub fn cancel(&self, task_id: u64) -> Result<(), String> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let active = inner
            .active
            .as_ref()
            .ok_or_else(|| "当前没有正在运行的模型下载任务".to_string())?;
        if active.snapshot.task_id != task_id {
            return Err(format!(
                "任务 ID 已失效：当前任务为 {}，不会取消当前下载",
                active.snapshot.task_id
            ));
        }
        active
            .cancel
            .send(true)
            .map_err(|_| "下载任务已结束".to_string())
    }

    fn clear(&self, task_id: u64) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if inner.active.as_ref().map(|active| active.snapshot.task_id) == Some(task_id) {
            inner.active = None;
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
            active.snapshot.status = status.to_string();
            active.snapshot.file = file.map(str::to_string);
            active.snapshot.downloaded = downloaded;
            active.snapshot.total = total;
            active.snapshot.source = source.map(str::to_string);
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
}
