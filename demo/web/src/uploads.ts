import type MoqWatch from "@moq/watch/element";

export type VideoRow = {
	id: string;
	original_name: string;
	video_name: string;
	abs_path: string;
	content_type: string | null;
	size_bytes: number;
	created_at: number;
	play_url: string;
	download_url: string;
	delete_url: string;
	ffmpeg_ok: boolean;
};

function apiBase(): string {
	if (import.meta.env.VITE_UPLOAD_API_URL) return import.meta.env.VITE_UPLOAD_API_URL;
	const relay = new URL(import.meta.env.VITE_RELAY_URL);
	return relay.origin;
}

function absUrl(path: string): string {
	return new URL(path, apiBase()).toString();
}

function selectedChannelName(): string {
	const watch = document.querySelector("moq-watch") as MoqWatch | null;
	if (!watch) throw new Error("unable to find <moq-watch> element");
	return watch.broadcast.name.peek().toString();
}

export async function listVideos(): Promise<VideoRow[]> {
	const res = await fetch(absUrl("/api/videos"));
	if (!res.ok) throw new Error(`list failed: ${res.status}`);
	return (await res.json()) as VideoRow[];
}

export async function uploadVideo(file: File): Promise<VideoRow> {
	const data = new FormData();
	data.set("file", file);

	const res = await fetch(absUrl("/api/videos"), {
		method: "POST",
		body: data,
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`upload failed: ${res.status} ${text}`.trim());
	}

	return (await res.json()) as VideoRow;
}

export async function deleteVideo(id: string): Promise<void> {
	const res = await fetch(absUrl(`/api/videos/${encodeURIComponent(id)}`), {
		method: "DELETE",
	});
	if (res.status === 204) return;
	if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}

function fmtTime(unixSeconds: number): string {
	const d = new Date(unixSeconds * 1000);
	return Number.isNaN(d.getTime()) ? `${unixSeconds}` : d.toLocaleString();
}

export async function wireUploadsUi(opts: {
	input: HTMLInputElement;
	button: HTMLButtonElement;
	publishButton?: HTMLButtonElement;
	status: HTMLElement;
	list: HTMLElement;
	
	pickButton?: HTMLButtonElement;

	fileNameLabel?: HTMLElement;
}) {
	
	opts.publishButton?.classList.add("visible");

	const resetPickUi = () => {
		opts.input.value = "";
		if (opts.fileNameLabel) opts.fileNameLabel.textContent = "Choose video…";
		if (opts.pickButton) {
			opts.pickButton.classList.remove("has-file", "uploading");
		}
		opts.button.classList.remove("visible", "uploading");
		opts.publishButton?.classList.remove("uploading");
	};

	const refresh = async () => {
		opts.status.textContent = "Loading uploaded videos…";
		try {
			const videos = await listVideos();
			if (videos.length === 0) {
				const empty = document.createElement("tr");
				empty.className = "empty-row";
				empty.innerHTML = '<td colspan="6">No videos uploaded yet.</td>';
				opts.list.replaceChildren(empty);
			} else {
				opts.list.replaceChildren(...videos.map((v) => renderRow(v, refresh, opts.status)));
			}

			opts.status.textContent = videos.length === 0 ? "No uploads yet." : "";
		} catch (err) {
			opts.status.textContent = err instanceof Error ? err.message : String(err);
		}
	};

	if (opts.pickButton) {
		opts.pickButton.addEventListener("click", () => {
			opts.input.click();
		});
	}

	opts.input.addEventListener("change", () => {
		const file = opts.input.files?.item(0);
		if (file) {
			if (opts.fileNameLabel) opts.fileNameLabel.textContent = file.name;
			opts.pickButton?.classList.add("has-file");
			opts.button.classList.add("visible");
			opts.status.textContent = "";
		} else {
			resetPickUi();
		}
	});

	opts.button.addEventListener("click", async () => {
		const file = opts.input.files?.item(0);
		if (!file) {
			opts.status.textContent = "Pick a video file first.";
			return;
		}

		opts.pickButton?.classList.add("uploading");
		opts.button.classList.add("uploading");
		opts.button.disabled = true;
		opts.status.textContent = `Uploading ${file.name}…`;
		try {
			await uploadVideo(file);
			resetPickUi();
			await refresh();
		} catch (err) {
			opts.status.textContent = err instanceof Error ? err.message : String(err);
		} finally {
			opts.pickButton?.classList.remove("uploading");
			opts.button.classList.remove("uploading");
			opts.button.disabled = false;
		}
	});

	opts.publishButton?.addEventListener("click", () => {
		void (async () => {
			const publishButton = opts.publishButton;
			if (!publishButton) return;

			publishButton.classList.add("uploading");
			publishButton.disabled = true;

			try {
				const channel = selectedChannelName();
				opts.status.textContent = `Publishing to ${channel}…`;

				const res = await fetch(absUrl(`/api/publish/${encodeURIComponent(channel)}`), {
					method: "POST",
				});

				if (!res.ok) {
					const text = await res.text().catch(() => "");
					throw new Error(`publish failed: ${res.status} ${text}`.trim());
				}

				opts.status.textContent = `Publish started for ${channel}.`;
			} catch (err) {
				opts.status.textContent = err instanceof Error ? err.message : String(err);
			} finally {
				publishButton.classList.remove("uploading");
				publishButton.disabled = false;
			}
		})();
	});

	await refresh();
}

function renderRow(v: VideoRow, refresh: () => Promise<void>, status: HTMLElement): HTMLTableRowElement {
	const tr = document.createElement("tr");

	const tdOriginal = document.createElement("td");
	tdOriginal.style.padding = "0.5rem";
	tdOriginal.textContent = v.original_name;

	const tdOutput = document.createElement("td");
	tdOutput.style.padding = "0.5rem";
	tdOutput.textContent = v.video_name;
	if (!v.ffmpeg_ok) {
		tdOutput.title = "FFmpeg transcode failed";
		tdOutput.style.opacity = "0.7";
	}

	const tdType = document.createElement("td");
	tdType.style.padding = "0.5rem";
	tdType.style.opacity = "0.85";
	tdType.textContent = v.content_type ?? "unknown";

	const tdUploaded = document.createElement("td");
	tdUploaded.style.padding = "0.5rem";
	tdUploaded.textContent = fmtTime(v.created_at);

	const tdFfmpeg = document.createElement("td");
	tdFfmpeg.style.padding = "0.5rem";
	tdFfmpeg.textContent = v.ffmpeg_ok ? "OK" : "FAILED";
	tdFfmpeg.style.opacity = v.ffmpeg_ok ? "1" : "0.85";

	const tdActions = document.createElement("td");
	tdActions.style.padding = "0.5rem";
	tdActions.style.whiteSpace = "nowrap";

	const actions = document.createElement("div");
	actions.className = "actions";

	const play = document.createElement("a");
	play.title = "Play";
	play.setAttribute("aria-label", "Play");
	play.append(iconPlay());
	play.href = absUrl(v.play_url);
	play.target = "_blank";
	play.rel = "noreferrer";
	play.className = "icon-btn play";

	const download = document.createElement("a");
	download.title = "Download";
	download.setAttribute("aria-label", "Download");
	download.append(iconDownload());
	download.href = absUrl(v.download_url);
	download.target = "_blank";
	download.rel = "noreferrer";
	download.className = "icon-btn copy";

	const del = document.createElement("button");
	del.title = "Delete";
	del.setAttribute("aria-label", "Delete");
	del.append(iconTrash());
	del.className = "icon-btn del";
	del.addEventListener("click", async () => {
		if (!confirm(`Delete ${v.video_name}?`)) return;
		del.disabled = true;
		status.textContent = `Deleting ${v.video_name}…`;
		try {
			await deleteVideo(v.id);
			await refresh();
		} catch (err) {
			status.textContent = err instanceof Error ? err.message : String(err);
		} finally {
			del.disabled = false;
		}
	});

	actions.append(play, download, del);
	tdActions.append(actions);

	tr.append(tdOriginal, tdOutput, tdType, tdUploaded, tdFfmpeg, tdActions);
	return tr;
}

function iconPlay(): SVGElement {
	return svgIcon("M8 5v14l11-7z");
}

function iconDownload(): SVGElement {
	return svgIcon("M12 3v10m0 0l4-4m-4 4L8 9M5 17v2h14v-2", true);
}

function iconTrash(): SVGElement {
	return svgIcon("M6 7h12M9 7v12m6-12v12M10 7l1-2h2l1 2M8 7l1 14h6l1-14", true);
}

function svgIcon(d: string, strokeOnly = false): SVGElement {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", "18");
	svg.setAttribute("height", "18");
	svg.style.verticalAlign = "middle";

	const path = document.createElementNS(ns, "path");
	path.setAttribute("d", d);
	if (strokeOnly) {
		path.setAttribute("fill", "none");
		path.setAttribute("stroke", "currentColor");
		path.setAttribute("stroke-width", "2");
		path.setAttribute("stroke-linecap", "round");
		path.setAttribute("stroke-linejoin", "round");
	} else {
		path.setAttribute("fill", "currentColor");
	}
	svg.appendChild(path);
	return svg;
}
