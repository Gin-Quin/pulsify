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
	| "LIMIT_EXCEEDED"
	| "FORBIDDEN";

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
		case "FORBIDDEN":
			return new PulseError(code, message);
		default:
			return new PulseError("CONNECTION_FAILED", `${code}: ${message}`);
	}
}

export class PulseError extends Error {
	/** Overrides the default for its code; see `isRetryable`. */
	readonly retryable: boolean | undefined;
	constructor(
		public readonly code: PulseErrorCode,
		message: string,
		options?: ErrorOptions & { retryable?: boolean },
	) {
		super(message, options);
		this.name = "PulseError";
		this.retryable = options?.retryable;
	}
}

const TRANSIENT_CODES = new Set<PulseErrorCode>([
	"CLOSED",
	"CONNECTION_FAILED",
	"TIMEOUT",
]);
/**
 * Transport failures (closed, unreachable, silent) are retried by a connected
 * pulse; protocol and authorization errors stop it until `connectPulse`.
 */
export function isRetryable(error: PulseError): boolean {
	return error.retryable ?? TRANSIENT_CODES.has(error.code);
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
