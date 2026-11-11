import {
	map,
	object,
	type MapSchema,
	type ObjectSchema,
	type Schema,
} from "@gin-quin/codec";
import { assertKey } from "./values.js";
import { isFractionalPosition } from "./fractionalPosition.js";

export const TreeSchemaSymbol: unique symbol = Symbol("TreeSchema");
export const TreeSymbol: unique symbol = Symbol("Tree");
const TreeNodeSchemaSymbol = Symbol("TreeNodeSchema");
const TreeLocationSchemaSymbol = Symbol("TreeLocationSchema");

/** Codec stores a flat map so reparenting never replaces a node's data. */
export type TreeData<Item> = Record<
	string,
	{
		data: Item;
		location: { parent: string; position: string };
		deleted: boolean;
	}
>;

/** How a tree of `S` is stored: a flat map of nodes keyed by ID. */
export type TreeStorageSchema<S extends Schema> = MapSchema<
	ObjectSchema<{
		data: S;
		location: ObjectSchema<{ parent: "string"; position: "string" }>;
		deleted: "boolean";
	}>
>;

function storage<S extends Schema>(element: S): TreeStorageSchema<S> {
	return map(
		Object.assign(
			object({
				data: element,
				location: Object.assign(
					object({ parent: "string", position: "string" }),
					{ [TreeLocationSchemaSymbol]: true },
				),
				deleted: "boolean",
			}),
			{ [TreeNodeSchemaSymbol]: true },
		),
	);
}

export type TreeSchema<S extends Schema = Schema> =
	(() => TreeStorageSchema<S>) & {
		readonly [TreeSchemaSymbol]: S;
	};

/** Declare a collaborative, ordered tree of values matching `element`. Initialize with `{}`. */
export function tree<S extends Schema>(element: S): TreeSchema<S> {
	const schema = storage(element);
	return Object.freeze(
		Object.assign(() => schema, { [TreeSchemaSymbol]: element }),
	);
}

export function treeSchemaRole(
	schema: Schema,
): "tree" | "node" | "location" | undefined {
	const seen = new Set<Schema>();
	while (!seen.has(schema)) {
		seen.add(schema);
		if (typeof schema === "function") {
			if (Object.hasOwn(schema, TreeSchemaSymbol)) return "tree";
			schema = schema();
		} else if (typeof schema === "object") {
			if (Object.hasOwn(schema, TreeNodeSchemaSymbol)) return "node";
			if (Object.hasOwn(schema, TreeLocationSchemaSymbol)) return "location";
			if (schema._type === "optional") schema = schema.schema;
			else return undefined;
		} else return undefined;
	}
	return undefined;
}

/** Structural metadata is validated in both compiled preparation and remote preflight. */
export function assertTreeStructure(
	value: unknown,
	role: "tree" | "node" | "location",
): void {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("Invalid tree structure");
	if (role === "location") {
		const location = value as TreeData<unknown>[string]["location"];
		if (
			typeof location.parent !== "string" ||
			!isFractionalPosition(location.position)
		)
			throw new TypeError("Invalid tree location");
		if (location.parent) assertKey(location.parent);
	} else if (role === "node") {
		const record = value as TreeData<unknown>[string];
		assertTreeStructure(record.location, "location");
		if (typeof record.deleted !== "boolean")
			throw new TypeError("Invalid tree deletion flag");
	} else {
		const positions = new Set<string>();
		for (const [id, record] of Object.entries(value)) {
			assertKey(id);
			if (!id) throw new TypeError("Tree IDs cannot be empty");
			assertTreeStructure(record, "node");
			const location = (record as TreeData<unknown>[string]).location;
			const key = location.position;
			if (positions.has(key))
				throw new TypeError("Tree nodes must have distinct positions");
			positions.add(key);
		}
	}
}
