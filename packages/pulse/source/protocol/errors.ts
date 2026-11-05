export type PulseErrorCode =
	| "HISTORY_UNAVAILABLE"
	| "INVALID_MESSAGE"
	| "UNSUPPORTED_VERSION"
	| "NOT_FOUND"
	| "INCOMPATIBLE_DOCUMENT"
	| "MIGRATION_DRIFT"
	| "CLOSED"
	| "TIMEOUT"
	| "CONNECTION_FAILED"
	| "CONFLICT"
	| "LIMIT_EXCEEDED";

export function remoteError(code: string, message: string): PulseError {
	switch (code) {
		case "HISTORY_UNAVAILABLE":
		case "INVALID_MESSAGE":
		case "UNSUPPORTED_VERSION":
		case "NOT_FOUND":
		case "INCOMPATIBLE_DOCUMENT":
		case "MIGRATION_DRIFT":
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

export type MigrationDriftDetails = {
	docId: string;
	kind: string;
	version: number | undefined;
	expected: string | undefined;
	received: string;
	reason: string;
};

export class MigrationDriftError extends PulseError {
	constructor(
		public readonly details: MigrationDriftDetails,
		public readonly incomingSnapshot?: unknown,
	) {
		super("MIGRATION_DRIFT", `MIGRATION DRIFT DETECTED: ${details.reason}`);
		this.name = "MigrationDriftError";
	}
}

export function asPulseError(error: unknown): PulseError {
	return error instanceof PulseError
		? error
		: new PulseError("CONNECTION_FAILED", String(error), { cause: error });
}
