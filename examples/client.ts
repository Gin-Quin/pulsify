import {
	connectPulse,
	createPulse,
	createWebSocketConnector,
	definePulse,
	destroyPulse,
	disconnectPulse,
	loadPulse,
	PulseError,
	subscribePulse,
	type PulseProperties,
} from "../packages/pulse/source/index";
type Note = PulseProperties<"Note"> & { title: string; body: string };
const Note = definePulse<Note>("Note").materialize();
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
subscribePulse(pulse, (value) => {
	if (title.value !== value.title) title.value = value.title;
	if (body.value !== value.body) body.value = value.body;
});
title.addEventListener("input", () => {
	pulse.title = title.value;
});
body.addEventListener("input", () => {
	pulse.body = body.value;
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
