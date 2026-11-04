import { describe, expect, test } from "bun:test";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
	subscribePulse,
	struct,
	tuple,
	type PulseProperties,
} from "../source/index";
import { Document, data, options } from "./helpers";

describe("local document API", () => {
	test("local mutations keep every view and model consistent", () => {
		const pulse = createPulse(Document, data(), options());
		const nested = pulse.nested;
		expect(pulse.nested).toBe(nested);
		pulse.nested.count = 10;
		pulse.title = "Updated";
		pulse.nested = { count: 11 };
		pulse.nested.count++;
		pulse.items.push({ value: 3 });
		pulse.items[2]!.value = 4;
		pulse.optional = "yes";
		delete pulse.optional;
		expect(getPulseMeta(pulse).model.view()).toEqual(snapshotPulse(pulse));
		expect(pulse.nested.count).toBe(12);
		expect(pulse.items[2]!.value).toBe(4);
		expect("optional" in pulse).toBe(false);
		expect(() => nested.count).toThrow("replaced or removed");
	});
	test("array mutations agree with native arrays", () => {
		type Numbers = PulseProperties<"Numbers"> & { items: number[] };
		const Numbers = definePulse<Numbers>("Numbers").materialize();
		const pulse = createPulse(Numbers, { items: [3, 1, 2] }, options());
		const expected = [3, 1, 2];
		const check = () => {
			expect(Array.from(pulse.items)).toEqual(expected);
			expect(getPulseMeta(pulse).model.view()).toEqual(snapshotPulse(pulse));
		};
		expect(pulse.items.unshift(9, 8)).toBe(expected.unshift(9, 8));
		check();
		expect(pulse.items.pop()).toBe(expected.pop());
		check();
		expect(pulse.items.shift()).toBe(expected.shift());
		check();
		expect(pulse.items.splice(-2, 1, 7, 6)).toEqual(
			expected.splice(-2, 1, 7, 6),
		);
		check();
		expect(pulse.items.splice(100, 1, 5)).toEqual(expected.splice(100, 1, 5));
		check();
		pulse.items.sort((a, b) => a - b);
		expected.sort((a, b) => a - b);
		check();
		pulse.items.reverse();
		expected.reverse();
		check();
		pulse.items.copyWithin(1, 0, 2);
		expected.copyWithin(1, 0, 2);
		check();
		pulse.items.fill(7, -2);
		expected.fill(7, -2);
		check();
		pulse.items[0] = 4;
		expected[0] = 4;
		check();
		pulse.items[pulse.items.length] = 8;
		expected[expected.length] = 8;
		check();
		pulse.items.length = 2;
		expected.length = 2;
		check();
		expect(pulse.items.map((n) => n + 1)).toEqual(expected.map((n) => n + 1));
		expect(Object.keys(pulse.items)).toEqual(["0", "1"]);
		pulse.items.replaceAll([1, 2, 3]);
		expect([...pulse.items]).toEqual([1, 2, 3]);
		expect(pulse.items.splice(1)).toEqual([2, 3]);
		expect((pulse.items.splice as any)()).toEqual([]);
		expect([...pulse.items]).toEqual([1]);
	});
	test("invalid changes are rejected before the model or history changes", () => {
		const pulse = createPulse(Document, data(), options());
		const before = snapshotPulse(pulse);
		const size = getPulseMeta(pulse).log.size;
		for (const mutate of [
			() => {
				(pulse as any).id = "other";
			},
			() => {
				(pulse as any).version = 0;
			},
			() => {
				pulse.items.length = 100;
			},
			() => {
				pulse.items[100] = { value: 1 };
			},
			() => {
				pulse.nested.count = Number.NaN;
			},
			() => {
				(pulse as any).nested = new Date();
			},
			() => {
				const cyclic: any = {};
				cyclic.self = cyclic;
				pulse.nested = cyclic;
			},
			() => {
				Object.defineProperty(pulse, "title", { value: "wrong" });
			},
			() => {
				(pulse as any).__proto__ = {};
			},
			() => {
				pulse.items.splice(0, 2, { value: Number.NaN });
			},
		]) {
			expect(mutate).toThrow();
			expect(snapshotPulse(pulse)).toEqual(before);
			expect(getPulseMeta(pulse).log.size).toBe(size);
		}
	});
	test("identity maps return the materialized pulse and isolate clients", () => {
		const config = options();
		const input = data();
		const a = createPulse(Document, input, config);
		expect(createPulse(Document, input, config)).toBe(a);
		expect(createPulse(Document, input, options())).not.toBe(a);
		expect(() =>
			createPulse(
				definePulse<Document>("Document").materialize(),
				input,
				config,
			),
		).toThrow();
	});
	test("subscriptions observe committed changes and destruction releases resources", () => {
		const scope = createPulseScope();
		const pulse = createPulse(Document, data(), { scope });
		const seen: number[] = [];
		const stop = subscribePulse(pulse, (value) =>
			seen.push(value.nested.count),
		);
		pulse.nested.count = 1;
		stop();
		pulse.nested.count = 2;
		expect(seen).toEqual([0, 1]);
		destroyPulse(pulse);
		destroyPulse(pulse);
		expect(scope.pulses.size).toBe(0);
		expect(() => {
			pulse.nested.count = 3;
		}).toThrow();
		expect(() => subscribePulse(pulse, () => {})).toThrow();
	});
	test("tuple and struct constants cannot be mutated through a view", () => {
		type Constants = PulseProperties<"Constants"> & {
			pair: ReturnType<typeof tuple<[number, string]>>;
			fixed: ReturnType<typeof struct<{ x: number }>>;
		};
		const Definition = definePulse<Constants>("Constants").materialize();
		const pulse = createPulse(
			Definition,
			{ pair: tuple([1, "x"]), fixed: struct({ x: 2 }) },
			options(),
		);
		expect(() => {
			(pulse.pair as any)[0] = 2;
		}).toThrow();
		expect(() => {
			(pulse.fixed as any).x = 3;
		}).toThrow();
		expect(getPulseMeta(pulse).model.view()).toEqual(snapshotPulse(pulse));
	});
});
