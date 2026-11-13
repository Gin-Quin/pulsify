import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { array, object } from "@gin-quin/codec";
import { Schema } from "prosemirror-model";
import {
	EditorState,
	NodeSelection,
	Plugin,
	TextSelection,
} from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema as basic } from "prosemirror-schema-basic";
import { addListNodes, wrapInList } from "prosemirror-schema-list";
import { history, undo, redo } from "prosemirror-history";
import { joinBackward, setBlockType, splitBlock } from "prosemirror-commands";
import {
	applyPulseUpdates,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	getPulseMeta,
	getPulseVersions,
	richText,
	snapshotPulse,
	type Pulse,
} from "pulsify-core";
import { createPulseViews } from "pulsify-core/bindings";
import { bindProseMirror, proseMirrorDocument } from "../source/index.js";
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
const definition = definePulse(
	"ProseMirrorNote",
	object({ body: richText() }),
).materialize();
const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
const views: EditorView[] = [];
const pulses: Pulse<any>[] = [];
let sid = 80000;
function create(text = "") {
	const pulse = createPulse(definition, { body: text }, options(sid++));
	pulses.push(pulse);
	return pulse;
}
function peer(source: ReturnType<typeof create>) {
	const pulse = createRuntime(
		definition,
		source.id,
		options(sid++),
	) as ReturnType<typeof create>;
	applyPulseUpdates(pulse, exportPulseUpdates(source, []));
	pulses.push(pulse);
	return pulse;
}
function editor(pulse: ReturnType<typeof create>, plugins = [history()]) {
	const element = document.createElement("div");
	document.body.append(element);
	const view = new EditorView(element, {
		state: EditorState.create({ schema, plugins }),
	});
	views.push(view);
	const binding = bindProseMirror(view, pulse.body);
	return { view, binding };
}
function sync(a: ReturnType<typeof create>, b: ReturnType<typeof create>) {
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	applyPulseUpdates(a, exportPulseUpdates(b, []));
}
afterEach(() => {
	for (const view of views.splice(0)) if (!view.isDestroyed) view.destroy();
	for (const pulse of pulses.splice(0)) destroyPulse(pulse);
	document.body.innerHTML = "";
});

test("a field read through a framework view binds like the field itself", () => {
	const a = create("Vue"),
		reactive = createPulseViews(() => () => {})(a);
	const element = document.createElement("div");
	document.body.append(element);
	const view = new EditorView(element, {
		state: EditorState.create({ schema }),
	});
	views.push(view);
	bindProseMirror(view, reactive.body);
	expect(view.dom.textContent).toBe("Vue");
	view.dispatch(view.state.tr.insertText("!", 4));
	expect(a.body.text).toBe("Vue!");
	expect(proseMirrorDocument(reactive.body, schema).textContent).toBe("Vue!");
});

test("bind an actual editor div; text, marks, blocks and atoms survive native transport", () => {
	const a = create("Bonjour 😀"),
		b = peer(a);
	const { view } = editor(a);
	expect(view.dom.textContent).toBe("Bonjour 😀");
	view.dispatch(view.state.tr.addMark(1, 8, schema.marks["strong"]!.create()));
	view.dispatch(
		view.state.tr.setSelection(TextSelection.create(view.state.doc, 8)),
	);
	expect(splitBlock(view.state, view.dispatch)).toBe(true);
	view.dispatch(
		view.state.tr.insert(
			view.state.doc.content.size,
			schema.nodes["horizontal_rule"]!.create(),
		),
	);
	sync(a, b);
	const remote = editor(b).view;
	expect(remote.state.doc.toJSON()).toEqual(view.state.doc.toJSON());
	expect(proseMirrorDocument(b.body, schema).toJSON()).toEqual(
		view.state.doc.toJSON(),
	);
	expect(a.body.text).toBe("Bonjour 😀");
	expect(snapshotPulse(a).body).toBe("Bonjour 😀");
	expect(
		a.body
			.toDelta()
			.every(
				(part) =>
					!Object.keys(part.attributes ?? {}).some((key) =>
						key.startsWith("$pulsify:"),
					),
			),
	).toBe(true);
	expect(view.dom.querySelector("strong")?.textContent).toBe("Bonjour");
	expect(view.dom.querySelector("hr")).not.toBeNull();
});

test("concurrent character insertion and formatting converge, including concurrent first binding", () => {
	const a = create("Hello"),
		b = peer(a);
	const left = editor(a).view,
		right = editor(b).view;
	left.dispatch(left.state.tr.insertText("A", 3));
	right.dispatch(
		right.state.tr
			.insertText("B", 3)
			.addMark(1, 3, schema.marks["em"]!.create()),
	);
	sync(a, b);
	expect(left.state.doc.toJSON()).toEqual(right.state.doc.toJSON());
	expect(a.body.text).toContain("A");
	expect(a.body.text).toContain("B");
	expect(left.state.doc.childCount).toBe(1);
	expect(left.state.doc.textContent).toBe(a.body.text);
});

test("two bound views on one field update synchronously without echo patches", () => {
	const a = create("x");
	const left = editor(a).view,
		right = editor(a).view;
	const clock = getPulseMeta(a).model.nextClock;
	left.dispatch(left.state.tr.insertText("y", 2));
	expect(right.state.doc.textContent).toBe("xy");
	expect(getPulseMeta(a).model.nextClock).toBe(clock + 1);
	a.body.insert(2, "!");
	expect(left.state.doc.textContent).toBe("xy!");
	expect(right.state.doc.textContent).toBe("xy!");
});

test("repeated characters retain the correct insertion position and identity", () => {
	const a = create("aaa"),
		local = editor(a).view;
	const b = peer(a),
		remote = editor(b).view;
	local.dispatch(
		local.state.tr
			.insertText("a", 1)
			.addMark(1, 2, schema.marks["strong"]!.create()),
	);
	remote.dispatch(remote.state.tr.insertText("X", 2));
	sync(a, b);
	expect(local.state.doc.toJSON()).toEqual(remote.state.doc.toJSON());
	expect(local.state.doc.textContent).toBe("aaXaa");
	expect(local.state.doc.firstChild!.firstChild!.text).toBe("a");
	expect(local.state.doc.firstChild!.firstChild!.marks[0]!.type.name).toBe(
		"strong",
	);
});

test("nested lists, headings, node attributes and node selections", () => {
	const a = create("One");
	const { view } = editor(a);
	view.dispatch(
		view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)),
	);
	expect(
		setBlockType(schema.nodes["heading"]!, { level: 2 })(
			view.state,
			view.dispatch,
		),
	).toBe(true);
	expect(view.state.doc.firstChild!.attrs["level"]).toBe(2);
	expect(
		setBlockType(schema.nodes["paragraph"]!)(view.state, view.dispatch),
	).toBe(true);
	expect(
		wrapInList(schema.nodes["bullet_list"]!)(view.state, view.dispatch),
	).toBe(true);
	const b = peer(a),
		remote = editor(b).view;
	expect(remote.state.doc.toJSON()).toEqual(view.state.doc.toJSON());
	view.dispatch(
		view.state.tr.insert(
			view.state.doc.content.size,
			schema.nodes["horizontal_rule"]!.create(),
		),
	);
	sync(a, b);
	remote.dispatch(
		remote.state.tr.setSelection(
			NodeSelection.create(remote.state.doc, remote.state.doc.content.size - 1),
		),
	);
	view.dispatch(view.state.tr.insertText("!", 4));
	sync(a, b);
	expect(remote.state.selection).toBeInstanceOf(NodeSelection);
	expect(remote.state.selection.$from.nodeAfter?.type.name).toBe(
		"horizontal_rule",
	);
});

test("UTF-16 selections remain anchored across remote Unicode insertion", () => {
	const a = create("a😀b"),
		local = editor(a).view;
	const b = peer(a),
		remote = editor(b).view;
	local.dispatch(
		local.state.tr.setSelection(TextSelection.create(local.state.doc, 4)),
	);
	remote.dispatch(remote.state.tr.insertText("🚀", 1));
	sync(a, b);
	expect(local.state.selection.from).toBe(6);
	expect(local.state.doc.textBetween(1, local.state.selection.from)).toBe(
		"🚀a😀",
	);
});

test("a caret in an empty paragraph stays in that paragraph after remote typing", () => {
	const a = create("a"),
		local = editor(a).view;
	local.dispatch(
		local.state.tr.setSelection(TextSelection.create(local.state.doc, 2)),
	);
	splitBlock(local.state, local.dispatch);
	const b = peer(a),
		remote = editor(b).view;
	expect(local.state.selection.from).toBe(4);
	remote.dispatch(remote.state.tr.insertText("X", 1));
	sync(a, b);
	expect(local.state.selection.from).toBe(5);
	expect(local.state.selection.$from.parent.content.size).toBe(0);
});

test("undo and redo retain remote insertions", () => {
	const a = create("ab"),
		local = editor(a).view;
	const b = peer(a),
		remote = editor(b).view;
	local.dispatch(local.state.tr.insertText("L", 2));
	sync(a, b);
	remote.dispatch(remote.state.tr.insertText("R", 4));
	sync(a, b);
	expect(undo(local.state, local.dispatch)).toBe(true);
	sync(a, b);
	expect(local.state.doc.textContent).toBe("abR");
	expect(remote.state.doc.textContent).toBe("abR");
	expect(redo(local.state, local.dispatch)).toBe(true);
	expect(local.state.doc.textContent).toBe("aLbR");
});

test("remote formatting does not erase the local undo history", () => {
	const a = create("ab"),
		local = editor(a).view;
	const b = peer(a),
		remote = editor(b).view;
	local.dispatch(local.state.tr.insertText("L", 2));
	sync(a, b);
	remote.dispatch(
		remote.state.tr.addMark(1, 4, schema.marks["strong"]!.create()),
	);
	sync(a, b);
	expect(undo(local.state, local.dispatch)).toBe(true);
	expect(local.state.doc.textContent).toBe("ab");
	expect(local.state.doc.firstChild!.firstChild!.marks[0]!.type.name).toBe(
		"strong",
	);
});

test("join with concurrent insertion in the removed paragraph preserves text", () => {
	const a = create("ab"),
		local = editor(a).view;
	local.dispatch(
		local.state.tr.setSelection(TextSelection.create(local.state.doc, 2)),
	);
	splitBlock(local.state, local.dispatch);
	const b = peer(a),
		remote = editor(b).view;
	local.dispatch(
		local.state.tr.setSelection(TextSelection.create(local.state.doc, 4)),
	);
	expect(joinBackward(local.state, local.dispatch)).toBe(true);
	remote.dispatch(remote.state.tr.insertText("X", 5));
	sync(a, b);
	expect(local.state.doc.toJSON()).toEqual(remote.state.doc.toJSON());
	expect(local.state.doc.textContent).toContain("X");
	expect(local.state.doc.childCount).toBe(1);
});

test("binding preserves custom dispatch and plugins; reconfigure and destroy clean subscriptions", () => {
	const a = create("x");
	let dispatched = 0;
	const view = new EditorView(document.createElement("div"), {
		state: EditorState.create({ schema, plugins: [history()] }),
		dispatchTransaction(tr) {
			dispatched++;
			view.updateState(view.state.apply(tr));
		},
	});
	views.push(view);
	const before = getPulseMeta(a).listeners.size;
	const binding = bindProseMirror(view, a.body);
	view.updateState(
		view.state.reconfigure({
			plugins: [...view.state.plugins, new Plugin({})],
		}),
	);
	expect(() => bindProseMirror(view, a.body)).toThrow("already bound");
	view.dispatch(view.state.tr.insertText("!", 2));
	expect(a.body.text).toBe("x!");
	expect(dispatched).toBeGreaterThan(0);
	expect(getPulseMeta(a).listeners.size).toBe(before + 1);
	binding.destroy();
	expect(getPulseMeta(a).listeners.size).toBe(before);
	bindProseMirror(view, a.body);
	view.destroy();
	expect(getPulseMeta(a).listeners.size).toBe(before);
});

test("schema mismatch and unattached values are rejected", () => {
	const a = create("x");
	editor(a);
	expect(() => proseMirrorDocument(a.body, basic)).toThrow(
		"Incompatible ProseMirror schema",
	);
	expect(() => proseMirrorDocument(richText("unattached"), schema)).toThrow(
		"attached",
	);
});

test("nested and array fields bind; replacing a field disconnects its old binding", () => {
	const Nested = definePulse(
		"NestedEditorNote",
		object({
			author: object({ bio: richText() }),
			sections: array(richText()),
		}),
	).materialize();
	const pulse = createPulse(
		Nested,
		{ author: { bio: "bio" }, sections: ["first"] },
		options(sid++),
	);
	pulses.push(pulse);
	const makeView = () => {
		const view = new EditorView(document.createElement("div"), {
			state: EditorState.create({ schema }),
		});
		views.push(view);
		return view;
	};
	const bio = makeView(),
		section = makeView();
	const errors: unknown[] = [];
	bindProseMirror(bio, pulse.author.bio);
	bindProseMirror(section, pulse.sections[0]!, {
		onError: (error) => errors.push(error),
	});
	bio.dispatch(bio.state.tr.insertText("!", 4));
	section.dispatch(section.state.tr.insertText("!", 6));
	expect(snapshotPulse(pulse).author.bio).toBe("bio!");
	expect(snapshotPulse(pulse).sections).toEqual(["first!"]);
	pulse.sections[0] = richText("replacement");
	expect(errors).toHaveLength(1);
	expect(String(errors[0])).toContain("replaced or removed");
	bindProseMirror(section, pulse.sections[0]!);
	expect(section.state.doc.textContent).toBe("replacement");
});

test("custom node attributes merge independently and preserve meaningful null values", () => {
	const custom = new Schema({
		nodes: basic.spec.nodes.update("paragraph", {
			...basic.spec.nodes.get("paragraph")!,
			attrs: { color: { default: null }, align: { default: "left" } },
		}),
		marks: basic.spec.marks,
	});
	const makeView = (pulse: ReturnType<typeof create>) => {
		const view = new EditorView(document.createElement("div"), {
			state: EditorState.create({ schema: custom }),
		});
		views.push(view);
		bindProseMirror(view, pulse.body);
		return view;
	};
	const a = create("x"),
		left = makeView(a),
		b = peer(a),
		right = makeView(b);
	left.dispatch(
		left.state.tr.setNodeMarkup(0, undefined, { color: "red", align: "left" }),
	);
	right.dispatch(
		right.state.tr.setNodeMarkup(0, undefined, { color: null, align: "right" }),
	);
	sync(a, b);
	expect(left.state.doc.firstChild!.attrs).toEqual({
		color: "red",
		align: "right",
	});
	expect(right.state.doc.toJSON()).toEqual(left.state.doc.toJSON());
	left.dispatch(
		left.state.tr.setNodeMarkup(0, undefined, { color: null, align: "right" }),
	);
	sync(a, b);
	expect(right.state.doc.firstChild!.attrs["color"]).toBeNull();
	const state = left.state,
		updates = exportPulseUpdates(a, []);
	expect(() =>
		left.dispatch(
			left.state.tr.setNodeMarkup(0, undefined, {
				color: new Date(),
				align: "right",
			}),
		),
	).toThrow();
	expect(left.state).toBe(state);
	expect(exportPulseUpdates(a, [])).toEqual(updates);
});

test("disjoint remote changes preserve local undo between them", () => {
	const a = create("abcdef"),
		local = editor(a).view;
	const b = peer(a),
		remote = editor(b).view;
	local.dispatch(local.state.tr.insertText("L", 4));
	remote.dispatch(remote.state.tr.insertText("X", 1).insertText("Y", 8));
	sync(a, b);
	expect(undo(local.state, local.dispatch)).toBe(true);
	expect(local.state.doc.textContent).toBe("XabcdefY");
	sync(a, b);
	expect(remote.state.doc.textContent).toBe("XabcdefY");
});

test("distant edits in a large document stay granular and preserve an unseen middle edit", () => {
	const a = create("a".repeat(12000)),
		local = editor(a).view;
	const b = peer(a),
		remote = editor(b).view;
	const versions = getPulseVersions(a).state;
	local.dispatch(local.state.tr.insertText("L", 2).insertText("R", 12001));
	const bytes = exportPulseUpdates(a, versions).reduce(
		(total, frame) => total + frame.byteLength,
		0,
	);
	expect(bytes).toBeLessThan(1024);
	remote.dispatch(remote.state.tr.insertText("M", 6000));
	sync(a, b);
	expect(local.state.doc.toJSON()).toEqual(remote.state.doc.toJSON());
	expect(local.state.doc.textContent).toContain("L");
	expect(local.state.doc.textContent).toContain("M");
	expect(local.state.doc.textContent).toContain("R");
	expect(local.state.doc.textContent.length).toBe(12003);
});

test("a custom schema with an inline root imports and synchronizes plain text", () => {
	const custom = new Schema({ nodes: { doc: { content: "text*" }, text: {} } });
	const a = create("inline");
	const view = new EditorView(document.createElement("div"), {
		state: EditorState.create({ schema: custom }),
	});
	views.push(view);
	bindProseMirror(view, a.body);
	view.dispatch(view.state.tr.insertText("!", 6));
	expect(view.state.doc.textContent).toBe("inline!");
	expect(proseMirrorDocument(a.body, custom).toJSON()).toEqual(
		view.state.doc.toJSON(),
	);
});

test("removing a block hides a concurrent edit to its deleted contents", () => {
	const a = create("ab"),
		local = editor(a).view;
	local.dispatch(
		local.state.tr.setSelection(TextSelection.create(local.state.doc, 2)),
	);
	splitBlock(local.state, local.dispatch);
	const b = peer(a),
		remote = editor(b).view;
	local.dispatch(local.state.tr.delete(3, 6));
	remote.dispatch(remote.state.tr.insertText("X", 5));
	sync(a, b);
	expect(local.state.doc.toJSON()).toEqual(remote.state.doc.toJSON());
	expect(local.state.doc.textContent).toBe("a");
	expect(a.body.text).toBe("a");
	expect(snapshotPulse(a).body).toBe("a");
	expect(snapshotPulse(b).body).toBe("a");
});

test("a block deletion wins over duplicate anchors from concurrent first binding", () => {
	const a = create(""),
		b = peer(a),
		local = editor(a).view,
		remote = editor(b).view;
	local.dispatch(
		local.state.tr.replaceWith(
			0,
			local.state.doc.content.size,
			schema.nodes["horizontal_rule"]!.create(),
		),
	);
	remote.dispatch(remote.state.tr.insertText("unseen", 1));
	sync(a, b);
	expect(local.state.doc.toJSON()).toEqual(remote.state.doc.toJSON());
	expect(local.state.doc.childCount).toBe(1);
	expect(local.state.doc.firstChild!.type.name).toBe("horizontal_rule");
	expect(a.body.text).toBe("");
	expect(b.body.text).toBe("");
});

test("concurrent splitting, wrapping, formatting and typing converge over repeated rounds", () => {
	const a = create("abcdef"),
		left = editor(a).view;
	const b = peer(a),
		right = editor(b).view;
	let seed = 104729;
	const random = (max: number) => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed % max;
	};
	for (let round = 0; round < 35; round++) {
		for (const view of [left, right]) {
			const positions: number[] = [];
			view.state.doc.descendants((node, pos) => {
				if (node.isTextblock)
					positions.push(pos + 1 + random(node.content.size + 1));
			});
			const pos = positions[random(positions.length)]!;
			view.dispatch(
				view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)),
			);
			switch (random(5)) {
				case 0:
					splitBlock(view.state, view.dispatch);
					break;
				case 1:
					wrapInList(schema.nodes["bullet_list"]!)(view.state, view.dispatch);
					break;
				case 2:
					setBlockType(schema.nodes["heading"]!, { level: 1 + random(3) })(
						view.state,
						view.dispatch,
					);
					break;
				case 3:
					view.dispatch(
						view.state.tr.insertText(String.fromCharCode(65 + random(26))),
					);
					break;
				case 4:
					if (view.state.selection.$from.parent.content.size)
						view.dispatch(
							view.state.tr.addMark(
								view.state.selection.$from.start(),
								view.state.selection.$from.end(),
								schema.marks["em"]!.create(),
							),
						);
					break;
			}
		}
		sync(a, b);
		expect(getPulseMeta(a).lastError).toBeUndefined();
		expect(getPulseMeta(b).lastError).toBeUndefined();
		expect(left.state.doc.toJSON()).toEqual(right.state.doc.toJSON());
		expect(left.state.doc.toJSON()).toEqual(
			proseMirrorDocument(a.body, schema).toJSON(),
		);
	}
});
