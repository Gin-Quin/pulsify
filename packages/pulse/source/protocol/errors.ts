export type PulseErrorCode =
	| "INVALID_MESSAGE"
	| "UNSUPPORTED_VERSION"
	| "NOT_FOUND"
	| "INCOMPATIBLE_DOCUMENT"
	| "CLOSED"
	| "TIMEOUT"
	| "CONNECTION_FAILED"
	| "CONFLICT"
	| "LIMIT_EXCEEDED";

export function remoteError(code: string, message: string): PulseError {
	switch (code) {
		case "INVALID_MESSAGE":
		case "UNSUPPORTED_VERSION":
		case "NOT_FOUND":
		case "INCOMPATIBLE_DOCUMENT":
		case "CLOSED":
		case "TIMEOUT":
		case "CONNECTION_FAILED":
		case "CONFLICT":
		case "LIMIT_EXCEEDED":
			return new PulseError(code, message);
		default:
			return new PulseError("CONNECTION_FAILED", `${code}: ${message}`);
	}
}

export class PulseError extends Error {
	constructor(
		public readonly code: PulseErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "PulseError";
	}
}

export function asPulseError(error: unknown): PulseError {
	return error instanceof PulseError
		? error
		: new PulseError("CONNECTION_FAILED", String(error), { cause: error });
}
