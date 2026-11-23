import { afterEach, expect, test } from "bun:test";
import { object } from "@gin-quin/codec";
import { createHeadlessEditor } from "@lexical/headless";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	type TextNode,
} from "lexical";
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
	type Pulse,
} from "pulsify-core";
import { RT_MARK, richTextContext } from "pulsify-core/bindings";
import { bindLexical, type LexicalBinding } from "../source/index.js";
import { createRuntime } from "../../pulse/source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../../pulse/source/pulses/PulseOptions.js";

const Doc = definePulse(
	"LexicalPerfDoc",
	object({ title: "string", body: richText() }),
).materialize();

const pulses: Pulse<any>[] = [];
const bindings: LexicalBinding[] = [];
let sid = 96000;
const opts = () => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId: sid++,
});

function setup(paragraphs: number) {
	const a = createPulse(Doc, { title: "init", body: "" }, opts());
	pulses.push(a);
	const edA = createHeadlessEditor({
		onError: (e) => {
			throw e;
		},
	});
	const bindA = bindLexical(edA, a.body);
	bindings.push(bindA);
	edA.update(
		() => {
			const root = $getRoot();
			root.clear();
			for (let i = 0; i < paragraphs; i++)
				root.append(
					$createParagraphNode().append(
						$createTextNode("0123456789abcdefghij"),
					),
				);
		},
		{ discrete: true },
	);
	const b = createRuntime(Doc, a.id, opts()) as typeof a;
	pulses.push(b);
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	const edB = createHeadlessEditor({
		onError: (e) => {
			throw e;
		},
	});
	const bindB = bindLexical(edB, b.body);
	bindings.push(bindB);
	return { a, b, edA, edB, bindA, bindB };
}

afterEach(() => {
	for (const binding of bindings.splice(0)) binding.destroy();
	for (const pulse of pulses.splice(0)) destroyPulse(pulse);
});

test("E1/E3: unrelated field writes do zero editor work and remote keystrokes dirty only changed nodes", () => {
	const small = setup(50);
	const large = setup(200);
	for (const { a, b, edA, edB } of [small, large]) {
		let updates = 0;
		let dirty = 0;
		const unsub = edA.registerUpdateListener(
			({ dirtyElements, dirtyLeaves }) => {
				updates++;
				dirty = dirtyElements.size + dirtyLeaves.size;
			},
		);
		a.title = "changed";
		expect(updates).toBe(0);
		expect(dirty).toBe(0);

		const ver = getPulseVersions(a).state;
		edB.update(
			() => {
				const p = $getRoot().getChildAtIndex(25)!;
				((p as any).getFirstChild() as TextNode).spliceText(5, 0, "Z");
			},
			{ discrete: true },
		);
		applyPulseUpdates(a, exportPulseUpdates(b, ver));
		expect(updates).toBe(1);
		expect(dirty).toBeLessThanOrEqual(4);
		unsub();
	}
});

test("E1: local and remote keystrokes scale sublinearly between n and 4n paragraphs", () => {
	const measure = (paragraphs: number) => {
		const { a, b, edA, edB } = setup(paragraphs);
		const mid = Math.floor(paragraphs / 2);
		// Warm up JIT once.
		edA.update(
			() => {
				const p = $getRoot().getChildAtIndex(mid)!;
				((p as any).getFirstChild() as TextNode).spliceText(5, 0, "w");
			},
			{ discrete: true },
		);
		applyPulseUpdates(b, exportPulseUpdates(a, []));
		applyPulseUpdates(a, exportPulseUpdates(b, []));

		const iters = 8;
		const t0 = performance.now();
		for (let i = 0; i < iters; i++) {
			edA.update(
				() => {
					const p = $getRoot().getChildAtIndex(mid)!;
					((p as any).getFirstChild() as TextNode).spliceText(5, 0, "x");
				},
				{ discrete: true },
			);
		}
		const localMs = (performance.now() - t0) / iters;

		applyPulseUpdates(b, exportPulseUpdates(a, []));
		let remoteTotal = 0;
		for (let i = 0; i < iters; i++) {
			const ver = getPulseVersions(a).state;
			edB.update(
				() => {
					const p = $getRoot().getChildAtIndex(mid)!;
					((p as any).getFirstChild() as TextNode).spliceText(5, 0, "y");
				},
				{ discrete: true },
			);
			const frames = exportPulseUpdates(b, ver);
			const s = performance.now();
			applyPulseUpdates(a, frames);
			remoteTotal += performance.now() - s;
		}
		return { localMs, remoteMs: remoteTotal / iters };
	};
	const n = measure(150);
	const fourN = measure(600);
	expect(fourN.localMs).toBeLessThan(Math.max(5, n.localMs * 3.2));
	expect(fourN.remoteMs).toBeLessThan(Math.max(5, n.remoteMs * 3.2));
});

test("E4: large Lexical paste is compact, omits constant default marks, and rejects >1 MiB atomically", () => {
	const a = createPulse(
		Doc,
		{ title: "t", body: "" },
		{ ...defaultPulseOptions, scope: createPulseScope() },
	);
	pulses.push(a);
	const ed = createHeadlessEditor({
		onError: (e) => {
			throw e;
		},
	});
	const errors: unknown[] = [];
	const binding = bindLexical(ed, a.body, {
		onError: (e) => errors.push(e),
	});
	bindings.push(binding);

	const ver = getPulseVersions(a).state;
	ed.update(
		() => {
			const p = $getRoot().getFirstChild() as any;
			p.append($createTextNode("a".repeat(20_000)));
		},
		{ discrete: true },
	);
	const rows = getPulseMeta(a).log.missing(ver);
	const opBytes = rows.reduce((s, r) => s + r.operations.byteLength, 0);
	expect(opBytes).toBeLessThan(25_000);

	// Plain characters carry no constant default RT_MARK entries.
	const ctx = richTextContext(a.body);
	const charEntry = ctx.node.visible.find((e) => e.value === "a")!;
	for (const key of charEntry.marks.keys())
		expect(key.startsWith(RT_MARK)).toBe(false);

	// An oversized >1 MiB paste fails locally and atomically, reverting the editor.
	const beforeText = a.body.text;
	const beforeVector = getPulseMeta(a).log.vector;
	ed.update(
		() => {
			const p = $getRoot().getFirstChild() as any;
			p.append($createTextNode("b".repeat(1_100_000)));
		},
		{ discrete: true },
	);
	expect(errors).toHaveLength(1);
	expect(String(errors[0])).toContain("1 MiB");
	expect(a.body.text).toBe(beforeText);
	expect(getPulseMeta(a).log.vector).toEqual(beforeVector);
	expect(
		ed.getEditorState().read(() => $getRoot().getTextContent().length),
	).toBe(20_000);
	// Synchronization still works after the rejected paste.
	ed.update(
		() => {
			const p = $getRoot().getFirstChild() as any;
			(p.getFirstChild() as TextNode).spliceText(0, 0, "!");
		},
		{ discrete: true },
	);
	const b = createRuntime(Doc, a.id, opts()) as typeof a;
	pulses.push(b);
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	expect(b.body.text.startsWith("!a")).toBe(true);
});
