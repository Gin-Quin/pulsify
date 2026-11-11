import { afterEach, expect, test } from "bun:test";
import { array, map, object, optional } from "@gin-quin/codec";
import {
	arrayOperations,
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	loadPulse,
	richText,
	tree,
	type Pulse,
	type RichText,
	type Tree,
} from "pulsify-core";
import { JSDOM } from "jsdom";
import {
	createElement as h,
	memo,
	StrictMode,
	Suspense,
	useLayoutEffect,
	type ReactNode,
} from "react";
import { usePulse } from "../source/index";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// react-dom reads the DOM globals when it loads.
const { act } = await import("react");
const { createRoot, hydrateRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");

const Note = definePulse(
	"Note",
	object({
		title: "string",
		author: object({ name: "string" }),
		items: array(object({ label: "string", done: "boolean" })),
	}),
).materialize();
type NotePulse = ReturnType<typeof note>;

function note(options = {}) {
	return createPulse(
		Note,
		{
			title: "Draft",
			author: { name: "Ada" },
			items: [
				{ label: "A", done: false },
				{ label: "B", done: false },
			],
		},
		{ scope: createPulseScope(), ...options },
	);
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function render(node: ReactNode) {
	const container = window.document.createElement("div");
	const root = createRoot(container);
	act(() => root.render(node));
	cleanups.push(() => act(() => root.unmount()));
	return { container, root };
}

function track<P extends Pulse<any>>(pulse: P) {
	cleanups.push(() => destroyPulse(pulse));
	return pulse;
}

test("re-renders only when a value read during render changes", () => {
	const doc = track(note());
	let renders = 0;
	function Title() {
		renders++;
		return usePulse(doc).title;
	}
	const { container } = render(h(Title));
	expect(container.textContent).toBe("Draft");
	expect(renders).toBe(1);

	act(() => {
		doc.author.name = "Grace";
		doc.items[0]!.done = true;
	});
	expect(renders).toBe(1);

	act(() => {
		doc.title = "Final";
	});
	expect(container.textContent).toBe("Final");
	expect(renders).toBe(2);

	act(() => {
		doc.title = "Final";
	});
	expect(renders).toBe(2);
});

test("memoized children receiving tracked objects re-render alone", () => {
	const doc = track(note());
	const renders: Record<string, number> = { list: 0 };
	const Item = memo(function Item({
		item,
	}: {
		item: NotePulse["items"][number];
	}) {
		renders[item.label] = (renders[item.label] ?? 0) + 1;
		return h("li", null, `${item.label}:${item.done}`);
	});
	function List() {
		renders["list"]!++;
		const snap = usePulse(doc);
		return h(
			"ul",
			null,
			snap.items.map((item, i) => h(Item, { key: i, item })),
		);
	}
	const { container } = render(h(List));
	expect(container.textContent).toBe("A:falseB:false");

	act(() => {
		doc.items[1]!.done = true;
	});
	expect(container.textContent).toBe("A:falseB:true");
	expect(renders).toEqual({ list: 2, A: 1, B: 2 });

	act(() => {
		doc.items.push({ label: "C", done: false });
	});
	expect(container.textContent).toBe("A:falseB:trueC:false");
	expect(renders).toEqual({ list: 3, A: 1, B: 2, C: 1 });

	// Reads made by a skipped child stay tracked.
	act(() => {
		doc.items[0]!.label = "Z";
	});
	expect(container.textContent).toBe("Z:falseB:trueC:false");
	expect(renders["list"]).toBe(4);
});

test("writes through the returned proxy update the pulse and re-render", () => {
	const doc = track(note());
	let snap: NotePulse | undefined;
	function Editor() {
		snap = usePulse(doc);
		return `${snap.title} by ${snap.author.name} (${snap.items.length})`;
	}
	const { container } = render(h(Editor));
	act(() => {
		snap!.title = "Edited";
		snap!.author = snap!.author;
		snap!.items.push({ label: "C", done: true });
	});
	expect(doc.title).toBe("Edited");
	expect(doc.author.name).toBe("Ada");
	expect(doc.items.map((item) => item.label)).toEqual(["A", "B", "C"]);
	expect(container.textContent).toBe("Edited by Ada (3)");
});

test("replacing or removing a read object re-renders", () => {
	const doc = track(note());
	function Author() {
		const snap = usePulse(doc);
		return `${snap.author.name}/${snap.items.map((item) => item.label).join()}`;
	}
	const { container } = render(h(Author));
	act(() => {
		doc.author = { name: "Grace" };
	});
	expect(container.textContent).toBe("Grace/A,B");
	act(() => {
		doc.items.splice(0, 1);
	});
	expect(container.textContent).toBe("Grace/B");
	act(() => {
		doc.author.name = "Linus";
	});
	expect(container.textContent).toBe("Linus/B");
});

test("tracks keys enumerated during render", () => {
	const Tags = definePulse(
		"Tags",
		object({ title: "string", tags: map("string") }),
	).materialize();
	const doc = track(
		createPulse(
			Tags,
			{ title: "Tags", tags: { a: "1" } },
			{ scope: createPulseScope() },
		),
	);
	let renders = 0;
	function Keys() {
		renders++;
		return Object.keys(usePulse(doc).tags).join();
	}
	const { container } = render(h(Keys));
	expect(container.textContent).toBe("a");
	act(() => {
		doc.title = "Other";
		doc.tags["a"] = "2";
	});
	expect(renders).toBe(1);
	act(() => {
		doc.tags["b"] = "3";
	});
	expect(container.textContent).toBe("a,b");
	act(() => {
		delete doc.tags["a"];
	});
	expect(container.textContent).toBe("b");
});

test("a child can subscribe with a tracked pulse from its parent", () => {
	const doc = track(note());
	const renders = { parent: 0, child: 0 };
	const Child = memo(function Child({ doc }: { doc: NotePulse }) {
		renders.child++;
		return usePulse(doc).author.name;
	});
	function Parent() {
		renders.parent++;
		const snap = usePulse(doc);
		return h("p", null, snap.title, " ", h(Child, { doc: snap }));
	}
	const { container } = render(h(Parent));
	act(() => {
		doc.author.name = "Grace";
	});
	expect(container.textContent).toBe("Draft Grace");
	expect(renders).toEqual({ parent: 1, child: 2 });
});

test("re-renders on remote changes", async () => {
	const connector = createMemoryConnector();
	const a = track(note({ connectors: [connector], sessionId: 65536 }));
	await connectPulse(a).synced;
	const b = track(
		await loadPulse(Note, a.id, {
			scope: createPulseScope(),
			sessionId: 65537,
			connectors: [connector],
			waitFor: "all",
		}),
	);
	function Title() {
		return usePulse(b).items[1]!.label;
	}
	const { container } = render(h(StrictMode, null, h(Title)));
	expect(container.textContent).toBe("B");
	a.items[1]!.label = "Remote";
	await act(async () => {
		for (let i = 0; i < 50 && b.items[1]!.label !== "Remote"; i++)
			await new Promise((resolve) => setTimeout(resolve, 5));
	});
	expect(container.textContent).toBe("Remote");
});

test("unsubscribes on unmount", () => {
	const doc = track(note());
	function Title() {
		return usePulse(doc).title;
	}
	const container = window.document.createElement("div");
	const root = createRoot(container);
	act(() => root.render(h(Title)));
	expect(getPulseMeta(doc).listeners.size).toBe(1);
	act(() => root.unmount());
	expect(getPulseMeta(doc).listeners.size).toBe(0);
});

test("a change between render and subscription is not lost", () => {
	const doc = track(note());
	function Title() {
		const snap = usePulse(doc);
		useLayoutEffect(() => {
			doc.title = "Changed";
			void snap.title;
		}, []);
		return snap.title;
	}
	const { container } = render(h(Title));
	expect(container.textContent).toBe("Changed");
});

test("a change in the middle of a render is not left half shown", () => {
	const doc = track(note());
	let mutate = false;
	function Name({ snap }: { snap: NotePulse }) {
		return snap.author.name;
	}
	function Mutate() {
		// Stands for a remote change landing while a concurrent render yields.
		if (mutate) {
			mutate = false;
			doc.author.name = "Grace";
		}
		return "|";
	}
	function App({ show }: { show: boolean }) {
		const snap = usePulse(doc);
		return show
			? [
					h(Name, { key: 1, snap }),
					h(Mutate, { key: 2 }),
					h(Name, { key: 3, snap }),
				]
			: snap.title;
	}
	const { container, root } = render(h(App, { show: false }));
	mutate = true;
	act(() => root.render(h(App, { show: true })));
	expect(container.textContent).toBe("Grace|Grace");
});

test("tracks key presence", () => {
	const Flags = definePulse(
		"Flags",
		object({ tags: map(optional("string")) }),
	).materialize();
	const doc = track(
		createPulse(
			Flags,
			{ tags: { a: undefined } },
			{ scope: createPulseScope() },
		),
	);
	function Presence() {
		const tags = usePulse(doc).tags;
		return `${"a" in tags}/${Object.hasOwn(tags, "b")}`;
	}
	const { container } = render(h(Presence));
	expect(container.textContent).toBe("true/false");
	act(() => {
		delete doc.tags["a"];
	});
	expect(container.textContent).toBe("false/false");
	act(() => {
		doc.tags["b"] = "x";
	});
	expect(container.textContent).toBe("false/true");
});

test("memoized children update when their rich text or tree changes", () => {
	const Article = definePulse(
		"Article",
		object({
			title: "string",
			body: richText(),
			outline: tree(object({ label: "string" })),
		}),
	).materialize();
	const doc = track(
		createPulse(
			Article,
			{ title: "Draft", body: "Hello", outline: {} },
			{ scope: createPulseScope() },
		),
	);
	const renders = { article: 0, body: 0, outline: 0 };
	const Body = memo(function Body({ body }: { body: RichText }) {
		renders.body++;
		return body.text;
	});
	const Outline = memo(function Outline({
		outline,
	}: {
		outline: Tree<{ label: string }>;
	}) {
		renders.outline++;
		return outline
			.roots()
			.map((node) => node.data.label)
			.join();
	});
	function Article_() {
		renders.article++;
		const snap = usePulse(doc);
		return [
			snap.title,
			"/",
			h(Body, { key: "body", body: snap.body }),
			"/",
			h(Outline, { key: "outline", outline: snap.outline }),
		];
	}
	const { container } = render(h(Article_));
	expect(container.textContent).toBe("Draft/Hello/");
	act(() => doc.body.insert(5, "!"));
	expect(container.textContent).toBe("Draft/Hello!/");
	expect(renders).toEqual({ article: 2, body: 2, outline: 1 });
	act(() => {
		doc.outline.createNode({ label: "One" });
	});
	expect(container.textContent).toBe("Draft/Hello!/One");
	expect(renders).toEqual({ article: 3, body: 2, outline: 2 });
	act(() => {
		doc.title = "Final";
	});
	expect(container.textContent).toBe("Final/Hello!/One");
	expect(renders).toEqual({ article: 4, body: 2, outline: 2 });
});

test("reads frozen materialized values", () => {
	const Frozen = definePulse(
		"Frozen",
		object({ author: object({ name: "string" }) }),
	).materialize<any>(() => ({
		rows: {
			get: (data: any) => Object.freeze([data["author"]]),
			set() {
				throw new TypeError("rows are derived");
			},
		},
	}));
	const doc = track(
		createPulse(Frozen, { author: { name: "Ada" } } as any, {
			scope: createPulseScope(),
		}),
	);
	function Rows() {
		return usePulse(doc)["rows"][0].name;
	}
	const { container } = render(h(Rows));
	expect(container.textContent).toBe("Ada");
	act(() => {
		doc["author"].name = "Grace";
	});
	expect(container.textContent).toBe("Grace");
});

test("drops the root reads of earlier renders", () => {
	const doc = track(note());
	let renders = 0;
	function View({ field }: { field: "title" | "author" }) {
		renders++;
		const snap = usePulse(doc);
		return field === "title" ? snap.title : snap.author.name;
	}
	const { container, root } = render(h(View, { field: "title" }));
	act(() => root.render(h(View, { field: "author" })));
	expect(container.textContent).toBe("Ada");
	expect(renders).toBe(2);
	act(() => {
		doc.title = "Final";
	});
	expect(renders).toBe(2);
});

test("moved array elements keep their identity unless they changed", () => {
	const doc = track(note());
	const renders: Record<string, number> = { list: 0 };
	const Item = memo(function Item({
		item,
	}: {
		item: NotePulse["items"][number];
	}) {
		renders[item.label] = (renders[item.label] ?? 0) + 1;
		return `${item.label}:${item.done}`;
	});
	function List() {
		renders["list"]!++;
		const items = usePulse(doc).items;
		return items.map((item) => h(Item, { key: item.label, item }));
	}
	const { container } = render(h(List));
	act(() => arrayOperations(doc.items).move(0, 1));
	expect(container.textContent).toBe("B:falseA:false");
	expect(renders).toEqual({ list: 2, A: 1, B: 1 });
	act(() => {
		arrayOperations(doc.items).move(0, 1);
		doc.items[1]!.done = true;
	});
	expect(container.textContent).toBe("A:falseB:true");
	expect(renders).toEqual({ list: 3, A: 1, B: 2 });
});

test("renders on the client only", async () => {
	const doc = track(note());
	function Title() {
		return usePulse(doc).title;
	}
	const app = h(Suspense, { fallback: "Loading" }, h(Title));
	const html = renderToString(app);
	expect(html).toContain("Loading");
	expect(() => renderToString(h(Title))).toThrow("client only");

	const container = window.document.createElement("div");
	container.innerHTML = html;
	const root = hydrateRoot(container, app, { onRecoverableError() {} });
	cleanups.push(() => act(() => root.unmount()));
	await act(async () => {});
	expect(container.textContent).toBe("Draft");
	act(() => {
		doc.title = "Final";
	});
	expect(container.textContent).toBe("Final");
});
