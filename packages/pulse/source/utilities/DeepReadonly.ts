export type DeepReadonly<Value> = Value extends object
	? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
	: Value;
