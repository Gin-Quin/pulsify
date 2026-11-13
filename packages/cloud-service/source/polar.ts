/** What the service needs from Polar: its API, its products and its webhook secret. */
export type PolarEnv = {
	/** `https://api.polar.sh`, or `https://sandbox-api.polar.sh`. */
	POLAR_API_URL: string;
	/** Organization access token: checkouts, customer sessions, event ingestion. */
	POLAR_ACCESS_TOKEN: string;
	/** The webhook endpoint's signing secret. */
	POLAR_WEBHOOK_SECRET: string;
	/** Product IDs of Pulsify Cloud Pro, monthly and yearly. */
	POLAR_PRO_MONTHLY: string;
	POLAR_PRO_YEARLY: string;
};

export type PolarEvent = {
	name: "cloud.messages" | "cloud.storage";
	external_customer_id: string;
	metadata: Record<string, number>;
	external_id?: string;
};

export async function polar<T>(
	env: PolarEnv,
	path: string,
	body: unknown,
): Promise<T> {
	const response = await fetch(`${env.POLAR_API_URL}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok)
		throw new Error(
			`Polar ${path}: ${response.status} ${await response.text()}`,
		);
	return (await response.json()) as T;
}

export const ingestEvents = (env: PolarEnv, events: PolarEvent[]) =>
	polar(env, "/v1/events/ingest", { events });

const FIVE_MINUTES = 5 * 60;
const encoder = new TextEncoder();

/**
 * Standard Webhooks, as Polar signs them: HMAC-SHA256 of `id.timestamp.body`
 * keyed by the secret's UTF-8 bytes, base64 in `webhook-signature` as `v1,…`.
 */
export async function verifyWebhook(
	body: string,
	headers: Headers,
	secret: string,
	now = Date.now(),
): Promise<boolean> {
	const id = headers.get("webhook-id");
	const timestamp = headers.get("webhook-timestamp");
	const signatures = headers.get("webhook-signature");
	if (!id || !timestamp || !signatures || !secret) return false;
	if (Math.abs(now / 1000 - Number(timestamp)) > FIVE_MINUTES) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	for (const signature of signatures.split(" ")) {
		const [version, value] = signature.split(",");
		if (version !== "v1" || !value) continue;
		let bytes: Uint8Array<ArrayBuffer>;
		try {
			bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
		} catch {
			continue;
		}
		// crypto.subtle.verify compares in constant time.
		if (
			await crypto.subtle.verify(
				"HMAC",
				key,
				bytes,
				encoder.encode(`${id}.${timestamp}.${body}`),
			)
		)
			return true;
	}
	return false;
}
