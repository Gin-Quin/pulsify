import "prosemirror-view/style/prosemirror.css";
import "./style.css";
import { mount } from "svelte";
import App from "./App.svelte";

const loading = document.querySelector("#loading")!;
try {
	const { openWorkspace } = await import("./pulsify");
	const workspace = await openWorkspace();
	loading.remove();
	mount(App, { target: document.body, props: { workspace } });
} catch (error) {
	loading.textContent = `Erreur : ${error instanceof Error ? error.message : error}`;
}
