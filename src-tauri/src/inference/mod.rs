pub mod backends;
pub mod health;
pub mod messages;
pub mod stream;

pub use health::{sidecar_health_ok, wait_for_sidecar_ready};
pub use messages::{
    build_chat_messages, build_standalone_follow_up_prompt, trim_history, HistoryMessage,
};
pub use stream::{emit_chunk, stream_fallback_response, stream_from_sidecar, StreamChunk};
