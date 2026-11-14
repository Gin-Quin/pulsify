import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import {
	applyPulseUpdates,
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	joinPresence,
	loadPulse,
	object,
	plainText,
	PulseRelay,
	RichTextSelection,
	type Pulse,
} from "pulsify-core";
import {
	bindCodeMirror,
	type CodeMirrorBindingOptions,
} from "../source/index.js";
import { createRuntime } from "../../pulse/source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../../pulse/source/pulses/PulseOptions.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	pretendToBeVisual: true,
});
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	Node: dom.window.Node,
	Window: dom.window.Window,
	HTMLElement: dom.window.HTMLElement,
	MutationObserver: dom.window.MutationObserver,
	getComputedStyle: dom.window.getComputedStyle,
	requestAnimationFrame: dom.window.requestAnimationFrame,
	cancelAnimationFrame: dom.window.cancelAnimationFrame,
});

const File = definePulse("File", object({ code: plainText() })).materialize();
const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
const views: EditorView[] = [];
const pulses: Pulse<any>[] = [];
let sid = 90000;
function create(code: string) {
	const pulse = createPulse(File, { code }, options(sid++));
	pulses.push(pulse);
	return pulse;
}
function peer(source: ReturnType<typeof create>) {
	const pulse = createRuntime(File, source.id, options(sid++)) as ReturnType<
		typeof create
	>;
	applyPulseUpdates(pulse, exportPulseUpdates(source, []));
	pulses.push(pulse);
	return pulse;
}
function editor(pulse: ReturnType<typeof create>, doc = "") {
	const view = new EditorView({
		state: EditorState.create({ doc, extensions: [history()] }),
		parent: document.body,
	});
	views.push(view);
	return { view, binding: bindCodeMirror(view, pulse.code) };
}
/** Exchange every update both ways. */
function sync(a: Pulse<any>, b: Pulse<any>) {
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	applyPulseUpdates(a, exportPulseUpdates(b, []));
}
afterEach(() => {
	for (const view of views.splice(0)) view.destroy();
	for (const pulse of pulses.splice(0)) destroyPulse(pulse);
});

test("the field supplies the document and editor changes edit the field", () => {
	const pulse = create("let a = 1;\nlet b = 2;");
	const { view } = editor(pulse, "stale editor content");
	expect(view.state.doc.toString()).toBe("let a = 1;\nlet b = 2;");
	view.dispatch({ changes: { from: 4, to: 5, insert: "😀" } });
	expect(pulse.code.text).toBe("let 😀 = 1;\nlet b = 2;");
	// Several ranges in one transaction, as with multiple cursors.
	view.dispatch({
		changes: [
			{ from: 0, to: 3, insert: "const" },
			{ from: 12, to: 15, insert: "const" },
		],
	});
	expect(pulse.code.text).toBe("const 😀 = 1;\nconst b = 2;");
	expect(view.state.doc.toString()).toBe(pulse.code.text);
});

test("concurrent edits in two editors merge and keep each selection", () => {
	const a = create("function f() {}\n");
	const b = peer(a);
	const first = editor(a).view,
		second = editor(b).view;
	first.dispatch({ changes: { from: 0, insert: "// header\n" } });
	second.dispatch({
		changes: { from: 16, insert: "f();\n" },
		selection: { anchor: 21 },
	});
	sync(a, b);
	const merged = "// header\nfunction f() {}\nf();\n";
	expect(first.state.doc.toString()).toBe(merged);
	expect(second.state.doc.toString()).toBe(merged);
	expect(a.code.text).toBe(merged);
	// The caret of the second editor moved with the text inserted before it.
	expect(second.state.selection.main.head).toBe(merged.length);
});

test("undo reverts local edits only", () => {
	const a = create("one");
	const b = peer(a);
	const { view } = editor(a);
	view.dispatch({ changes: { from: 3, insert: " two" } });
	b.code.insert(0, "zero ");
	sync(a, b);
	expect(view.state.doc.toString()).toBe("zero one two");
	undo(view);
	expect(view.state.doc.toString()).toBe("zero one");
	expect(a.code.text).toBe("zero one");
	// Nothing left to undo: the remote edit is not in the history.
	expect(undo(view)).toBe(false);
});

test("carriage returns are normalized to CodeMirror line breaks", () => {
	const pulse = create("a\r\nb\rc");
	const { view } = editor(pulse);
	expect(pulse.code.text).toBe("a\nb\nc");
	expect(view.state.doc.lines).toBe(3);
	view.dispatch({ changes: { from: 4, insert: "!" } });
	expect(pulse.code.text).toBe("a\nb\n!c");
});

test("a destroyed binding leaves the editor and the field independent", () => {
	const pulse = create("bound");
	const { view, binding } = editor(pulse);
	binding.destroy();
	view.dispatch({ changes: { from: 0, insert: "un" } });
	pulse.code.insert(0, "re");
	expect(view.state.doc.toString()).toBe("unbound");
	expect(pulse.code.text).toBe("rebound");
});

/** Presence is throttled and relayed asynchronously: poll instead of sleeping. */
async function eventually(assertion: () => void, timeout = 2000) {
	const end = performance.now() + timeout;
	while (true) {
		try {
			assertion();
			return;
		} catch (error) {
			if (performance.now() >= end) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

test("a selection is drawn in the other editor, follows edits and leaves on blur", async () => {
	const relay = new PulseRelay();
	const a = createPulse(
		File,
		{ code: "Hello world" },
		{ scope: createPulseScope(), connectors: [createMemoryConnector(relay)] },
	);
	pulses.push(a);
	await connectPulse(a).synced;
	const b = await loadPulse(File, a.id, {
		scope: createPulseScope(),
		connectors: [createMemoryConnector(relay)],
		waitFor: "all",
	});
	pulses.push(b);
	const mount = (
		pulse: typeof a,
		selection: NonNullable<CodeMirrorBindingOptions["selection"]>,
	) => {
		const view = new EditorView({ parent: document.body });
		views.push(view);
		return { view, binding: bindCodeMirror(view, pulse.code, { selection }) };
	};
	const left = mount(a, { name: "Ada", color: "#e5484d" });
	const right = mount(b, true);
	const carets = () => [
		...right.view.dom.querySelectorAll<HTMLElement>("[data-peer]"),
	];
	const range = () =>
		right.view.dom.querySelector("[data-peer-selection]")?.textContent;
	// Nothing is shared before the editor has the focus.
	left.view.dispatch({ selection: { anchor: 2, head: 6 } });
	expect(joinPresence(a, RichTextSelection).mine).toBeUndefined();
	left.view.focus();
	left.view.dispatch({ selection: { anchor: 2, head: 6 } });
	await eventually(() => expect(carets()).toHaveLength(1));
	expect(carets()[0]!.textContent).toBe("Ada");
	expect(carets()[0]!.style.borderLeftColor).toBe("rgb(229, 72, 77)");
	expect(range()).toBe("llo ");
	// My own selection is never drawn.
	expect(left.view.dom.querySelectorAll("[data-peer]")).toHaveLength(0);
	// Text typed before it here moves it at once.
	right.view.dispatch({ changes: { from: 0, insert: "Oh " } });
	expect(range()).toBe("llo ");
	await eventually(() => expect(a.code.text).toBe("Oh Hello world"));
	// Blur withdraws it.
	left.view.contentDOM.blur();
	await eventually(() => expect(carets()).toHaveLength(0));
	expect(right.view.state.doc.toString()).toBe("Oh Hello world");
});

test("a caret stays where it was while the characters it moved after are on their way", async () => {
	const relay = new PulseRelay();
	const a = createPulse(
		File,
		{ code: "Hello" },
		{ scope: createPulseScope(), connectors: [createMemoryConnector(relay)] },
	);
	pulses.push(a);
	await connectPulse(a).synced;
	const b = await loadPulse(File, a.id, {
		scope: createPulseScope(),
		connectors: [createMemoryConnector(relay)],
		waitFor: "all",
	});
	pulses.push(b);
	const view = new EditorView({ parent: document.body });
	views.push(view);
	bindCodeMirror(view, b.code, { selection: true });
	const mine = joinPresence(a, RichTextSelection);
	const others = joinPresence(b, RichTextSelection);
	const at = (anchor: string) => ({
		anchor,
		head: anchor,
		name: "Ada",
		color: "",
	});
	const caret = () => {
		const element = view.dom.querySelector("[data-peer]");
		return element && view.posAtDOM(element);
	};
	mine.set(at(a.code.anchorAt(3)));
	await eventually(() => expect(caret()).toBe(3));
	// Presence is relayed at once, the edit is not: hold the edit back.
	const c = createRuntime(File, a.id, options(sid++)) as typeof a;
	pulses.push(c);
	applyPulseUpdates(c, exportPulseUpdates(a, []));
	c.code.insert(5, "!");
	const typed = c.code.anchorAt(6);
	mine.set(at(typed));
	await eventually(() => expect(others.others[0]!.state.head).toBe(typed));
	expect(caret()).toBe(3);
	applyPulseUpdates(b, exportPulseUpdates(c, []));
	expect(caret()).toBe(6);
});
