import "@moq/ui-core/variables.css";
import { render } from "solid-js/web";
import QualitySelector from "./components/QualitySelector";
import WatchUIContextProvider from "./context";
import type MoqWatch from "../element";
import "./styles/quality-selector.css";

/** Mount quality selector with watch UI context (demo / embeds without full moq-watch-ui). */
export function mountLatencyQualityUI(container: HTMLElement, moqWatch: MoqWatch): () => void {
	return render(
		() => (
			<WatchUIContextProvider moqWatch={moqWatch}>
				<QualitySelector />
			</WatchUIContextProvider>
		),
		container,
	);
}
