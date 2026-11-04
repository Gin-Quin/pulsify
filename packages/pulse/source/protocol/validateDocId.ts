import { PulseError } from "./errors.js";

/** Keep document IDs lossless and portable across UTF-8 codecs and SQL text. */
export function validateDocId(docId: string): void {
	if (
		typeof docId !== "string" ||
		!docId.length ||
		docId.length > 1024 ||
		!docId.isWellFormed() ||
		docId.includes("\0")
	)
		throw new PulseError("INVALID_MESSAGE", "Invalid document ID");
}
