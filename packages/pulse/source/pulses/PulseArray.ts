import { me } from "../values/me";
import { BasePulse, type PulseProperties } from "./BasePulse";
import { findLeftRightEvents } from "../functions/findLeftRightEvents";
import type { Update } from "../types/Update";
import type { Entry } from "../types/Entry";
import { assimilateUpdate } from "pulse/types/State";

export class PulseArray<Item> extends BasePulse<Array<Item>, Item> {
	/**
	 * Memoized value of the array.
	 */
	private memoizedValue: Array<Item> = [];

	/**
	 * Whether the memoized value is dirty and needs to be recalculated.
	 */
	private dirty = false;

	/**
	 * State of the array.
	 */
	state = Array<Entry<Item>>();

	/**
	 * Get current value of the array.
	 */
	get value(): Array<Item> {
		if (this.dirty) {
			this.memoizedValue = this.state.flatMap((entry) => entry.content);
			this.dirty = false;
		}
		return this.memoizedValue;
	}

	/**
	 * Get length of the array.
	 */
	get length(): number {
		return this.value.length;
	}

	constructor(content: Array<Item> = [], properties: PulseProperties = {}) {
		super(properties);
		if (content.length > 0) {
			this.state = [
				{
					actor: me,
					clock: 0n,
					content,
				},
			];
			this.stateVector.set(me, BigInt(content.length));
			this.memoizedValue = content;
		}

		// biome-ignore lint: We have to use a proxy to handle the array indexing.
		return new Proxy(this, {
			get: (target, prop) => {
				if (
					typeof prop === "number" ||
					(typeof prop === "string" && !Number.isNaN(Number(prop)))
				) {
					return target.value[Number(prop)];
				}
				return target[prop as keyof typeof target];
			},
			set: (target, prop, value) => {
				if (
					typeof prop === "number" ||
					(typeof prop === "string" && !Number.isNaN(Number(prop)))
				) {
					target.value[Number(prop)] = value;
				} else {
					target[prop as keyof typeof target] = value;
				}
				return true;
			},
		});
	}

	/* -------------------------------------------------------------------------- */
	/*                              Abstract methods                              */
	/* -------------------------------------------------------------------------- */

	assimilateUpdate(update: Update<Item>): boolean {
		return assimilateUpdate(this.state, update);
	}

	/* -------------------------------------------------------------------------- */
	/*                              Mutation methods                              */
	/* -------------------------------------------------------------------------- */

	insert(index: number, values: Array<Item>): number {
		const finalLength = this.length + values.length;
		const { left, right } = findLeftRightEvents(this.state, index);
		const update: Update<Item> = {
			actor: me,
			clock: this.stateVector.get(me) ?? 0n,
			content: values,
			left,
			right,
		};
		this.applyUpdate(update);
		this.dirty = true;
		return finalLength;
	}

	push(...values: Array<Item>): number {
		const finalLength = this.length + values.length;
		const lastEntry = this.state[this.state.length - 1];
		const left = lastEntry && {
			actor: lastEntry.actor,
			clock: lastEntry.clock + BigInt(lastEntry.content.length) - 1n,
		};
		const update: Update<Item> = {
			actor: me,
			clock: this.stateVector.get(me) ?? 0n,
			content: values,
			left,
		};
		this.applyUpdate(update);
		this.dirty = true;
		return finalLength;
	}

	delete(index: number, count = 1): this {
		if (count === 0) return this;
		console.warn("TODO: PulseArray::delete");
		return this;
	}

	splice(index: number, deleteCount = 1, ...values: Array<Item>): Array<Item> {
		const deletedElements = this.value.slice(index, index + deleteCount);
		this.delete(index, deleteCount);
		this.insert(index, values);
		return deletedElements;
	}

	pop() {
		const lastItem = this.value.at(-1);
		this.delete(this.state.length - 1);
		return lastItem;
	}

	shift() {
		const firstItem = this.value.at(0);
		this.delete(0, 1);
		return firstItem;
	}

	unshift(...values: Array<Item>): number {
		return this.insert(0, values);
	}

	/* -------------------------------------------------------------------------- */
	/*                                Array methods                               */
	/* -------------------------------------------------------------------------- */

	get forEach() {
		return this.value.forEach;
	}

	get map() {
		return this.value.map;
	}

	get filter() {
		return this.value.filter;
	}

	get concat() {
		return this.value.concat;
	}

	get join() {
		return this.value.join;
	}

	get reverse() {
		return this.value.reverse;
	}

	get slice() {
		return this.value.slice;
	}

	// @ts-ignore
	get copyWithin() {
		return this.value.copyWithin;
	}

	// @ts-ignore
	get fill() {
		return this.value.fill;
	}

	get indexOf() {
		return this.value.indexOf;
	}

	get lastIndexOf() {
		return this.value.lastIndexOf;
	}

	get every() {
		return this.value.every;
	}

	get some() {
		return this.value.some;
	}

	// @ts-ignore
	get sort() {
		return this.value.sort;
	}

	get find() {
		return this.value.find;
	}

	get findIndex() {
		return this.value.findIndex;
	}

	get findLast() {
		return this.value.findLast;
	}

	get findLastIndex() {
		return this.value.findLastIndex;
	}

	get at() {
		return this.value.at;
	}

	get entries() {
		return this.value.entries;
	}

	get includes() {
		return this.value.includes;
	}

	get toLocaleString() {
		return this.value.toLocaleString;
	}

	get toString() {
		return this.value.toString;
	}

	get valueOf() {
		return this.value.valueOf;
	}

	get keys() {
		return this.value.keys;
	}

	get values() {
		return this.value.values;
	}

	get toReversed() {
		return this.value.toReversed;
	}

	get toSorted() {
		return this.value.toSorted;
	}

	get toSpliced() {
		return this.value.toSpliced;
	}

	get with() {
		return this.value.with;
	}

	get reduce() {
		return this.value.reduce;
	}

	get reduceRight() {
		return this.value.reduceRight;
	}

	get flat() {
		return this.value.flat;
	}

	get flatMap() {
		return this.value.flatMap;
	}

	get [Symbol.iterator]() {
		return this.value[Symbol.iterator];
	}

	get [Symbol.unscopables]() {
		return this.value[Symbol.unscopables];
	}

	[index: number]: Item;
}
