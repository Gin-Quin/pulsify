import { object } from "@gin-quin/codec";
import {
	createEditor,
	FORMAT_TEXT_COMMAND,
	UNDO_COMMAND,
	REDO_COMMAND,
} from "lexical";
import { registerRichText, HeadingNode, QuoteNode } from "@lexical/rich-text";
import {
	registerList,
	ListNode,
	ListItemNode,
	INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import { LinkNode } from "@lexical/link";
import { bindLexical } from "pulsify-lexical";
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
} from "@pulsify/core";

const Note = definePulse(
	"LexicalDemoNote",
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
	note = await loadPulse(Note, "shared-lexical-note", {
		connectors: [connector],
		waitFor: "all",
	});
} catch (error) {
	if (!(error instanceof PulseError) || error.code !== "NOT_FOUND") throw error;
	note = createPulse(
		Note,
		{ id: "shared-lexical-note", body: "Edit this text in two tabs." },
		{ connectors: [connector] },
	);
	await connectPulse(note).synced;
}
const pulse = note;
const editor = createEditor({
	namespace: "PulsifyDemo",
	nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode],
	onError(error) {
		status.value = String(error);
		throw error;
	},
});
editor.setRootElement(document.querySelector<HTMLElement>("#editor"));
const removeRichText = registerRichText(editor),
	removeList = registerList(editor);
const binding = bindLexical(editor, pulse.body, {
	onError(error) {
		status.value = String(error);
	},
});
for (const [id, action] of [
	["bold", () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")],
	["italic", () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")],
	[
		"list",
		() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined),
	],
	["undo", () => editor.dispatchCommand(UNDO_COMMAND, undefined)],
	["redo", () => editor.dispatchCommand(REDO_COMMAND, undefined)],
] as const)
	document.querySelector(`#${id}`)!.addEventListener("mousedown", (event) => {
		event.preventDefault();
		action();
		editor.focus();
	});
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
	removeList();
	removeRichText();
	editor.setRootElement(null);
	destroyPulse(pulse);
});
