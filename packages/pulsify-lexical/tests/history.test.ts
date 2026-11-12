import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createHeadlessEditor } from "@lexical/headless";
import {
	$getRoot,
	$createParagraphNode,
	$createTextNode,
	$isTextNode,
	HISTORY_PUSH_TAG,
	HISTORY_MERGE_TAG,
	UNDO_COMMAND,
	CAN_UNDO_COMMAND,
	COMMAND_PRIORITY_LOW,
} from "lexical";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "prosemirror-schema-basic";
import {
	createPulse,
	createPulseScope,
	definePulse,
	object,
	richText,
	destroyPulse,
	exportPulseUpdates,
	applyPulseUpdates,
	type Pulse,
} from "pulsify-core";
import {
	bindLexical,
	createPulsifyHistory,
	type PulsifyHistory,
} from "../source/index.js";
import {
	bindProseMirror,
	createPulsifyHistory as createPMHistory,
	undo as pmUndo,
	redo as pmRedo,
} from "pulsify-prosemirror";
import { createRuntime } from "../../pulse/source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../../pulse/source/pulses/PulseOptions.js";

const dom = new JSDOM("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
});
const Note = definePulse(
	"HistoryNote",
	object({ body: richText() }),
).materialize();
let sid = 98000;
const pulses: Pulse<any>[] = [],
	cleanup: (() => void)[] = [];
const options = () => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId: sid++,
});
function create(text = "ab") {
	const pulse = createPulse(Note, { body: text }, options());
	pulses.push(pulse);
	return pulse;
}
function peer(source: ReturnType<typeof create>) {
	const pulse = createRuntime(Note, source.id, options()) as ReturnType<
		typeof create
	>;
	pulses.push(pulse);
	applyPulseUpdates(pulse, exportPulseUpdates(source, []));
	return pulse;
}
function sync(a: ReturnType<typeof create>, b: ReturnType<typeof create>) {
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	applyPulseUpdates(a, exportPulseUpdates(b, []));
}
function firstText() {
	const node = $getRoot().getFirstDescendant();
	if (!$isTextNode(node)) throw new Error("Expected text");
	return node;
}
function bind(
	kind: "ProseMirror" | "Lexical",
	pulse: ReturnType<typeof create>,
	history: PulsifyHistory,
) {
	if (kind === "ProseMirror") {
		const view = new EditorView(document.createElement("div"), {
			state: EditorState.create({ schema }),
		});
		const binding = bindProseMirror(view, pulse.body, { history });
		cleanup.push(() => {
			binding.destroy();
			view.destroy();
		});
		return {
			binding,
			insert(at: number, text: string, group?: string) {
				view.dispatch(
					view.state.tr
						.insertText(text, at + 1)
						.setMeta("pulsifyHistory", group),
				);
			},
			remove(at: number, count: number) {
				view.dispatch(view.state.tr.delete(at + 1, at + count + 1));
			},
			format(value: boolean, group?: string) {
				const tr = view.state.tr;
				value
					? tr.addMark(
							1,
							tr.doc.content.size - 1,
							schema.marks["strong"]!.create(),
						)
					: tr.removeMark(1, tr.doc.content.size - 1, schema.marks["strong"]!);
				view.dispatch(tr.setMeta("pulsifyHistory", group));
			},
			appendBlock(text: string) {
				view.dispatch(
					view.state.tr.insert(
						view.state.doc.content.size,
						schema.nodes["paragraph"]!.create(null, schema.text(text)),
					),
				);
			},
			removeBlock() {
				const last = view.state.doc.lastChild!;
				view.dispatch(
					view.state.tr.delete(
						view.state.doc.content.size - last.nodeSize,
						view.state.doc.content.size,
					),
				);
			},
			appendToLast(text: string) {
				view.dispatch(
					view.state.tr.insertText(text, view.state.doc.content.size - 1),
				);
			},
			bold: () =>
				!!view.state.doc.firstChild?.firstChild?.marks.some(
					(mark) => mark.type.name === "strong",
				),
			undo: () => pmUndo(view.state, view.dispatch),
			redo: () => pmRedo(view.state, view.dispatch),
		};
	}
	const editor = createHeadlessEditor({
		onError(error) {
			throw error;
		},
	});
	const binding = bindLexical(editor, pulse.body, { history });
	cleanup.push(() => binding.destroy());
	const update = (fn: () => void, group?: string) =>
		editor.update(fn, {
			discrete: true,
			...(group
				? { tag: group === "push" ? HISTORY_PUSH_TAG : HISTORY_MERGE_TAG }
				: {}),
		});
	return {
		binding,
		insert(at: number, text: string, group?: string) {
			update(() => firstText().spliceText(at, 0, text), group);
		},
		remove(at: number, count: number) {
			update(() => firstText().spliceText(at, count, ""));
		},
		format(value: boolean, group?: string) {
			update(() => {
				for (const node of $getRoot().getAllTextNodes())
					if (node.hasFormat("bold") !== value) node.toggleFormat("bold");
			}, group);
		},
		appendBlock(text: string) {
			update(() =>
				$getRoot().append($createParagraphNode().append($createTextNode(text))),
			);
		},
		removeBlock() {
			update(() => {
				$getRoot().getLastChild()!.remove();
			});
		},
		appendToLast(text: string) {
			update(() => {
				const node = $getRoot().getLastDescendant();
				if ($isTextNode(node))
					node.spliceText(node.getTextContentSize(), 0, text);
			});
		},
		bold: () => editor.read(() => firstText().hasFormat("bold")),
		undo: () => editor.dispatchCommand(UNDO_COMMAND, undefined),
		redo: () => history.redo(),
	};
}
afterEach(() => {
	for (const destroy of cleanup.splice(0)) destroy();
	for (const pulse of pulses.splice(0)) destroyPulse(pulse);
});

test("both packages export the same plugin factory and validate its options", () => {
	expect(createPMHistory).toBe(createPulsifyHistory);
	for (const options of [
		{ undoDelay: -1 },
		{ undoDelay: NaN },
		{ maxUndo: 1.5 },
		{ maxUndo: -1 },
	])
		expect(() => createPulsifyHistory(options)).toThrow();
	const history = createPulsifyHistory();
	expect(history.undo()).toBe(false);
	expect(history.redo()).toBe(false);
});
for (const kind of ["ProseMirror", "Lexical"] as const) {
	test(`${kind}: adjacent typing groups, explicit boundaries, subscriptions and cleanup`, () => {
		const pulse = create(),
			history = createPulsifyHistory(),
			editor = bind(kind, pulse, history);
		let notifications = 0;
		const unsubscribe = history.subscribe(() => notifications++);
		expect(editor.binding.history).toBe(history);
		editor.insert(1, "L");
		editor.insert(2, "M");
		expect(notifications).toBe(2);
		expect(editor.undo()).toBe(true);
		expect(pulse.body.text).toBe("ab");
		expect(history.canUndo).toBe(false);
		expect(editor.redo()).toBe(true);
		expect(pulse.body.text).toBe("aLMb");
		history.stopCapturing();
		editor.insert(3, "N");
		history.undo();
		expect(pulse.body.text).toBe("aLMb");
		history.undo();
		expect(pulse.body.text).toBe("ab");
		unsubscribe();
		const previous = notifications;
		history.clear();
		expect(notifications).toBe(previous);
		editor.insert(1, "X");
		editor.binding.destroy();
		expect(history.canUndo).toBe(false);
		expect(history.canRedo).toBe(false);
		expect(history.undo()).toBe(false);
	});
	test(`${kind}: remote text and formatting survive local undo/redo and do not enter history`, () => {
		const a = create(),
			history = createPulsifyHistory(),
			left = bind(kind, a, history),
			b = peer(a),
			other = createPulsifyHistory(),
			right = bind(kind, b, other);
		left.insert(1, "L");
		sync(a, b);
		right.insert(3, "R");
		right.format(true);
		sync(a, b);
		history.undo();
		sync(a, b);
		expect(a.body.text).toBe("abR");
		expect(b.body.text).toBe("abR");
		expect(left.bold()).toBe(true);
		expect(history.canUndo).toBe(false);
		history.redo();
		sync(a, b);
		expect(a.body.text).toBe("aLbR");
		expect(b.body.text).toBe("aLbR");
		expect(left.bold()).toBe(true);
	});
	test(`${kind}: repeated formatting can be undone and redone across multiple groups`, () => {
		const pulse = create(),
			history = createPulsifyHistory(),
			editor = bind(kind, pulse, history);
		editor.format(true, "push");
		editor.format(false, "push");
		history.undo();
		expect(editor.bold()).toBe(true);
		history.undo();
		expect(editor.bold()).toBe(false);
		history.redo();
		expect(editor.bold()).toBe(true);
		history.redo();
		expect(editor.bold()).toBe(false);
		history.clear();
		editor.format(true, "push");
		editor.format(false, "merge");
		history.undo();
		expect(editor.bold()).toBe(false);
		expect(history.canUndo).toBe(false);
	});
	test(`${kind}: older groups follow character identities restored by undo and redo`, () => {
		const pulse = create(),
			history = createPulsifyHistory(),
			editor = bind(kind, pulse, history);
		editor.insert(1, "L", "push");
		editor.format(true, "push");
		editor.remove(1, 1);
		for (let round = 0; round < 3; round++) {
			history.undo();
			expect(pulse.body.text).toBe("aLb");
			expect(editor.bold()).toBe(true);
			history.undo();
			expect(editor.bold()).toBe(false);
			history.undo();
			expect(pulse.body.text).toBe("ab");
			expect(history.canUndo).toBe(false);
			history.redo();
			expect(pulse.body.text).toBe("aLb");
			history.redo();
			expect(editor.bold()).toBe(true);
			history.redo();
			expect(pulse.body.text).toBe("ab");
		}
	});
	test(`${kind}: a local history ignores another binding on the same field and keeps redo through remote changes`, () => {
		const a = create(),
			history = createPulsifyHistory(),
			left = bind(kind, a, history),
			other = createPulsifyHistory(),
			right = bind(kind, a, other);
		left.insert(1, "L");
		expect(other.canUndo).toBe(false);
		history.undo();
		right.insert(2, "R");
		expect(history.canRedo).toBe(true);
		history.redo();
		expect(a.body.text).toBe("aLbR");
		history.undo();
		left.insert(0, "X");
		expect(history.canRedo).toBe(false);
	});
	test(`${kind}: undoing block deletion restores concurrent hidden content`, () => {
		const a = create("a"),
			history = createPulsifyHistory(),
			left = bind(kind, a, history);
		left.appendBlock("b");
		history.clear();
		const b = peer(a),
			other = createPulsifyHistory(),
			right = bind(kind, b, other);
		left.removeBlock();
		right.appendToLast("X");
		sync(a, b);
		expect(a.body.text).toBe("a");
		history.undo();
		sync(a, b);
		expect(a.body.text).toBe("abX");
		expect(b.body.text).toBe("abX");
		history.redo();
		sync(a, b);
		expect(a.body.text).toBe("a");
		expect(b.body.text).toBe("a");
	});
	test(`${kind}: a remote attribute overwrite survives local undo`, () => {
		const a = create(),
			history = createPulsifyHistory(),
			left = bind(kind, a, history),
			b = peer(a),
			other = createPulsifyHistory(),
			right = bind(kind, b, other);
		left.format(true);
		sync(a, b);
		right.format(false);
		sync(a, b);
		history.undo();
		sync(a, b);
		expect(left.bold()).toBe(false);
		expect(right.bold()).toBe(false);
		history.redo();
		sync(a, b);
		expect(left.bold()).toBe(false);
		expect(right.bold()).toBe(false);
	});
	test(`${kind}: a connected plugin cannot be reused until detached`, () => {
		const a = create(),
			history = createPulsifyHistory(),
			left = bind(kind, a, history);
		expect(() => bind(kind, a, history)).toThrow("already connected");
		left.insert(1, "L");
		left.binding.destroy();
		const right = bind(kind, a, history);
		expect(history.canUndo).toBe(false);
		right.insert(0, "X");
		expect(history.undo()).toBe(true);
		expect(a.body.text).toBe("aLb");
	});

	test(`${kind}: limits and zero capture`, () => {
		const pulse = create(),
			history = createPulsifyHistory({ maxUndo: 1 }),
			editor = bind(kind, pulse, history);
		editor.insert(1, "L", "push");
		editor.insert(2, "M", "push");
		history.undo();
		expect(pulse.body.text).toBe("aLb");
		expect(history.canUndo).toBe(false);
		const disabled = createPulsifyHistory({ maxUndo: 0 });
		const second = bind(kind, create(), disabled);
		second.insert(0, "X");
		expect(disabled.canUndo).toBe(false);
	});
}
test("ProseMirror excludes addToHistory=false without losing earlier undo", () => {
	const pulse = create(),
		history = createPulsifyHistory(),
		view = new EditorView(document.createElement("div"), {
			state: EditorState.create({ schema }),
		});
	const binding = bindProseMirror(view, pulse.body, { history });
	cleanup.push(() => {
		binding.destroy();
		view.destroy();
	});
	view.dispatch(view.state.tr.insertText("L", 2));
	view.dispatch(
		view.state.tr.insertText("X", 1).setMeta("addToHistory", false),
	);
	expect(pmUndo(view.state)).toBe(true);
	expect(pulse.body.text).toBe("XaLb");
	history.undo();
	expect(pulse.body.text).toBe("Xab");
	expect(history.canUndo).toBe(false);
});
test("Lexical emits history availability and flushes pending typing before direct undo", () => {
	const pulse = create(),
		editor = createHeadlessEditor({
			onError(error) {
				throw error;
			},
		}),
		binding = bindLexical(editor, pulse.body);
	cleanup.push(() => binding.destroy());
	const available: boolean[] = [];
	cleanup.push(
		editor.registerCommand(
			CAN_UNDO_COMMAND,
			(value) => {
				available.push(value);
				return false;
			},
			COMMAND_PRIORITY_LOW,
		),
	);
	editor.update(() => firstText().spliceText(1, 0, "L"));
	expect(binding.undo()).toBe(true);
	expect(pulse.body.text).toBe("ab");
	expect(available).toContain(true);
	expect(available.at(-1)).toBe(false);
});
