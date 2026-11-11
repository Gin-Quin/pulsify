export type CloudErrorCode =
	| "BAD_REQUEST"
	| "UNAUTHORIZED"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "METHOD_NOT_ALLOWED"
	| "UPGRADE_REQUIRED"
	| "LIMIT_EXCEEDED"
	| "UNAVAILABLE";

export const CLOUD_ERROR_STATUS: Readonly<Record<CloudErrorCode, number>> = {
	BAD_REQUEST: 400,
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	METHOD_NOT_ALLOWED: 405,
	UPGRADE_REQUIRED: 426,
	LIMIT_EXCEEDED: 413,
	UNAVAILABLE: 503,
};

/** An HTTP-level failure of the cloud API, shared by every backend. */
export class CloudError extends Error {
	readonly status: number;
	constructor(
		public readonly code: CloudErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CloudError";
		this.status = CLOUD_ERROR_STATUS[code];
	}
}

export function isCloudErrorCode(value: unknown): value is CloudErrorCode {
	return typeof value === "string" && Object.hasOwn(CLOUD_ERROR_STATUS, value);
}
