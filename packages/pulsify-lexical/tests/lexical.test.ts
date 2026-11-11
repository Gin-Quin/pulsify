import { afterEach, expect, test } from "bun:test";
import { object, array } from "@gin-quin/codec";
import { createHeadlessEditor } from "@lexical/headless";
import { HeadingNode, QuoteNode, $createHeadingNode } from "@lexical/rich-text";
import {
	ListNode,
	ListItemNode,
	$createListNode,
	$createListItemNode,
} from "@lexical/list";
import { LinkNode, $createLinkNode } from "@lexical/link";
import {
	$getRoot,
	$createTextNode,
	$createParagraphNode,
	$isElementNode,
	$isTextNode,
	$isRangeSelection,
	$getSelection,
	UNDO_COMMAND,
	REDO_COMMAND,
	type LexicalEditor,
	type TextNode,
} from "lexical";
import {
	createPulse,
	createPulseScope,
	definePulse,
	richText,
	destroyPulse,
	exportPulseUpdates,
	applyPulseUpdates,
	getPulseMeta,
	getPulseVersions,
	snapshotPulse,
	type Pulse,
} from "pulsify-core";
import {
	bindLexical,
	lexicalDocument,
	type LexicalBinding,
} from "../source/index.js";
import { bindProseMirror } from "pulsify-prosemirror";
import { EditorState } from "prosemirror-state";
import { schema } from "prosemirror-schema-basic";
import { EditorView } from "prosemirror-view";
import { JSDOM } from "jsdom";
import { createRuntime } from "../../pulse/source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../../pulse/source/pulses/PulseOptions.js";

const Note = definePulse(
	"LexicalNote",
	object({ body: richText() }),
).materialize();
const pulses: Pulse<any>[] = [],
	bindings: LexicalBinding[] = [];
let sid = 95000;
const options = () => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId: sid++,
});
function create(text = "Hello") {
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
function editor(
	pulse: ReturnType<typeof create>,
	config: Parameters<typeof bindLexical>[2] = {},
) {
	const editor = createHeadlessEditor({
		nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode],
		onError: (error) => {
			throw error;
		},
	});
	const binding = bindLexical(editor, pulse.body, config);
	bindings.push(binding);
	return { editor, binding };
}
function sync(a: ReturnType<typeof create>, b: ReturnType<typeof create>) {
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	applyPulseUpdates(a, exportPulseUpdates(b, []));
}
function text(editor: LexicalEditor) {
	return editor.getEditorState().read(() =>
		$getRoot()
			.getAllTextNodes()
			.map((node) => node.getTextContent())
			.join(""),
	);
}
function firstText(): TextNode {
	const node = $getRoot().getFirstDescendant();
	if (!$isTextNode(node)) throw new Error("Expected text");
	return node;
}
afterEach(() => {
	for (const binding of bindings.splice(0)) binding.destroy();
	for (const pulse of pulses.splice(0)) destroyPulse(pulse);
});

test("same richText() field binds without React or a DOM and exports Lexical JSON", () => {
	const pulse = create("Bonjour 😀"),
		{ editor } = editorFor(pulse);
	expect(text(editor)).toBe("Bonjour 😀");
	editor.update(() => firstText().spliceText(7, 0, "!"), { discrete: true });
	expect(pulse.body.text).toBe("Bonjour! 😀");
	expect(lexicalDocument(pulse.body)).toEqual(editor.getEditorState().toJSON());
	expect(snapshotPulse(pulse).body).toBe("Bonjour! 😀");
});
const editorFor = editor;

test("concurrent first bindings, character edits and different format bits merge", () => {
	const a = create("aaa"),
		b = peer(a),
		left = editor(a).editor,
		right = editor(b).editor;
	left.update(
		() => {
			firstText().select(0, 0);
		},
		{ discrete: true },
	);
	left.update(
		() => {
			firstText().spliceText(0, 0, "a", true);
			firstText().toggleFormat("bold");
		},
		{ discrete: true },
	);
	right.update(
		() => {
			firstText().select(1, 1);
		},
		{ discrete: true },
	);
	right.update(
		() => {
			firstText().spliceText(1, 0, "X", true);
			firstText().toggleFormat("italic");
		},
		{ discrete: true },
	);
	sync(a, b);
	expect(left.getEditorState().toJSON()).toEqual(
		right.getEditorState().toJSON(),
	);
	expect(text(left)).toBe("aaXaa");
	left.getEditorState().read(() => {
		const nodes = $getRoot().getAllTextNodes();
		expect(
			nodes.some((node) => node.hasFormat("bold") && node.hasFormat("italic")),
		).toBe(true);
	});
});

test("headings, nested lists and links survive synchronization", () => {
	const a = create(""),
		left = editor(a).editor;
	left.update(
		() => {
			const root = $getRoot();
			root.clear();
			root.append(
				$createHeadingNode("h2").append($createTextNode("Title")),
				$createListNode("bullet").append(
					$createListItemNode().append(
						$createLinkNode("https://example.com").append(
							$createTextNode("Link"),
						),
					),
				),
			);
		},
		{ discrete: true },
	);
	const b = peer(a),
		right = editor(b).editor;
	expect(right.getEditorState().toJSON()).toEqual(
		left.getEditorState().toJSON(),
	);
	expect(text(right)).toBe("TitleLink");
});

test("two editors on one field synchronize once; detached bindings stop writing", () => {
	const a = create("x"),
		{ editor: left, binding } = editor(a),
		right = editor(a).editor;
	const clock = getPulseMeta(a).model.nextClock;
	left.update(() => firstText().spliceText(1, 0, "y"), { discrete: true });
	expect(text(right)).toBe("xy");
	expect(getPulseMeta(a).model.nextClock).toBe(clock + 1);
	binding.destroy();
	left.update(() => firstText().spliceText(2, 0, "z"), { discrete: true });
	expect(a.body.text).toBe("xy");
	const rebound = bindLexical(left, a.body);
	bindings.push(rebound);
	expect(text(left)).toBe("xy");
});

test("collaborative undo/redo retains remote insertions and remote formatting", () => {
	const a = create("ab"),
		{ editor: left, binding } = editor(a),
		b = peer(a),
		right = editor(b).editor;
	left.update(() => firstText().spliceText(1, 0, "L"), { discrete: true });
	sync(a, b);
	right.update(
		() => {
			firstText().spliceText(3, 0, "R");
			firstText().toggleFormat("bold");
		},
		{ discrete: true },
	);
	sync(a, b);
	expect(binding.canUndo).toBe(true);
	left.dispatchCommand(UNDO_COMMAND, undefined);
	sync(a, b);
	expect(text(left)).toBe("abR");
	expect(text(right)).toBe("abR");
	left
		.getEditorState()
		.read(() => expect(firstText().hasFormat("bold")).toBe(true));
	left.dispatchCommand(REDO_COMMAND, undefined);
	sync(a, b);
	expect(text(left)).toBe("aLbR");
	expect(text(right)).toBe("aLbR");
});

test("undoing a deletion restores characters without deleting unseen descendants", () => {
	const a = create("abc"),
		{ editor: left, binding } = editor(a),
		b = peer(a),
		right = editor(b).editor;
	left.update(() => firstText().spliceText(1, 1, ""), { discrete: true });
	right.update(() => firstText().spliceText(2, 0, "X"), { discrete: true });
	sync(a, b);
	expect(text(left)).toBe("aXc");
	binding.undo();
	sync(a, b);
	expect(text(left)).toBe("abXc");
	expect(text(right)).toBe("abXc");
});

test("UTF-16 selections remain on surviving characters after remote emoji insertion", () => {
	const a = create("a😀b"),
		left = editor(a).editor,
		b = peer(a),
		right = editor(b).editor;
	left.update(() => firstText().select(3, 3), { discrete: true });
	right.update(() => firstText().spliceText(0, 0, "🚀"), { discrete: true });
	sync(a, b);
	left.getEditorState().read(() => {
		const selected = $getSelection();
		expect($isRangeSelection(selected)).toBe(true);
		if ($isRangeSelection(selected)) expect(selected.anchor.offset).toBe(5);
	});
});

test("nested/array fields bind and replacing the field disconnects the old editor", () => {
	const Nested = definePulse(
		"NestedLexical",
		object({ sections: array(object({ body: richText() })) }),
	).materialize();
	const pulse = createPulse(Nested, { sections: [{ body: "old" }] }, options());
	pulses.push(pulse);
	const view = createHeadlessEditor({
			onError: (error) => {
				throw error;
			},
		}),
		errors: unknown[] = [];
	const binding = bindLexical(view, pulse.sections[0]!.body, {
		onError: (error) => errors.push(error),
	});
	bindings.push(binding);
	pulse.sections[0]!.body = richText("new");
	expect(errors.length).toBe(1);
	const next = bindLexical(view, pulse.sections[0]!.body);
	bindings.push(next);
	expect(text(view)).toBe("new");
});

test("incompatible document families and schema IDs fail before changing the field", () => {
	const a = create("x"),
		left = editor(a).editor;
	expect(() => bindLexical(left, a.body)).toThrow("already bound");
	const other = createHeadlessEditor();
	expect(() => bindLexical(other, a.body, { schemaId: "custom:v2" })).toThrow(
		"schemaId",
	);
	const dom = new JSDOM("<html><body></body></html>");
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		navigator: dom.window.navigator,
	});
	const view = new EditorView(document.createElement("div"), {
		state: EditorState.create({ schema }),
	});
	const frames = exportPulseUpdates(a, []);
	expect(() => bindProseMirror(view, a.body)).toThrow(
		"different editor format",
	);
	expect(exportPulseUpdates(a, [])).toEqual(frames);
	view.destroy();
});

test("large plain text edits send a small patch", () => {
	const a = create("a".repeat(10000)),
		left = editor(a).editor;
	const versions = getPulseVersions(a).state;
	left.update(() => firstText().spliceText(5000, 0, "X"), { discrete: true });
	expect(
		exportPulseUpdates(a, versions).reduce(
			(size, frame) => size + frame.byteLength,
			0,
		),
	).toBeLessThan(1024);
	expect(a.body.length).toBe(10001);
});

test("joining paragraphs preserves a concurrent insertion in the removed paragraph", () => {
	const a = create("a"),
		left = editor(a).editor;
	left.update(
		() =>
			$getRoot().append($createParagraphNode().append($createTextNode("b"))),
		{ discrete: true },
	);
	const b = peer(a),
		right = editor(b).editor;
	left.update(
		() => {
			const first = $getRoot().getFirstChild()!,
				last = $getRoot().getLastChild()!;
			if ($isElementNode(first) && $isElementNode(last)) {
				first.append(...last.getChildren());
				last.remove();
			}
		},
		{ discrete: true },
	);
	right.update(
		() => {
			const last = $getRoot().getLastDescendant();
			if ($isTextNode(last)) last.spliceText(1, 0, "X");
		},
		{ discrete: true },
	);
	sync(a, b);
	expect(text(left)).toBe("abX");
	expect(right.getEditorState().toJSON()).toEqual(
		left.getEditorState().toJSON(),
	);
});

test("undo and redo a block deletion including concurrent hidden content", () => {
	const a = create("a"),
		{ editor: left, binding } = editor(a);
	left.update(
		() =>
			$getRoot().append($createParagraphNode().append($createTextNode("b"))),
		{ discrete: true },
	);
	const b = peer(a),
		right = editor(b).editor;
	left.update(() => $getRoot().getLastChild()!.remove(), { discrete: true });
	right.update(
		() => {
			const last = $getRoot().getLastDescendant();
			if ($isTextNode(last)) last.spliceText(1, 0, "X");
		},
		{ discrete: true },
	);
	sync(a, b);
	expect(text(left)).toBe("a");
	binding.undo();
	sync(a, b);
	expect(text(left)).toBe("abX");
	expect(text(right)).toBe("abX");
	binding.redo();
	sync(a, b);
	expect(text(left)).toBe("a");
	expect(text(right)).toBe("a");
});

test("a pending batched local edit is flushed before a remote change", () => {
	const a = create("ab"),
		left = editor(a).editor,
		b = peer(a),
		right = editor(b).editor;
	left.update(() => firstText().spliceText(1, 0, "L"));
	right.update(() => firstText().spliceText(2, 0, "R"), { discrete: true });
	sync(a, b);
	// Flushing during delivery creates a new local frame; deliver it too.
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	expect(text(left)).toBe("aLbR");
	expect(text(right)).toBe("aLbR");
});

test("pending typing preserves remote deletion and formatting intent", () => {
	const a = create("ab"),
		left = editor(a).editor,
		b = peer(a),
		right = editor(b).editor;
	left.update(() => firstText().spliceText(1, 0, "L"));
	right.update(
		() => {
			firstText().spliceText(1, 1, "");
			firstText().toggleFormat("bold");
		},
		{ discrete: true },
	);
	sync(a, b);
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	expect(text(left)).toBe("aL");
	expect(text(right)).toBe("aL");
	left
		.getEditorState()
		.read(() => expect(firstText().hasFormat("bold")).toBe(true));
});
