import type {
	ArrayUpdate,
	IncrementableUpdate,
	ObjectUpdate,
	ValueUpdate,
} from "./Update"

/**
 * An State represents a list of updates.
 */
export type State = ArrayState<any> | ObjectState<any, any> | ValueState<any>

export type ArrayState<Value> = Array<ArrayUpdate<Value>>

export type ObjectState<
	Properties extends Record<string, any>,
	Key extends keyof Properties
> = Array<ObjectUpdate<Properties, Key>>

export type ValueState<Value> = Array<ValueUpdate<Value>>

export type IncrementableState = Array<IncrementableUpdate>
