use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use image::ImageFormat;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
const THUMBNAIL_EDGE_PX: u32 = 320;
const THUMBNAIL_JPEG_QUALITY: u8 = 82;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureSource {
    Capture,
    Paste,
    Drag,
    File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OcrState {
    Pending,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMessage {
    pub role: CaptureMessageRole,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRecord {
    pub id: String,
    pub source: CaptureSource,
    pub title: Option<String>,
    pub ocr_text: String,
    pub ocr_state: OcrState,
    pub messages: Vec<CaptureMessage>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub expires_at_ms: Option<i64>,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRecordSummary {
    pub id: String,
    pub source: CaptureSource,
    pub title: Option<String>,
    pub ocr_state: OcrState,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub expires_at_ms: Option<i64>,
    pub pinned: bool,
}

impl From<&CaptureRecord> for CaptureRecordSummary {
    fn from(record: &CaptureRecord) -> Self {
        Self {
            id: record.id.clone(),
            source: record.source,
            title: record.title.clone(),
            ocr_state: record.ocr_state,
            created_at_ms: record.created_at_ms,
            updated_at_ms: record.updated_at_ms,
            expires_at_ms: record.expires_at_ms,
            pinned: record.pinned,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureRecordAction {
    Created,
    Updated,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRecordChanged {
    pub action: CaptureRecordAction,
    pub id: String,
    pub summary: CaptureRecordSummary,
}

impl CaptureRecordChanged {
    fn new(action: CaptureRecordAction, record: &CaptureRecord) -> Self {
        Self {
            action,
            id: record.id.clone(),
            summary: CaptureRecordSummary::from(record),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum CaptureRetention {
    #[serde(rename = "none")]
    None,
    #[default]
    #[serde(rename = "24h")]
    Hours24,
    #[serde(rename = "7d")]
    Days7,
    #[serde(rename = "forever")]
    Forever,
}

impl CaptureRetention {
    fn expires_at_ms(self, now_ms: i64) -> Option<i64> {
        match self {
            Self::None => Some(now_ms),
            Self::Hours24 => Some(now_ms.saturating_add(DAY_MS)),
            Self::Days7 => Some(now_ms.saturating_add(7 * DAY_MS)),
            Self::Forever => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCaptureInput {
    pub image_data_url: String,
    pub source: CaptureSource,
    #[serde(default)]
    pub retention: CaptureRetention,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NullablePatch<T> {
    Unset,
    Set(Option<T>),
}

impl<T> Default for NullablePatch<T> {
    fn default() -> Self {
        Self::Unset
    }
}

impl<'de, T> Deserialize<'de> for NullablePatch<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Self::Set)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRecordPatch {
    #[serde(default)]
    pub title: NullablePatch<String>,
    pub ocr_text: Option<String>,
    pub ocr_state: Option<OcrState>,
    pub messages: Option<Vec<CaptureMessage>>,
    pub pinned: Option<bool>,
}

pub struct CaptureStore {
    captures_dir: PathBuf,
}

#[derive(Default)]
struct CaptureStoreState {
    transient: HashMap<(PathBuf, String), TransientCapture>,
}

struct TransientCapture {
    record: CaptureRecord,
    image_png: Vec<u8>,
    thumbnail_jpeg: Vec<u8>,
}

static CAPTURE_STORE_STATE: OnceLock<Mutex<CaptureStoreState>> = OnceLock::new();

fn capture_store_state() -> &'static Mutex<CaptureStoreState> {
    CAPTURE_STORE_STATE.get_or_init(|| Mutex::new(CaptureStoreState::default()))
}

impl CaptureStore {
    pub fn new(app_data_dir: impl AsRef<Path>) -> Self {
        Self {
            captures_dir: app_data_dir.as_ref().join("captures"),
        }
    }

    pub fn create(&self, input: CreateCaptureInput, now_ms: i64) -> Result<CaptureRecord, String> {
        self.with_state(|state| self.create_locked(input, now_ms, state))
    }

    fn create_locked(
        &self,
        input: CreateCaptureInput,
        now_ms: i64,
        state: &mut CaptureStoreState,
    ) -> Result<CaptureRecord, String> {
        let image = decode_image_data_url(&input.image_data_url)?;
        let is_transient = input.retention == CaptureRetention::None;
        let record = CaptureRecord {
            id: Uuid::new_v4().hyphenated().to_string(),
            source: input.source,
            title: None,
            ocr_text: String::new(),
            ocr_state: OcrState::Pending,
            messages: Vec::new(),
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            expires_at_ms: input.retention.expires_at_ms(now_ms),
            pinned: false,
        };

        if is_transient {
            state
                .transient
                .retain(|(captures_dir, _), _| captures_dir != &self.captures_dir);
            state.transient.insert(
                self.transient_key(&record.id),
                TransientCapture {
                    record: record.clone(),
                    image_png: encode_original(&image)?,
                    thumbnail_jpeg: encode_thumbnail(&image)?,
                },
            );
            return Ok(record);
        }

        let record_dir = self.record_dir(&record.id)?;
        fs::create_dir_all(&record_dir).map_err(|error| error.to_string())?;

        let result = (|| {
            write_original(&record_dir.join("image.png"), &image)?;
            write_thumbnail(&record_dir.join("thumbnail.jpg"), &image)?;
            write_metadata_atomically(&record_dir, &record)
        })();
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&record_dir);
            return Err(error);
        }

        Ok(record)
    }

    pub fn get(&self, id: &str) -> Result<Option<CaptureRecord>, String> {
        self.with_state(|state| self.get_locked(id, state))
    }

    fn get_locked(
        &self,
        id: &str,
        state: &CaptureStoreState,
    ) -> Result<Option<CaptureRecord>, String> {
        validate_capture_id(id)?;
        if let Some(capture) = state.transient.get(&self.transient_key(id)) {
            let mut record = capture.record.clone();
            sanitize_legacy_ocr_diagnostics(&mut record);
            return Ok(Some(record));
        }
        let metadata_path = self.record_dir(id)?.join("metadata.json");
        match fs::read(metadata_path) {
            Ok(bytes) => {
                let mut record: CaptureRecord =
                    serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
                sanitize_legacy_ocr_diagnostics(&mut record);
                Ok(Some(record))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn list(
        &self,
        query: Option<&str>,
        pinned_only: bool,
    ) -> Result<Vec<CaptureRecord>, String> {
        self.with_state(|state| self.list_locked(query, pinned_only, state))
    }

    fn list_locked(
        &self,
        query: Option<&str>,
        pinned_only: bool,
        state: &CaptureStoreState,
    ) -> Result<Vec<CaptureRecord>, String> {
        let entries = match fs::read_dir(&self.captures_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        let normalized_query = query.map(str::trim).unwrap_or_default().to_lowercase();
        let mut records = Vec::new();

        for entry in entries {
            let Ok(entry) = entry else { continue };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let Some(directory_id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Ok(Some(record)) = self.get_locked(&directory_id, state) else {
                continue;
            };
            if record.id != directory_id || (pinned_only && !record.pinned) {
                continue;
            }
            if !normalized_query.is_empty() {
                let title_matches = record
                    .title
                    .as_deref()
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains(&normalized_query);
                let ocr_matches = record.ocr_text.to_lowercase().contains(&normalized_query);
                if !title_matches && !ocr_matches {
                    continue;
                }
            }
            records.push(record);
        }

        records.sort_by(|left, right| {
            right
                .created_at_ms
                .cmp(&left.created_at_ms)
                .then_with(|| right.updated_at_ms.cmp(&left.updated_at_ms))
                .then_with(|| right.id.cmp(&left.id))
        });
        Ok(records)
    }

    pub fn read_image(&self, id: &str, thumbnail: bool) -> Result<String, String> {
        self.with_state(|state| self.read_image_locked(id, thumbnail, state))
    }

    fn read_image_locked(
        &self,
        id: &str,
        thumbnail: bool,
        state: &CaptureStoreState,
    ) -> Result<String, String> {
        validate_capture_id(id)?;
        let (filename, mime_type) = if thumbnail {
            ("thumbnail.jpg", "image/jpeg")
        } else {
            ("image.png", "image/png")
        };
        let key = self.transient_key(id);
        let bytes = if let Some(capture) = state.transient.get(&key) {
            if thumbnail {
                capture.thumbnail_jpeg.clone()
            } else {
                capture.image_png.clone()
            }
        } else {
            fs::read(self.record_dir(id)?.join(filename)).map_err(|error| error.to_string())?
        };
        Ok(format!(
            "data:{mime_type};base64,{}",
            STANDARD.encode(bytes)
        ))
    }

    pub fn update(
        &self,
        id: &str,
        patch: CaptureRecordPatch,
        now_ms: i64,
    ) -> Result<CaptureRecord, String> {
        self.with_state(|state| self.update_locked(id, patch, now_ms, state))
    }

    fn update_locked(
        &self,
        id: &str,
        patch: CaptureRecordPatch,
        now_ms: i64,
        state: &mut CaptureStoreState,
    ) -> Result<CaptureRecord, String> {
        validate_capture_id(id)?;
        let key = self.transient_key(id);
        if let Some(capture) = state.transient.get_mut(&key) {
            apply_patch(&mut capture.record, patch, now_ms);
            return Ok(capture.record.clone());
        }

        let mut record = self
            .get_locked(id, state)?
            .ok_or_else(|| "capture record not found".to_string())?;
        apply_patch(&mut record, patch, now_ms);
        write_metadata_atomically(&self.record_dir(id)?, &record)?;
        Ok(record)
    }

    pub fn delete(&self, id: &str) -> Result<bool, String> {
        self.with_state(|state| self.delete_locked(id, state))
    }

    fn delete_locked(&self, id: &str, state: &mut CaptureStoreState) -> Result<bool, String> {
        validate_capture_id(id)?;
        if state.transient.remove(&self.transient_key(id)).is_some() {
            return Ok(true);
        }
        let record_dir = self.record_dir(id)?;
        match fs::remove_dir_all(record_dir) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn cleanup(&self, now_ms: i64) -> Result<Vec<CaptureRecord>, String> {
        self.with_state(|state| self.cleanup_locked(now_ms, state))
    }

    fn cleanup_locked(
        &self,
        now_ms: i64,
        state: &mut CaptureStoreState,
    ) -> Result<Vec<CaptureRecord>, String> {
        let mut removed = Vec::new();
        for record in self.list_locked(None, false, state)? {
            let expired = record
                .expires_at_ms
                .is_some_and(|expires_at_ms| expires_at_ms <= now_ms);
            if !record.pinned && expired && self.delete_locked(&record.id, state)? {
                removed.push(record);
            }
        }
        Ok(removed)
    }

    fn with_state<R>(
        &self,
        operation: impl FnOnce(&mut CaptureStoreState) -> Result<R, String>,
    ) -> Result<R, String> {
        let mut state = capture_store_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        operation(&mut state)
    }

    fn transient_key(&self, id: &str) -> (PathBuf, String) {
        (self.captures_dir.clone(), id.to_string())
    }

    fn record_dir(&self, id: &str) -> Result<PathBuf, String> {
        validate_capture_id(id)?;
        Ok(self.captures_dir.join(id))
    }
}

fn sanitize_legacy_ocr_diagnostics(record: &mut CaptureRecord) {
    record.ocr_text = strip_legacy_vision_diagnostics(&record.ocr_text);
    record.title = record.title.take().and_then(|title| {
        let title = strip_legacy_vision_diagnostics(&title);
        (!title.is_empty()).then_some(title)
    });
}

fn strip_legacy_vision_diagnostics(text: &str) -> String {
    const PREFIX: &str = "Unable to find a valid E5 in provided path ";
    const SUFFIX: &str = "@ GetE5PathFromCompositeBundle";

    let mut remaining = text;
    let mut result = String::with_capacity(text.len());

    while let Some(start) = remaining.find(PREFIX) {
        result.push_str(&remaining[..start]);
        let diagnostic = &remaining[start + PREFIX.len()..];
        let Some(end) = diagnostic.find(SUFFIX) else {
            result.push_str(&remaining[start..]);
            return result.trim().to_string();
        };
        remaining = &diagnostic[end + SUFFIX.len()..];
    }

    result.push_str(remaining);
    result.trim().to_string()
}

fn apply_patch(record: &mut CaptureRecord, patch: CaptureRecordPatch, now_ms: i64) {
    if let NullablePatch::Set(title) = patch.title {
        record.title = title;
    }
    if let Some(ocr_text) = patch.ocr_text {
        record.ocr_text = ocr_text;
    }
    if let Some(ocr_state) = patch.ocr_state {
        record.ocr_state = ocr_state;
    }
    if let Some(messages) = patch.messages {
        record.messages = messages;
    }
    if let Some(pinned) = patch.pinned {
        record.pinned = pinned;
    }
    record.updated_at_ms = now_ms;
}

fn validate_capture_id(id: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(id).map_err(|_| "invalid capture id".to_string())?;
    if parsed.hyphenated().to_string() != id {
        return Err("invalid capture id".to_string());
    }
    Ok(())
}

fn decode_image_data_url(data_url: &str) -> Result<image::DynamicImage, String> {
    let (header, payload) = data_url
        .split_once(',')
        .ok_or_else(|| "image must be a data URL".to_string())?;
    if !header.starts_with("data:image/") || !header.ends_with(";base64") {
        return Err("image must be a base64 image data URL".to_string());
    }
    let bytes = STANDARD
        .decode(payload)
        .map_err(|error| error.to_string())?;
    image::load_from_memory(&bytes).map_err(|error| error.to_string())
}

fn encode_original(image: &image::DynamicImage) -> Result<Vec<u8>, String> {
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    Ok(bytes.into_inner())
}

fn encode_thumbnail(image: &image::DynamicImage) -> Result<Vec<u8>, String> {
    let thumbnail = image.thumbnail(THUMBNAIL_EDGE_PX, THUMBNAIL_EDGE_PX);
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, THUMBNAIL_JPEG_QUALITY)
        .encode_image(&thumbnail)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn write_original(path: &Path, image: &image::DynamicImage) -> Result<(), String> {
    let mut file = File::create(path).map_err(|error| error.to_string())?;
    image
        .write_to(&mut file, ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn write_thumbnail(path: &Path, image: &image::DynamicImage) -> Result<(), String> {
    let thumbnail = image.thumbnail(THUMBNAIL_EDGE_PX, THUMBNAIL_EDGE_PX);
    let mut file = File::create(path).map_err(|error| error.to_string())?;
    JpegEncoder::new_with_quality(&mut file, THUMBNAIL_JPEG_QUALITY)
        .encode_image(&thumbnail)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn write_metadata_atomically(record_dir: &Path, record: &CaptureRecord) -> Result<(), String> {
    let temporary_path = record_dir.join("metadata.json.tmp");
    let metadata_path = record_dir.join("metadata.json");
    let mut temporary = File::create(&temporary_path).map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut temporary, record).map_err(|error| error.to_string())?;
    temporary
        .write_all(b"\n")
        .map_err(|error| error.to_string())?;
    temporary.flush().map_err(|error| error.to_string())?;
    temporary.sync_all().map_err(|error| error.to_string())?;
    fs::rename(temporary_path, metadata_path).map_err(|error| error.to_string())
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

fn current_time_ms() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|_| "system time is out of range".to_string())
}

async fn run_store_operation<R, F>(app: &AppHandle, operation: F) -> Result<R, String>
where
    R: Send + 'static,
    F: FnOnce(CaptureStore) -> Result<R, String> + Send + 'static,
{
    let app_data_dir = app_data_dir(app)?;
    tauri::async_runtime::spawn_blocking(move || operation(CaptureStore::new(app_data_dir)))
        .await
        .map_err(|error| error.to_string())?
}

fn emit_record_changed(app: &AppHandle, action: CaptureRecordAction, record: &CaptureRecord) {
    if let Err(error) = app.emit(
        "capture-record-changed",
        CaptureRecordChanged::new(action, record),
    ) {
        eprintln!("failed to emit capture-record-changed: {error}");
    }
}

#[tauri::command]
pub async fn list_capture_records(
    app: AppHandle,
    query: Option<String>,
    pinned_only: Option<bool>,
) -> Result<Vec<CaptureRecord>, String> {
    run_store_operation(&app, move |store| {
        store.list(query.as_deref(), pinned_only.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub async fn get_capture_record(
    app: AppHandle,
    id: String,
) -> Result<Option<CaptureRecord>, String> {
    run_store_operation(&app, move |store| store.get(&id)).await
}

#[tauri::command]
pub async fn read_capture_image(
    app: AppHandle,
    id: String,
    thumbnail: bool,
) -> Result<String, String> {
    run_store_operation(&app, move |store| store.read_image(&id, thumbnail)).await
}

#[tauri::command]
pub async fn create_capture_record(
    app: AppHandle,
    input: CreateCaptureInput,
) -> Result<CaptureRecord, String> {
    let now_ms = current_time_ms()?;
    let (record, removed) = run_store_operation(&app, move |store| {
        let removed = store.cleanup(now_ms)?;
        let record = store.create(input, now_ms)?;
        Ok((record, removed))
    })
    .await?;
    for expired in &removed {
        emit_record_changed(&app, CaptureRecordAction::Deleted, expired);
    }
    emit_record_changed(&app, CaptureRecordAction::Created, &record);
    Ok(record)
}

#[tauri::command]
pub async fn update_capture_record(
    app: AppHandle,
    id: String,
    patch: CaptureRecordPatch,
) -> Result<CaptureRecord, String> {
    let now_ms = current_time_ms()?;
    let record = run_store_operation(&app, move |store| store.update(&id, patch, now_ms)).await?;
    emit_record_changed(&app, CaptureRecordAction::Updated, &record);
    Ok(record)
}

#[tauri::command]
pub async fn delete_capture_record(app: AppHandle, id: String) -> Result<bool, String> {
    let deleted = run_store_operation(&app, move |store| {
        let record = store.get(&id)?;
        match record {
            Some(record) if store.delete(&id)? => Ok(Some(record)),
            _ => Ok(None),
        }
    })
    .await?;
    if let Some(record) = deleted.as_ref() {
        emit_record_changed(&app, CaptureRecordAction::Deleted, record);
    }
    Ok(deleted.is_some())
}

#[tauri::command]
pub async fn cleanup_capture_records(app: AppHandle) -> Result<usize, String> {
    let now_ms = current_time_ms()?;
    let removed = run_store_operation(&app, move |store| store.cleanup(now_ms)).await?;
    for record in &removed {
        emit_record_changed(&app, CaptureRecordAction::Deleted, record);
    }
    Ok(removed.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Barrier};

    const PNG_DATA_URL: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("minivu-capture-store-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn creates_and_loads_a_capture_with_camel_case_metadata() {
        let app_data = TestDir::new();
        let store = CaptureStore::new(app_data.path());

        let record = store
            .create(
                CreateCaptureInput {
                    image_data_url: PNG_DATA_URL.to_string(),
                    source: CaptureSource::Capture,
                    retention: CaptureRetention::Hours24,
                },
                1_000,
            )
            .expect("create capture");

        let record_dir = app_data.path().join("captures").join(&record.id);
        assert!(record_dir.join("image.png").is_file());
        assert!(record_dir.join("thumbnail.jpg").is_file());
        assert_eq!(store.get(&record.id).expect("load capture"), Some(record));

        let metadata =
            fs::read_to_string(record_dir.join("metadata.json")).expect("read capture metadata");
        assert!(metadata.contains("\"ocrText\""));
        assert!(metadata.contains("\"createdAtMs\""));
        assert!(!metadata.contains("ocr_text"));
    }

    #[test]
    fn hides_legacy_vision_diagnostics_when_loading_saved_captures() {
        let app_data = TestDir::new();
        let store = CaptureStore::new(app_data.path());
        let record = store
            .create(
                CreateCaptureInput {
                    image_data_url: PNG_DATA_URL.to_string(),
                    source: CaptureSource::Capture,
                    retention: CaptureRetention::Hours24,
                },
                1_000,
            )
            .expect("create capture");
        let diagnostic = concat!(
            "Unable to find a valid E5 in provided path /System/Library/model.bundle. ",
            "Found bundles : { }. Expected : { universal.bundle }. ",
            "@ GetE5PathFromCompositeBundle",
            "还没有截图",
        );
        store
            .update(
                &record.id,
                CaptureRecordPatch {
                    title: NullablePatch::Set(Some(diagnostic.to_string())),
                    ocr_text: Some(diagnostic.to_string()),
                    ocr_state: Some(OcrState::Ready),
                    ..CaptureRecordPatch::default()
                },
                2_000,
            )
            .expect("save legacy capture");

        let loaded = store.get(&record.id).unwrap().unwrap();

        assert_eq!(loaded.title.as_deref(), Some("还没有截图"));
        assert_eq!(loaded.ocr_text, "还没有截图");
    }

    #[test]
    fn updates_metadata_atomically() {
        let app_data = TestDir::new();
        let store = CaptureStore::new(app_data.path());
        let original = store
            .create(
                CreateCaptureInput {
                    image_data_url: PNG_DATA_URL.to_string(),
                    source: CaptureSource::Paste,
                    retention: CaptureRetention::Hours24,
                },
                2_000,
            )
            .expect("create capture");

        let updated = store
            .update(
                &original.id,
                CaptureRecordPatch {
                    title: NullablePatch::Set(Some("Receipt".to_string())),
                    ocr_text: Some("Total 128".to_string()),
                    ocr_state: Some(OcrState::Ready),
                    ..CaptureRecordPatch::default()
                },
                3_000,
            )
            .expect("update capture");
        let record_dir = app_data.path().join("captures").join(&original.id);
        assert_eq!(updated.title.as_deref(), Some("Receipt"));
        assert_eq!(updated.updated_at_ms, 3_000);
        assert!(!record_dir.join("metadata.json.tmp").exists());
        assert_eq!(store.get(&original.id).unwrap(), Some(updated.clone()));

        fs::create_dir(record_dir.join("metadata.json.tmp")).expect("block temporary file");
        let error = store.update(
            &original.id,
            CaptureRecordPatch {
                title: NullablePatch::Set(Some("Must not persist".to_string())),
                ..CaptureRecordPatch::default()
            },
            4_000,
        );
        assert!(error.is_err());
        assert_eq!(store.get(&original.id).unwrap(), Some(updated));
    }

    #[test]
    fn concurrent_metadata_updates_preserve_all_fields() {
        let app_data = TestDir::new();
        let store = Arc::new(CaptureStore::new(app_data.path()));
        let original = store
            .create(
                CreateCaptureInput {
                    image_data_url: PNG_DATA_URL.to_string(),
                    source: CaptureSource::Capture,
                    retention: CaptureRetention::Hours24,
                },
                1_000,
            )
            .expect("create capture");
        let barrier = Arc::new(Barrier::new(4));

        let updates = [
            CaptureRecordPatch {
                ocr_text: Some("recognized text".to_string()),
                ocr_state: Some(OcrState::Ready),
                ..CaptureRecordPatch::default()
            },
            CaptureRecordPatch {
                messages: Some(vec![CaptureMessage {
                    role: CaptureMessageRole::Assistant,
                    content: "answer".to_string(),
                }]),
                ..CaptureRecordPatch::default()
            },
            CaptureRecordPatch {
                pinned: Some(true),
                ..CaptureRecordPatch::default()
            },
        ];
        let handles = updates
            .into_iter()
            .enumerate()
            .map(|(index, patch)| {
                let store = Arc::clone(&store);
                let barrier = Arc::clone(&barrier);
                let id = original.id.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.update(&id, patch, 2_000 + index as i64)
                })
            })
            .collect::<Vec<_>>();

        barrier.wait();
        for handle in handles {
            handle.join().expect("join update").expect("update record");
        }

        let record = store.get(&original.id).unwrap().unwrap();
        assert_eq!(record.ocr_text, "recognized text");
        assert_eq!(record.ocr_state, OcrState::Ready);
        assert_eq!(
            record.messages,
            vec![CaptureMessage {
                role: CaptureMessageRole::Assistant,
                content: "answer".to_string(),
            }]
        );
        assert!(record.pinned);
    }

    #[test]
    fn lists_newest_first_and_searches_normalized_title_and_ocr() {
        let app_data = TestDir::new();
        let store = CaptureStore::new(app_data.path());
        let old = store
            .create(
                CreateCaptureInput {
                    image_data_url: PNG_DATA_URL.to_string(),
                    source: CaptureSource::File,
                    retention: CaptureRetention::Hours24,
                },
                10,
            )
            .unwrap();
        store
            .update(
                &old.id,
                CaptureRecordPatch {
                    title: NullablePatch::Set(Some("Quarterly Receipt".to_string())),
                    ..CaptureRecordPatch::default()
                },
                11,
            )
            .unwrap();
        let new = store
            .create(
                CreateCaptureInput {
                    image_data_url: PNG_DATA_URL.to_string(),
                    source: CaptureSource::Drag,
                    retention: CaptureRetention::Hours24,
                },
                20,
            )
            .unwrap();
        store
            .update(
                &new.id,
                CaptureRecordPatch {
                    ocr_text: Some("MEETING NOTES".to_string()),
                    ..CaptureRecordPatch::default()
                },
                21,
            )
            .unwrap();

        let all = store.list(None, false).unwrap();
        assert_eq!(
            all.iter().map(|item| &item.id).collect::<Vec<_>>(),
            vec![&new.id, &old.id]
        );

        let by_title = store.list(Some("  receipt  "), false).unwrap();
        assert_eq!(
            by_title.iter().map(|item| &item.id).collect::<Vec<_>>(),
            vec![&old.id]
        );
        let by_ocr = store.list(Some(" meeting "), false).unwrap();
        assert_eq!(
            by_ocr.iter().map(|item| &item.id).collect::<Vec<_>>(),
            vec![&new.id]
        );
    }

    #[test]
    fn pins_a_record_and_filters_the_pinned_list() {
        let app_data = TestDir::new();
        let store = CaptureStore::new(app_data.path());
        let pinned = store
            .create(
                CreateCaptureInput {
                    image_data_url: PNG_DATA_URL.to_string(),
                    source: CaptureSource::Capture,
                    retention: CaptureRetention::Hours24,
                },
                100,
            )
            .unwrap();
        let original_expiry = pinned.expires_at_ms;
        store
            .create(
                CreateCaptureInput {
                    image_data_url: PNG_DATA_URL.to_string(),
                    source: CaptureSource::Capture,
                    retention: CaptureRetention::Hours24,
                },
                200,
            )
            .unwrap();

        let pinned = store
            .update(
                &pinned.id,
                CaptureRecordPatch {
                    pinned: Some(true),
                    ..CaptureRecordPatch::default()
                },
                300,
            )
            .unwrap();

        assert!(pinned.pinned);
        assert_eq!(pinned.expires_at_ms, original_expiry);
        assert_eq!(store.list(None, true).unwrap(), vec![pinned]);
    }

    #[test]
    fn deletes_the_entire_capture_directory() {
        let app_data = TestDir::new();
        let store = CaptureStore::new(app_data.path());
        let record = store
            .create(
                CreateCaptureInput {
                    image_data_url: PNG_DATA_URL.to_string(),
                    source: CaptureSource::Capture,
                    retention: CaptureRetention::Hours24,
                },
                1_000,
            )
            .unwrap();
        let record_dir = app_data.path().join("captures").join(&record.id);

        assert!(store.delete(&record.id).unwrap());
        assert!(!record_dir.exists());
        assert_eq!(store.get(&record.id).unwrap(), None);
        assert!(!store.delete(&record.id).unwrap());
    }

    #[test]
    fn calculates_retention_and_cleans_up_expired_records() {
        let app_data = TestDir::new();
        let store = CaptureStore::new(app_data.path());
        let create = |retention| {
            store
                .create(
                    CreateCaptureInput {
                        image_data_url: PNG_DATA_URL.to_string(),
                        source: CaptureSource::Capture,
                        retention,
                    },
                    500,
                )
                .unwrap()
        };
        let none = create(CaptureRetention::None);
        let hours_24 = create(CaptureRetention::Hours24);
        let days_7 = create(CaptureRetention::Days7);
        let forever = create(CaptureRetention::Forever);

        assert_eq!(none.expires_at_ms, Some(500));
        assert_eq!(hours_24.expires_at_ms, Some(500 + DAY_MS));
        assert_eq!(days_7.expires_at_ms, Some(500 + 7 * DAY_MS));
        assert_eq!(forever.expires_at_ms, None);
        assert!(!app_data.path().join("captures").join(&none.id).exists());
        assert_eq!(store.get(&none.id).unwrap(), Some(none.clone()));
        assert!(store.read_image(&none.id, false).is_ok());
        let transient_update = store
            .update(
                &none.id,
                CaptureRecordPatch {
                    ocr_text: Some("temporary OCR".to_string()),
                    ocr_state: Some(OcrState::Ready),
                    ..CaptureRecordPatch::default()
                },
                501,
            )
            .unwrap();
        assert_eq!(transient_update.ocr_text, "temporary OCR");
        assert_eq!(store.get(&none.id).unwrap(), Some(transient_update.clone()));
        assert!(!store
            .list(None, false)
            .unwrap()
            .iter()
            .any(|record| record.id == none.id));

        let removed = store.cleanup(500).unwrap();
        assert!(removed.is_empty());
        assert_eq!(store.get(&none.id).unwrap(), Some(transient_update));
        assert!(store.get(&hours_24.id).unwrap().is_some());
        assert!(store.get(&days_7.id).unwrap().is_some());
        assert!(store.get(&forever.id).unwrap().is_some());

        let newer_none = create(CaptureRetention::None);
        assert_eq!(store.get(&none.id).unwrap(), None);
        assert_eq!(store.get(&newer_none.id).unwrap(), Some(newer_none));
    }

    #[test]
    fn cleanup_keeps_pinned_records_past_expiry() {
        let app_data = TestDir::new();
        let store = CaptureStore::new(app_data.path());
        let record = store
            .create(
                CreateCaptureInput {
                    image_data_url: PNG_DATA_URL.to_string(),
                    source: CaptureSource::Paste,
                    retention: CaptureRetention::Hours24,
                },
                1_000,
            )
            .unwrap();
        let pinned = store
            .update(
                &record.id,
                CaptureRecordPatch {
                    pinned: Some(true),
                    ..CaptureRecordPatch::default()
                },
                1_001,
            )
            .unwrap();

        assert!(store.cleanup(1_000 + DAY_MS).unwrap().is_empty());
        assert_eq!(store.get(&record.id).unwrap(), Some(pinned));
    }

    #[test]
    fn reads_original_and_thumbnail_as_data_urls() {
        let app_data = TestDir::new();
        let store = CaptureStore::new(app_data.path());
        let record = store
            .create(
                CreateCaptureInput {
                    image_data_url: PNG_DATA_URL.to_string(),
                    source: CaptureSource::Capture,
                    retention: CaptureRetention::Hours24,
                },
                1_000,
            )
            .unwrap();

        let original = store.read_image(&record.id, false).unwrap();
        let thumbnail = store.read_image(&record.id, true).unwrap();
        assert!(original.starts_with("data:image/png;base64,"));
        assert!(thumbnail.starts_with("data:image/jpeg;base64,"));
        for data_url in [original, thumbnail] {
            let payload = data_url.split_once(',').unwrap().1;
            let bytes = STANDARD.decode(payload).unwrap();
            image::load_from_memory(&bytes).expect("stored image is decodable");
        }
    }

    #[test]
    fn rejects_invalid_ids_before_any_path_access() {
        let app_data = TestDir::new();
        let store = CaptureStore::new(app_data.path());
        let invalid = "../outside";

        assert!(store.get(invalid).is_err());
        assert!(store.read_image(invalid, false).is_err());
        assert!(store
            .update(invalid, CaptureRecordPatch::default(), 1_000)
            .is_err());
        assert!(store.delete(invalid).is_err());
        assert!(!app_data.path().join("outside").exists());
    }

    #[test]
    fn list_skips_corrupt_metadata_without_hiding_valid_records() {
        let app_data = TestDir::new();
        let store = CaptureStore::new(app_data.path());
        let valid = store
            .create(
                CreateCaptureInput {
                    image_data_url: PNG_DATA_URL.to_string(),
                    source: CaptureSource::Capture,
                    retention: CaptureRetention::Hours24,
                },
                1_000,
            )
            .unwrap();
        let corrupt = store
            .create(
                CreateCaptureInput {
                    image_data_url: PNG_DATA_URL.to_string(),
                    source: CaptureSource::Capture,
                    retention: CaptureRetention::Hours24,
                },
                2_000,
            )
            .unwrap();
        fs::write(
            app_data
                .path()
                .join("captures")
                .join(&corrupt.id)
                .join("metadata.json"),
            b"{not-json",
        )
        .unwrap();

        assert_eq!(store.list(None, false).unwrap(), vec![valid]);
    }

    #[test]
    fn changed_event_contains_only_action_id_and_lightweight_summary() {
        let record = CaptureRecord {
            id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
            source: CaptureSource::Capture,
            title: Some("Receipt".to_string()),
            ocr_text: "sensitive OCR text".to_string(),
            ocr_state: OcrState::Ready,
            messages: vec![CaptureMessage {
                role: CaptureMessageRole::Assistant,
                content: "long answer".to_string(),
            }],
            created_at_ms: 10,
            updated_at_ms: 20,
            expires_at_ms: Some(30),
            pinned: false,
        };

        let value = serde_json::to_value(CaptureRecordChanged::new(
            CaptureRecordAction::Created,
            &record,
        ))
        .unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 3);
        assert_eq!(value["action"], "created");
        assert_eq!(value["id"], record.id);
        assert!(value["summary"].get("messages").is_none());
        assert!(value["summary"].get("ocrText").is_none());
        assert!(!value.to_string().contains("base64"));
    }
}
