import { CloudError } from "./errors.js";

const MAX_ID_LENGTH = 1024;

function isValidId(id: unknown): id is string {
	return (
		typeof id === "string" &&
		id.length > 0 &&
		id.length <= MAX_ID_LENGTH &&
		id.isWellFormed() &&
		!id.includes("\0")
	);
}

/**
 * The root document of an ID: everything before the first `/`. One root is one
 * isolated namespace, served by one Durable Object or one server-side actor.
 */
export function rootOf(docId: string): string {
	const slash = docId.indexOf("/");
	return slash < 0 ? docId : docId.slice(0, slash);
}

/** `"u1/notes"` covers itself and `"u1/notes/…"`, never `"u1/notes2"`. */
export function covers(prefix: string, docId: string): boolean {
	return docId === prefix || docId.startsWith(`${prefix}/`);
}

export function assertRoot(root: unknown): asserts root is string {
	if (!isValidId(root) || root.includes("/"))
		throw new CloudError("BAD_REQUEST", "Invalid root document ID");
}

/** A document ID inside `root`: the root itself or one of its sub-documents. */
export function assertDocumentOf(
	root: string,
	docId: unknown,
): asserts docId is string {
	if (!isValidId(docId) || rootOf(docId) !== root || docId.endsWith("/"))
		throw new CloudError(
			"BAD_REQUEST",
			`Expected a document ID inside the root "${root}"`,
		);
}
