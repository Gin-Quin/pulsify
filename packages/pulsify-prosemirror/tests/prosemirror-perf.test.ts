import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { object } from "@gin-quin/codec";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema as basic } from "prosemirror-schema-basic";
import {
	applyPulseUpdates,
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	getPulseMeta,
	getPulseVersions,
	joinPresence,
	loadPulse,
	PulseRelay,
	richText,
	RichTextSelection,
	type Pulse,
} from "pulsify-core";
import { bindProseMirror, type ProseMirrorBinding } from "../source/index.js";
import { createRuntime } from "../../pulse/source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../../pulse/source/pulses/PulseOptions.js";

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

const schema = new Schema({ nodes: basic.spec.nodes, marks: basic.spec.marks });
const Doc = definePulse(
	"PMPerfDoc",
	object({ title: "string", body: richText() }),
).materialize();

const views: EditorView[] = [];
const pulses: Pulse<any>[] = [];
const bindings: ProseMirrorBinding[] = [];
let sid = 86000;
const opts = () => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId: sid++,
});

function setup(paragraphs: number) {
	const a = createPulse(Doc, { title: "init", body: "" }, opts());
	pulses.push(a);
	const elA = document.createElement("div");
	document.body.append(elA);
	const viewA = new EditorView(elA, { state: EditorState.create({ schema }) });
	views.push(viewA);
	const bindA = bindProseMirror(viewA, a.body);
	bindings.push(bindA);

	const nodes = Array.from({ length: paragraphs }, () =>
		schema.nodes["paragraph"]!.create(
			null,
			schema.text("0123456789abcdefghij"),
		),
	);
	viewA.dispatch(
		viewA.state.tr.replaceWith(0, viewA.state.doc.content.size, nodes),
	);

	const b = createRuntime(Doc, a.id, opts()) as typeof a;
	pulses.push(b);
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	const elB = document.createElement("div");
	document.body.append(elB);
	const viewB = new EditorView(elB, { state: EditorState.create({ schema }) });
	views.push(viewB);
	const bindB = bindProseMirror(viewB, b.body);
	bindings.push(bindB);
	return { a, b, viewA, viewB, bindA, bindB };
}

afterEach(() => {
	for (const binding of bindings.splice(0)) binding.destroy();
	for (const view of views.splice(0)) if (!view.isDestroyed) view.destroy();
	for (const pulse of pulses.splice(0)) destroyPulse(pulse);
	document.body.innerHTML = "";
});

test("E2/E3: unrelated field writes skip ProseMirror binding and keystrokes scale sublinearly (n vs 4n)", () => {
	const measure = (paragraphs: number) => {
		const { a, b, viewA, viewB } = setup(paragraphs);
		const midPos = Math.floor(paragraphs / 2) * 22 + 6;
		// Warm up once.
		viewA.dispatch(viewA.state.tr.insertText("w", midPos));
		applyPulseUpdates(b, exportPulseUpdates(a, []));

		const iters = 8;
		const t0 = performance.now();
		for (let i = 0; i < iters; i++)
			viewA.dispatch(viewA.state.tr.insertText("x", midPos));
		const localMs = (performance.now() - t0) / iters;

		applyPulseUpdates(b, exportPulseUpdates(a, []));
		let remoteTotal = 0;
		for (let i = 0; i < iters; i++) {
			const ver = getPulseVersions(a).state;
			viewB.dispatch(viewB.state.tr.insertText("y", midPos));
			const frames = exportPulseUpdates(b, ver);
			const s = performance.now();
			applyPulseUpdates(a, frames);
			remoteTotal += performance.now() - s;
		}
		const tOther = performance.now();
		for (let i = 0; i < 20; i++) a.title = "t" + i;
		const otherMs = (performance.now() - tOther) / 20;
		return { localMs, remoteMs: remoteTotal / iters, otherMs };
	};
	const n = measure(150);
	const fourN = measure(600);
	expect(fourN.otherMs).toBeLessThan(0.5);
	expect(fourN.localMs).toBeLessThan(Math.max(5, n.localMs * 3.2));
	expect(fourN.remoteMs).toBeLessThan(Math.max(5, n.remoteMs * 3.2));
});

test("E4: large ProseMirror paste, format and delete use compact ops, and >1 MiB paste reverts atomically", () => {
	const a = createPulse(
		Doc,
		{ title: "t", body: "" },
		{ ...defaultPulseOptions, scope: createPulseScope() },
	);
	pulses.push(a);
	const el = document.createElement("div");
	document.body.append(el);
	const view = new EditorView(el, { state: EditorState.create({ schema }) });
	views.push(view);
	const binding = bindProseMirror(view, a.body);
	bindings.push(binding);

	// 10k paste ~ 1 B/char
	let ver = getPulseVersions(a).state;
	view.dispatch(view.state.tr.insertText("a".repeat(10_000), 1));
	const pasteBytes = getPulseMeta(a)
		.log.missing(ver)
		.reduce((s, r) => s + r.operations.byteLength, 0);
	expect(pasteBytes).toBeLessThan(12_000);

	// Formatting 10k contiguous pasted characters uses an entry ID range (kind 11)
	ver = getPulseVersions(a).state;
	view.dispatch(
		view.state.tr.addMark(1, 10_001, schema.marks["strong"]!.create()),
	);
	const formatBytes = getPulseMeta(a)
		.log.missing(ver)
		.reduce((s, r) => s + r.operations.byteLength, 0);
	expect(formatBytes).toBeLessThan(512);

	// Deleting 10k contiguous pasted characters uses a delete range (kind 13)
	ver = getPulseVersions(a).state;
	view.dispatch(view.state.tr.delete(1, 10_001));
	const deleteBytes = getPulseMeta(a)
		.log.missing(ver)
		.reduce((s, r) => s + r.operations.byteLength, 0);
	expect(deleteBytes).toBeLessThan(512);

	// Oversized >1 MiB paste fails locally and reverts atomically
	view.dispatch(view.state.tr.insertText("ok", 1));
	const beforeState = view.state;
	const beforeVector = getPulseMeta(a).log.vector;
	expect(() =>
		view.dispatch(view.state.tr.insertText("b".repeat(1_100_000), 3)),
	).toThrow(/1 MiB/);
	expect(view.state).toBe(beforeState);
	expect(a.body.text).toBe("ok");
	expect(getPulseMeta(a).log.vector).toEqual(beforeVector);

	// Subsequent edits still export and synchronize cleanly
	view.dispatch(view.state.tr.insertText("!", 3));
	const b = createRuntime(Doc, a.id, opts()) as typeof a;
	pulses.push(b);
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	expect(b.body.text).toBe("ok!");
});

test("E5: ProseMirror local edits do not re-enter updateState via redraw()", async () => {
	const relay = new PulseRelay();
	const a = createPulse(
		Doc,
		{ title: "t", body: "Hello world" },
		{ scope: createPulseScope(), connectors: [createMemoryConnector(relay)] },
	);
	pulses.push(a);
	const elA = document.createElement("div");
	document.body.append(elA);
	const viewA = new EditorView(elA, { state: EditorState.create({ schema }) });
	views.push(viewA);
	bindings.push(bindProseMirror(viewA, a.body, { selection: { name: "Ada" } }));
	await connectPulse(a).synced;

	const b = await loadPulse(Doc, a.id, {
		scope: createPulseScope(),
		connectors: [createMemoryConnector(relay)],
		waitFor: "all",
	});
	pulses.push(b);
	const elB = document.createElement("div");
	document.body.append(elB);
	const viewB = new EditorView(elB, { state: EditorState.create({ schema }) });
	views.push(viewB);
	bindings.push(bindProseMirror(viewB, b.body, { selection: true }));

	// Publish a remote selection on `a` so `b` draws peer decorations.
	joinPresence(a, RichTextSelection).set({
		anchor: a.body.anchorAt(3),
		head: a.body.anchorAt(6),
		name: "Ada",
		color: "#e5484d",
	});
	const end = performance.now() + 1000;
	while (!viewB.dom.querySelector("[data-peer]") && performance.now() < end)
		await new Promise((r) => setTimeout(r, 5));
	expect(viewB.dom.querySelector("[data-peer]")).not.toBeNull();

	// Track re-entrancy into `viewB.updateState` during local edits (including deleting the peer's anchor char).
	let depth = 0;
	let maxDepth = 0;
	const origUpdateState = viewB.updateState.bind(viewB);
	viewB.updateState = (state) => {
		depth++;
		if (depth > maxDepth) maxDepth = depth;
		try {
			return origUpdateState(state);
		} finally {
			depth--;
		}
	};
	viewB.dispatch(viewB.state.tr.delete(2, 8));
	viewB.dispatch(viewB.state.tr.insertText("XYZ", 2));
	expect(maxDepth).toBe(1);
});
