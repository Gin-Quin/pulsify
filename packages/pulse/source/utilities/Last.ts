/**
 * @returns The last type of a tuple
 */
export type Last<T extends readonly unknown[]> = T extends readonly [
	...unknown[],
	infer L,
]
	? L
	: T extends readonly (infer L)[]
		? L
		: never;
