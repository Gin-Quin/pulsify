import {
	connectPulse,
	createPulse,
	createWebSocketConnector,
	definePulse,
	destroyPulse,
	disconnectPulse,
	loadPulse,
	object,
	plainText,
	PulseError,
	subscribePulse,
} from "../packages/pulse/source/index";
// The title is an atomic value: the last writer wins. The body is a
// collaborative string: edits made on both sides merge.
const Note = definePulse(
	"Note",
	object({ title: "string", body: plainText() }),
).materialize();
const connector = createWebSocketConnector(
	`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/sync`,
	undefined,
	{ protocolVersion: 3 },
);
const status = document.querySelector<HTMLOutputElement>("#status")!;
const title = document.querySelector<HTMLInputElement>("#title")!;
const body = document.querySelector<HTMLTextAreaElement>("#body")!;
let note;
try {
	note = await loadPulse(Note, "shared-note", {
		connectors: [connector],
		waitFor: "all",
	});
} catch (error) {
	if (!(error instanceof PulseError) || error.code !== "NOT_FOUND") throw error;
	note = createPulse(
		Note,
		{
			id: "shared-note",
			title: "Shared note",
			body: "Open another tab and edit this note.",
		},
		{ connectors: [connector] },
	);
	await connectPulse(note).synced;
}
const pulse = note;
// Anchors follow their character, so the caret stays put while others type.
let caret = [pulse.body.anchorAt(0), pulse.body.anchorAt(0)];
document.addEventListener("selectionchange", () => {
	if (body.value === pulse.body.text)
		caret = [body.selectionStart, body.selectionEnd].map((index) =>
			pulse.body.anchorAt(index),
		);
});
subscribePulse(pulse, (value) => {
	if (title.value !== value.title) title.value = value.title;
	if (body.value === value.body.text) return;
	body.value = value.body.text;
	const [start, end] = caret.map((anchor) => value.body.indexOf(anchor) ?? 0);
	body.setSelectionRange(start!, end!);
});
title.addEventListener("input", () => {
	pulse.title = title.value;
});
body.addEventListener("input", () => {
	// Assigning the whole value edits only the characters that changed.
	pulse.body = plainText(body.value);
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
window.addEventListener("pagehide", () => destroyPulse(pulse));
