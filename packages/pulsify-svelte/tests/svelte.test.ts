import { expect, test } from "bun:test";
import { object } from "@gin-quin/codec";
import {
	connectPulse,
	createMemoryConnector,
	createPulseScope,
	definePresence,
	definePulse,
	joinPresence,
	PulseRelay,
} from "pulsify-core";
import { flushSync } from "svelte";
// What `$effect.root` and `$effect` compile to: a test file has no compiler.
// @ts-expect-error Svelte ships no types for its compiled-code runtime.
import { effect_root, user_effect } from "svelte/internal/client";
import { checkPulseViews } from "../../pulse/tests/pulseViewScenario";
import {
	createSveltePulse,
	loadSveltePulse,
	SveltePresence,
	SveltePulse,
} from "../source/index";

// Run with `--conditions browser`: Svelte's server build is not reactive.
test("SveltePulse tracks reads and writes to the pulse", () =>
	checkPulseViews(
		(pulse) => new SveltePulse(pulse),
		(run) => {
			effect_root(() => user_effect(run));
		},
		flushSync,
	));

const Note = definePulse("Note", object({ title: "string" })).materialize();

test("createSveltePulse and loadSveltePulse return tracked views", async () => {
	const connector = createMemoryConnector();
	const options = { scope: createPulseScope(), connectors: [connector] };
	const created = createSveltePulse(Note, { title: "Draft" }, options);
	expect(new SveltePulse(created)).toBe(created);
	await connectPulse(created).synced;
	const loaded = await loadSveltePulse(Note, created.id, {
		...options,
		scope: createPulseScope(),
		sessionId: 65540,
	});
	expect(new SveltePulse(loaded)).toBe(loaded);

	const seen: string[] = [];
	effect_root(() =>
		user_effect(() => void seen.push(`${created.title}/${loaded.title}`)),
	);
	flushSync();
	expect(seen).toEqual(["Draft/Draft"]);
	created.title = "Ready";
	for (let i = 0; i < 50 && seen.at(-1) !== "Ready/Ready"; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		flushSync();
	}
	expect(seen.at(-1)).toBe("Ready/Ready");
});

const Viewer = definePresence("viewer", object({ name: "string" }), {
	throttleMs: 0,
});

test("SveltePresence tracks others and mine, and leaves on demand", async () => {
	const relay = new PulseRelay();
	const options = () => ({
		scope: createPulseScope(),
		connectors: [createMemoryConnector(relay)],
	});
	const mine = createSveltePulse(Note, { title: "Draft" }, options());
	await connectPulse(mine).synced;
	const theirs = await loadSveltePulse(Note, mine.id, {
		...options(),
		waitFor: "all",
	});
	const remote = joinPresence(theirs, Viewer);
	remote.set({ name: "Grace" });

	// Outside a component: nothing leaves for us.
	const viewers = new SveltePresence(mine, Viewer);
	const seen: string[] = [];
	effect_root(() =>
		user_effect(
			() =>
				void seen.push(
					`${viewers.mine?.name}:${viewers.others.map((other) => other.state.name)}`,
				),
		),
	);
	const wait = async (check: () => void) => {
		for (let i = 0; i < 100; i++) {
			flushSync();
			try {
				return check();
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		}
		check();
	};
	await wait(() => expect(seen.at(-1)).toBe("undefined:Grace"));
	viewers.set({ name: "Ada" });
	await wait(() => expect(seen.at(-1)).toBe("Ada:Grace"));
	await wait(() =>
		expect(remote.others.map((other) => other.state.name)).toEqual(["Ada"]),
	);
	// Leaving while the effect is alive shows in what it reads.
	viewers.leave();
	await wait(() => expect(seen.at(-1)).toBe("undefined:"));
	await wait(() => expect(remote.others).toEqual([]));
	expect(viewers.others).toEqual([]);
});
