import { expect, test } from "bun:test";
import { object, union } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
for (const branch of ["leaf", "object", "union"] as const)
	test(`constant ${branch} preserves an already-rounded negative float32 zero`, () => {
		const schema = object({
			fixed:
				branch === "leaf"
					? "float32"
					: branch === "object"
						? object({ value: "float32" })
						: union(["float32", "boolean"]),
		});
		const definition = definePulse("ConstantF32", schema, {
			constantPaths: [["fixed"]],
		}).materialize();
		const source = createPulse(
			definition,
			{ fixed: branch === "object" ? { value: -1e-50 } : -1e-50 } as never,
			options(65536),
		);
		const target = createRuntime(definition, source.id, options(65537));
		try {
			getPulseMeta(target).applyRows(getPulseMeta(source).log.missing([]));
			expect(snapshotPulse(target)).toEqual(snapshotPulse(source));
			const a: any = snapshotPulse(source)["fixed"],
				b: any = snapshotPulse(target)["fixed"];
			expect(Object.is(typeof a === "object" ? a.value : a, -0)).toBe(true);
			expect(Object.is(typeof b === "object" ? b.value : b, -0)).toBe(true);
		} finally {
			destroyPulse(source);
			destroyPulse(target);
		}
	});
