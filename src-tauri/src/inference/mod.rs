pub mod backends;
pub mod context;
pub mod health;
pub mod messages;
pub mod session;
pub mod stream;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub type GenerationFlag = Arc<AtomicBool>;

#[derive(Clone, Default)]
pub struct GenerationRegistry {
    requests: Arc<Mutex<HashMap<String, GenerationFlag>>>,
}

impl GenerationRegistry {
    pub fn begin(&self, request_id: &str) -> GenerationFlag {
        let flag = Arc::new(AtomicBool::new(false));
        let mut requests = self
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(previous) = requests.insert(request_id.to_string(), flag.clone()) {
            previous.store(true, Ordering::SeqCst);
        }
        flag
    }

    pub fn cancel(&self, request_id: &str) {
        let requests = self
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(flag) = requests.get(request_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    pub fn finish(&self, request_id: &str, flag: &GenerationFlag) {
        let mut requests = self
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if requests
            .get(request_id)
            .is_some_and(|current| Arc::ptr_eq(current, flag))
        {
            requests.remove(request_id);
        }
    }
}

pub fn init_generation_registry() -> GenerationRegistry {
    GenerationRegistry::default()
}

#[cfg(test)]
mod generation_registry_tests {
    use super::GenerationRegistry;
    use std::sync::atomic::Ordering;

    #[test]
    fn cancellation_only_targets_one_request() {
        let registry = GenerationRegistry::default();
        let first = registry.begin("first");
        let second = registry.begin("second");

        registry.cancel("first");

        assert!(first.load(Ordering::SeqCst));
        assert!(!second.load(Ordering::SeqCst));
    }

    #[test]
    fn finishing_old_duplicate_does_not_remove_new_request() {
        let registry = GenerationRegistry::default();
        let old = registry.begin("same");
        let current = registry.begin("same");

        registry.finish("same", &old);
        registry.cancel("same");

        assert!(old.load(Ordering::SeqCst));
        assert!(current.load(Ordering::SeqCst));
    }
}

pub use context::ActiveInferenceContext;
pub use health::{
    format_mlx_sidecar_exit_error, sidecar_health_ok, sidecar_health_ok_blocking,
    wait_for_sidecar_ready,
};
pub use messages::{
    build_chat_messages, build_standalone_follow_up_prompt, trim_history, HistoryMessage,
};
pub use session::{run_ask_image, AskImageRequest};
pub use stream::{emit_chunk, sidecar_request_model, stream_from_sidecar, StreamChunk};
