import { CloudError } from "pulsify-cloud";

/**
 * The management API uses bearer credentials, never cookies, so any origin may
 * call it: a browser still needs a valid token to do anything.
 */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
	"Access-Control-Max-Age": "86400",
};

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

export function preflightResponse(): Response {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** `{ error: { code, message } }` with the code's HTTP status. */
export function errorResponse(error: unknown): Response {
	const failure =
		error instanceof CloudError
			? error
			: new CloudError("UNAVAILABLE", "Internal error", { cause: error });
	return jsonResponse(
		{ error: { code: failure.code, message: failure.message } },
		failure.status,
	);
}

export async function readJson(request: Request): Promise<unknown> {
	const text = await request.text();
	if (text.length > 64 * 1024)
		throw new CloudError("LIMIT_EXCEEDED", "Request body is too large");
	try {
		return JSON.parse(text);
	} catch {
		throw new CloudError("BAD_REQUEST", "Expected a JSON body");
	}
}
