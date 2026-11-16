import { PulseError } from "../protocol/errors.js";
import { validateDocId } from "../protocol/validateDocId.js";

/** A subtree is the document itself and IDs separated from it by `/`. */
export const coversDocument = (prefix: string, docId: string): boolean =>
	docId === prefix || docId.startsWith(`${prefix}/`);

/** Possible covering tombstones; never matches a sibling with a shared name. */
export function documentPrefixes(docId: string): string[] {
	validateDocId(docId);
	const prefixes = [docId];
	for (let i = docId.indexOf("/"); i >= 0; i = docId.indexOf("/", i + 1))
		if (i > 0) prefixes.push(docId.slice(0, i));
	return prefixes;
}

export const deletedDocument = (docId: string): PulseError =>
	new PulseError("NOT_FOUND", `Document ${docId} was permanently deleted`);
