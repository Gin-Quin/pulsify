import { me } from "../values/me";
import { PulseState, type PulseProperties } from "./AbstractPulse";
import { findLeftRightEvents } from "../functions/findLeftRightEvents";
import type { Update } from "../types/Update";
import type { Entries } from "../types/Entry";
import { assimilateUpdate } from "pulse/types/State";
import { reuse } from "@gin-quin/minimix/reuse";
import { Mix } from "@gin-quin/minimix";

export class PulseArrayClass<Item> extends Array<Item> {
	___pulse___: PulseState<Array<Item>, Item>;

	constructor(content: Array<Item> = [], properties: PulseProperties = {}) {
		super(...content);
		this.___pulse___ = new PulseState<Array<Item>, Item>(this, properties);

		if (content.length > 0) {
			this.___pulse___.state = [
				{
					actor: me,
					clock: 0n,
					content,
				},
			];
			this.___pulse___.stateVector.set(me, BigInt(content.length));
		}

		// biome-ignore lint: We use a proxy to capture changes
		return new Proxy(this, {
			get: (target, prop) => target[prop as keyof typeof target],
			set: (target, prop, value) => {
				if (
					typeof prop === "number" ||
					(typeof prop === "string" && !Number.isNaN(Number(prop)))
				) {
					console.log("splice", prop, value);
					const index = Number(prop);
					target.splice(index, 1, value);
				} else {
					(target as any)[prop] = value;
				}
				return true;
			},
		});
	}
}

export function createPulseArray<Item>(
	content: Array<Item> = [],
	properties: PulseProperties = {},
): PulseArray<Item> {
	const PulseArray = PulseArrayFactory<Item>();
	const pulse = new PulseArray(content, properties);
	return new Proxy(pulse, {
		get: (target, prop) => target[prop as keyof typeof target],
		set: (target, prop, value) => {
			if (
				typeof prop === "number" ||
				(typeof prop === "string" && !Number.isNaN(Number(prop)))
			) {
				console.log("splice", prop, value);
				const index = Number(prop);
				target.splice(index, 1, value);
			} else {
				(target as any)[prop] = value;
			}
			return true;
		},
	});
}

const a = createPulseArray([1, 2, 3]);

console.log(a);
console.log(a[0]);
a[0] = 4;
console.log(a);

export function PulseArrayFactory<Item>() {
	return reuse(
		PulseArrayFactory,
		class PulseArray extends Mix(Array<Item>, PulseState<Array<Item>, Item>) {
			value = this;

			/**
			 * State of the array.
			 */
			state = Array<Entries<Item>>();

			constructor(content: Array<Item> = [], properties: PulseProperties = {}) {
				super(content, [properties]);
				if (content.length > 0) {
					this.state = [
						{
							actor: me,
							clock: 0n,
							content,
						},
					];
					this.stateVector.set(me, BigInt(content.length));
				}
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
				this.splice(index, 0, ...values);
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
					right: undefined,
				};
				this.applyUpdate(update);
				this.push(...values);
				return finalLength;
			}

			delete(index: number, count = 1): this {
				if (count === 0) return this;
				console.warn("TODO: PulseArray::delete");
				return this;
			}

			splice(
				index: number,
				deleteCount = 1,
				...values: Array<Item>
			): Array<Item> {
				if (deleteCount > 0) {
					const deletedElements = this.slice(index, index + deleteCount);
					this.delete(index, deleteCount);
					this.insert(index, values);
					return deletedElements;
				} else {
					this.insert(index, values);
					return [];
				}
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

			reverse() {
				return super.reverse();
			}

			// @ts-ignore
			fill(value: Item, start = 0, end = this.length) {
				// TODO: update pulse
				return super.fill(value, start, end);
			}

			// @ts-ignore
			sort() {
				return super.sort();
			}

			// @ts-ignore
			copyWithin(target: number, start: number, end = this.length) {
				return super.copyWithin(target, start, end);
			}

			slice(start = 0, end = this.length): Array<Item> {
				const result = new Array<Item>(end - start);
				for (let index = start; index < end; index++) {
					result[index - start] = this[index];
				}
				return result;
			}
		},
	);
}
