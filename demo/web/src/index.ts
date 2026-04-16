import "./highlight";
import MoqWatch from "@moq/watch/element";
import { mountLatencyQualityUI } from "@moq/watch/ui/latency-quality";
import MoqWatchSupport from "@moq/watch/support/element";
import MoqDiscover from "./discover";
import { wireUploadsUi } from "./uploads";

export { MoqDiscover, MoqWatch, MoqWatchSupport };

type LiveVariant = "error" | "connecting" | "loading" | "live" | "connected";

function liveState(
	url: URL | undefined,
	connection: "connecting" | "connected" | "disconnected",
	broadcast: "offline" | "loading" | "live",
): { variant: LiveVariant; text: string } {
	if (!url) return { variant: "error", text: "No URL" };
	if (connection === "disconnected") return { variant: "error", text: "Disconnected" };
	if (connection === "connecting") return { variant: "connecting", text: "Connecting…" };
	if (broadcast === "offline") return { variant: "error", text: "Offline" };
	if (broadcast === "loading") return { variant: "loading", text: "Loading…" };
	if (broadcast === "live") return { variant: "live", text: "Live" };
	if (connection === "connected") return { variant: "connected", text: "Connected" };
	return { variant: "error", text: "Unknown" };
}

/** Demo chrome: transport, mute, volume, live status (no @moq/watch/ui). */
function wireDemoMinimalPlayer(watch: MoqWatch) {
	const play = document.getElementById("demo-transport-play") as HTMLButtonElement | null;
	const pause = document.getElementById("demo-transport-pause") as HTMLButtonElement | null;
	const stop = document.getElementById("demo-transport-stop") as HTMLButtonElement | null;
	const mute = document.getElementById("demo-transport-mute") as HTMLButtonElement | null;
	const volumeInput = document.getElementById("demo-volume") as HTMLInputElement | null;
	const volumeLabel = document.getElementById("demo-volume-label");
	const fs = document.getElementById("demo-transport-fs") as HTMLButtonElement | null;
	const statusRoot = document.getElementById("demo-live-status");
	const statusText = document.getElementById("demo-live-status-text");
	if (!play || !pause || !stop || !mute || !volumeInput || !volumeLabel || !fs) return;

	const syncPlayback = () => {
		const paused = watch.paused;
		play.disabled = !paused;
		pause.disabled = paused;
		stop.disabled = paused;
	};

	const syncFs = () => {
		const fsOn = document.fullscreenElement === watch;
		fs.dataset.fs = String(fsOn);
		fs.setAttribute("aria-label", fsOn ? "Exit fullscreen" : "Enter fullscreen");
	};

	play.addEventListener("click", () => {
		watch.paused = false;
		syncPlayback();
	});
	pause.addEventListener("click", () => {
		watch.paused = true;
		syncPlayback();
	});
	stop.addEventListener("click", () => {
		watch.paused = true;
		syncPlayback();
	});
	mute.addEventListener("click", () => {
		watch.muted = !watch.muted;
	});
	volumeInput.addEventListener("input", () => {
		const n = Number(volumeInput.value);
		const v = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) / 100 : 0;
		watch.volume = v;
		if (v > 0 && watch.muted) watch.muted = false;
	});
	fs.addEventListener("click", () => {
		if (document.fullscreenElement === watch) {
			void document.exitFullscreen();
		} else {
			void watch.requestFullscreen();
		}
	});

	const pausedObserver = new MutationObserver(syncPlayback);
	pausedObserver.observe(watch, { attributes: true, attributeFilter: ["paused"] });
	document.addEventListener("fullscreenchange", syncFs);

	watch.signals.run((effect) => {
		const url = effect.get(watch.connection.url);
		const connection = effect.get(watch.connection.status);
		const broadcast = effect.get(watch.broadcast.status);
		const { variant, text } = liveState(url, connection, broadcast);
		if (statusRoot && statusText) {
			statusRoot.className = `demo-live-status demo-live-status--${variant}`;
			statusText.textContent = text;
		}
	});

	watch.signals.run((effect) => {
		const v = effect.get(watch.backend.audio.volume);
		const pct = Math.round(v	 * 100);
		const cur = Math.round(Number(volumeInput.value));
		if (cur !== pct) volumeInput.value = String(pct);
		volumeLabel.textContent = String(pct);
		volumeInput.setAttribute("aria-valuenow", String(pct));
	});

	watch.signals.run((effect) => {
		const m = effect.get(watch.backend.audio.muted);
		mute.dataset.muted = String(m);
		mute.setAttribute("aria-pressed", String(m));
		mute.setAttribute("aria-label", m ? "Unmute" : "Mute");
	});

	syncPlayback();
	syncFs();
}

const watch = document.querySelector("moq-watch") as MoqWatch | undefined;
if (!watch) throw new Error("unable to find <moq-watch> element");

// If query params are provided, use them.
const urlParams = new URLSearchParams(window.location.search);
const name = urlParams.get("broadcast") ?? urlParams.get("name");
const url = urlParams.get("url");

if (url) watch.url = url;
if (name) watch.name = name;

wireDemoMinimalPlayer(watch);

const qualityHost = document.getElementById("demo-watch-quality");
if (qualityHost) {
	mountLatencyQualityUI(qualityHost, watch);
}

const fileInput = document.getElementById("video-file") as HTMLInputElement | null;
const uploadButton = document.getElementById("video-upload") as HTMLButtonElement | null;
const publishButton = document.getElementById("video-publish") as HTMLButtonElement | null;
const pickButton = document.getElementById("upload-pick-btn") as HTMLButtonElement | null;
const pickFileName = document.getElementById("pick-file-name");
const status = document.getElementById("video-upload-status");
const list = document.getElementById("video-list");

if (fileInput && uploadButton && status && list) {
	wireUploadsUi({
		input: fileInput,
		button: uploadButton,
		publishButton: publishButton ?? undefined,
		status,
		list,
		pickButton: pickButton ?? undefined,
		fileNameLabel: pickFileName ?? undefined,
	}).catch((err) => {
		status.textContent = err instanceof Error ? err.message : String(err);
	});
}
