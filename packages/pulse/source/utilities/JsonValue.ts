export type JsonValue =
	| number
	| string
	| boolean
	| null
	| undefined
	| JsonObject
	| JsonArray;

export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = Array<JsonValue>;
