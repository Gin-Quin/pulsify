// Runs the "Notes" tutorial of the Cloud documentation end to end, with
// ProseMirror editors in jsdom and the in-process backend.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "prosemirror-schema-basic";
import { history } from "prosemirror-history";
import {
	array,
	connectPulse,
	createPulse,
	createPulseScope,
	definePulse,
	getPulseMeta,
	loadPulse,
	object,
	PulseError,
	richText,
	sub,
	pulseRef,
	type ModelFromDefinition,
	type Pulse,
} from "pulsify-core";
import {
	createCloudClient,
	createCloudConnector,
	signCloudToken,
	type CloudConnector,
} from "pulsify-cloud";
import { bindProseMirror, proseMirrorDocument } from "pulsify-prosemirror";
import { eventually } from "./conformance.js";
import { startCloudHost } from "./host.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	Node: dom.window.Node,
	HTMLElement: dom.window.HTMLElement,
	MutationObserver: dom.window.MutationObserver,
	getComputedStyle: dom.window.getComputedStyle,
	innerHeight: 800,
});

// schema.ts
const Note = definePulse(
	"Note",
	object({ title: "string", body: richText() }),
).materialize();
const Notebook = definePulse(
	"Notebook",
	object({ name: "string", notes: array(sub(Note)) }),
).materialize();
type NotebookPulse = Pulse<ModelFromDefinition<typeof Notebook>>;
type NotePulse = Pulse<ModelFromDefinition<typeof Note>>;

const env = {
	PULSIFY_TOKEN_SECRET: "a test token secret of at least 32 characters",
	PULSIFY_API_KEY: "a test api key of at least thirty-two characters",
	PULSIFY_URL: "",
};
let host: ReturnType<typeof startCloudHost>;
beforeAll(() => {
	host = startCloudHost({
		tokenSecret: env.PULSIFY_TOKEN_SECRET,
		apiKey: env.PULSIFY_API_KEY,
	});
	env.PULSIFY_URL = host.url;
});
afterAll(() => host.stop());

// backend.ts: your server, behind your own login.
const backend = {
	cloud: () =>
		createCloudClient({
			url: env.PULSIFY_URL,
			credential: env.PULSIFY_API_KEY,
		}),
	async onSignUp(user: { id: string }) {
		await backend
			.cloud()
			.grant({ subject: user.id, prefix: user.id, role: "owner" });
	},
	pulsifyToken: (user: { id: string }) =>
		signCloudToken({ subject: user.id }, env.PULSIFY_TOKEN_SECRET, {
			expiresIn: "15m",
		}),
};

// notes.ts: the browser application of one signed-in user.
function createApp(user: { id: string }) {
	const scope = createPulseScope();
	const cloud: CloudConnector = createCloudConnector({
		url: env.PULSIFY_URL,
		token: () => backend.pulsifyToken(user),
	});
	return {
		cloud,
		async openNotebook(): Promise<NotebookPulse> {
			try {
				return await loadPulse(Notebook, user.id, {
					connectors: [cloud],
					scope,
				});
			} catch (error) {
				if (!(error instanceof PulseError) || error.code !== "NOT_FOUND")
					throw error;
				const notebook = createPulse(
					Notebook,
					{ id: user.id, name: "My notes", notes: [] },
					{ connectors: [cloud], scope },
				);
				await connectPulse(notebook).synced;
				return notebook;
			}
		},
		async addNote(notebook: NotebookPulse, title: string): Promise<NotePulse> {
			const note = createPulse(Note, { title, body: "" }, { parent: notebook });
			await connectPulse(note).synced;
			notebook.notes.push(pulseRef(note));
			return note;
		},
		openShared: (noteId: string) =>
			loadPulse(Note, noteId, { connectors: [cloud], scope }),
		openEditor(note: NotePulse) {
			const view = new EditorView(document.createElement("div"), {
				state: EditorState.create({ schema, plugins: [history()] }),
				editable: () => cloud.roleOf(note.id) !== "reader",
			});
			const binding = bindProseMirror(view, note.body);
			const stop = cloud.onRole((docId) => {
				if (docId === note.id) view.setProps({});
			});
			return {
				view,
				close() {
					stop();
					binding.destroy();
					view.destroy();
				},
			};
		},
		share: (noteId: string, subject: string, role: "reader" | "editor") =>
			createCloudClient({
				url: env.PULSIFY_URL,
				credential: () => backend.pulsifyToken(user),
			}).grant({ subject, prefix: noteId, role }),
	};
}

test("the notes tutorial: one root per user, rich-text sub-documents, sharing", async () => {
	const alice = { id: `alice-${crypto.randomUUID().slice(0, 8)}` };
	const bob = { id: `bob-${crypto.randomUUID().slice(0, 8)}` };
	await backend.onSignUp(alice);
	await backend.onSignUp(bob);

	const laptop = createApp(alice);
	const notebook = await laptop.openNotebook();
	const note = await laptop.addNote(notebook, "Groceries");
	const editor = laptop.openEditor(note);
	editor.view.dispatch(editor.view.state.tr.insertText("Apples", 1));
	expect(String(note.body)).toBe("Apples");

	const phone = createApp(alice);
	const synced = await phone.openNotebook();
	const copy = synced.notes[0]!.pulse!;
	expect(copy.title).toBe("Groceries");
	await eventually(() => expect(String(copy.body)).toBe("Apples"));
	expect(
		phone.cloud.connections.map(({ root, envelope, documents, state }) => ({
			root,
			envelope,
			documents,
			state,
		})),
	).toEqual([
		{
			root: alice.id,
			envelope: 2,
			documents: [alice.id, note.id],
			state: "open",
		},
	]);

	const desktop = createApp(bob);
	await expect(desktop.openShared(note.id)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await laptop.share(note.id, bob.id, "editor");
	const shared = await desktop.openShared(note.id);
	const bobEditor = desktop.openEditor(shared);
	expect(desktop.cloud.roleOf(note.id)).toBe("editor");
	expect(bobEditor.view.editable).toBe(true);
	bobEditor.view.dispatch(bobEditor.view.state.tr.insertText("Pears, ", 1));
	await eventually(() =>
		expect(proseMirrorDocument(note.body, schema).textContent).toBe(
			"Pears, Apples",
		),
	);
	expect(editor.view.state.doc.textContent).toBe("Pears, Apples");

	await laptop.share(note.id, bob.id, "reader");
	await eventually(() => expect(bobEditor.view.editable).toBe(false));

	// The network drops: edits continue offline and sync once it is back.
	host.suspend();
	await eventually(() => expect(getPulseMeta(note).status).toBe("offline"));
	note.title = "Groceries (offline)";
	editor.view.dispatch(editor.view.state.tr.insertText("Bananas, ", 1));
	host.resume();
	await eventually(() => expect(copy.title).toBe("Groceries (offline)"));
	await eventually(() =>
		expect(String(copy.body)).toBe("Bananas, Pears, Apples"),
	);
	await eventually(() => expect(getPulseMeta(note).status).toBe("synced"));
	expect(laptop.cloud.connections).toHaveLength(1);

	for (const item of [editor, bobEditor]) item.close();
	for (const app of [laptop, phone, desktop]) app.cloud.close();
});
