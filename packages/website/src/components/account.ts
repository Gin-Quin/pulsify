/** The dashboard's API on the hosted service, with the session cookie. */
import { PULSIFY_API } from "./links";

export type Usage = { messages: number; bytes: number; connections: number };

export type Account = {
	project: string;
	email: string;
	plan: "free" | "pro";
	tokenSecret: string;
	apiKey: string;
	url: string;
	usage: Usage;
	limits: Usage;
};

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** `/account/<action>`: a GET without a body, a JSON POST with one. */
export async function api<T>(action: string, body?: object): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${PULSIFY_API}/account${action && `/${action}`}`, {
			method: body ? "POST" : "GET",
			credentials: "include",
			headers: body ? { "Content-Type": "application/json" } : undefined,
			body: body && JSON.stringify(body),
		});
	} catch {
		throw new ApiError(
			0,
			"Pulsify Cloud is unreachable. Check your connection and try again.",
		);
	}
	if (response.status === 204) return undefined as T;
	const data = await response.json().catch(() => undefined);
	if (!response.ok) {
		const error = data?.error;
		throw new ApiError(
			response.status,
			typeof error === "string"
				? error
				: (error?.message ?? `Request failed with status ${response.status}`),
		);
	}
	return data as T;
}

export const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** Keeps a click on Pro made while signed out, for the dashboard to resume. */
export function rememberUpgrade() {
	try {
		localStorage.setItem("upgrade", String(Date.now()));
	} catch {
		// Storage blocked: signing in lands on the dashboard, which has the buttons.
	}
}

/** Whether Pro was picked less than 30 minutes ago, once: a stale pick never opens a checkout. */
export function takeUpgrade(): boolean {
	try {
		const at = Number(localStorage.getItem("upgrade"));
		localStorage.removeItem("upgrade");
		return Date.now() - at < 30 * 60_000;
	} catch {
		// Storage blocked: nothing was remembered.
		return false;
	}
}
