export type DeepReadonly<Value> = Value extends (...args: any[]) => unknown
	? Value
	: Value extends Uint8Array
		? Readonly<Uint8Array>
		: Value extends object
			? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
			: Value;
