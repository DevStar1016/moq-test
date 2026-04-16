use std::{
	collections::HashSet,
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use axum::{
	Json,
	body::Body,
	extract::{Multipart, Path as AxumPath, Query, State},
	http::{HeaderMap, HeaderValue, StatusCode},
	response::{IntoResponse, Response},
};
use serde::Serialize;
use sqlx::Row;
use tokio::process::Command;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

#[derive(Debug, serde::Deserialize)]
pub(crate) struct VideoQuery {
	#[serde(default)]
	download: Option<String>,
}

#[derive(Clone)]
pub struct UploadState {
	pub(crate) pool: sqlx::SqlitePool,
	pub(crate) upload_dir_abs: PathBuf,
	pub(crate) media_dir_abs: PathBuf,
	pub(crate) list_path_abs: PathBuf,
}

#[derive(Debug, Serialize)]
pub(crate) struct VideoRow {
	pub(crate) id: String,
	pub(crate) original_name: String,
	pub(crate) video_name: String,
	pub(crate) abs_path: String,
	pub(crate) content_type: Option<String>,
	pub(crate) size_bytes: i64,
	pub(crate) created_at: i64,
	pub(crate) play_url: String,
	pub(crate) download_url: String,
	pub(crate) delete_url: String,
	pub(crate) ffmpeg_ok: bool,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
	error: String,
}

#[derive(Debug, Serialize)]
struct PublishBody {
	channel: String,
}

#[derive(Debug)]
pub(crate) struct ApiError {
	status: StatusCode,
	message: &'static str,
}

impl ApiError {
	fn bad_request(message: &'static str) -> Self {
		Self {
			status: StatusCode::BAD_REQUEST,
			message,
		}
	}

	fn not_found(message: &'static str) -> Self {
		Self {
			status: StatusCode::NOT_FOUND,
			message,
		}
	}

	fn internal(message: &'static str) -> Self {
		Self {
			status: StatusCode::INTERNAL_SERVER_ERROR,
			message,
		}
	}

	fn payload_too_large(message: &'static str) -> Self {
		Self {
			status: StatusCode::PAYLOAD_TOO_LARGE,
			message,
		}
	}
}

impl IntoResponse for ApiError {
	fn into_response(self) -> Response {
		(self.status, Json(ErrorBody { error: self.message.to_string() })).into_response()
	}
}

fn monorepo_root() -> Result<PathBuf, ApiError> {
	let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
		.ancestors()
		.nth(2)
		.ok_or_else(|| ApiError::internal("cannot resolve repo root"))?;
	Ok(repo_root.to_path_buf())
}

pub(crate) async fn publish_concat(AxumPath(channel): AxumPath<String>) -> Result<impl IntoResponse, ApiError> {
	let channel = channel.trim().to_string();
	if channel.is_empty() {
		return Err(ApiError::bad_request("missing channel name"));
	}

	let repo_root = monorepo_root()?;
	let demo_dir = repo_root.join("demo");

	let list_path = repo_root.join("demo/pub/media/list.txt");
	let list_contents = tokio::fs::read_to_string(&list_path)
		.await
		.map_err(|_| ApiError::bad_request("list.txt is missing"))?;
	let has_entries = list_contents
		.lines()
		.map(str::trim)
		.any(|l| !l.is_empty() && !l.starts_with('#'));
	if !has_entries {
		return Err(ApiError::bad_request("list.txt is empty"));
	}

	// `just pub cmaf-concat` is typically a long-running publisher; awaiting `.output()`
	// would block the HTTP response until the process exits (often never), which leaves
	// the web UI publish button disabled waiting on `fetch`.
	let mut child = Command::new("just")
		.current_dir(&demo_dir)
		.args(["pub", "cmaf-concat", "media/list.txt", channel.as_str()])
		.spawn()
		.map_err(|err| {
			tracing::warn!(%err, "failed to spawn publish command");
			ApiError::internal("failed to start publish command")
		})?;

	let channel_log = channel.clone();
	tokio::spawn(async move {
		match child.wait().await {
			Ok(status) if status.success() => {
				tracing::info!(channel = %channel_log, ?status, "publish command exited");
			}
			Ok(status) => {
				tracing::warn!(channel = %channel_log, ?status, "publish command exited with failure");
			}
			Err(err) => {
				tracing::warn!(channel = %channel_log, %err, "publish command wait error");
			}
		}
	});

	Ok((StatusCode::ACCEPTED, Json(PublishBody { channel })))
}

pub(crate) async fn init_db(pool: &sqlx::SqlitePool) -> Result<(), anyhow::Error> {
	sqlx::query(
		r#"
		CREATE TABLE IF NOT EXISTS videos (
			id TEXT PRIMARY KEY NOT NULL,
			original_name TEXT NOT NULL,
			stored_name TEXT NOT NULL,
			abs_path TEXT NOT NULL,
			content_type TEXT,
			size_bytes INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			video_name TEXT,
			ffmpeg_ok INTEGER,
			ffmpeg_error TEXT
		);
		"#,
	)
	.execute(pool)
	.await?;

	let added = sqlx::query(r#"ALTER TABLE videos ADD COLUMN abs_path TEXT"#)
		.execute(pool)
		.await
		.is_ok();
	if added {
		let _ = sqlx::query(
			r#"
			UPDATE videos
			SET abs_path = stored_name
			WHERE abs_path IS NULL
			"#,
		)
		.execute(pool)
		.await;
	}

	let _ = sqlx::query(r#"ALTER TABLE videos ADD COLUMN video_name TEXT"#)
		.execute(pool)
		.await;
	let _ = sqlx::query(r#"ALTER TABLE videos ADD COLUMN ffmpeg_ok INTEGER"#)
		.execute(pool)
		.await;
	let _ = sqlx::query(r#"ALTER TABLE videos ADD COLUMN ffmpeg_error TEXT"#)
		.execute(pool)
		.await;

	let _ = sqlx::query(
		r#"
		UPDATE videos
		SET video_name = stored_name
		WHERE video_name IS NULL
		"#,
	)
	.execute(pool)
	.await;

	let _ = sqlx::query(
		r#"
		UPDATE videos
		SET ffmpeg_ok = 1
		WHERE ffmpeg_ok IS NULL
		"#,
	)
	.execute(pool)
	.await;

	Ok(())
}

pub(crate) async fn upload_video(
	State(state): State<std::sync::Arc<crate::WebState>>,
	mut multipart: Multipart,
) -> Result<impl IntoResponse, ApiError> {
	let state = state.upload.as_ref().ok_or_else(|| ApiError::not_found("upload api disabled"))?;

	while let Some(mut field) = multipart
		.next_field()
		.await
		.map_err(|_| ApiError::bad_request("invalid multipart body"))?
	{
		if field.name() != Some("file") {
			continue;
		}

		let original_name = field
			.file_name()
			.map(|s| s.to_string())
			.unwrap_or_else(|| "upload".to_string());

		let content_type = field.content_type().map(|s| s.to_string());

		if let Some(ct) = content_type.as_deref() {
			if !ct.starts_with("video/") {
				return Err(ApiError::bad_request("file must be a video/* content-type"));
			}
		}

		let id = Uuid::new_v4();
		let created_at = now_unix_seconds();

		let tmp_name = format!(".upload-{id}.tmp");
		let tmp_path = state.upload_dir_abs.join(tmp_name);

		let mut out = tokio::fs::File::create(&tmp_path)
			.await
			.map_err(|_| ApiError::internal("failed to create output file"))?;

		while let Some(chunk) = field
			.chunk()
			.await
			.map_err(|err| {
				tracing::warn!(%err, "failed reading upload stream");
				let msg = err.to_string();
				if msg.to_lowercase().contains("size")
					|| msg.to_lowercase().contains("limit")
					|| msg.to_lowercase().contains("too large")
				{
					ApiError::payload_too_large("upload too large")
				} else {
					ApiError::bad_request("failed reading upload stream")
				}
			})?
		{
			tokio::io::AsyncWriteExt::write_all(&mut out, &chunk)
				.await
				.map_err(|_| ApiError::internal("failed writing output file"))?;
		}

		let _ = tokio::io::AsyncWriteExt::flush(&mut out).await;
		drop(out);

		let base = safe_stem(&original_name).unwrap_or_else(|| "upload".to_string());
		let output_name = format!("{base}_output.mp4");
		let output_path = unique_path(&state.media_dir_abs, &output_name).await;

		let ffmpeg = Command::new("ffmpeg")
			.arg("-hide_banner")
			.arg("-i")
			.arg(&tmp_path)
			.args([
				"-c:v",
				"libx264",
				"-profile:v",
				"high",
				"-level:v",
				"4.1",
				"-pix_fmt",
				"yuv420p",
				"-r",
				"25",
				"-g",
				"50",
				"-keyint_min",
				"50",
				"-sc_threshold",
				"0",
				"-preset",
				"veryfast",
				"-b:v",
				"4M",
				"-vf",
				"scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
				"-c:a",
				"aac",
				"-ar",
				"48000",
				"-ac",
				"2",
				"-b:a",
				"128k",
				"-movflags",
				"+faststart",
			])
			.arg(&output_path)
			.output()
			.await;

		let _ = tokio::fs::remove_file(&tmp_path).await;

		let (ffmpeg_ok, ffmpeg_error) = match ffmpeg {
			Ok(out) if out.status.success() => (true, None),
			Ok(out) => {
				let err = String::from_utf8_lossy(&out.stderr).to_string();
				(false, Some(truncate_err(&err)))
			}
			Err(err) => (false, Some(truncate_err(&err.to_string()))),
		};

		if !ffmpeg_ok {
			let _ = tokio::fs::remove_file(&output_path).await;
		}

		let abs_path = if ffmpeg_ok {
			tokio::fs::canonicalize(&output_path)
				.await
				.map(|p| p.to_string_lossy().to_string())
				.unwrap_or_else(|_| output_path.to_string_lossy().to_string())
		} else {
			output_path.to_string_lossy().to_string()
		};
		let video_name = output_path
			.file_name()
			.and_then(|s| s.to_str())
			.unwrap_or("output.mp4")
			.to_string();
		let out_size_bytes = match tokio::fs::metadata(&output_path).await {
			Ok(m) => m.len() as i64,
			Err(_) => 0,
		};

		if ffmpeg_ok {
			let _ = upsert_list_entry(&state.list_path_abs, &video_name).await;
		}

		sqlx::query(
			r#"
			INSERT INTO videos (id, original_name, stored_name, abs_path, content_type, size_bytes, created_at, video_name, ffmpeg_ok, ffmpeg_error)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
			"#,
		)
		.bind(id.to_string())
		.bind(&original_name)
		.bind(&video_name)
		.bind(&abs_path)
		.bind(&Some("video/mp4".to_string()))
		.bind(out_size_bytes)
		.bind(created_at)
		.bind(&video_name)
		.bind(if ffmpeg_ok { 1 } else { 0 })
		.bind(&ffmpeg_error)
		.execute(&state.pool)
		.await
		.map_err(|_| ApiError::internal("failed to insert metadata"))?;

		let row = VideoRow {
			id: id.to_string(),
			original_name,
			video_name: video_name.clone(),
			abs_path,
			content_type: Some("video/mp4".to_string()),
			size_bytes: out_size_bytes,
			created_at,
			play_url: format!("/videos/{id}"),
			download_url: format!("/videos/{id}?download=1"),
			delete_url: format!("/api/videos/{id}"),
			ffmpeg_ok,
		};

		return Ok((StatusCode::CREATED, Json(row)));
	}

	Err(ApiError::bad_request("missing multipart field: file"))
}

pub(crate) async fn list_videos(
	State(state): State<std::sync::Arc<crate::WebState>>,
) -> Result<impl IntoResponse, ApiError> {
	let state = state.upload.as_ref().ok_or_else(|| ApiError::not_found("upload api disabled"))?;
	let rows = sqlx::query(
		r#"
		SELECT id, original_name, stored_name, abs_path, content_type, size_bytes, created_at, video_name, ffmpeg_ok
		FROM videos
		ORDER BY created_at DESC
		"#,
	)
	.fetch_all(&state.pool)
	.await
	.map_err(|_| ApiError::internal("failed to query videos"))?;

	let mut videos = Vec::with_capacity(rows.len());
	for r in rows {
		let id: String = r.try_get("id").map_err(|_| ApiError::internal("invalid id"))?;
		let original_name: String = r
			.try_get("original_name")
			.map_err(|_| ApiError::internal("invalid original_name"))?;
		let stored_name: String = r
			.try_get("stored_name")
			.map_err(|_| ApiError::internal("invalid stored_name"))?;
		let abs_path: Option<String> = r.try_get("abs_path").unwrap_or(None);
		let content_type: Option<String> = r
			.try_get("content_type")
			.map_err(|_| ApiError::internal("invalid content_type"))?;
		let size_bytes: i64 = r
			.try_get("size_bytes")
			.map_err(|_| ApiError::internal("invalid size_bytes"))?;
		let created_at: i64 = r
			.try_get("created_at")
			.map_err(|_| ApiError::internal("invalid created_at"))?;

		let abs_path = abs_path.unwrap_or_else(|| stored_name.clone());
		let video_name: Option<String> = r.try_get("video_name").unwrap_or(None);
		let ffmpeg_ok: Option<i64> = r.try_get("ffmpeg_ok").unwrap_or(None);
		let video_name = video_name.unwrap_or_else(|| stored_name.clone());
		let ffmpeg_ok = ffmpeg_ok.unwrap_or(1) != 0;

		videos.push(VideoRow {
			play_url: format!("/videos/{id}"),
			download_url: format!("/videos/{id}?download=1"),
			delete_url: format!("/api/videos/{id}"),
			id,
			original_name,
			video_name,
			abs_path,
			content_type,
			size_bytes,
			created_at,
			ffmpeg_ok,
		});
	}

	Ok(Json(videos))
}

pub(crate) async fn get_video(
	State(state): State<std::sync::Arc<crate::WebState>>,
	AxumPath(id): AxumPath<String>,
	Query(query): Query<VideoQuery>,
) -> Result<Response, ApiError> {
	let state = state.upload.as_ref().ok_or_else(|| ApiError::not_found("upload api disabled"))?;
	let _ = Uuid::parse_str(&id).map_err(|_| ApiError::not_found("video not found"))?;

	let row = sqlx::query(
		r#"
		SELECT stored_name, abs_path, content_type, original_name
		FROM videos
		WHERE id = ?1
		"#,
	)
	.bind(&id)
	.fetch_optional(&state.pool)
	.await
	.map_err(|_| ApiError::internal("failed to query video"))?
	.ok_or_else(|| ApiError::not_found("video not found"))?;

	let abs_path: Option<String> = row.try_get("abs_path").unwrap_or(None);
	let content_type: Option<String> = row
		.try_get("content_type")
		.map_err(|_| ApiError::internal("invalid content_type"))?;
	let original_name: String = row
		.try_get("original_name")
		.map_err(|_| ApiError::internal("invalid original_name"))?;

	let path = abs_path.and_then(|p| PathBuf::from(p).canonicalize().ok()).ok_or_else(|| {
		ApiError::internal("invalid stored path")
	})?;
	if !path.starts_with(&state.media_dir_abs) {
		return Err(ApiError::internal("invalid stored path"));
	}

	let file = tokio::fs::File::open(&path)
		.await
		.map_err(|_| ApiError::not_found("file not found"))?;
	let stream = ReaderStream::new(file);

	let mut headers = HeaderMap::new();
	if let Some(ct) = content_type {
		if let Ok(v) = HeaderValue::from_str(&ct) {
			headers.insert(http::header::CONTENT_TYPE, v);
		}
	}

	if query.download.is_some() {
		let value = format!("attachment; filename=\"{}\"", sanitize_filename(&original_name));
		if let Ok(v) = HeaderValue::from_str(&value) {
			headers.insert(http::header::CONTENT_DISPOSITION, v);
		}
	}

	Ok((headers, Body::from_stream(stream)).into_response())
}

pub(crate) async fn delete_video(
	State(state): State<std::sync::Arc<crate::WebState>>,
	AxumPath(id): AxumPath<String>,
) -> Result<impl IntoResponse, ApiError> {
	let state = state.upload.as_ref().ok_or_else(|| ApiError::not_found("upload api disabled"))?;
	let _ = Uuid::parse_str(&id).map_err(|_| ApiError::not_found("video not found"))?;

	let row = sqlx::query(
		r#"
		SELECT stored_name, abs_path
		FROM videos
		WHERE id = ?1
		"#,
	)
	.bind(&id)
	.fetch_optional(&state.pool)
	.await
	.map_err(|_| ApiError::internal("failed to query video"))?
	.ok_or_else(|| ApiError::not_found("video not found"))?;

	let abs_path: Option<String> = row.try_get("abs_path").unwrap_or(None);
	let path = abs_path.and_then(|p| PathBuf::from(p).canonicalize().ok()).ok_or_else(|| {
		ApiError::internal("invalid stored path")
	})?;
	if !path.starts_with(&state.media_dir_abs) {
		return Err(ApiError::internal("invalid stored path"));
	}
	let video_name = path
		.file_name()
		.and_then(|s| s.to_str())
		.map(|s| s.to_string());

	sqlx::query(
		r#"
		DELETE FROM videos
		WHERE id = ?1
		"#,
	)
	.bind(&id)
	.execute(&state.pool)
	.await
	.map_err(|_| ApiError::internal("failed to delete metadata"))?;

	let _ = tokio::fs::remove_file(path).await;

	if let Some(name) = video_name {
		let _ = remove_list_entry(&state.list_path_abs, &name).await;
	}

	Ok(StatusCode::NO_CONTENT)
}

fn now_unix_seconds() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_secs() as i64
}

fn sanitize_filename(name: &str) -> String {
	name.chars()
		.map(|c| match c {
			'/' | '\\' | '\0' => '_',
			_ => c,
		})
		.collect()
}

fn safe_filename(name: &str) -> Option<String> {
	let leaf = Path::new(name).file_name()?.to_str()?;
	let leaf = leaf.trim();
	if leaf.is_empty() {
		return None;
	}
	Some(sanitize_filename(leaf))
}

fn safe_stem(name: &str) -> Option<String> {
	let leaf = safe_filename(name)?;
	let stem = Path::new(&leaf).file_stem()?.to_str()?.trim();
	if stem.is_empty() {
		return None;
	}
	Some(sanitize_filename(stem))
}

async fn unique_path(dir: &Path, desired_name: &str) -> PathBuf {
	let desired = Path::new(desired_name);
	let stem = desired.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
	let ext = desired.extension().and_then(|s| s.to_str()).unwrap_or("mp4");

	let mut i = 0;
	loop {
		let name = if i == 0 {
			format!("{stem}.{ext}")
		} else {
			format!("{stem}-{i}.{ext}")
		};
		let path = dir.join(name);
		if tokio::fs::try_exists(&path).await.unwrap_or(false) {
			i += 1;
			continue;
		}
		return path;
	}
}

fn truncate_err(s: &str) -> String {
	const MAX: usize = 4000;
	if s.len() <= MAX {
		return s.to_string();
	}
	let mut out = s[..MAX].to_string();
	out.push_str("…");
	out
}

fn concat_list_line(video_basename: &str) -> String {
	let inner = video_basename.replace('\'', "'\"'\"'");
	format!("file '{inner}'")
}

fn basename_from_concat_list_line(line: &str) -> Option<String> {
	let line = line.trim();
	if line.is_empty() || line.starts_with('#') {
		return None;
	}
	let rest = line.strip_prefix("file")?.trim_start();
	if !rest.starts_with('\'') {
		return None;
	}
	let inner = &rest[1..];
	let end = inner.rfind('\'')?;
	Some(inner[..end].to_string())
}

fn try_parse_legacy_basename_line(line: &str) -> Option<String> {
	let line = line.trim();
	if line.is_empty() || line.starts_with('#') || line.starts_with("file") {
		return None;
	}
	Some(line.to_string())
}

fn basename_for_list_row(line: &str) -> Option<String> {
	basename_from_concat_list_line(line).or_else(|| try_parse_legacy_basename_line(line))
}

async fn upsert_list_entry(path: &Path, video_basename: &str) -> std::io::Result<()> {
	let video_basename = video_basename.trim();
	if video_basename.is_empty() {
		return Ok(());
	}

	let contents = match tokio::fs::read_to_string(path).await {
		Ok(s) => s,
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
		Err(err) => return Err(err),
	};

	let mut ordered: Vec<String> = Vec::new();
	let mut seen = HashSet::new();

	for line in contents.lines() {
		if let Some(base) = basename_for_list_row(line) {
			if seen.insert(base.clone()) {
				ordered.push(base);
			}
		}
	}

	if seen.insert(video_basename.to_string()) {
		ordered.push(video_basename.to_string());
	}

	let mut out = ordered.iter().map(|b| concat_list_line(b)).collect::<Vec<_>>().join("\n");
	if !out.is_empty() {
		out.push('\n');
	}
	tokio::fs::write(path, out).await
}

async fn remove_list_entry(path: &Path, video_basename: &str) -> std::io::Result<()> {
	let video_basename = video_basename.trim();
	if video_basename.is_empty() {
		return Ok(());
	}

	let contents = match tokio::fs::read_to_string(path).await {
		Ok(s) => s,
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
		Err(err) => return Err(err),
	};

	let mut ordered: Vec<String> = Vec::new();
	let mut seen = HashSet::new();
	for line in contents.lines() {
		if let Some(base) = basename_for_list_row(line) {
			if base == video_basename {
				continue;
			}
			if seen.insert(base.clone()) {
				ordered.push(base);
			}
		}
	}

	let mut out = ordered.iter().map(|b| concat_list_line(b)).collect::<Vec<_>>().join("\n");
	if !out.is_empty() {
		out.push('\n');
	}
	tokio::fs::write(path, out).await
}

