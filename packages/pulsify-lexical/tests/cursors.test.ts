import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { object } from "@gin-quin/codec";
import { createHeadlessEditor } from "@lexical/headless";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	$isTextNode,
	$setSelection,
	BLUR_COMMAND,
	FOCUS_COMMAND,
	createEditor,
	type ElementNode,
	type LexicalEditor,
	type TextNode,
} from "lexical";
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
} from "pulsify-core";
import { JSDOM } from "jsdom";
import { bindLexical, type LexicalBinding } from "../source/index.js";
import { createRuntime } from "../../pulse/source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../../pulse/source/pulses/PulseOptions.js";

const Note = definePulse(
	"LexicalCursorNote",
	object({ body: richText(), other: richText() }),
).materialize();
type Note = ReturnType<typeof create>;
type Config = Parameters<typeof bindLexical>[2];

const pulses: Pulse<any>[] = [],
	undo: (() => void)[] = [];
let sid = 96000;
const options = () => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId: sid++,
});
function create(text = "Hello world") {
	const pulse = createPulse(Note, { body: text, other: "Other" }, options());
	pulses.push(pulse);
	return pulse;
}
/** An unconnected replica of a pulse. */
function replica(source: Note): Note {
	const pulse = createRuntime(Note, source.id, options()) as Note;
	pulses.push(pulse);
	applyPulseUpdates(pulse, exportPulseUpdates(source, []));
	return pulse;
}
function sync(a: Note, b: Note) {
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	applyPulseUpdates(a, exportPulseUpdates(b, []));
}
/** Two pulses of one document, each through its own session of one relay. */
async function pair(text = "Hello world") {
	const connector = createMemoryConnector(new PulseRelay());
	const a = createPulse(
		Note,
		{ body: text, other: "Other" },
		{ scope: createPulseScope(), connectors: [connector] },
	);
	pulses.push(a);
	await connectPulse(a).synced;
	// The first binding writes the document structure: let it reach the relay.
	const left = headless(a, { selection: { name: "Ada", color: "#e5484d" } });
	const b = await loadPulse(Note, a.id, {
		scope: createPulseScope(),
		connectors: [connector],
		waitFor: "all",
	});
	pulses.push(b);
	await eventually(() =>
		expect(getPulseVersions(b).state).toEqual(getPulseVersions(a).state),
	);
	return { a, b, left, connector };
}
function headless(pulse: Note, config: Config = {}, field = pulse.body) {
	const editor = createHeadlessEditor({
		onError: (error) => {
			throw error;
		},
	});
	const binding = bindLexical(editor, field, config);
	undo.push(() => binding.destroy());
	return { editor, binding };
}
/** An editor with a root element in a jsdom document. */
function mounted(pulse: Note, config: Config = {}) {
	const container = document.createElement("div"),
		root = document.createElement("div");
	root.contentEditable = "true";
	container.append(root);
	document.body.append(container);
	const editor = createEditor({
		namespace: "cursors",
		onError: (error) => {
			throw error;
		},
	});
	editor.setRootElement(root);
	const binding = bindLexical(editor, pulse.body, config);
	undo.push(() => {
		binding.destroy();
		editor.setRootElement(null);
		container.remove();
	});
	return { editor, binding, container, root };
}
async function eventually(assertion: () => void, timeout = 2000) {
	const end = performance.now() + timeout;
	while (true) {
		try {
			return assertion();
		} catch (error) {
			if (performance.now() >= end) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}
function firstText(): TextNode {
	const node = $getRoot().getFirstDescendant();
	if (!$isTextNode(node)) throw new Error("Expected text");
	return node;
}
function block(index: number): ElementNode {
	const node = $getRoot().getChildAtIndex(index);
	if (!$isElementNode(node)) throw new Error("Expected a block");
	return node;
}
const run = (editor: LexicalEditor, change: () => void) =>
	editor.update(change, { discrete: true });
const select = (editor: LexicalEditor, anchor: number, focus = anchor) =>
	run(editor, () => {
		firstText().select(anchor, focus);
	});
/** The text of the node an anchor is in, with a bar where the anchor is. */
function caret(editor: LexicalEditor, binding: LexicalBinding, anchor: string) {
	const point = binding.pointOf(anchor);
	if (!point) return undefined;
	return editor.getEditorState().read(() => {
		const node = $getRoot()
			.getAllTextNodes()
			.find((text) => text.getKey() === point.key);
		if (point.type !== "text" || !node) return `${point.type}:${point.offset}`;
		const text = node.getTextContent();
		return `${text.slice(0, point.offset)}|${text.slice(point.offset)}`;
	});
}
const carets = (container: Element) =>
	[...container.querySelectorAll<HTMLElement>("[data-peer]")].map((element) =>
		element.getAttribute("data-peer"),
	);

const globals = [
	"window",
	"document",
	"navigator",
	"MutationObserver",
	"getComputedStyle",
	"Node",
	"Text",
	"Element",
	"HTMLElement",
] as const;
const previous = new Map<string, unknown>();
let dom: JSDOM;
beforeAll(() => {
	dom = new JSDOM("<!doctype html><html><body></body></html>");
	for (const name of globals) {
		previous.set(name, (globalThis as any)[name]);
		const value = (dom.window as any)[name];
		Object.defineProperty(globalThis, name, {
			value: name === "getComputedStyle" ? value.bind(dom.window) : value,
			configurable: true,
			writable: true,
		});
	}
});
afterAll(() => {
	for (const name of globals)
		Object.defineProperty(globalThis, name, {
			value: previous.get(name),
			configurable: true,
			writable: true,
		});
	dom.window.close();
});
afterEach(() => {
	for (const stop of undo.splice(0).reverse()) stop();
	for (const pulse of pulses.splice(0)) destroyPulse(pulse);
});

test("an anchor follows its character through local and remote edits", () => {
	const a = create(),
		{ editor: left, binding } = headless(a),
		b = replica(a),
		{ editor: right, binding: other } = headless(b);
	select(left, 5);
	const anchor = left.read(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) throw new Error("Expected a range");
		return binding.anchorAt(selection.anchor);
	});
	// The same anchors as the field's own, in text indices.
	expect(anchor).toBe(a.body.anchorAt(5));
	expect(a.body.indexOf(anchor)).toBe(5);
	expect(caret(left, binding, anchor)).toBe("Hello| world");
	expect(caret(right, other, anchor)).toBe("Hello| world");

	run(left, () => firstText().spliceText(0, 0, "Hey, "));
	expect(caret(left, binding, anchor)).toBe("Hey, Hello| world");
	run(right, () => firstText().spliceText(0, 0, "> "));
	sync(a, b);
	expect(caret(left, binding, anchor)).toBe("> Hey, Hello| world");
	expect(caret(right, other, anchor)).toBe("> Hey, Hello| world");

	// Text typed at an anchor, here or there, lands after it.
	run(left, () => firstText().spliceText(12, 0, ","));
	run(right, () => firstText().spliceText(12, 0, ";"));
	sync(a, b);
	expect(caret(left, binding, anchor)).toMatch(/^> Hey, Hello\|[,;]{2} world$/);
	expect(caret(right, other, anchor)).toBe(caret(left, binding, anchor));

	// Once its character is deleted, it stays where the character was.
	run(right, () => firstText().spliceText(9, 3, ""));
	sync(a, b);
	expect(caret(left, binding, anchor)?.startsWith("> Hey, He|")).toBe(true);
	run(left, () => firstText().spliceText(0, 9, ""));
	expect(caret(left, binding, anchor)?.startsWith("|")).toBe(true);
	expect(a.body.indexOf(anchor)).toBe(0);
});

test("the start of the document and an empty paragraph have anchors", () => {
	const a = create(""),
		{ editor, binding } = headless(a);
	const key = (index: number) =>
		editor.read(() => $getRoot().getChildAtIndex(index)!.getKey());
	const first = key(0);
	const start = binding.anchorAt({ key: first, offset: 0, type: "element" });
	expect(binding.pointOf(start)).toEqual({
		key: first,
		offset: 0,
		type: "element",
	});
	// The field's own start anchor is the first place a caret can be.
	expect(binding.pointOf(a.body.anchorAt(0))).toEqual(binding.pointOf(start));
	expect(a.body.indexOf(start)).toBe(0);

	run(editor, () => {
		block(0).append($createTextNode("abc"));
		$getRoot().append($createParagraphNode());
	});
	expect(caret(editor, binding, start)).toBe("|abc");
	expect(caret(editor, binding, a.body.anchorAt(0))).toBe("|abc");

	// The type of a point defaults to what its node is.
	const second = key(1),
		empty = binding.anchorAt({ key: second, offset: 0 });
	expect(binding.pointOf(empty)).toEqual({
		key: second,
		offset: 0,
		type: "element",
	});
	expect(a.body.indexOf(empty)).toBe(3);
	const b = replica(a),
		remote = headless(b).editor;
	run(remote, () => firstText().spliceText(0, 0, "X"));
	sync(a, b);
	expect(binding.pointOf(empty)).toEqual({
		key: second,
		offset: 0,
		type: "element",
	});
	run(remote, () => {
		block(1).append($createTextNode("def"));
	});
	sync(a, b);
	expect(caret(editor, binding, empty)).toBe("|def");
	expect(a.body.indexOf(empty)).toBe(4);

	// After a block is the end of what it holds.
	const between = binding.anchorAt({ key: "root", offset: 1, type: "element" });
	expect(caret(editor, binding, between)).toBe("Xabc|");

	expect(() => binding.anchorAt({ key: "nope", offset: 0 })).toThrow(
		RangeError,
	);
	expect(() => binding.anchorAt({ key: second, offset: 9 })).toThrow(
		RangeError,
	);
	expect(() => binding.anchorAt({ key: second, offset: -1 })).toThrow(
		RangeError,
	);
	expect(() =>
		binding.anchorAt({ key: second, offset: 0, type: "text" }),
	).toThrow(RangeError);
	expect(() => binding.anchorAt({ key: second, offset: 0.5 })).toThrow(
		TypeError,
	);
	expect(() => binding.anchorAt(undefined as never)).toThrow(TypeError);
});

test("an anchor of another field or of an unknown entry does not resolve", () => {
	const a = create(),
		{ binding } = headless(a),
		elsewhere = headless(create()).binding;
	expect(binding.pointOf(a.other.anchorAt(2))).toBeUndefined();
	expect(binding.pointOf(a.other.anchorAt(0))).toBeUndefined();
	expect(binding.pointOf("999999:1:0")).toBeUndefined();
	const anchor = binding.anchorAt({ key: "root", offset: 0 });
	expect(binding.pointOf(anchor)).toBeDefined();
	expect(elsewhere.pointOf(anchor)).toBeUndefined();
	expect(a.other.indexOf(anchor)).toBeUndefined();
});

test("a selection is shared through presence and drawn by the other editor", async () => {
	const { a, b, left } = await pair(),
		right = mounted(b, { selection: true }),
		seen = joinPresence(b, RichTextSelection),
		versions = getPulseVersions(a).state;
	expect(right.container.children).toHaveLength(1);

	select(left.editor, 1, 4);
	await eventually(() => expect(seen.others).toHaveLength(1));
	const { peer, state } = seen.others[0]!;
	expect(state.name).toBe("Ada");
	expect(state.color).toBe("#e5484d");
	expect(caret(right.editor, right.binding, state.anchor)).toBe("H|ello world");
	expect(caret(right.editor, right.binding, state.head)).toBe("Hell|o world");
	await eventually(() =>
		expect(carets(right.container)).toEqual([String(peer)]),
	);
	const drawn = right.container.querySelector<HTMLElement>("[data-peer]")!;
	expect(drawn.style.position).toBe("absolute");
	expect(drawn.style.pointerEvents).toBe("none");
	expect(drawn.style.backgroundColor).toBe("rgb(229, 72, 77)");
	expect(drawn.textContent).toBe("Ada");
	// Nothing was written for it, and the overlay stays out of the content.
	expect(getPulseVersions(a).state).toEqual(versions);
	expect(right.root.querySelector("[data-peer]")).toBeNull();
	expect(left.binding.canUndo).toBe(false);

	// The cursor follows its character when text is typed before it.
	run(left.editor, () => firstText().spliceText(0, 0, ">", true));
	await eventually(() => expect(right.root.textContent).toBe(">Hello world"));
	expect(caret(right.editor, right.binding, state.head)).toBe(">Hell|o world");
	expect(carets(right.container)).toEqual([String(peer)]);

	// A null selection is withdrawn.
	run(left.editor, () => $setSelection(null));
	await eventually(() => expect(seen.others).toEqual([]));
	expect(right.container.children).toHaveLength(1);

	// So is the selection Lexical keeps when the editor loses focus, until
	// the editor is focused again.
	select(left.editor, 2);
	await eventually(() => expect(seen.others).toHaveLength(1));
	left.editor.dispatchCommand(BLUR_COMMAND, new window.FocusEvent("blur"));
	await eventually(() => expect(seen.others).toEqual([]));
	select(left.editor, 3);
	await new Promise((resolve) => setTimeout(resolve, 80));
	expect(seen.others).toEqual([]);
	left.editor.dispatchCommand(FOCUS_COMMAND, new window.FocusEvent("focus"));
	await eventually(() => expect(seen.others).toHaveLength(1));
	run(left.editor, () => $setSelection(null));
	await eventually(() => expect(seen.others).toEqual([]));

	select(left.editor, 2);
	await eventually(() =>
		expect(carets(right.container)).toEqual([String(peer)]),
	);
	left.binding.destroy();
	await eventually(() => expect(seen.others).toEqual([]));
	expect(carets(right.container)).toEqual([]);
});

test("a peer without a name or color gets a color from its peer number", async () => {
	const { a, b, left, connector } = await pair(),
		right = mounted(b, { selection: true }),
		seen = joinPresence(a, RichTextSelection);
	select(right.editor, 3);
	await eventually(() => expect(seen.others).toHaveLength(1));
	expect(seen.others[0]!.state).toEqual({
		anchor: b.body.anchorAt(3),
		head: b.body.anchorAt(3),
		name: "",
		color: "",
	});
	// A headless editor shares its selection and draws nothing.
	expect(left.binding.pointOf(seen.others[0]!.state.head)).toBeDefined();

	const third = await loadPulse(Note, a.id, {
		scope: createPulseScope(),
		connectors: [connector],
		waitFor: "all",
	});
	pulses.push(third);
	const viewer = mounted(third, { selection: true });
	await eventually(() => expect(carets(viewer.container)).toHaveLength(1));
	const drawn = viewer.container.querySelector<HTMLElement>("[data-peer]")!;
	expect(drawn.style.backgroundColor).not.toBe("");
	expect(drawn.children).toHaveLength(0);
	const color = drawn.style.backgroundColor;
	select(right.editor, 4);
	await eventually(() =>
		expect(
			caret(
				viewer.editor,
				viewer.binding,
				joinPresence(third, RichTextSelection).others[0]!.state.head,
			),
		).toBe("Hell|o world"),
	);
	expect(
		viewer.container.querySelector<HTMLElement>("[data-peer]")!.style
			.backgroundColor,
	).toBe(color);
});

test("draw: false shares the selection and draws nothing", async () => {
	const { a, b, left } = await pair(),
		right = mounted(b, { selection: { name: "Grace", draw: false } }),
		seen = joinPresence(b, RichTextSelection),
		mine = joinPresence(a, RichTextSelection);
	select(left.editor, 2, 5);
	select(right.editor, 1);
	await eventually(() => {
		expect(seen.others).toHaveLength(1);
		expect(mine.others.map((other) => other.state.name)).toEqual(["Grace"]);
	});
	expect(right.binding.pointOf(seen.others[0]!.state.head)).toBeDefined();
	expect(right.container.children).toHaveLength(1);
	expect(right.container.querySelector("[data-peer]")).toBeNull();
});

test("destroying the binding removes the overlay and its own selection", async () => {
	const { a, b, left } = await pair(),
		right = mounted(b, { selection: true }),
		mine = joinPresence(a, RichTextSelection);
	select(left.editor, 2, 5);
	select(right.editor, 1);
	await eventually(() => {
		expect(carets(right.container)).toHaveLength(1);
		expect(mine.others).toHaveLength(1);
	});
	expect(
		right.container.querySelector("[data-pulsify-cursors]"),
	).not.toBeNull();
	right.binding.destroy();
	expect(right.container.querySelector("[data-pulsify-cursors]")).toBeNull();
	expect(right.container.children).toHaveLength(1);
	await eventually(() => expect(mine.others).toEqual([]));
	// A later change of the other peer draws nothing.
	select(left.editor, 0);
	await new Promise((resolve) => setTimeout(resolve, 80));
	expect(right.container.querySelector("[data-peer]")).toBeNull();
});

test("the overlay goes in the given container", async () => {
	const { b, left } = await pair(),
		container = document.createElement("div");
	document.body.append(container);
	undo.push(() => container.remove());
	const right = mounted(b, { selection: { container } });
	select(left.editor, 3);
	await eventually(() => expect(carets(container)).toHaveLength(1));
	expect(carets(right.container)).toEqual([]);
});

test("a remote cursor adds no undo step and changes neither document nor selection", async () => {
	const { a, b, left } = await pair(),
		right = mounted(b, { selection: true });
	select(right.editor, 2);
	const versions = getPulseVersions(b).state,
		state = JSON.stringify(right.editor.getEditorState()),
		selection = () =>
			right.editor.getEditorState().read(() => {
				const selected = $getSelection();
				return $isRangeSelection(selected) ? selected.anchor.offset : -1;
			});
	let updates = 0;
	undo.push(right.editor.registerUpdateListener(() => updates++));
	for (const offset of [1, 4, 7]) {
		select(left.editor, 0, offset);
		await eventually(() =>
			expect(
				caret(
					right.editor,
					right.binding,
					joinPresence(b, RichTextSelection).others[0]?.state.head ?? "",
				),
			).toBe(
				`${"Hello world".slice(0, offset)}|${"Hello world".slice(offset)}`,
			),
		);
	}
	expect(carets(right.container)).toHaveLength(1);
	expect(updates).toBe(0);
	expect(right.binding.canUndo).toBe(false);
	expect(right.binding.undo()).toBe(false);
	expect(JSON.stringify(right.editor.getEditorState())).toBe(state);
	expect(selection()).toBe(2);
	expect(getPulseVersions(b).state).toEqual(versions);
	expect(getPulseVersions(a).state).toEqual(versions);
	expect(b.body.text).toBe("Hello world");
});

test("an anchor that arrives before its character is drawn once it is there", async () => {
	const { a, b } = await pair(),
		right = mounted(b, { selection: true });
	// An edit that only an unconnected replica has, and an anchor on it.
	const ahead = replica(a),
		writer = headless(ahead);
	run(writer.editor, () => firstText().spliceText(5, 0, "!"));
	const anchor = writer.binding.anchorAt({
		key: writer.editor.read(() => firstText().getKey()),
		offset: 6,
	});
	const seen = joinPresence(b, RichTextSelection);
	joinPresence(a, RichTextSelection).set({
		anchor,
		head: anchor,
		name: "Ada",
		color: "",
	});
	await eventually(() => expect(seen.others).toHaveLength(1));
	expect(right.binding.pointOf(anchor)).toBeUndefined();
	expect(carets(right.container)).toEqual([]);

	applyPulseUpdates(b, exportPulseUpdates(ahead, []));
	expect(caret(right.editor, right.binding, anchor)).toBe("Hello!| world");
	await eventually(() =>
		expect(carets(right.container)).toEqual([String(seen.others[0]!.peer)]),
	);
});

test("a selected range is drawn with one element per rectangle", async () => {
	const { b, left } = await pair(),
		right = mounted(b, { selection: true }),
		prototype = dom.window.Range.prototype as any;
	// jsdom has no layout: give ranges one rectangle each.
	prototype.getClientRects = () => [
		{ left: 10, top: 20, width: 30, height: 15 },
	];
	undo.push(() => delete prototype.getClientRects);
	select(left.editor, 1, 4);
	await eventually(() => expect(carets(right.container)).toHaveLength(1));
	const peer = carets(right.container)[0]!;
	const ranges = right.container.querySelectorAll<HTMLElement>(
		`[data-peer-selection="${peer}"]`,
	);
	expect(ranges).toHaveLength(1);
	expect(ranges[0]!.style.left).toBe("10px");
	expect(ranges[0]!.style.top).toBe("20px");
	expect(ranges[0]!.style.width).toBe("30px");
	expect(ranges[0]!.style.height).toBe("15px");
	expect(ranges[0]!.style.pointerEvents).toBe("none");
	expect(Number(ranges[0]!.style.opacity)).toBeLessThan(1);
	const drawn = right.container.querySelector<HTMLElement>("[data-peer]")!;
	expect(drawn.style.left).toBe("10px");
	expect(drawn.style.height).toBe("15px");

	// A caret alone has no range.
	select(left.editor, 2);
	await eventually(() =>
		expect(
			right.container.querySelectorAll("[data-peer-selection]"),
		).toHaveLength(0),
	);
	expect(carets(right.container)).toEqual([peer]);
});

test("two fields of one pulse do not clear each other's selection", () => {
	const a = create(),
		body = headless(a, { selection: true }),
		other = headless(a, { selection: true }, a.other),
		mine = joinPresence(a, RichTextSelection);
	select(body.editor, 3);
	const shared = mine.mine;
	expect(shared?.anchor).toBe(a.body.anchorAt(3));
	// An editor without a selection leaves the one of the other field.
	run(other.editor, () => firstText().spliceText(0, 0, "x"));
	expect(mine.mine).toEqual(shared);
	other.binding.destroy();
	expect(mine.mine).toEqual(shared);
	select(body.editor, 4);
	expect(mine.mine?.anchor).toBe(a.body.anchorAt(4));
	body.binding.destroy();
	expect(mine.mine).toBeUndefined();
});

test("a binding withdraws only the selection it shared, even at the same position", () => {
	const a = create(),
		first = headless(a, { selection: { name: "First" } }),
		second = headless(a, { selection: { name: "Second" } }),
		mine = joinPresence(a, RichTextSelection);
	select(first.editor, 3);
	expect(mine.mine?.name).toBe("First");
	// The second editor shares the very same position after the first one.
	select(second.editor, 3);
	expect(mine.mine?.name).toBe("Second");
	first.binding.destroy();
	expect(mine.mine?.name).toBe("Second");
	second.binding.destroy();
	expect(mine.mine).toBeUndefined();
});
