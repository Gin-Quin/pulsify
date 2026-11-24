import { afterEach, expect, test } from "bun:test";
import { array, record, object, optional } from "@gin-quin/codec";
import {
	arrayOperations,
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePresence,
	definePulse,
	destroyPulse,
	getPulseMeta,
	joinPresence,
	loadPulse,
	PulseError,
	PulseRelay,
	pulseRef,
	richText,
	sub,
	tree,
	type Pulse,
	type RichText,
	type Tree,
} from "pulsify-core";
import { JSDOM } from "jsdom";
import {
	Component,
	createElement as h,
	memo,
	StrictMode,
	Suspense,
	useEffect,
	useLayoutEffect,
	type ReactNode,
} from "react";
import { useLoadPulse, usePulse, usePulsePresence } from "../source/index";

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
	// Last in, first out: components unmount before their pulses are destroyed.
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
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
		object({ title: "string", tags: record("string") }),
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
		object({ tags: record(optional("string")) }),
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

test("useLoadPulse suspends until the pulse is loaded, on the client only", async () => {
	const connector = createMemoryConnector();
	const a = track(note({ connectors: [connector], sessionId: 65538 }));
	await connectPulse(a).synced;
	const options = { connectors: [connector], sessionId: 65539 };
	let loaded: NotePulse | undefined;
	function Title() {
		loaded = useLoadPulse(Note, a.id, options);
		return loaded.title;
	}
	const app = h(Suspense, { fallback: "Loading" }, h(Title));
	expect(renderToString(app)).toContain("Loading");
	expect(loaded).toBeUndefined();

	const { container } = render(app);
	expect(container.textContent).toBe("Loading");
	const until = async (text: string) =>
		act(async () => {
			for (let i = 0; i < 50 && container.textContent !== text; i++)
				await new Promise((resolve) => setTimeout(resolve, 5));
		});
	await until("Draft");
	expect(container.textContent).toBe("Draft");
	track(loaded!);
	a.title = "Remote";
	await until("Remote");
	expect(container.textContent).toBe("Remote");
});

class Boundary extends Component<
	{ children?: ReactNode },
	{ error?: unknown }
> {
	override state: { error?: unknown } = {};
	static getDerivedStateFromError(error: unknown) {
		return { error };
	}
	override render() {
		return this.state.error
			? `Failed: ${(this.state.error as Error).message}`
			: this.props.children;
	}
}

test("useLoadPulse loads one ID in two scopes without sharing a wait or an error", async () => {
	const connector = createMemoryConnector();
	const a = track(note({ connectors: [connector], sessionId: 65538 }));
	await connectPulse(a).synced;
	const denied = {
		kind: "remote" as const,
		async open(): Promise<never> {
			throw new PulseError("FORBIDDEN", "denied", { retryable: false });
		},
	};
	const failing = { scope: createPulseScope(), connectors: [denied] };
	const working = {
		scope: createPulseScope(),
		connectors: [connector],
		sessionId: 65539,
	};
	type Options = typeof working | typeof failing;
	function Title({ options }: { options: Options }) {
		return useLoadPulse(Note, a.id, options as typeof working).title;
	}
	const load = (options: Options, key: string) =>
		h(
			Boundary,
			{ key },
			h(Suspense, { fallback: "Loading " }, h(Title, { options })),
		);
	const until = async (container: HTMLElement, text: string) => {
		for (let i = 0; i < 50 && container.textContent !== text; i++)
			await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
		expect(container.textContent).toBe(text);
	};
	const error = console.error;
	console.error = () => {};
	try {
		// The failing scope starts its load first.
		const both = render([load(failing, "failing"), load(working, "working")]);
		await until(both.container, "Failed: deniedDraft");
		track(working.scope.pulses.get(a.id) as NotePulse);
		// The failure reached its boundary; a render in a later task loads again.
		await act(() => new Promise((resolve) => setTimeout(resolve)));
		const again = render(load(failing, "again"));
		expect(again.container.textContent).toBe("Loading ");
		await until(again.container, "Failed: denied");
	} finally {
		console.error = error;
	}
});

test("useLoadPulse returns a pulse created already without suspending", () => {
	const created = track(
		createPulse(Note, { title: "Local", author: { name: "Ada" }, items: [] }),
	);
	function Title() {
		return useLoadPulse(Note, created.id).title;
	}
	const { container } = render(h(Suspense, { fallback: "Loading" }, h(Title)));
	expect(container.textContent).toBe("Local");
});

const Viewer = definePresence("viewer", object({ name: "string" }), {
	throttleMs: 0,
});

/** Two pulses of one document, each through its own session of one relay. */
async function peers() {
	const relay = new PulseRelay();
	const options = () => ({
		scope: createPulseScope(),
		connectors: [createMemoryConnector(relay)],
	});
	const mine = track(note(options()));
	await connectPulse(mine).synced;
	const theirs = track(
		await loadPulse(Note, mine.id, { ...options(), waitFor: "all" }),
	);
	return { mine, theirs };
}
/** Presence arrives from the relay later: wait inside act, then check. */
const settle = async (check: () => void) => {
	for (let i = 0; i < 100; i++) {
		await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
		try {
			return check();
		} catch {
			// Not there yet.
		}
	}
	check();
};

test("usePulsePresence joins on mount, shows the others and leaves on unmount", async () => {
	const { mine, theirs } = await peers();
	const remote = joinPresence(theirs, Viewer);
	remote.set({ name: "Grace" });
	let renders = 0;
	function Viewers() {
		renders++;
		const viewers = usePulsePresence(usePulse(mine), Viewer);
		useEffect(() => viewers.set({ name: "Ada" }), [viewers.set]);
		return `${viewers.mine?.name}:${viewers.others.map((other) => other.state.name)}`;
	}
	const { container, root } = render(h(Viewers));
	await settle(() => expect(container.textContent).toBe("Ada:Grace"));
	await settle(() =>
		expect(remote.others.map((other) => other.state.name)).toEqual(["Ada"]),
	);
	const before = renders;
	// The relay delivers it later, so act has to wait for it.
	await act(async () => {
		remote.set({ name: "Grace Hopper" });
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
	await settle(() => expect(container.textContent).toBe("Ada:Grace Hopper"));
	expect(renders).toBe(before + 1);
	// A change of the document does not re-render a component that reads presence only.
	act(() => {
		mine.title = "Other";
	});
	expect(renders).toBe(before + 1);
	act(() => root.unmount());
	await settle(() => expect(remote.others).toEqual([]));
});

test("usePulsePresence survives StrictMode and keeps a stable set", async () => {
	const { mine, theirs } = await peers();
	const remote = joinPresence(theirs, Viewer);
	const setters = new Set<unknown>();
	function Viewers() {
		const viewers = usePulsePresence(mine, Viewer);
		setters.add(viewers.set);
		useEffect(() => viewers.set({ name: "Ada" }), [viewers.set]);
		return viewers.mine?.name ?? "nobody";
	}
	const { container } = render(h(StrictMode, null, h(Viewers)));
	await settle(() => expect(container.textContent).toBe("Ada"));
	await settle(() => expect(remote.others).toHaveLength(1));
	expect(setters.size).toBe(1);
});

test("a state set by a child's effect, before the join, is not lost", async () => {
	const { mine, theirs } = await peers();
	const remote = joinPresence(theirs, Viewer);
	function Child({ set }: { set: (state: { name: string }) => void }) {
		useEffect(() => set({ name: "From a child" }), [set]);
		return null;
	}
	function Parent() {
		const viewers = usePulsePresence(mine, Viewer);
		return h(Child, { set: viewers.set });
	}
	render(h(Parent));
	await settle(() =>
		expect(remote.others.map((other) => other.state.name)).toEqual([
			"From a child",
		]),
	);
});

test("two components share a channel: the last one to unmount leaves it", async () => {
	const { mine, theirs } = await peers();
	const remote = joinPresence(theirs, Viewer);
	function Publisher() {
		const viewers = usePulsePresence(mine, Viewer);
		useEffect(() => viewers.set({ name: "Ada" }), [viewers.set]);
		return null;
	}
	function Reader() {
		return usePulsePresence(mine, Viewer).mine?.name ?? "nobody";
	}
	const reader = render(h(Reader));
	const publisher = render(h(Publisher));
	await settle(() => expect(reader.container.textContent).toBe("Ada"));
	await settle(() => expect(remote.others).toHaveLength(1));
	act(() => publisher.root.unmount());
	// The channel is still held: the state stays.
	await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
	expect(remote.others).toHaveLength(1);
	act(() => reader.root.unmount());
	await settle(() => expect(remote.others).toEqual([]));
});

test("switching the pulse never shows or publishes into the previous one", async () => {
	const first = await peers();
	const second = await peers();
	const remoteFirst = joinPresence(first.theirs, Viewer);
	const remoteSecond = joinPresence(second.theirs, Viewer);
	remoteFirst.set({ name: "In the first" });
	const reachedFirst: string[] = [];
	remoteFirst.subscribe(({ others }) =>
		reachedFirst.push(...others.map((other) => other.state.name)),
	);
	const shown: string[] = [];
	function Child({
		name,
		set,
	}: {
		name: string;
		set: (state: { name: string }) => void;
	}) {
		// A layout effect runs before the hook has joined the new channel.
		useLayoutEffect(() => set({ name }), [name, set]);
		return null;
	}
	function Viewers({ pulse, name }: { pulse: NotePulse; name: string }) {
		const viewers = usePulsePresence(pulse, Viewer);
		shown.push(
			`${name}:${viewers.mine?.name}:${viewers.others.map((other) => other.state.name)}`,
		);
		return h(Child, { name, set: viewers.set });
	}
	const { root } = render(h(Viewers, { pulse: first.mine, name: "one" }));
	await settle(() =>
		expect(remoteFirst.others.map((other) => other.state.name)).toEqual([
			"one",
		]),
	);
	shown.length = 0;
	await act(async () =>
		root.render(h(Viewers, { pulse: second.mine, name: "two" })),
	);
	// The first render for the second pulse shows nothing of the first one.
	expect(shown[0]).toBe("two:undefined:");
	await settle(() =>
		expect(remoteSecond.others.map((other) => other.state.name)).toEqual([
			"two",
		]),
	);
	// The first pulse was left, and never got the second one's state.
	expect(remoteFirst.others).toEqual([]);
	expect(reachedFirst).not.toContain("two");
	expect(shown.every((line) => !line.includes("In the first"))).toBe(true);
	expect(shown.every((line) => !line.startsWith("two:one"))).toBe(true);
});

test("usePulsePresence refuses to render on the server", () => {
	const doc = track(note());
	function Viewers() {
		return String(usePulsePresence(doc, Viewer).others.length);
	}
	expect(() => renderToString(h(Viewers))).toThrow("client only");
});

test("usePulse re-renders when a sub-pulse loads live or via ref.load()", async () => {
	const Card = definePulse("Card", object({ title: "string" })).materialize();
	const Board = definePulse(
		"Board",
		object({ cards: array(sub(Card)) }),
	).materialize();
	const connector = createMemoryConnector(new PulseRelay());
	const aBoard = track(
		createPulse(
			Board,
			{ id: "board-react", cards: [] },
			{ scope: createPulseScope(), connectors: [connector] },
		),
	);
	await connectPulse(aBoard).synced;

	const bBoard = track(
		await loadPulse(Board, "board-react", {
			scope: createPulseScope(),
			connectors: [connector],
			waitFor: "all",
		}),
	);
	const lazyBoard = track(
		await loadPulse(Board, "board-react", {
			scope: createPulseScope(),
			connectors: [connector],
			waitFor: "all",
			subPulses: false,
		}),
	);

	function View({ board }: { board: typeof bBoard }) {
		return usePulse(board)
			.cards.map((ref) => ref.pulse?.title ?? "...")
			.join(",");
	}
	const eager = render(h(View, { board: bBoard }));
	const lazy = render(h(View, { board: lazyBoard }));
	expect(eager.container.textContent).toBe("");
	expect(lazy.container.textContent).toBe("");

	const card = track(createPulse(Card, { title: "Hello" }, { parent: aBoard }));
	await connectPulse(card).synced;
	aBoard.cards.push(pulseRef(card));

	await settle(() => expect(eager.container.textContent).toBe("Hello"));
	await settle(() => expect(lazy.container.textContent).toBe("..."));

	await act(async () => {
		await lazyBoard.cards[0]!.load({ waitFor: "all" });
	});
	expect(lazy.container.textContent).toBe("Hello");
});

test("R6: rich text and tree change checks are O(1) on unrelated pulse edits", () => {
	const Article = definePulse(
		"PerfR6Article",
		object({
			title: "string",
			body: richText(),
			outline: tree(object({ label: "string" })),
		}),
	).materialize();

	const measure = (len: number) => {
		const doc = track(
			createPulse(
				Article,
				{ title: "0", body: "a".repeat(len), outline: {} },
				{ scope: createPulseScope() },
			),
		);
		const Body = memo(function Body({ body }: { body: RichText }) {
			return String(body.length);
		});
		function View() {
			const snap = usePulse(doc);
			return h(Body, { body: snap.body });
		}
		const { root } = render(h(View));
		const start = performance.now();
		act(() => {
			for (let i = 1; i <= 50; i++) doc.title = `t${i}`;
		});
		const elapsed = performance.now() - start;
		act(() => root.unmount());
		return elapsed;
	};

	const tSmall = measure(4_000);
	const tLarge = measure(16_000);
	expect(tLarge).toBeLessThan(Math.max(tSmall * 2.5, 15));

	// Mutating nested data inside a tree node still triggers re-render.
	const doc = track(
		createPulse(
			Article,
			{ title: "Draft", body: "Hi", outline: {} },
			{ scope: createPulseScope() },
		),
	);
	const node = doc.outline.createNode({ label: "First" });
	function OutlineView() {
		const snap = usePulse(doc);
		return snap.outline
			.roots()
			.map((n) => n.data.label)
			.join(",");
	}
	const { container } = render(h(OutlineView));
	expect(container.textContent).toBe("First");
	act(() => {
		node.data.label = "Renamed";
	});
	expect(container.textContent).toBe("Renamed");
});

test("a memoized child stays reactive when its parent starts reading a new key of the same object", () => {
	const doc = track(note());
	let rows = 0;
	const Row = memo(function Row({
		item,
	}: {
		item: NotePulse["items"][number];
	}) {
		rows++;
		return item.label;
	});
	function List({ showDone }: { showDone: boolean }) {
		const item = usePulse(doc).items[0]!;
		// The parent reads a key it never read before; the skipped row read another one.
		return [showDone ? String(item.done) : "", h(Row, { key: "row", item })];
	}
	const { root, container } = render(h(List, { showDone: false }));
	act(() => root.render(h(List, { showDone: true })));
	const before = rows;
	act(() => {
		doc.items[0]!.label = "Renamed";
	});
	expect(rows).toBeGreaterThan(before);
	expect(container.textContent).toContain("Renamed");
});
