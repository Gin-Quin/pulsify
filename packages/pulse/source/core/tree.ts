import type { CoreNode } from "./model.js";
import { TreeSymbol, type TreeData } from "./treeSchema.js";
import { positionBetween } from "./fractionalPosition.js";
import { pulsify, type Pulsify } from "../utilities/pulsify.js";
import type { ProxyContext } from "../pulses/ProxyContext.js";
import type { PulseSnapshot } from "../pulses/Pulse.js";
import type { InitialValue } from "../pulses/createPulse.js";

export type TreeJSONNode<Item> = {
	id: string;
	data: Item;
	children: TreeJSONNode<Item>[];
};
export interface Tree<Item> {
	readonly [TreeSymbol]: true;
	createNode(
		data: InitialValue<Item>,
		parent?: TreeNode<Item>,
		index?: number,
	): TreeNode<Item>;
	getNode(id: string): TreeNode<Item> | undefined;
	roots(): TreeNode<Item>[];
	nodes(): TreeNode<Item>[];
	toJSON(): TreeJSONNode<PulseSnapshot<Item>>[];
	snapshot(): TreeData<PulseSnapshot<Item>>;
}
export interface TreeNode<Item> {
	readonly id: string;
	get data(): Pulsify<Item>;
	set data(value: InitialValue<Item> | Pulsify<Item>);
	parent(): TreeNode<Item> | undefined;
	children(): TreeNode<Item>[];
	index(): number;
	createNode(data: InitialValue<Item>, index?: number): TreeNode<Item>;
	move(parent?: TreeNode<Item>, index?: number): void;
	moveBefore(sibling: TreeNode<Item>): void;
	moveAfter(sibling: TreeNode<Item>): void;
	delete(): void;
}

/** Tree structure is a projection of independent, atomic LWW location registers. */
export function createTreeProxy(
	node: CoreNode,
	context: ProxyContext,
): Tree<unknown> {
	const model = context.meta.model;
	const cached = new Map<string, TreeNode<unknown>>();
	const owners = new WeakMap<TreeNode<unknown>, string>();
	const attached = () => {
		context.assertActive();
		if (!model.isAttached(node))
			throw new TypeError("This pulse tree has been replaced or removed");
	};
	const records = () => node.data as TreeData<unknown>;
	const structure = () => {
		attached();
		const data = records();
		const parents = new Map<string, string>();
		for (const id of Object.keys(data).sort()) {
			const parent = data[id]!.location.parent;
			parents.set(id, Object.hasOwn(data, parent) ? parent : "");
		}
		// A concurrent cycle is broken at its lexicographically smallest node ID.
		// Compute from raw registers every time, so delivery order cannot affect it.
		const done = new Set<string>();
		for (const id of parents.keys()) {
			const path: string[] = [],
				offsets = new Map<string, number>();
			let current = id;
			while (current && !done.has(current)) {
				const offset = offsets.get(current);
				if (offset !== undefined) {
					parents.set(path.slice(offset).sort()[0]!, "");
					break;
				}
				offsets.set(current, path.length);
				path.push(current);
				current = parents.get(current)!;
			}
			for (const item of path) done.add(item);
		}
		const visible = new Set<string>();
		const hidden = new Set<string>();
		for (const id of parents.keys()) {
			const path: string[] = [];
			let current = id;
			while (current && !visible.has(current) && !hidden.has(current)) {
				path.push(current);
				if (data[current]!.deleted) {
					hidden.add(current);
					break;
				}
				current = parents.get(current)!;
			}
			const target = hidden.has(current) ? hidden : visible;
			for (const item of path) target.add(item);
		}
		const children = new Map<string, string[]>();
		for (const id of visible) {
			const parent = parents.get(id)!;
			let siblings = children.get(parent);
			if (!siblings) children.set(parent, (siblings = []));
			siblings.push(id);
		}
		for (const siblings of children.values())
			siblings.sort((a, b) => {
				const x = data[a]!.location.position,
					y = data[b]!.location.position;
				return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
			});
		return { parents, visible, children };
	};
	const active = (id: string) => {
		if (!structure().visible.has(id))
			throw new TypeError("This tree node has been deleted or hidden");
		return node.child(id)!;
	};
	const owner = (item: TreeNode<unknown> | undefined): string => {
		if (item === undefined) return "";
		const id = owners.get(item);
		if (!id) throw new TypeError("Tree nodes must belong to the same tree");
		active(id);
		return id;
	};
	const location = (
		parent: string,
		index: number | undefined,
		exclude?: string,
	) => {
		const siblings = (structure().children.get(parent) ?? []).filter(
			(id) => id !== exclude,
		);
		const at = index ?? siblings.length;
		if (!Number.isSafeInteger(at) || at < 0 || at > siblings.length)
			throw new RangeError("Invalid tree index");
		const data = records();
		const unique =
			model.sid.toString(16).padStart(14, "0") +
			model.nextClock.toString(16).padStart(14, "0");
		const left = at ? data[siblings[at - 1]!]!.location.position : undefined;
		const right =
			at < siblings.length ? data[siblings[at]!]!.location.position : undefined;
		const used = new Set(
			Object.values(data).map((record) => record.location.position),
		);
		let position = positionBetween(left, right, unique),
			nonce = 0;
		// Restored snapshots can contain ranks minted with this new document's clocks.
		while (used.has(position))
			position = positionBetween(
				left,
				right,
				(++nonce).toString(16).padStart(8, "0") + unique,
			);
		return { parent, position };
	};
	const create = (
		data: unknown,
		parent?: TreeNode<unknown>,
		index?: number,
	) => {
		attached();
		const parentId = owner(parent);
		const base = `n${model.sid}:${model.nextClock}`;
		let id = base,
			suffix = 0;
		while (Object.hasOwn(records(), id)) id = `${base}:${++suffix}`;
		model.set(node, id, {
			data,
			location: location(parentId, index),
			deleted: false,
		});
		return get(id);
	};
	const get = (id: string): TreeNode<unknown> => {
		let item = cached.get(id);
		if (item) return item;
		const move = (parent?: TreeNode<unknown>, index?: number) => {
			const record = active(id);
			const parentId = owner(parent);
			const state = structure();
			for (
				let ancestor = parentId;
				ancestor;
				ancestor = state.parents.get(ancestor)!
			)
				if (ancestor === id)
					throw new TypeError("A tree node cannot move into its own subtree");
			const next = location(parentId, index, id);
			const siblings = state.children.get(parentId) ?? [];
			const current = siblings.indexOf(id);
			const final = index ?? siblings.filter((key) => key !== id).length;
			if (
				records()[id]!.location.parent === parentId &&
				state.parents.get(id) === parentId &&
				current === final
			)
				return;
			model.set(record, "location", next);
		};
		const moveRelative = (sibling: TreeNode<unknown>, offset: number) => {
			active(id);
			const siblingId = owner(sibling);
			if (siblingId === id) return;
			const state = structure();
			const parent = state.parents.get(siblingId)!;
			const siblings = state.children.get(parent)!.filter((key) => key !== id);
			move(
				parent ? get(parent) : undefined,
				siblings.indexOf(siblingId) + offset,
			);
		};
		const dataContext: ProxyContext = {
			meta: context.meta,
			assertActive() {
				active(id);
			},
		};
		item = Object.freeze({
			id,
			get data() {
				const record = active(id);
				return pulsify(record.data.data, record.child("data"), dataContext);
			},
			set data(value: unknown) {
				model.set(active(id), "data", value);
			},
			parent() {
				active(id);
				const parent = structure().parents.get(id)!;
				return parent ? get(parent) : undefined;
			},
			children() {
				active(id);
				return (structure().children.get(id) ?? []).map(get);
			},
			index() {
				active(id);
				const state = structure();
				return state.children.get(state.parents.get(id)!)!.indexOf(id);
			},
			createNode: (data: unknown, index?: number) =>
				create(data, get(id), index),
			move,
			moveBefore: (sibling: TreeNode<unknown>) => moveRelative(sibling, 0),
			moveAfter: (sibling: TreeNode<unknown>) => moveRelative(sibling, 1),
			delete() {
				model.set(active(id), "deleted", true);
			},
		});
		cached.set(id, item);
		owners.set(item, id);
		return item;
	};
	return Object.freeze({
		[TreeSymbol]: true as const,
		createNode: create,
		getNode(id: string) {
			return structure().visible.has(id) ? get(id) : undefined;
		},
		roots() {
			return (structure().children.get("") ?? []).map(get);
		},
		nodes() {
			return [...structure().visible].map(get);
		},
		snapshot() {
			attached();
			return structuredClone(records());
		},
		toJSON() {
			const state = structure();
			const output = new Map<string, TreeJSONNode<unknown>>();
			for (const id of state.visible)
				output.set(id, {
					id,
					data: structuredClone(records()[id]!.data),
					children: [],
				});
			for (const [parent, children] of state.children)
				if (parent)
					output.get(parent)!.children = children.map((id) => output.get(id)!);
			return (state.children.get("") ?? []).map((id) => output.get(id)!);
		},
	});
}
