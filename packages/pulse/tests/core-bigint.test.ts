import { expect, test } from "bun:test";
import { bigint, object } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
	type PulseProperties,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
for (const typed of [false, true])
	test(`bigint primitives ${typed ? "typed" : "legacy"} retain exact values through binary sync`, () => {
		type Data = PulseProperties<"BigInt"> & {
			value: bigint;
			nested: { count: bigint };
		};
		const schema = object({
			value: bigint(256),
			nested: object({ count: bigint(256) }),
		});
		const definition = typed
			? definePulse("BigInt", schema).materialize()
			: definePulse<Data>("BigInt").materialize();
		const source = createPulse(
			definition,
			{
				value: (1n << 200n) + 123n,
				nested: { count: -123456789012345678901234567890n },
			},
			options(65536),
		);
		const target = createRuntime(definition, source.id, options(65537));
		try {
			getPulseMeta(target).applyRows(getPulseMeta(source).log.missing([]));
			expect(snapshotPulse(target)).toEqual(snapshotPulse(source));
			source.value = -(1n << 300n);
			source.nested.count = (1n << 500n) + 789n;
			getPulseMeta(target).applyRows(
				getPulseMeta(source).log.missing(getPulseMeta(target).log.vector),
			);
			expect(snapshotPulse(target)).toEqual(snapshotPulse(source));
		} finally {
			destroyPulse(source);
			destroyPulse(target);
		}
	});
test("typed bigint bounds reject before state or journal advances", () => {
	const definition = definePulse(
		"BoundedBigInt",
		object({ value: bigint(1) }),
	).materialize();
	const pulse = createPulse(definition, { value: 1n }, options(65536));
	try {
		const vector = getPulseMeta(pulse).log.vector;
		expect(() => {
			pulse.value = 1n << 100n;
		}).toThrow();
		expect(pulse.value).toBe(1n);
		expect(getPulseMeta(pulse).log.vector).toEqual(vector);
	} finally {
		destroyPulse(pulse);
	}
});
