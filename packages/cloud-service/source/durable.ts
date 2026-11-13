// Structural runtime types, as in pulsify-cloud-server/cloudflare: the
// workspace stays on one lib set and the classes run in Bun tests.

type SqlCursor = { toArray(): Record<string, unknown>[] };
export type DurableStorage = {
	sql: { exec(query: string, ...bindings: unknown[]): SqlCursor };
	setAlarm(time: number): Promise<void> | void;
	getAlarm(): Promise<number | null> | number | null;
};
export type DurableState = { storage: DurableStorage };
export type DurableStub = { fetch(request: Request): Promise<Response> };
export type DurableNamespace = {
	idFromName(name: string): unknown;
	get(id: unknown): DurableStub;
};

/** Call a method of a Durable Object over `fetch`: `call(stub, "report", status)`. */
export async function call<T>(
	stub: DurableStub,
	method: string,
	...args: unknown[]
): Promise<T> {
	const response = await stub.fetch(
		new Request(`https://object/${method}`, {
			method: "POST",
			body: JSON.stringify(args),
		}),
	);
	if (!response.ok)
		throw new Error(
			`${method} failed: ${response.status} ${await response.text()}`,
		);
	return ((await response.json()) as { result: T }).result;
}

/** The other side of `call`: run one of `methods` on `target`. */
export async function serve(
	target: object,
	methods: readonly string[],
	request: Request,
): Promise<Response> {
	const method = new URL(request.url).pathname.slice(1);
	if (!methods.includes(method))
		return new Response("Unknown method", { status: 404 });
	const args = (await request.json()) as unknown[];
	const result = await (
		target as Record<string, (...args: unknown[]) => unknown>
	)[method]!(...args);
	return Response.json({ result: result ?? null });
}

export function randomToken(bytes = 32): string {
	const data = crypto.getRandomValues(new Uint8Array(bytes));
	return btoa(String.fromCharCode(...data))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export function first<T>(cursor: SqlCursor): T | undefined {
	return cursor.toArray()[0] as T | undefined;
}
