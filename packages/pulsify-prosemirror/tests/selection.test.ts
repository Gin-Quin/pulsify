import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { object } from "@gin-quin/codec";
import { Schema } from "prosemirror-model";
import {
	EditorState,
	Plugin,
	TextSelection,
	type Transaction,
} from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema as basic } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { history, undo, undoDepth } from "prosemirror-history";
import { splitBlock } from "prosemirror-commands";
import {
	applyPulseUpdates,
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	getPulseVersions,
	joinPresence,
	loadPulse,
	PulseRelay,
	richText,
	RichTextSelection,
	type Pulse,
	type RichText,
} from "pulsify-core";
import {
	bindProseMirror,
	type ProseMirrorBindingOptions,
} from "../source/index.js";
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
const schema = new Schema({
	nodes: addListNodes(basic.spec.nodes, "paragraph block*", "block"),
	marks: basic.spec.marks,
});
const Note = definePulse(
	"ProseMirrorCursorNote",
	object({ body: richText(), other: richText() }),
).materialize();
type Note = ReturnType<typeof create>;
const offline = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
const views: EditorView[] = [];
const pulses: Pulse<any>[] = [];
let sid = 90000;
function create(text = "") {
	const pulse = createPulse(
		Note,
		{ body: text, other: "Other" },
		offline(sid++),
	);
	pulses.push(pulse);
	return pulse;
}
/** Another replica of a document, synchronized by hand with `sync`. */
function peer(source: Note) {
	const pulse = createRuntime(Note, source.id, offline(sid++)) as Note;
	applyPulseUpdates(pulse, exportPulseUpdates(source, []));
	pulses.push(pulse);
	return pulse;
}
function sync(a: Note, b: Note) {
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	applyPulseUpdates(a, exportPulseUpdates(b, []));
}
function editor(
	field: RichText,
	options?: ProseMirrorBindingOptions,
	plugins: Plugin[] = [history()],
) {
	const element = document.createElement("div");
	document.body.append(element);
	const view = new EditorView(element, {
		state: EditorState.create({ schema, plugins }),
	});
	views.push(view);
	return { view, binding: bindProseMirror(view, field, options) };
}
/**
 * Two pulses of one document, each through its own session of one relay, and
 * a bound editor on each. The left one binds first and writes the structure.
 */
async function pair(
	leftOptions?: ProseMirrorBindingOptions,
	rightOptions?: ProseMirrorBindingOptions,
	rightPlugins?: Plugin[],
) {
	const relay = new PulseRelay();
	const a = createPulse(
		Note,
		{ body: "Hello world", other: "Other" },
		{ scope: createPulseScope(), connectors: [createMemoryConnector(relay)] },
	);
	pulses.push(a);
	const left = editor(a.body, leftOptions);
	await connectPulse(a).synced;
	const b = await loadPulse(Note, a.id, {
		scope: createPulseScope(),
		connectors: [createMemoryConnector(relay)],
		waitFor: "all",
	});
	pulses.push(b);
	const right = editor(b.body, rightOptions, rightPlugins);
	return { a, b, left, right };
}
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
// Both editors live in one JSDOM document, which has a single focused element:
// these give each editor the focus event its own window would.
const focus = (view: EditorView) =>
	view.dom.dispatchEvent(new dom.window.FocusEvent("focus"));
const blur = (view: EditorView) =>
	view.dom.dispatchEvent(new dom.window.FocusEvent("blur"));
const select = (view: EditorView, anchor: number, head = anchor) =>
	view.dispatch(
		view.state.tr.setSelection(
			TextSelection.create(view.state.doc, anchor, head),
		),
	);
const carets = (view: EditorView) => [
	...view.dom.querySelectorAll<HTMLElement>("[data-peer]"),
];
const ranges = (view: EditorView) =>
	[...view.dom.querySelectorAll("[data-peer-selection]")].map(
		(element) => element.textContent,
	);
/** The document text before the remote caret, without its label. */
function textBeforeCaret(view: EditorView): string | undefined {
	const caret = carets(view)[0];
	if (!caret) return undefined;
	let text = "";
	const walker = document.createTreeWalker(
		view.dom,
		dom.window.NodeFilter.SHOW_TEXT,
	);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (
			!(
				caret.compareDocumentPosition(node) &
				dom.window.Node.DOCUMENT_POSITION_PRECEDING
			)
		)
			break;
		text += node.textContent;
	}
	return text;
}
afterEach(() => {
	for (const view of views.splice(0)) if (!view.isDestroyed) view.destroy();
	for (const pulse of pulses.splice(0)) destroyPulse(pulse);
	document.body.innerHTML = "";
});

test("an anchor follows its position through local and remote inserts and deletes", () => {
	const a = create("Hello world"),
		{ view, binding } = editor(a.body);
	const b = peer(a),
		remote = editor(b.body);
	const anchor = binding.anchorAt(6);
	expect(binding.positionOf(anchor)).toBe(6);
	view.dispatch(view.state.tr.insertText("Hey, ", 1));
	expect(binding.positionOf(anchor)).toBe(11);
	// Text typed exactly at an anchor lands after it.
	view.dispatch(view.state.tr.insertText(",", 11));
	expect(binding.positionOf(anchor)).toBe(11);
	sync(a, b);
	remote.view.dispatch(remote.view.state.tr.insertText("🚀", 1));
	sync(a, b);
	expect(view.state.doc.textContent).toBe("🚀Hey, Hello, world");
	expect(binding.positionOf(anchor)).toBe(13);
	expect(remote.binding.positionOf(anchor)).toBe(13);
	expect(view.state.doc.textBetween(1, 13)).toBe("🚀Hey, Hello");
	// The field has the same anchors, in text indices.
	expect(a.body.indexOf(anchor)).toBe(11);
	expect(binding.anchorAt(13)).toBe(a.body.anchorAt(11));
	expect(binding.positionOf(a.body.anchorAt(11))).toBe(13);
	// Once its character is deleted, an anchor is where the character was.
	remote.view.dispatch(remote.view.state.tr.delete(10, 13));
	sync(a, b);
	expect(view.state.doc.textContent).toBe("🚀Hey, He, world");
	expect(binding.positionOf(anchor)).toBe(10);
	view.dispatch(view.state.tr.delete(1, 10));
	expect(view.state.doc.textContent).toBe(", world");
	expect(binding.positionOf(anchor)).toBe(1);
	expect(remote.binding.positionOf(anchor)).toBe(10);
	sync(a, b);
	expect(remote.binding.positionOf(anchor)).toBe(1);
});

test("anchors at position 0, in an empty paragraph and at block boundaries", () => {
	const a = create("ab"),
		{ view, binding } = editor(a.body);
	select(view, 2);
	splitBlock(view.state, view.dispatch);
	select(view, 5);
	splitBlock(view.state, view.dispatch);
	view.dispatch(
		view.state.tr.insert(
			view.state.doc.content.size,
			schema.nodes["horizontal_rule"]!.create(),
		),
	);
	// <p>a</p><p>b</p><p></p><hr>
	expect(view.state.doc.childCount).toBe(4);
	expect(view.state.doc.content.size).toBe(9);
	expect(binding.positionOf(binding.anchorAt(0))).toBe(0);
	// Every text position, the empty paragraph (7) included, is its own anchor.
	for (const position of [1, 2, 4, 5, 7]) {
		expect(view.state.doc.resolve(position).parent.isTextblock).toBe(true);
		expect(binding.positionOf(binding.anchorAt(position))).toBe(position);
	}
	// Between two blocks: the end of the block before.
	expect(binding.positionOf(binding.anchorAt(3))).toBe(2);
	expect(binding.positionOf(binding.anchorAt(6))).toBe(5);
	expect(binding.positionOf(binding.anchorAt(8))).toBe(7);
	// After a leaf block.
	expect(binding.positionOf(binding.anchorAt(9))).toBe(9);
	for (const position of [-1, 10, 1.5, Number.NaN])
		expect(() => binding.anchorAt(position)).toThrow(RangeError);
	// Interchangeable with the anchors of the field.
	expect(a.body.indexOf(binding.anchorAt(0))).toBe(0);
	expect(a.body.indexOf(binding.anchorAt(7))).toBe(2);
	expect(binding.positionOf(a.body.anchorAt(0))).toBe(0);
	expect(binding.positionOf(a.body.anchorAt(1))).toBe(2);
	expect(binding.positionOf(a.body.anchorAt(2))).toBe(5);
	// A caret in the empty paragraph stays there when a peer types before it.
	const empty = binding.anchorAt(7);
	const b = peer(a),
		remote = editor(b.body);
	remote.view.dispatch(remote.view.state.tr.insertText("X", 5));
	sync(a, b);
	expect(binding.positionOf(empty)).toBe(8);
	expect(view.state.doc.resolve(8).parent.content.size).toBe(0);
	expect(remote.binding.positionOf(empty)).toBe(8);
	// Removing the paragraph leaves the anchor at the end of the one before.
	view.dispatch(view.state.tr.delete(7, 9));
	expect(view.state.doc.childCount).toBe(3);
	expect(binding.positionOf(empty)).toBe(6);
});

test("an anchor of another field or of an entry not received does not resolve", () => {
	const a = create("Hello"),
		body = editor(a.body).binding,
		other = editor(a.other).binding;
	expect(body.positionOf(a.other.anchorAt(2))).toBeUndefined();
	expect(body.positionOf(other.anchorAt(0))).toBeUndefined();
	expect(body.positionOf(other.anchorAt(3))).toBeUndefined();
	expect(other.positionOf(body.anchorAt(3))).toBeUndefined();
	expect(other.positionOf(other.anchorAt(3))).toBe(3);
	expect(body.positionOf("999999:1:0")).toBeUndefined();
	const b = peer(a),
		remote = editor(b.body);
	remote.view.dispatch(remote.view.state.tr.insertText("!", 6));
	const unseen = remote.binding.anchorAt(7);
	expect(body.positionOf(unseen)).toBeUndefined();
	sync(a, b);
	expect(body.positionOf(unseen)).toBe(7);
});

test("a destroyed binding gives no anchor and resolves none", () => {
	const a = create("Hello"),
		{ view, binding } = editor(a.body);
	const anchor = binding.anchorAt(3);
	binding.destroy();
	expect(() => binding.anchorAt(3)).toThrow("destroyed");
	expect(binding.positionOf(anchor)).toBeUndefined();
	const again = bindProseMirror(view, a.body);
	expect(again.positionOf(anchor)).toBe(3);
	view.destroy();
	expect(() => again.anchorAt(3)).toThrow("destroyed");
	expect(again.positionOf(anchor)).toBeUndefined();
});

test("a selection is drawn in the other editor, moves with it and leaves on blur and destroy", async () => {
	const { a, b, left, right } = await pair(
		{ selection: { name: "Ada", color: "#e5484d" } },
		{ selection: true },
	);
	const others = joinPresence(b, RichTextSelection);
	// Nothing is shared before the editor has the focus.
	select(left.view, 3, 7);
	expect(joinPresence(a, RichTextSelection).mine).toBeUndefined();
	left.view.focus();
	await eventually(() => expect(carets(right.view)).toHaveLength(1));
	const caret = carets(right.view)[0]!;
	expect(caret.getAttribute("data-peer")).toBe(String(others.others[0]!.peer));
	expect(caret.textContent).toBe("Ada");
	expect(caret.style.borderLeftColor).toBe("rgb(229, 72, 77)");
	expect(caret.style.borderLeftWidth).toBe("2px");
	expect(textBeforeCaret(right.view)).toBe("Hello ");
	expect(ranges(right.view)).toEqual(["llo "]);
	expect(
		right.view.dom
			.querySelector("[data-peer-selection]")!
			.getAttribute("style"),
	).toContain("rgb(229, 72, 77)");
	expect(right.view.state.doc.textContent).toBe("Hello world");
	// My own selection is never drawn.
	expect(carets(left.view)).toEqual([]);
	// It moves when it moves, here to a caret.
	select(left.view, 2);
	await eventually(() => expect(textBeforeCaret(right.view)).toBe("H"));
	expect(ranges(right.view)).toEqual([]);
	// It follows its character at once when this editor types before it, and
	// stays before what is typed exactly on it.
	right.view.dispatch(right.view.state.tr.insertText("X", 1));
	expect(textBeforeCaret(right.view)).toBe("XH");
	right.view.dispatch(right.view.state.tr.insertText("Y", 3));
	expect(textBeforeCaret(right.view)).toBe("XH");
	await eventually(() =>
		expect(left.view.state.doc.textContent).toBe("XHYello world"),
	);
	expect(left.view.state.selection.head).toBe(3);
	// It disappears on blur and comes back with the focus.
	(left.view.dom as HTMLElement).blur();
	await eventually(() => expect(carets(right.view)).toEqual([]));
	expect(others.others).toEqual([]);
	left.view.focus();
	await eventually(() => expect(textBeforeCaret(right.view)).toBe("XH"));
	left.binding.destroy();
	await eventually(() => expect(carets(right.view)).toEqual([]));
	expect(others.others).toEqual([]);
	expect(right.view.state.doc.textContent).toBe("XHYello world");
});

test("destroying the editor or the drawing binding removes the cursors", async () => {
	const { a, b, left, right } = await pair(
		{ selection: { name: "Ada" } },
		{ selection: true },
	);
	const others = joinPresence(b, RichTextSelection);
	focus(left.view);
	select(left.view, 4);
	await eventually(() => expect(textBeforeCaret(right.view)).toBe("Hel"));
	left.view.destroy();
	await eventually(() => expect(others.others).toEqual([]));
	expect(carets(right.view)).toEqual([]);
	const again = editor(a.body, { selection: { name: "Ada" } });
	focus(again.view);
	select(again.view, 2);
	await eventually(() => expect(textBeforeCaret(right.view)).toBe("H"));
	right.binding.destroy();
	expect(carets(right.view)).toEqual([]);
	expect(right.view.dom.textContent).toBe("Hello world");
});

test("draw: false shares a selection and draws none", async () => {
	const { a, left, right } = await pair(
		{ selection: { name: "Ada", draw: false } },
		{ selection: { name: "Grace", color: "rebeccapurple" } },
	);
	const selections = joinPresence(a, RichTextSelection);
	select(right.view, 3, 6);
	focus(right.view);
	await eventually(() => expect(selections.others).toHaveLength(1));
	const { state } = selections.others[0]!;
	expect(state.name).toBe("Grace");
	expect(state.color).toBe("rebeccapurple");
	// The anchors of the channel resolve with the binding.
	expect(left.binding.positionOf(state.anchor)).toBe(3);
	expect(left.binding.positionOf(state.head)).toBe(6);
	expect(carets(left.view)).toEqual([]);
	expect(ranges(left.view)).toEqual([]);
	// Mine is shared all the same.
	focus(left.view);
	select(left.view, 8, 2);
	await eventually(() => expect(textBeforeCaret(right.view)).toBe("H"));
	expect(carets(right.view)).toHaveLength(1);
	expect(carets(right.view)[0]!.textContent).toBe("Ada");
	expect(ranges(right.view)).toEqual(["ello w"]);
	expect(carets(left.view)).toEqual([]);
});

test("a remote cursor adds no undo step and leaves the document, the selection and the field alone", async () => {
	const seen: Transaction[] = [];
	const spy = new Plugin({
		filterTransaction(tr) {
			seen.push(tr);
			return true;
		},
	});
	const { a, b, left, right } = await pair(
		{ selection: { name: "Ada" } },
		{ selection: true },
		[history(), spy],
	);
	right.view.dispatch(right.view.state.tr.insertText("!", 12));
	select(right.view, 4);
	await eventually(() =>
		expect(left.view.state.doc.textContent).toBe("Hello world!"),
	);
	const { doc, selection } = right.view.state;
	const depth = undoDepth(right.view.state);
	expect(depth).toBe(1);
	// Pulsify's own history recorded the edit, and must see nothing else.
	expect(right.binding.canUndo).toBe(true);
	let historyChanges = 0;
	const stopHistory = right.binding.history.subscribe(() => historyChanges++);
	const versions = [a, b].map((pulse) =>
		JSON.stringify(getPulseVersions(pulse).state),
	);
	const frames = [a, b].map((pulse) => exportPulseUpdates(pulse, []));
	seen.length = 0;
	focus(left.view);
	select(left.view, 2, 6);
	await eventually(() => expect(ranges(right.view)).toEqual(["ello"]));
	select(left.view, 9);
	await eventually(() => expect(textBeforeCaret(right.view)).toBe("Hello wo"));
	blur(left.view);
	await eventually(() => expect(carets(right.view)).toEqual([]));
	focus(left.view);
	await eventually(() => expect(carets(right.view)).toHaveLength(1));
	// Each redraw is a transaction that does nothing but carry its meta.
	expect(seen.length).toBeGreaterThanOrEqual(4);
	for (const tr of seen) {
		expect(tr.docChanged).toBe(false);
		expect(tr.selectionSet).toBe(false);
		expect(tr.scrolledIntoView).toBe(false);
		expect(tr.getMeta("addToHistory")).toBe(false);
	}
	expect(right.view.state.doc).toBe(doc);
	expect(right.view.state.selection.eq(selection)).toBe(true);
	expect(undoDepth(right.view.state)).toBe(depth);
	expect(historyChanges).toBe(0);
	expect(right.binding.canUndo).toBe(true);
	expect(right.binding.canRedo).toBe(false);
	stopHistory();
	// Sharing and drawing selections wrote nothing to the document.
	expect(
		[a, b].map((pulse) => JSON.stringify(getPulseVersions(pulse).state)),
	).toEqual(versions);
	expect([a, b].map((pulse) => exportPulseUpdates(pulse, []))).toEqual(frames);
	expect(undo(right.view.state, right.view.dispatch)).toBe(true);
	expect(right.view.state.doc.textContent).toBe("Hello world");
	expect(textBeforeCaret(right.view)).toBe("Hello wo");
});

test("a selection that arrives before its character is drawn once the character does", async () => {
	const { a, b, right } = await pair(undefined, { selection: true });
	// A replica that typed offline: the others have its anchor before its text.
	const c = createRuntime(Note, a.id, offline(sid++)) as Note;
	pulses.push(c);
	applyPulseUpdates(c, exportPulseUpdates(a, []));
	c.body.insert(5, " there");
	const anchor = c.body.anchorAt(11);
	joinPresence(a, RichTextSelection).set({
		anchor,
		head: anchor,
		name: "Ghost",
		color: "",
	});
	const others = joinPresence(b, RichTextSelection);
	await eventually(() => expect(others.others).toHaveLength(1));
	expect(right.binding.positionOf(anchor)).toBeUndefined();
	expect(carets(right.view)).toEqual([]);
	applyPulseUpdates(b, exportPulseUpdates(c, []));
	expect(right.view.state.doc.textContent).toBe("Hello there world");
	expect(right.binding.positionOf(anchor)).toBe(12);
	expect(carets(right.view)).toHaveLength(1);
	expect(carets(right.view)[0]!.textContent).toBe("Ghost");
	expect(textBeforeCaret(right.view)).toBe("Hello there");
});

test("a caret stays where it was while the characters it moved after are on their way", async () => {
	const { a, b, left, right } = await pair(undefined, { selection: true });
	const mine = joinPresence(a, RichTextSelection);
	const others = joinPresence(b, RichTextSelection);
	const at = (anchor: string) => ({
		anchor,
		head: anchor,
		name: "Ada",
		color: "",
	});
	mine.set(at(left.binding.anchorAt(6)));
	await eventually(() => expect(textBeforeCaret(right.view)).toBe("Hello"));
	// Presence is relayed at once, the edit is not: hold the edit back.
	const c = createRuntime(Note, a.id, offline(sid++)) as Note;
	pulses.push(c);
	applyPulseUpdates(c, exportPulseUpdates(a, []));
	c.body.insert(5, "!");
	const typed = c.body.anchorAt(6);
	mine.set(at(typed));
	await eventually(() => expect(others.others[0]!.state.head).toBe(typed));
	expect(carets(right.view)).toHaveLength(1);
	expect(textBeforeCaret(right.view)).toBe("Hello");
	applyPulseUpdates(b, exportPulseUpdates(c, []));
	expect(textBeforeCaret(right.view)).toBe("Hello!");
	// A peer gone to another field leaves this one at once.
	mine.set(at(a.other.anchorAt(2)));
	await eventually(() => expect(carets(right.view)).toEqual([]));
});

test("a selection in another field is not drawn; a peer without a color gets one from its number", async () => {
	const { a, b, left, right } = await pair(undefined, { selection: true });
	const others = joinPresence(b, RichTextSelection);
	const other = editor(a.other, { selection: { name: "Ada" } });
	focus(other.view);
	select(other.view, 3);
	await eventually(() => expect(others.others).toHaveLength(1));
	expect(
		right.binding.positionOf(others.others[0]!.state.head),
	).toBeUndefined();
	expect(carets(right.view)).toEqual([]);
	// The same peer, now in this field, without a name or a color.
	blur(other.view);
	const mine = joinPresence(a, RichTextSelection);
	const anchor = left.binding.anchorAt(0),
		head = left.binding.anchorAt(4);
	mine.set({ anchor, head, name: "", color: "" });
	await eventually(() => expect(carets(right.view)).toHaveLength(1));
	const caret = carets(right.view)[0]!;
	expect(caret.childNodes).toHaveLength(0);
	const color = caret.style.borderLeftColor;
	expect(color).toMatch(/^(rgb|hsl)\(/);
	// The start of the field is drawn from the start of the first text block.
	expect(ranges(right.view)).toEqual(["Hel"]);
	expect(textBeforeCaret(right.view)).toBe("Hel");
	// A color that could leave its declaration is replaced by that default.
	mine.set({ anchor, head, name: "", color: "red; background: url(x)" });
	await eventually(() =>
		expect(others.others[0]!.state.color).toContain("url"),
	);
	expect(carets(right.view)).toHaveLength(1);
	expect(carets(right.view)[0]!.style.borderLeftColor).toBe(color);
	expect(right.view.dom.innerHTML).not.toContain("url");
});

test("a binding without `selection` joins no channel and draws nothing", async () => {
	const { a, b, left, right } = await pair({ selection: true });
	const others = joinPresence(b, RichTextSelection);
	focus(left.view);
	select(left.view, 3);
	await eventually(() => expect(others.others).toHaveLength(1));
	expect(right.binding.positionOf(others.others[0]!.state.head)).toBe(3);
	expect(carets(right.view)).toEqual([]);
	focus(right.view);
	select(right.view, 5);
	await new Promise((resolve) => setTimeout(resolve, 120));
	expect(joinPresence(a, RichTextSelection).others).toEqual([]);
	expect(carets(left.view)).toEqual([]);
});

test("a binding withdraws only the selection it shared, even at the same position", () => {
	const note = create("Hello world"),
		first = editor(note.body, { selection: { name: "First" } }),
		second = editor(note.body, { selection: { name: "Second" } }),
		mine = joinPresence(note, RichTextSelection);
	focus(first.view);
	select(first.view, 3);
	expect(mine.mine?.name).toBe("First");
	// The second editor shares the very same position after the first one.
	focus(second.view);
	select(second.view, 3);
	expect(mine.mine?.name).toBe("Second");
	blur(first.view);
	expect(mine.mine?.name).toBe("Second");
	first.binding.destroy();
	expect(mine.mine?.name).toBe("Second");
	second.binding.destroy();
	expect(mine.mine).toBeUndefined();
});

test("undo and redo put the cursor after the text they restore, here and for the others", async () => {
	const { left, right } = await pair(
		{ selection: { name: "Ada" } },
		{ selection: true },
	);
	const before = (view: EditorView) =>
		view.state.doc.textBetween(0, view.state.selection.head);
	focus(left.view);
	select(left.view, 12);
	left.view.dispatch(left.view.state.tr.insertText("!?"));
	expect(left.binding.undo()).toBe(true);
	expect(before(left.view)).toBe("Hello world");
	expect(left.binding.redo()).toBe(true);
	expect(before(left.view)).toBe("Hello world!?");
	await eventually(() =>
		expect(textBeforeCaret(right.view)).toBe("Hello world!?"),
	);
	// Undoing a deletion restores the text before the cursor, as it was.
	left.view.dispatch(left.view.state.tr.delete(6, 13));
	expect(left.binding.undo()).toBe(true);
	expect(before(left.view)).toBe("Hello world!?");
});

test("undo and redo keep remote cursors and anchors usable", async () => {
	const { left, right } = await pair(
		{ selection: { name: "Ada" } },
		{ selection: true },
	);
	focus(left.view);
	left.view.dispatch(left.view.state.tr.insertText(" there", 6));
	select(left.view, 12);
	const stored = left.binding.anchorAt(12);
	await eventually(() =>
		expect(right.view.state.doc.textContent).toBe("Hello there world"),
	);
	await eventually(() =>
		expect(textBeforeCaret(right.view)).toBe("Hello there"),
	);

	// Undo is an ordinary edit for the other peer; the cursor follows it.
	expect(left.binding.undo()).toBe(true);
	await eventually(() =>
		expect(right.view.state.doc.textContent).toBe("Hello world"),
	);
	await eventually(() => expect(textBeforeCaret(right.view)).toBe("Hello"));
	// An anchor on a character that is gone stays where the character was.
	expect(left.binding.positionOf(stored)).toBe(6);

	expect(left.binding.redo()).toBe(true);
	await eventually(() =>
		expect(right.view.state.doc.textContent).toBe("Hello there world"),
	);
	await eventually(() => expect(carets(right.view)).toHaveLength(1));
	// Redo restores the text under new identities, each after its old
	// character: the old anchor is back inside it, just before its own.
	expect(left.binding.positionOf(stored)).toBe(11);
	// Drawing the cursors never entered the other editor's history.
	expect(right.binding.canUndo).toBe(false);
});
