import { object } from "@gin-quin/codec";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema as basic } from "prosemirror-schema-basic";
import { addListNodes, wrapInList } from "prosemirror-schema-list";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import {
	connectPulse,
	createPulse,
	createWebSocketConnector,
	definePulse,
	destroyPulse,
	disconnectPulse,
	loadPulse,
	PulseError,
	richText,
} from "../packages/pulse/source/index.js";
import { bindProseMirror } from "pulsify-prosemirror";

const Note = definePulse(
	"EditorNote",
	object({ body: richText() }),
).materialize();
const connector = createWebSocketConnector(
	`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/sync`,
	undefined,
	{ protocolVersion: 3 },
);
const status = document.querySelector<HTMLOutputElement>("#status")!;
let note;
try {
	note = await loadPulse(Note, "shared-editor-note", {
		connectors: [connector],
		waitFor: "all",
	});
} catch (error) {
	if (!(error instanceof PulseError) || error.code !== "NOT_FOUND") throw error;
	note = createPulse(
		Note,
		{ id: "shared-editor-note", body: "Edit this text in two tabs." },
		{ connectors: [connector] },
	);
	await connectPulse(note).synced;
}
const pulse = note;
const schema = new Schema({
	nodes: addListNodes(basic.spec.nodes, "paragraph block*", "block"),
	marks: basic.spec.marks,
});
const view = new EditorView(document.querySelector("#editor"), {
	state: EditorState.create({
		schema,
		plugins: [
			history(),
			keymap({
				"Mod-b": toggleMark(schema.marks["strong"]!),
				"Mod-i": toggleMark(schema.marks["em"]!),
				"Mod-z": undo,
				"Mod-Shift-z": redo,
			}),
			keymap(baseKeymap),
		],
	}),
});
const binding = bindProseMirror(view, pulse.body, {
	onError(error) {
		status.value = String(error);
	},
});
for (const [id, command] of [
	["bold", toggleMark(schema.marks["strong"]!)],
	["italic", toggleMark(schema.marks["em"]!)],
	["list", wrapInList(schema.nodes["bullet_list"]!)],
	["undo", undo],
	["redo", redo],
] as const) {
	document.querySelector(`#${id}`)!.addEventListener("mousedown", (event) => {
		event.preventDefault();
		command(view.state, view.dispatch, view);
		view.focus();
	});
}
status.value = "Connected";
document.querySelector("#disconnect")!.addEventListener("click", () => {
	disconnectPulse(pulse);
	status.value = "Offline — edits stay in this tab";
});
document.querySelector("#connect")!.addEventListener("click", async () => {
	try {
		await connectPulse(pulse).synced;
		status.value = "Connected";
	} catch (error) {
		status.value = String(error);
	}
});
window.addEventListener("pagehide", () => {
	binding.destroy();
	view.destroy();
	destroyPulse(pulse);
});
