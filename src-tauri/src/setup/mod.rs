pub mod orchestrator;

pub use orchestrator::SetupEnvironmentResult;

use orchestrator::setup_environment as run_setup;
use tauri::AppHandle;

#[tauri::command]
pub async fn setup_environment(app: AppHandle) -> Result<SetupEnvironmentResult, String> {
    run_setup(app).await
}
