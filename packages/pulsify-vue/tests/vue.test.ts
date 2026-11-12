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
import { effectScope, watchEffect } from "vue";
import { checkPulseViews } from "../../pulse/tests/pulseViewScenario";
import {
	createReactivePulse,
	loadReactivePulse,
	reactivePulse,
	usePulsePresence,
} from "../source/index";

test("reactivePulse tracks reads and writes to the pulse", () =>
	checkPulseViews(reactivePulse, (run) => {
		watchEffect(run, { flush: "sync" });
	}));

const Note = definePulse("Note", object({ title: "string" })).materialize();

test("createReactivePulse and loadReactivePulse return tracked views", async () => {
	const connector = createMemoryConnector();
	const options = { scope: createPulseScope(), connectors: [connector] };
	const created = createReactivePulse(Note, { title: "Draft" }, options);
	expect(reactivePulse(created)).toBe(created);
	await connectPulse(created).synced;
	const loaded = await loadReactivePulse(Note, created.id, {
		...options,
		scope: createPulseScope(),
		sessionId: 65540,
	});
	expect(reactivePulse(loaded)).toBe(loaded);

	const seen: string[] = [];
	watchEffect(() => void seen.push(`${created.title}/${loaded.title}`), {
		flush: "sync",
	});
	expect(seen).toEqual(["Draft/Draft"]);
	created.title = "Ready";
	for (let i = 0; i < 50 && seen.at(-1) !== "Ready/Ready"; i++)
		await new Promise((resolve) => setTimeout(resolve, 5));
	expect(seen.at(-1)).toBe("Ready/Ready");
});

const Viewer = definePresence("viewer", object({ name: "string" }), {
	throttleMs: 0,
});

test("usePulsePresence tracks others and mine, and leaves with its scope", async () => {
	const relay = new PulseRelay();
	const options = () => ({
		scope: createPulseScope(),
		connectors: [createMemoryConnector(relay)],
	});
	const mine = createReactivePulse(Note, { title: "Draft" }, options());
	await connectPulse(mine).synced;
	const theirs = await loadReactivePulse(Note, mine.id, {
		...options(),
		waitFor: "all",
	});
	const remote = joinPresence(theirs, Viewer);
	remote.set({ name: "Grace" });

	const scope = effectScope();
	const seen: string[] = [];
	const viewers = scope.run(() => {
		const viewers = usePulsePresence(mine, Viewer);
		watchEffect(
			() =>
				void seen.push(
					`${viewers.mine?.name}:${viewers.others.map((other) => other.state.name)}`,
				),
			{ flush: "sync" },
		);
		return viewers;
	})!;
	const wait = async (check: () => void) => {
		for (let i = 0; i < 100; i++) {
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
	expect(seen.at(-1)).toBe("Ada:Grace");
	await wait(() =>
		expect(remote.others.map((other) => other.state.name)).toEqual(["Ada"]),
	);
	const before = viewers.others;
	expect(viewers.others).toBe(before);
	// Leaving by hand, while the effect is alive, shows in what it reads.
	viewers.leave();
	expect(seen.at(-1)).toBe("undefined:");
	await wait(() => expect(remote.others).toEqual([]));
	scope.stop();
	expect(viewers.others).toEqual([]);

	// Without a manual leave, the scope does it.
	const other = effectScope();
	other.run(() => usePulsePresence(mine, Viewer).set({ name: "Again" }));
	await wait(() => expect(remote.others).toHaveLength(1));
	other.stop();
	await wait(() => expect(remote.others).toEqual([]));
});
