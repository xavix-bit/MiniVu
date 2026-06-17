pub mod backends;
pub mod health;
pub mod messages;
pub mod stream;

pub use health::{
    format_mlx_sidecar_exit_error, sidecar_health_ok, sidecar_health_ok_blocking,
    wait_for_sidecar_ready,
};
pub use messages::{
    build_chat_messages, build_standalone_follow_up_prompt, trim_history, HistoryMessage,
};
pub use stream::{emit_chunk, sidecar_request_model, stream_from_sidecar, StreamChunk};
