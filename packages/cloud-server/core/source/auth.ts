import { CloudError, readSubprotocols, verifyCloudToken } from "pulsify-cloud";

/** Who is calling: your backend with the API key, or a user with a token. */
export type CloudCaller = { kind: "admin" } | { kind: "user"; subject: string };
export type CloudSecrets = {
	/** HS256 secret shared with the backend that signs user tokens. */
	tokenSecret: string;
	/** Server-to-server key for the management API. Never ship it to a browser. */
	apiKey: string;
};

const encoder = new TextEncoder();
function sameSecret(left: string, right: string): boolean {
	const a = encoder.encode(left),
		b = encoder.encode(right);
	let difference = a.length ^ b.length;
	for (let i = 0; i < a.length; i++)
		difference |= a[i]! ^ (b[i % b.length] ?? 0);
	return difference === 0;
}

/** The credential of a request: bearer header, token subprotocol, then `?token=`. */
export function readCredential(request: Request): string | undefined {
	const authorization = request.headers.get("Authorization");
	if (authorization?.startsWith("Bearer "))
		return authorization.slice(7).trim() || undefined;
	return (
		readSubprotocols(request.headers.get("Sec-WebSocket-Protocol")).token ??
		(new URL(request.url).searchParams.get("token") || undefined)
	);
}

/** `undefined` without a credential; throws `UNAUTHORIZED` for a bad one. */
export async function authenticateCloudRequest(
	request: Request,
	secrets: CloudSecrets,
): Promise<CloudCaller | undefined> {
	const credential = readCredential(request);
	if (!credential) return undefined;
	if (secrets.apiKey.length >= 32 && sameSecret(credential, secrets.apiKey))
		return { kind: "admin" };
	const { subject } = await verifyCloudToken(credential, secrets.tokenSecret);
	return { kind: "user", subject };
}

export function requireCaller(caller: CloudCaller | undefined): CloudCaller {
	if (!caller) throw new CloudError("UNAUTHORIZED", "Missing credentials");
	return caller;
}

const CALLER_HEADER = "x-pulsify-caller";
/** Internal header between an authenticating gateway and the root it forwards to. */
export function callerToHeaders(caller: CloudCaller): Record<string, string> {
	return {
		[CALLER_HEADER]:
			caller.kind === "admin"
				? "admin"
				: `user:${encodeURIComponent(caller.subject)}`,
	};
}
export function callerFromHeaders(headers: Headers): CloudCaller | undefined {
	const value = headers.get(CALLER_HEADER);
	if (value === "admin") return { kind: "admin" };
	if (value?.startsWith("user:"))
		return { kind: "user", subject: decodeURIComponent(value.slice(5)) };
	return undefined;
}
