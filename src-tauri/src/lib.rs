mod media_server;

use std::collections::{HashSet, VecDeque};
use std::future::poll_fn;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Poll, Waker};
use std::time::{Duration, Instant};

use media_server::MediaServer;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const ALLOWED_MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "webm", "mkv", "m4v", "mp3", "wav", "aac", "m4a", "flac", "png", "jpg", "jpeg",
    "gif", "webp",
];

const MAX_CONCURRENT_PROXIES: usize = 2;

static FFMPEG_AVAILABLE: OnceLock<bool> = OnceLock::new();
static FFPROBE_AVAILABLE: OnceLock<bool> = OnceLock::new();

#[derive(serde::Serialize)]
struct MediaTools {
    ffmpeg: bool,
}

#[derive(serde::Serialize)]
struct LocalFileInfo {
    size: u64,
}

struct SemaphoreState {
    available: usize,
    waiters: VecDeque<Waker>,
}

struct ProxySemaphore {
    state: Mutex<SemaphoreState>,
}

impl ProxySemaphore {
    fn new(limit: usize) -> Self {
        Self {
            state: Mutex::new(SemaphoreState {
                available: limit,
                waiters: VecDeque::new(),
            }),
        }
    }

    async fn acquire(self: &Arc<Self>) -> ProxyPermit {
        poll_fn(|cx| {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if guard.available > 0 {
                guard.available -= 1;
                return Poll::Ready(ProxyPermit {
                    semaphore: Arc::clone(self),
                });
            }
            guard.waiters.push_back(cx.waker().clone());
            Poll::Pending
        })
        .await
    }
}

struct ProxyPermit {
    semaphore: Arc<ProxySemaphore>,
}

impl Drop for ProxyPermit {
    fn drop(&mut self) {
        let wakers: Vec<Waker> = {
            let mut guard = self.semaphore.state.lock().unwrap_or_else(|e| e.into_inner());
            guard.available += 1;
            guard.waiters.drain(..).collect()
        };
        for waker in wakers {
            waker.wake();
        }
    }
}

struct ProxyLimiter(Arc<ProxySemaphore>);

struct ApprovedExportPaths(Mutex<HashSet<PathBuf>>);

struct TempFilesGuard(Vec<PathBuf>);

impl Drop for TempFilesGuard {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn command_exists(name: &str) -> bool {
    Command::new(name)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn has_ffmpeg() -> bool {
    *FFMPEG_AVAILABLE.get_or_init(|| command_exists("ffmpeg"))
}

fn has_ffprobe() -> bool {
    *FFPROBE_AVAILABLE.get_or_init(|| command_exists("ffprobe"))
}

fn is_allowed_media_extension(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    let lower = ext.to_ascii_lowercase();
    ALLOWED_MEDIA_EXTENSIONS.contains(&lower.as_str())
}

fn canonicalize_media_file(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("media path is empty".into());
    }
    let text = path.to_str().ok_or("media path is not valid unicode")?;
    if text.contains('\0') {
        return Err("media path is invalid".into());
    }
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.is_file() {
        return Err("media path is not a file".into());
    }
    if !is_allowed_media_extension(&canonical) {
        return Err("unsupported media file extension".into());
    }
    Ok(canonical)
}

fn valid_asset_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
}

fn allow_asset_file<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &Path,
) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_file(path)
        .map_err(|error| error.to_string())
}

fn take_approved_export_path(
    approved: &ApprovedExportPaths,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(raw_path);
    let mut guard = approved
        .0
        .lock()
        .map_err(|_| "export path lock poisoned".to_string())?;
    if !guard.remove(&candidate) {
        return Err("export destination must be selected via the save dialog".into());
    }
    Ok(candidate)
}

fn is_valid_export_extension(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ext == "mp4" || ext == "webm" {
        Some(ext)
    } else {
        None
    }
}

#[tauri::command]
fn media_tools() -> MediaTools {
    MediaTools {
        ffmpeg: has_ffmpeg(),
    }
}

#[tauri::command]
fn local_file_info(path: String) -> Result<LocalFileInfo, String> {
    let candidate = canonicalize_media_file(Path::new(&path))?;
    let metadata = std::fs::metadata(&candidate).map_err(|error| error.to_string())?;

    Ok(LocalFileInfo {
        size: metadata.len(),
    })
}

#[tauri::command]
fn media_base_url(server: tauri::State<MediaServer>) -> String {
    server.base_url()
}

#[tauri::command]
fn media_token(server: tauri::State<MediaServer>) -> String {
    server.token().to_string()
}

#[tauri::command]
fn allow_media_path(
    app: tauri::AppHandle,
    server: tauri::State<MediaServer>,
    path: String,
) -> Result<(), String> {
    let candidate = canonicalize_media_file(Path::new(&path))?;
    server.allow(&candidate)?;
    allow_asset_file(&app, &candidate)
}

fn render_proxy(source: &Path, temp_destination: &Path, destination: &Path) -> Result<(), String> {
    let source_arg = source.to_string_lossy().into_owned();
    let temp_arg = temp_destination.to_string_lossy().into_owned();
    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-i",
            source_arg.as_str(),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-vf",
            "scale=-2:'min(720,ih)'",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "28",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            temp_arg.as_str(),
        ])
        .status()
        .map_err(|error| {
            let _ = std::fs::remove_file(temp_destination);
            format!("ffmpeg failed to start: {error}")
        })?;

    if !status.success() {
        let _ = std::fs::remove_file(temp_destination);
        return Err(format!("ffmpeg exited with {status}"));
    }

    if let Err(error) = std::fs::rename(temp_destination, destination) {
        let _ = std::fs::remove_file(temp_destination);
        return Err(format!("failed to finalize proxy file: {error}"));
    }

    Ok(())
}

#[tauri::command]
async fn generate_proxy(
    app: tauri::AppHandle,
    limiter: tauri::State<'_, ProxyLimiter>,
    source: String,
    asset_id: String,
) -> Result<String, String> {
    if !valid_asset_id(&asset_id) {
        return Err("invalid asset id".into());
    }
    if !has_ffmpeg() {
        return Err("ffmpeg is not installed".into());
    }

    let source_path = canonicalize_media_file(Path::new(&source))?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    let proxy_dir = cache.join("proxies");
    std::fs::create_dir_all(&proxy_dir).map_err(|error| error.to_string())?;
    let destination = proxy_dir.join(format!("{asset_id}.mp4"));
    let temp_destination = proxy_dir.join(format!("{asset_id}.{}.tmp.mp4", std::process::id()));

    let semaphore = Arc::clone(&limiter.0);
    let _permit = semaphore.acquire().await;
    let source_for_task = source_path.clone();
    let temp_for_task = temp_destination.clone();
    let destination_for_task = destination.clone();
    tauri::async_runtime::spawn_blocking(move || {
        render_proxy(&source_for_task, &temp_for_task, &destination_for_task)
    })
    .await
    .map_err(|error| error.to_string())??;

    app.state::<MediaServer>().allow(&destination)?;
    allow_asset_file(&app, &destination)?;
    destination
        .to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "proxy path is not valid unicode".into())
}

#[tauri::command]
fn delete_proxy(app: tauri::AppHandle, asset_id: String) -> Result<(), String> {
    if !valid_asset_id(&asset_id) {
        return Err("invalid asset id".into());
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    let proxy_path = cache.join("proxies").join(format!("{asset_id}.mp4"));
    if proxy_path.exists() {
        app.state::<MediaServer>().disallow(&proxy_path);
        std::fs::remove_file(&proxy_path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn pick_export_path(
    app: tauri::AppHandle,
    approved: tauri::State<'_, ApprovedExportPaths>,
    default_filename: String,
) -> Result<Option<String>, String> {
    let extension = Path::new(&default_filename)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .filter(|ext| ext == "mp4" || ext == "webm")
        .unwrap_or_else(|| "mp4".to_string());

    let app_handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_handle
            .dialog()
            .file()
            .set_file_name(&default_filename)
            .add_filter("Video", &[extension.as_str()])
            .blocking_save_file()
    })
    .await
    .map_err(|error| error.to_string())?;

    let Some(file_path) = picked else {
        return Ok(None);
    };

    let path = file_path
        .into_path()
        .map_err(|error| format!("invalid export path: {error}"))?;
    if is_valid_export_extension(&path).is_none() {
        return Err("export path must end with .mp4 or .webm".into());
    }

    let path_str = path
        .to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "export path is not valid unicode".to_string())?;

    approved
        .0
        .lock()
        .map_err(|_| "export path lock poisoned".to_string())?
        .insert(path);

    Ok(Some(path_str))
}

#[tauri::command]
async fn write_export_bytes(
    approved: tauri::State<'_, ApprovedExportPaths>,
    path: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let destination = take_approved_export_path(&approved, &path)?;
    let ext = is_valid_export_extension(&destination)
        .ok_or_else(|| "export path must end with .mp4 or .webm".to_string())?;
    let parent = destination
        .parent()
        .ok_or_else(|| "invalid export destination directory".to_string())?;
    let file_stem = destination
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("avi-export");
    let temp_path = parent.join(format!(".{file_stem}.{}.tmp.{ext}", std::process::id()));

    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&temp_path, &bytes).map_err(|error| {
            let _ = std::fs::remove_file(&temp_path);
            error.to_string()
        })?;
        std::fs::rename(&temp_path, &destination).map_err(|error| {
            let _ = std::fs::remove_file(&temp_path);
            error.to_string()
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportClipInput {
    pub id: String,
    pub track_type: String,
    pub track_muted: bool,
    pub start_frame: u64,
    pub end_frame: u64,
    pub media_type: String,
    pub source_path: Option<String>,
    pub media_start: Option<u64>,
    pub media_end: Option<u64>,
    pub opacity: Option<f64>,
    pub pixel_filter: Option<String>,
    pub text: Option<String>,
    pub font_size: Option<u32>,
    pub font_color: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTimelineRequest {
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub total_frames: u64,
    pub clips: Vec<ExportClipInput>,
}

fn probe_has_audio(path: &Path) -> bool {
    if !has_ffprobe() {
        return false;
    }
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output();
    match output {
        Ok(res) if res.status.success() => !String::from_utf8_lossy(&res.stdout).trim().is_empty(),
        _ => false,
    }
}

fn ffmpeg_pixel_filter_expr(filter: Option<&str>) -> String {
    match filter {
        Some("grayscale") => ",hue=s=0".to_string(),
        Some("sepia") => {
            ",colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131".to_string()
        }
        Some("invert") => ",negate".to_string(),
        Some("brightness") => {
            ",lutrgb=r='clip(val*1.5,0,255)':g='clip(val*1.5,0,255)':b='clip(val*1.5,0,255)'"
                .to_string()
        }
        Some("warm") => ",colorchannelmixer=rr=1.08:gg=1.0:bb=0.9".to_string(),
        _ => String::new(),
    }
}

fn sanitize_hex_color(color: Option<&str>) -> String {
    let raw = color.unwrap_or("#ffffff").trim();
    if raw.starts_with('#')
        && (raw.len() == 7 || raw.len() == 4)
        && raw[1..].chars().all(|c| c.is_ascii_hexdigit())
    {
        return raw.to_string();
    }
    "#ffffff".to_string()
}

fn escape_ffmpeg_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'")
}

fn build_export_ffmpeg_args(
    request: &ExportTimelineRequest,
    resolved_paths: &[Option<PathBuf>],
    audio_flags: &[bool],
    text_files: &[Option<PathBuf>],
    temp_output: &Path,
    output_ext: &str,
) -> Result<Vec<String>, String> {
    if request.width == 0 || request.height == 0 || request.width > 3840 || request.height > 2160 {
        return Err("invalid export dimensions".into());
    }
    if request.fps == 0 || request.fps > 120 {
        return Err("invalid export fps".into());
    }
    if request.total_frames == 0 {
        return Err("export totalFrames must be >= 1".into());
    }

    let fps = request.fps as f64;
    let total_secs = request.total_frames as f64 / fps;

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!(
            "color=c=#0e0e0e:s={}x{}:r={}:d={total_secs:.6}",
            request.width, request.height, request.fps
        ),
    ];

    let mut input_indices: Vec<Option<usize>> = Vec::with_capacity(request.clips.len());
    let mut next_input_idx = 1usize;

    for (idx, clip) in request.clips.iter().enumerate() {
        let Some(path) = resolved_paths.get(idx).and_then(|p| p.as_ref()) else {
            input_indices.push(None);
            continue;
        };

        let clip_frames = clip.end_frame.saturating_sub(clip.start_frame) + 1;
        let clip_dur = clip_frames as f64 / fps;
        if clip.media_type == "image" {
            args.extend([
                "-loop".into(),
                "1".into(),
                "-t".into(),
                format!("{clip_dur:.6}"),
                "-i".into(),
                path.to_string_lossy().into_owned(),
            ]);
        } else {
            args.extend(["-i".into(), path.to_string_lossy().into_owned()]);
        }
        input_indices.push(Some(next_input_idx));
        next_input_idx += 1;
    }

    let mut filter_parts: Vec<String> = vec!["[0:v]format=rgba[base0]".to_string()];
    let mut current_video = "base0".to_string();
    let mut video_step = 0usize;
    let mut audio_labels: Vec<String> = Vec::new();

    for (idx, clip) in request.clips.iter().enumerate() {
        if clip.end_frame < clip.start_frame {
            continue;
        }
        let t_start = clip.start_frame as f64 / fps;
        let t_end = (clip.end_frame + 1) as f64 / fps;
        let clip_dur = t_end - t_start;
        let media_start_sec = clip.media_start.unwrap_or(0) as f64 / fps;
        let opacity = clip.opacity.unwrap_or(1.0).clamp(0.0, 1.0);

        if clip.media_type == "text" {
            if let Some(text_file) = text_files.get(idx).and_then(|p| p.as_ref()) {
                let scaled_font = (((clip.font_size.unwrap_or(48) as f64)
                    * (request.height as f64 / 720.0))
                    .round() as u32)
                    .max(12);
                let font_color = sanitize_hex_color(clip.font_color.as_deref());
                let next_video = format!("vstep{video_step}");
                video_step += 1;
                let escaped_file = escape_ffmpeg_path(text_file);
                filter_parts.push(format!(
                    "[{current_video}]drawtext=textfile='{escaped_file}':fontcolor={font_color}@{opacity:.3}:fontsize={scaled_font}:x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black@0.6:shadowx=2:shadowy=2:enable='between(t,{t_start:.6},{t_end:.6})'[{next_video}]"
                ));
                current_video = next_video;
            }
            continue;
        }

        let Some(input_idx) = input_indices.get(idx).and_then(|v| *v) else {
            continue;
        };

        if clip.media_type == "video" || clip.media_type == "image" {
            let v_label = format!("clipv{video_step}");
            let next_video = format!("vstep{video_step}");
            video_step += 1;
            let px_filter = ffmpeg_pixel_filter_expr(clip.pixel_filter.as_deref());
            let opacity_expr = if opacity < 0.999 {
                format!(",colorchannelmixer=aa={opacity:.3}")
            } else {
                String::new()
            };

            if clip.media_type == "video" {
                filter_parts.push(format!(
                    "[{input_idx}:v]trim=start={media_start_sec:.6}:duration={clip_dur:.6},setpts=PTS-STARTPTS,fps={fps_val},scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,format=rgba{px_filter}{opacity_expr},setpts=PTS+{t_start:.6}/TB[{v_label}]",
                    fps_val = request.fps,
                    w = request.width,
                    h = request.height,
                ));
            } else {
                filter_parts.push(format!(
                    "[{input_idx}:v]fps={fps_val},scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,format=rgba{px_filter}{opacity_expr},setpts=PTS+{t_start:.6}/TB[{v_label}]",
                    fps_val = request.fps,
                    w = request.width,
                    h = request.height,
                ));
            }

            filter_parts.push(format!(
                "[{current_video}][{v_label}]overlay=0:0:enable='between(t,{t_start:.6},{t_end:.6})':eof_action=pass[{next_video}]"
            ));
            current_video = next_video;
        }

        let has_audio = audio_flags.get(idx).copied().unwrap_or(false);
        if !clip.track_muted
            && (clip.media_type == "audio" || (clip.media_type == "video" && has_audio))
        {
            let a_label = format!("clipa{}", audio_labels.len());
            let delay_ms = (t_start * 1000.0).round() as u64;
            filter_parts.push(format!(
                "[{input_idx}:a]atrim=start={media_start_sec:.6}:duration={clip_dur:.6},asetpts=PTS-STARTPTS,adelay={delay_ms}|{delay_ms}[{a_label}]"
            ));
            audio_labels.push(format!("[{a_label}]"));
        }
    }

    filter_parts.push(format!("[{current_video}]format=yuv420p[vout]"));

    let has_audio_out = !audio_labels.is_empty();
    if audio_labels.len() == 1 {
        let single = audio_labels[0].trim_matches(['[', ']']);
        filter_parts.push(format!("[{single}]apad=whole_dur={total_secs:.6}[aout]"));
    } else if audio_labels.len() > 1 {
        let joined = audio_labels.join("");
        filter_parts.push(format!(
            "{joined}amix=inputs={}:duration=longest:normalize=0,apad=whole_dur={total_secs:.6}[aout]",
            audio_labels.len()
        ));
    }

    args.extend(["-filter_complex".into(), filter_parts.join(";")]);
    args.extend(["-map".into(), "[vout]".into()]);
    if has_audio_out {
        args.extend(["-map".into(), "[aout]".into()]);
    }
    args.extend(["-t".into(), format!("{total_secs:.6}")]);

    if output_ext == "webm" {
        args.extend([
            "-c:v".into(),
            "libvpx-vp9".into(),
            "-crf".into(),
            "28".into(),
            "-b:v".into(),
            "0".into(),
        ]);
        if has_audio_out {
            args.extend(["-c:a".into(), "libopus".into(), "-b:a".into(), "128k".into()]);
        }
    } else {
        args.extend([
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "medium".into(),
            "-crf".into(),
            "18".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-movflags".into(),
            "+faststart".into(),
        ]);
        if has_audio_out {
            args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
        }
    }

    args.push(temp_output.to_string_lossy().into_owned());
    Ok(args)
}

#[tauri::command]
async fn export_timeline(
    app: tauri::AppHandle,
    approved: tauri::State<'_, ApprovedExportPaths>,
    request: ExportTimelineRequest,
) -> Result<String, String> {
    if !has_ffmpeg() {
        return Err("ffmpeg is not installed".into());
    }

    let destination = take_approved_export_path(&approved, &request.output_path)?;
    let output_ext = is_valid_export_extension(&destination)
        .ok_or_else(|| "export path must end with .mp4 or .webm".to_string())?;

    let parent = destination
        .parent()
        .ok_or_else(|| "invalid export destination directory".to_string())?;
    let stem = destination
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("avi-export");
    let temp_output = parent.join(format!(".{stem}.{}.tmp.{output_ext}", std::process::id()));

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    let export_tmp_dir = cache_dir.join("export-tmp");
    std::fs::create_dir_all(&export_tmp_dir).map_err(|error| error.to_string())?;

    let mut resolved_paths: Vec<Option<PathBuf>> = Vec::with_capacity(request.clips.len());
    let mut audio_flags: Vec<bool> = Vec::with_capacity(request.clips.len());
    let mut text_files: Vec<Option<PathBuf>> = Vec::with_capacity(request.clips.len());
    let mut temp_files: Vec<PathBuf> = vec![temp_output.clone()];

    for (idx, clip) in request.clips.iter().enumerate() {
        if clip.media_type == "text" {
            resolved_paths.push(None);
            audio_flags.push(false);
            if let Some(text) = clip.text.as_deref().filter(|t| !t.is_empty()) {
                let text_path =
                    export_tmp_dir.join(format!("text-{}-{idx}.txt", std::process::id()));
                std::fs::write(&text_path, text).map_err(|error| error.to_string())?;
                temp_files.push(text_path.clone());
                text_files.push(Some(text_path));
            } else {
                text_files.push(None);
            }
            continue;
        }

        text_files.push(None);
        let Some(source) = clip.source_path.as_deref() else {
            return Err(format!("clip '{}' has no local source path", clip.id));
        };
        let canonical = canonicalize_media_file(Path::new(source))?;
        let has_audio = if clip.media_type == "audio" {
            true
        } else if clip.media_type == "video" {
            probe_has_audio(&canonical)
        } else {
            false
        };
        resolved_paths.push(Some(canonical));
        audio_flags.push(has_audio);
    }

    let args = build_export_ffmpeg_args(
        &request,
        &resolved_paths,
        &audio_flags,
        &text_files,
        &temp_output,
        &output_ext,
    )?;

    let destination_clone = destination.clone();
    let temp_clone = temp_output.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = TempFilesGuard(temp_files);
        let output = Command::new("ffmpeg")
            .args(&args)
            .output()
            .map_err(|error| format!("ffmpeg failed to start: {error}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail = stderr.lines().rev().take(4).collect::<Vec<_>>().join(" | ");
            return Err(format!("ffmpeg export failed ({}): {tail}", output.status));
        }

        std::fs::rename(&temp_clone, &destination_clone)
            .map_err(|error| format!("failed to finalize exported file: {error}"))?;

        destination_clone
            .to_str()
            .map(ToOwned::to_owned)
            .ok_or_else(|| "export path is not valid unicode".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn respond_html(mut stream: TcpStream, status: &str, html: &str) {
    let body = html.as_bytes();
    let header = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
}

fn handle_oauth_connection(
    stream: TcpStream,
    port: u16,
    app: &tauri::AppHandle,
) -> Option<String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).ok()? == 0 {
        return None;
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;

    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).ok()?;
        if read == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().unwrap_or(0).min(16_384);
            }
        }
    }

    if method == "POST" && target == "/auth/complete" {
        let mut body_bytes = vec![0u8; content_length];
        reader.read_exact(&mut body_bytes).ok()?;
        let full_url = String::from_utf8_lossy(&body_bytes).trim().to_string();
        if full_url.starts_with(&format!("http://127.0.0.1:{port}/auth/callback")) {
            respond_html(stream, "200 OK", "<html><body>Signed in. You can close this tab.</body></html>");
            let _ = app.emit("avi://oauth-callback", &full_url);
            return Some(full_url);
        }
        respond_html(stream, "400 Bad Request", "<html><body>Invalid callback.</body></html>");
        return None;
    }

    if method == "GET" && target.starts_with("/auth/callback") {
        let (_, query) = target.split_once('?').unwrap_or((target, ""));
        if query.contains("code=") || query.contains("error=") {
            let full_url = format!("http://127.0.0.1:{port}{target}");
            respond_html(
                stream,
                "200 OK",
                "<!doctype html><html><body style='font-family:system-ui;background:#111;color:#eee;padding:40px;text-align:center'><h2>Sign-in complete</h2><p>You can close this tab and return to avi.</p></body></html>",
            );
            let _ = app.emit("avi://oauth-callback", &full_url);
            return Some(full_url);
        }

        // Implicit/hash fallback: capture window.location.href in browser and post back to loopback.
        respond_html(
            stream,
            "200 OK",
            "<!doctype html><html><body style='font-family:system-ui;background:#111;color:#eee;padding:40px;text-align:center'><p id='msg'>Completing sign-in…</p><script>fetch('/auth/complete',{method:'POST',body:window.location.href}).then(()=>{document.getElementById('msg').textContent='Sign-in complete. You can close this tab and return to avi.';}).catch(()=>{document.getElementById('msg').textContent='Sign-in failed to relay to avi.';});</script></body></html>",
        );
        return None;
    }

    respond_html(stream, "404 Not Found", "<html><body>Not Found</body></html>");
    None
}

#[tauri::command]
fn start_oauth_loopback(app: tauri::AppHandle) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;

    let redirect_url = format!("http://127.0.0.1:{port}/auth/callback");
    std::thread::Builder::new()
        .name("avi-oauth-loopback".into())
        .spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(180);
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if handle_oauth_connection(stream, port, &app).is_some() {
                            break;
                        }
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|error| error.to_string())?;

    Ok(redirect_url)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("only http/https URLs can be opened externally".into());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = Command::new("xdg-open").arg(&url).spawn();
    #[cfg(target_os = "macos")]
    let spawned = Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let spawned = Command::new("cmd").args(["/C", "start", "", &url]).spawn();

    spawned
        .map(|_| ())
        .map_err(|error| format!("failed to launch system browser: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ProxyLimiter(Arc::new(ProxySemaphore::new(
            MAX_CONCURRENT_PROXIES,
        ))))
        .manage(ApprovedExportPaths(Mutex::new(HashSet::new())))
        .setup(|app| {
            app.manage(MediaServer::start()?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            media_tools,
            local_file_info,
            media_base_url,
            media_token,
            allow_media_path,
            generate_proxy,
            delete_proxy,
            pick_export_path,
            write_export_bytes,
            export_timeline,
            start_oauth_loopback,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running avi");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_allowed_media_extensions() {
        assert!(is_allowed_media_extension(Path::new("/tmp/clip.mp4")));
        assert!(is_allowed_media_extension(Path::new("/tmp/CLIP.MOV")));
        assert!(is_allowed_media_extension(Path::new("/tmp/song.wav")));
        assert!(!is_allowed_media_extension(Path::new("/etc/passwd")));
        assert!(!is_allowed_media_extension(Path::new("/tmp/script.sh")));
    }

    #[test]
    fn builds_ffmpeg_export_args_with_filters_audio_and_text() {
        let req = ExportTimelineRequest {
            output_path: "/tmp/out.mp4".into(),
            width: 1920,
            height: 1080,
            fps: 30,
            total_frames: 90,
            clips: vec![
                ExportClipInput {
                    id: "v1".into(),
                    track_type: "video".into(),
                    track_muted: false,
                    start_frame: 0,
                    end_frame: 59,
                    media_type: "video".into(),
                    source_path: Some("/tmp/in.mp4".into()),
                    media_start: Some(10),
                    media_end: Some(69),
                    opacity: Some(1.0),
                    pixel_filter: Some("grayscale".into()),
                    text: None,
                    font_size: None,
                    font_color: None,
                },
                ExportClipInput {
                    id: "t1".into(),
                    track_type: "overlay".into(),
                    track_muted: false,
                    start_frame: 0,
                    end_frame: 29,
                    media_type: "text".into(),
                    source_path: None,
                    media_start: None,
                    media_end: None,
                    opacity: Some(0.8),
                    pixel_filter: None,
                    text: Some("Hello".into()),
                    font_size: Some(48),
                    font_color: Some("#ffffff".into()),
                },
            ],
        };

        let resolved = vec![Some(PathBuf::from("/tmp/in.mp4")), None];
        let audio = vec![true, false];
        let texts = vec![None, Some(PathBuf::from("/tmp/text-0.txt"))];
        let args = build_export_ffmpeg_args(
            &req,
            &resolved,
            &audio,
            &texts,
            Path::new("/tmp/.out.tmp.mp4"),
            "mp4",
        )
        .unwrap();

        let fc_idx = args.iter().position(|a| a == "-filter_complex").unwrap();
        let fc = &args[fc_idx + 1];
        assert!(fc.contains("hue=s=0"), "{fc}");
        assert!(fc.contains("drawtext=textfile="), "{fc}");
        assert!(fc.contains("fontsize=72"), "{fc}");
        assert!(fc.contains("[aout]"), "{fc}");
        assert!(args.contains(&"+faststart".to_string()));
    }
}
