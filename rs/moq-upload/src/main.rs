use std::{
	net::SocketAddr,
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use axum::{
	Json, Router,
	body::Body,
	extract::{Multipart, Path as AxumPath, State},
	http::{HeaderMap, HeaderValue, Method, StatusCode},
	response::{IntoResponse, Response},
	routing::{get, post},
};
use clap::Parser;
use serde::{Deserialize, Serialize};
use sqlx::{Row, sqlite::SqlitePoolOptions};
use tokio_util::io::ReaderStream;
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

#[derive(Parser, Clone, Debug)]
struct Args {

	#[arg(long, env = "MOQ_UPLOAD_LISTEN", default_value = "127.0.0.1:3000")]
	listen: SocketAddr,


	#[arg(long, env = "MOQ_UPLOAD_DIR", default_value = "demo/web/uploads")]
	upload_dir: PathBuf,

	#[arg(long, env = "MOQ_UPLOAD_DB", default_value = "demo/web/videos.sqlite")]
	db_path: PathBuf,
}

#[derive(Clone)]
struct AppState {
	pool: sqlx::SqlitePool,
	upload_dir: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
struct VideoRow {
	id: Uuid,
	original_name: String,
	stored_name: String,
	content_type: Option<String>,
	size_bytes: i64,
	created_at: i64,
	play_url: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
	tracing_subscriber::fmt()
		.with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
		.init();

	let args = Args::parse();

	tokio::fs::create_dir_all(&args.upload_dir)
		.await
		.with_context(|| format!("failed to create upload dir: {}", args.upload_dir.display()))?;

	let db_url = format!("sqlite://{}", args.db_path.display());
	let pool = SqlitePoolOptions::new()
		.max_connections(10)
		.connect(&db_url)
		.await
		.with_context(|| format!("failed to open sqlite db at {}", args.db_path.display()))?;

	init_db(&pool).await?;

	let state = AppState {
		pool,
		upload_dir: args.upload_dir,
	};

	let cors = CorsLayer::new()
		.allow_origin(Any)
		.allow_methods([Method::GET, Method::POST]);

	let app = Router::new()
		.route("/api/videos", post(upload_video).get(list_videos))
		.route("/videos/{id}", get(get_video))
		.layer(cors)
		.with_state(state);

	tracing::info!(listen = %args.listen, "moq-upload listening");
	let listener = tokio::net::TcpListener::bind(args.listen)
		.await
		.context("failed to bind listener")?;
	axum::serve(listener, app).await?;

	Ok(())
}

async fn init_db(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
	sqlx::query(
		r#"
		CREATE TABLE IF NOT EXISTS videos (
			id TEXT PRIMARY KEY NOT NULL,
			original_name TEXT NOT NULL,
			stored_name TEXT NOT NULL,
			content_type TEXT,
			size_bytes INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		"#,
	)
	.execute(pool)
	.await
	.context("failed to init sqlite schema")?;

	Ok(())
}

async fn upload_video(
	State(state): State<AppState>,
	mut multipart: Multipart,
) -> Result<impl IntoResponse, ApiError> {
	let mut file_field = None;

	while let Some(field) = multipart
		.next_field()
		.await
		.map_err(|_| ApiError::bad_request("invalid multipart body"))?
	{
		if field.name() == Some("file") {
			file_field = Some(field);
			break;
		}
	}

	let mut field = file_field.ok_or_else(|| ApiError::bad_request("missing multipart field: file"))?;

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
	let ext = extension_from_filename(&original_name).unwrap_or("bin");
	let stored_name = format!("{id}.{ext}");
	let stored_path = state.upload_dir.join(&stored_name);

	let mut size_bytes: i64 = 0;
	let mut out = tokio::fs::File::create(&stored_path)
		.await
		.map_err(|_| ApiError::internal("failed to create output file"))?;

	while let Some(chunk) = field
		.chunk()
		.await
		.map_err(|_| ApiError::bad_request("failed reading upload stream"))?
	{
		size_bytes += chunk.len() as i64;
		tokio::io::AsyncWriteExt::write_all(&mut out, &chunk)
			.await
			.map_err(|_| ApiError::internal("failed writing output file"))?;
	}

	let created_at = now_unix_seconds();

	sqlx::query(
		r#"
		INSERT INTO videos (id, original_name, stored_name, content_type, size_bytes, created_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6)
		"#,
	)
	.bind(id.to_string())
	.bind(&original_name)
	.bind(&stored_name)
	.bind(&content_type)
	.bind(size_bytes)
	.bind(created_at)
	.execute(&state.pool)
	.await
	.map_err(|_| ApiError::internal("failed to insert metadata"))?;

	let row = VideoRow {
		id,
		original_name,
		stored_name,
		content_type,
		size_bytes,
		created_at,
		play_url: format!("/videos/{id}"),
	};

	Ok((StatusCode::CREATED, Json(row)))
}

async fn list_videos(State(state): State<AppState>) -> Result<impl IntoResponse, ApiError> {
	let rows = sqlx::query(
		r#"
		SELECT id, original_name, stored_name, content_type, size_bytes, created_at
		FROM videos
		ORDER BY created_at DESC
		"#,
	)
	.fetch_all(&state.pool)
	.await
	.map_err(|_| ApiError::internal("failed to query videos"))?;

	let mut videos = Vec::with_capacity(rows.len());
	for r in rows {
		let id_str: String = r.try_get("id").map_err(|_| ApiError::internal("invalid id"))?;
		let id = Uuid::parse_str(&id_str).map_err(|_| ApiError::internal("invalid id"))?;

		let original_name: String = r
			.try_get("original_name")
			.map_err(|_| ApiError::internal("invalid original_name"))?;
		let stored_name: String = r
			.try_get("stored_name")
			.map_err(|_| ApiError::internal("invalid stored_name"))?;
		let content_type: Option<String> = r
			.try_get("content_type")
			.map_err(|_| ApiError::internal("invalid content_type"))?;
		let size_bytes: i64 = r
			.try_get("size_bytes")
			.map_err(|_| ApiError::internal("invalid size_bytes"))?;
		let created_at: i64 = r
			.try_get("created_at")
			.map_err(|_| ApiError::internal("invalid created_at"))?;

		videos.push(VideoRow {
			id,
			original_name,
			stored_name,
			content_type,
			size_bytes,
			created_at,
			play_url: format!("/videos/{id}"),
		});
	}

	Ok(Json(videos))
}

async fn get_video(
	State(state): State<AppState>,
	AxumPath(id): AxumPath<String>,
) -> Result<Response, ApiError> {
	let id = Uuid::parse_str(&id).map_err(|_| ApiError::not_found("video not found"))?;

	let row = sqlx::query(
		r#"
		SELECT stored_name, content_type
		FROM videos
		WHERE id = ?1
		"#,
	)
	.bind(id.to_string())
	.fetch_optional(&state.pool)
	.await
	.map_err(|_| ApiError::internal("failed to query video"))?
	.ok_or_else(|| ApiError::not_found("video not found"))?;

	let stored_name: String = row
		.try_get("stored_name")
		.map_err(|_| ApiError::internal("invalid stored_name"))?;
	let content_type: Option<String> = row
		.try_get("content_type")
		.map_err(|_| ApiError::internal("invalid content_type"))?;

	let path = safe_join(&state.upload_dir, &stored_name)
		.ok_or_else(|| ApiError::internal("invalid stored path"))?;

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

	Ok((headers, Body::from_stream(stream)).into_response())
}

fn now_unix_seconds() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_secs() as i64
}

fn extension_from_filename(name: &str) -> Option<&str> {
	let p = Path::new(name);
	let ext = p.extension()?.to_str()?;
	let ext = ext.trim().trim_start_matches('.');
	if ext.is_empty() {
		None
	} else {
		Some(ext)
	}
}

fn safe_join(base: &Path, leaf: &str) -> Option<PathBuf> {
	let leaf_path = Path::new(leaf);
	if leaf_path.components().count() != 1 {
		return None;
	}
	Some(base.join(leaf_path))
}

#[derive(Debug, Serialize)]
struct ErrorBody {
	error: String,
}

#[derive(Debug)]
struct ApiError {
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
}

impl IntoResponse for ApiError {
	fn into_response(self) -> Response {
		(self.status, Json(ErrorBody { error: self.message.to_string() })).into_response()
	}
}

