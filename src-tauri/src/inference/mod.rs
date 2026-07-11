pub mod backends;
pub mod context;
pub mod health;
pub mod messages;
pub mod session;
pub mod stream;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub type GenerationFlag = Arc<AtomicBool>;

pub fn init_generation_flag() -> GenerationFlag {
    Arc::new(AtomicBool::new(false))
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
