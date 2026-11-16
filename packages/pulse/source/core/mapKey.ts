import type { MapKeySchema } from "@gin-quin/codec";
import { assertKey } from "./values.js";

/**
 * A `map(key, value)` key. The model, the operations and the stored rows only
 * know string keys, so a typed key lives under its canonical string: the one
 * spelling `encode` produces. `decode` rejects every other spelling, so two
 * strings can never name the same key.
 */
export interface MapKey {
	/** The key schema, which enters the schema fingerprint. */
	readonly kind: string;
	/** A public key to its canonical string; throws on a key of another type. */
	encode(key: unknown): string;
	/** A canonical string to its public key; throws on any other string. */
	decode(text: string): unknown;
	/** The iteration order of a map: ascending keys, the same on every peer. */
	compare(left: any, right: any): number;
}

const fail = (key: unknown, kind: string): never => {
	throw new TypeError(`${String(key)} is not a valid ${kind} map key`);
};
const byOrder = (left: any, right: any) =>
	left < right ? -1 : left > right ? 1 : 0;

function numberKey(kind: string, valid: (key: number) => boolean): MapKey {
	return {
		kind,
		encode: (key) =>
			typeof key === "number" && valid(key)
				? // -0 and 0 are one Map key, and one string.
					String(key === 0 ? 0 : key)
				: fail(key, kind),
		decode(text) {
			const key = Number(text);
			return String(key) === text && valid(key) ? key : fail(text, kind);
		},
		compare: (left: number, right: number) => left - right,
	};
}

const keys: Record<string, MapKey> = {
	string: {
		kind: "string",
		encode: (key) => (assertKey(key as PropertyKey), key as string),
		decode: (text) => (assertKey(text), text),
		compare: byOrder,
	},
	boolean: {
		kind: "boolean",
		encode: (key) =>
			typeof key === "boolean" ? String(key) : fail(key, "boolean"),
		decode: (text) =>
			text === "true" || (text === "false" ? false : fail(text, "boolean")),
		compare: byOrder,
	},
	bigint: {
		kind: "bigint",
		encode: (key) =>
			typeof key === "bigint" ? String(key) : fail(key, "bigint"),
		decode: (text) =>
			/^(0|-?[1-9][0-9]*)$/.test(text) ? BigInt(text) : fail(text, "bigint"),
		compare: byOrder,
	},
	float64: numberKey("float64", Number.isFinite),
};
for (const kind of ["int", "int32", "int64"])
	keys[kind] = numberKey(kind, Number.isSafeInteger);
for (const kind of ["uint", "uint32", "uint64"])
	keys[kind] = numberKey(kind, (key) => Number.isSafeInteger(key) && key >= 0);

export function mapKey(schema: MapKeySchema): MapKey {
	return keys[typeof schema === "string" ? schema : schema._type]!;
}

/** The entries of a stored map as `[key, canonical string]`, in key order. */
export function mapEntries(
	key: MapKey,
	data: Record<string, unknown>,
): [unknown, string][] {
	const entries = Object.keys(data).map((text): [unknown, string] => [
		key.decode(text),
		text,
	]);
	return entries.sort((left, right) => key.compare(left[0], right[0]));
}
