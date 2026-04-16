import "./highlight";
import "@moq/watch/ui";
import MoqWatch from "@moq/watch/element";
import MoqWatchSupport from "@moq/watch/support/element";
import MoqDiscover from "./discover";
import { wireUploadsUi } from "./uploads";

export { MoqDiscover, MoqWatch, MoqWatchSupport };

const watch = document.querySelector("moq-watch") as MoqWatch | undefined;
if (!watch) throw new Error("unable to find <moq-watch> element");

// If query params are provided, use them.
const urlParams = new URLSearchParams(window.location.search);
const name = urlParams.get("broadcast") ?? urlParams.get("name");
const url = urlParams.get("url");

if (url) watch.url = url;
if (name) watch.name = name;

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
