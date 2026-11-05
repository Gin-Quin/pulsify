import { expect, test } from "bun:test";
import {
	array,
	createCodec,
	map,
	object,
	optional,
	tuple,
	union,
	type ArraySchema,
	type ObjectSchema,
} from "@gin-quin/codec";
import {
	applyPulseUpdates,
	compilePulseSchema,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	getPulseMeta,
	richText,
	schemaFingerprint,
	snapshotPulse,
	type RichTextSchema,
	struct,
	type Struct,
	type RichText,
	type PulseProperties,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});

test("richText() declares a codec string schema; richText(text) remains a value initializer", () => {
	const field = richText();
	expect(field).toBe(richText());
	expect(Object.isFrozen(field)).toBe(true);
	expect(
		createCodec(field).decode(createCodec(field).encode("Bonjour 😀")),
	).toBe("Bonjour 😀");
	expect(richText("").text).toBe("");
	expect(richText("Bonjour").text).toBe("Bonjour");
	expect(() => richText(undefined as unknown as string)).toThrow(
		"Unicode string",
	);
});

test("inline rich text works in nested objects, arrays, maps, optionals and tuples", () => {
	const schema = object({
		title: "string",
		body: richText(),
		author: object({ bio: richText() }),
		items: array(richText()),
		notes: array(object({ text: richText() })),
		byId: map(richText()),
		maybe: optional(richText()),
		pair: tuple("uint", richText()),
	});
	const definition = definePulse("InlineRichText", schema).materialize();
	const input = {
		title: "Plain",
		body: "Bonjour",
		author: { bio: "Ada" },
		items: ["A"],
		notes: [{ text: "N" }],
		byId: { first: "Map" },
		pair: [1, "Pair"] as [number, string],
	};
	const source = createPulse(definition, input, options(65536));
	const peer = createRuntime(definition, source.id, options(65537));
	try {
		source.body.insert(7, " 😀");
		source.body.format(0, 7, { bold: true });
		source.author.bio.insert(3, "!");
		source.items[0]!.format(0, 1, { italic: true });
		source.items.push(richText("B"));
		source.notes[0]!.text.insert(1, "!");
		source.byId["first"]!.insert(3, "!");
		source.pair[1].insert(4, "!");
		expect(source.maybe).toBeUndefined();
		source.maybe = richText("Optional");
		source.maybe.insert(8, "!");
		applyPulseUpdates(peer, exportPulseUpdates(source, []));
		expect(snapshotPulse(peer)).toEqual(snapshotPulse(source));
		expect(peer["body"].toDelta()).toEqual(source.body.toDelta());
		expect(peer["items"][0].toDelta()).toEqual(source.items[0]!.toDelta());
		const snapshot = snapshotPulse(source);
		expect(snapshot).toMatchObject({
			body: "Bonjour 😀",
			author: { bio: "Ada!" },
			items: ["A", "B"],
			notes: [{ text: "N!" }],
			byId: { first: "Map!" },
			maybe: "Optional!",
			pair: [1, "Pair!"],
		});
		const codec = createCodec(schema);
		const { title, body, author, items, notes, byId, maybe, pair } = snapshot;
		const plain = { title, body, author, items, notes, byId, maybe, pair };
		expect(codec.decode(codec.encode(plain))).toEqual(plain);
	} finally {
		destroyPulse(source);
		destroyPulse(peer);
	}
});

test("inline schemas preserve codec bytes and fingerprints of equivalent richTextPaths", () => {
	const inline = object({
		body: richText(),
		nested: object({ text: richText() }),
		items: array(optional(richText())),
	});
	const plain = object({
		body: "string",
		nested: object({ text: "string" }),
		items: array(optional("string")),
	});
	const paths = [["body"], ["nested", "text"], ["items", "*"]] as const;
	const a = compilePulseSchema(inline);
	const b = compilePulseSchema(plain, { richTextPaths: paths });
	const value = { body: "A", nested: { text: "B" }, items: [undefined, "C"] };
	expect(a.schema).toBe(inline);
	expect(a.codecSchema).toEqual(plain);
	expect(a.codec.encode(value)).toEqual(createCodec(plain).encode(value));
	expect(a.codec.encode(value)).toEqual(createCodec(inline).encode(value));
	expect(schemaFingerprint(a)).toBe(schemaFingerprint(b));
	expect(schemaFingerprint(a)).not.toBe(
		schemaFingerprint(compilePulseSchema(plain)),
	);
	const original = definePulse("CompatibleInline", plain, {
		richTextPaths: paths,
	}).materialize();
	const replacement = definePulse("CompatibleInline", inline).materialize();
	const source = createPulse(original, value, options(65536));
	const peer = createRuntime(replacement, source.id, options(65537));
	try {
		source.body.format(0, 1, { bold: true });
		applyPulseUpdates(peer, exportPulseUpdates(source, []));
		expect(peer["body"].toDelta()).toEqual(source.body.toDelta());
	} finally {
		destroyPulse(source);
		destroyPulse(peer);
	}
});

test("inline declarations stay local to their tagged and untagged union branches", () => {
	const schema = object({
		value: union("string", {
			rich: { body: richText() },
			plain: { body: "string" },
		}),
		other: union([object({ rich: richText() }), object({ plain: "string" })]),
	});
	const definition = definePulse("RichBranches", schema).materialize();
	const pulse = createPulse(
		definition,
		{ value: { type: "rich", body: "R" }, other: { rich: "A" } },
		options(65536),
	);
	try {
		if (pulse.value.type !== "rich") throw new Error("Wrong variant");
		pulse.value.body.insert(1, "!");
		if (!("rich" in pulse.other)) throw new Error("Wrong variant");
		pulse.other.rich.insert(1, "!");
		pulse.value = { type: "plain", body: "Plain" };
		pulse.other = { plain: "Atomic" };
		expect(typeof pulse.value.body).toBe("string");
		expect(pulse.other.plain).toBe("Atomic");
		expect(
			getPulseMeta(pulse).model.root!.child("value")!.child("body"),
		).toBeUndefined();
	} finally {
		destroyPulse(pulse);
	}
});

test("inline rich text in recursive lazy schemas applies to every occurrence", () => {
	type Tree = ObjectSchema<{
		body: RichTextSchema;
		children: ArraySchema<() => Tree>;
	}>;
	const tree: Tree = object({ body: richText(), children: array(() => tree) });
	const definition = definePulse(
		"RecursiveInline",
		object({ tree }),
	).materialize();
	const source = createPulse(
		definition,
		{
			tree: {
				body: "Root",
				children: [
					{ body: "Child", children: [{ body: "Leaf", children: [] }] },
				],
			},
		},
		options(65536),
	);
	const peer = createRuntime(definition, source.id, options(65537));
	try {
		source.tree.children[0]!.children[0]!.body.insert(4, "!");
		applyPulseUpdates(peer, exportPulseUpdates(source, []));
		expect(peer["tree"].children[0].children[0].body.text).toBe("Leaf!");
		const codec = createCodec(object({ tree }));
		const value = { tree: snapshotPulse(source).tree };
		expect(codec.decode(codec.encode(value))).toEqual(value);
	} finally {
		destroyPulse(source);
		destroyPulse(peer);
	}
});

test("inline rich text rejects invalid values and conflicting constants atomically", () => {
	const schema = object({ body: richText() });
	expect(() =>
		definePulse("FrozenRich", schema, {
			constantPaths: [["body"]],
		}).materialize(),
	).toThrow("constant");
	const pulse = createPulse(
		definePulse("ValidateInline", schema).materialize(),
		{ body: "Text" },
		options(65536),
	);
	try {
		const before = snapshotPulse(pulse),
			vector = getPulseMeta(pulse).log.vector;
		expect(() => Reflect.set(pulse, "body", 42)).toThrow();
		expect(snapshotPulse(pulse)).toEqual(before);
		expect(getPulseMeta(pulse).log.vector).toEqual(vector);
		expect(() => Reflect.set(pulse, "body", richText())).toThrow();
	} finally {
		destroyPulse(pulse);
	}
});

test("migrations receive detached strings and can upgrade, preserve and edit inline rich text", () => {
	const first = definePulse("InlineMigration", object({ body: "string" }));
	const old = first.materialize();
	const secondSchema = object({
		body: richText(),
		nested: object({ body: richText() }),
	});
	const second = first.migrateTo(secondSchema, (before) => ({
		nested: { body: before.body },
	}));
	let seen = "";
	const latest = second
		.migrateTo(secondSchema, (before) => {
			seen = `${typeof before.body}/${typeof before.nested.body}`;
			return {
				body: `${before.body}!`,
				nested: { body: `${before.nested.body}?` },
			};
		})
		.materialize();
	const source = createPulse(old, { body: "Bonjour" }, options(65536));
	const peer = createRuntime(latest, source.id, options(65537));
	try {
		applyPulseUpdates(peer, exportPulseUpdates(source, []));
		expect(seen).toBe("string/string");
		expect(peer["body"].text).toBe("Bonjour!");
		expect(peer["nested"].body.text).toBe("Bonjour?");
		peer["body"].format(0, 7, { bold: true });
		expect(peer["body"].toDelta()[0].attributes).toEqual({ bold: true });
	} finally {
		destroyPulse(source);
		destroyPulse(peer);
	}
});

test("compiled inline fields do not invoke their schema helper during ordinary edits or exports", () => {
	let calls = 0;
	const field = new Proxy(richText(), {
		apply(target, receiver, args) {
			calls++;
			return Reflect.apply(target, receiver, args);
		},
	});
	const definition = definePulse(
		"CompiledInline",
		object({ body: field, count: "float64" }),
	).materialize();
	const source = createPulse(
		definition,
		{ body: "A", count: 0 },
		options(65536),
	);
	const peer = createRuntime(definition, source.id, options(65537));
	expect(calls).toBeGreaterThan(0);
	calls = 0;
	try {
		source.body.insert(1, "B");
		source.count++;
		applyPulseUpdates(peer, exportPulseUpdates(source, []));
		expect(peer["body"].text).toBe("AB");
		expect(calls).toBe(0);
	} finally {
		destroyPulse(source);
		destroyPulse(peer);
	}
});

test("legacy migrations preserve omitted rich-text and struct fields with detached callback input", () => {
	type V1 = PulseProperties<"PreservedMigrationFields"> & {
		body: RichText;
		metadata: Struct<{ key: string }>;
	};
	type V2 = V1 & { count: number };
	const builder = definePulse<V1>("PreservedMigrationFields");
	const previous = builder.materialize();
	let input: string | undefined;
	const latest = builder
		.migrate<V2>((before) => {
			input = before.body;
			return { count: 0 };
		})
		.materialize();
	const source = createPulse(
		previous,
		{ body: richText("Hello"), metadata: struct({ key: "K" }) },
		options(65536),
	);
	source.body.format(0, 5, { bold: true });
	const target = createRuntime(latest, source.id, options(65537));
	try {
		applyPulseUpdates(target, exportPulseUpdates(source, []));
		expect(input).toBe("Hello");
		expect(target["body"].toDelta()).toEqual(source.body.toDelta());
		expect(target["metadata"].key).toBe("K");
		expect(target["count"]).toBe(0);
		expect(() => Reflect.set(target["metadata"], "key", "other")).toThrow();
	} finally {
		destroyPulse(source);
		destroyPulse(target);
	}
});
