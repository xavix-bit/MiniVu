pub mod process;

pub use process::{default_sidecar_port, ModelSidecar};

use std::sync::{Arc, Mutex};

pub type SidecarState = Arc<Mutex<ModelSidecar>>;

pub fn init_sidecar_state() -> SidecarState {
    Arc::new(Mutex::new(ModelSidecar::new(default_sidecar_port())))
}
