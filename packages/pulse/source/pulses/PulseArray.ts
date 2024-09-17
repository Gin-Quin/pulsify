import type { ArrayUpdate } from "../types/Update"
import { me } from "../values/me"
import { BasePulse } from "./BasePulse"
import { findLeftRightEntries } from "../functions/findLeftRightEntries"

export class PulseArray<T> extends BasePulse<Array<T>> {
	state = Array<ArrayUpdate<T>>()

	get length(): number {
		return this.value.length
	}

	/* -------------------------------------------------------------------------- */
	/*                              Mutation methods                              */
	/* -------------------------------------------------------------------------- */

	insert(index: number, values: Array<T>): number {
		const { left, right } = findLeftRightEntries(this.state, index)
		const update: ArrayUpdate<T> = {
			actor: me.id,
			clock: me.clock,
			content: values,
			left,
			right,
		}
		me.clock += BigInt(values.length)
		this.applyUpdate(update)
		this.value.splice(index, 0, ...values)
		return this.value.length
	}

	push(...values: Array<T>): number {
		return this.insert(this.state.length, values)
	}

	delete(index: number, count = 1): this {
		if (count == 0) return this
		throw "TODO"
		this.value.splice(index, count)
		return this
	}

	splice(index: number, deleteCount = 1, ...values: Array<T>): Array<T> {
		const deletedElements = this.value.slice(index, index + deleteCount)
		this.delete(index, deleteCount)
		this.insert(index, values)
		return deletedElements
	}

	pop() {
		this.delete(this.state.length - 1)
		return this.value.pop()
	}

	shift() {
		this.delete(0, 1)
		return this.value.shift()
	}

	unshift(...values: Array<T>): number {
		return this.insert(0, values)
	}

	/* -------------------------------------------------------------------------- */
	/*                                Array methods                               */
	/* -------------------------------------------------------------------------- */

	forEach(
		callbackfn: (value: T, index: number, array: Array<T>) => void,
		thisArg?: any
	): void {
		this.value.forEach(callbackfn, thisArg)
	}

	map<U>(
		callbackfn: (value: T, index: number, array: Array<T>) => U,
		thisArg?: any
	): Array<U> {
		return this.value.map(callbackfn, thisArg)
	}

	filter<S extends T>(
		callbackfn: (value: T, index: number, array: Array<T>) => value is S,
		thisArg?: any
	): Array<S> {
		return this.value.filter(callbackfn, thisArg)
	}

	concat(...items: Array<ConcatArray<T>>): Array<T> {
		return this.value.concat(...items)
	}

	join(separator?: string): string {
		return this.value.join(separator)
	}

	reverse(): Array<T> {
		return this.value.reverse()
	}

	slice(start?: number, end?: number): Array<T> {
		return this.value.slice(start, end)
	}

	copyWithin(target: number, start: number, end?: number): this {
		this.value.copyWithin(target, start, end)
		return this
	}

	fill(value: T, start?: number, end?: number): this {
		this.value.fill(value, start, end)
		return this
	}

	indexOf(searchElement: T, fromIndex?: number): number {
		return this.value.indexOf(searchElement, fromIndex)
	}

	lastIndexOf(searchElement: T, fromIndex?: number): number {
		return this.value.lastIndexOf(searchElement, fromIndex)
	}

	every<S extends T>(
		predicate: (value: T, index: number, array: T[]) => value is S,
		thisArg?: any
	): this is S[] {
		return this.value.every(predicate, thisArg)
	}

	some(
		callbackfn: (value: T, index: number, array: Array<T>) => unknown,
		thisArg?: any
	): boolean {
		return this.value.some(callbackfn, thisArg)
	}

	// sort, reduce, reduceRight, find

	sort(compareFn?: (a: T, b: T) => number): this {
		this.value.sort(compareFn)
		return this
	}

	find<S extends T>(
		predicate: (value: T, index: number, obj: Array<T>) => value is S,
		thisArg?: any
	): S | undefined {
		return this.value.find(predicate, thisArg)
	}

	findIndex(
		predicate: (value: T, index: number, obj: Array<T>) => unknown,
		thisArg?: any
	): number {
		return this.value.findIndex(predicate, thisArg)
	}

	findLast<S extends T>(
		predicate: (value: T, index: number, obj: Array<T>) => value is S,
		thisArg?: any
	): S | undefined {
		return this.value.findLast(predicate, thisArg)
	}

	findLastIndex(
		predicate: (value: T, index: number, obj: Array<T>) => unknown,
		thisArg?: any
	): number {
		return this.value.findLastIndex(predicate, thisArg)
	}

	at(index: number) {
		return this.value.at(index)
	}

	entries() {
		return this.value.entries()
	}

	includes(value: T) {
		return this.value.includes(value)
	}

	toLocaleString() {
		return this.value.toLocaleString()
	}

	toString() {
		return this.value.toString()
	}

	valueOf() {
		return this.value.valueOf()
	}

	keys() {
		return this.value.keys()
	}

	values() {
		return this.value.values()
	}

	toReversed() {
		return this.value.toReversed()
	}

	toSorted(compareFn?: (a: T, b: T) => number) {
		return this.value.toSorted(compareFn)
	}

	toSpliced(start: number, deleteCount: number, ...values: Array<T>) {
		return this.value.toSpliced(start, deleteCount, ...values)
	}

	with(index: number, value: T) {
		return this.value.with(index, value)
	}

	[Symbol.iterator] = this.value[Symbol.iterator]
}
