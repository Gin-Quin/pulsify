import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { decodeMessage, encodeMessage } from "pulsify-core/protocol";
import { PulsifyAccount } from "../source/Account.js";
import { PulsifyProject, type Dashboard } from "../source/Project.js";
import { PulsifyRoot } from "../source/Root.js";
import {
	handleServiceRequest,
	type EmailMessage,
	type ServiceEnv,
} from "../source/worker.js";

const API = "https://api.test";
const DASHBOARD = "https://site.test/dashboard";
const ORIGIN = "https://site.test";
const WEBHOOK_SECRET = "polar_whs_test_secret";

/** A Durable Object's storage in memory: SQLite, one alarm. */
function durableState() {
	const db = new Database(":memory:");
	let alarm: number | null = null;
	const storage = {
		sql: {
			exec: (query: string, ...bindings: unknown[]) => {
				const rows = db.query(query).all(...(bindings as never[])) as Record<
					string,
					unknown
				>[];
				return { toArray: () => rows };
			},
			databaseSize: 4096,
		},
		transactionSync: <T>(work: () => T) => db.transaction(work)(),
		setAlarm: (time: number) => void (alarm = time),
		getAlarm: () => alarm,
		deleteAlarm: () => void (alarm = null),
		deleteAll: () => {
			const tables = db
				.query("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all() as { name: string }[];
			for (const { name } of tables) db.run(`DROP TABLE "${name}"`);
		},
	};
	return {
		storage,
		acceptWebSocket: () => {},
		getWebSockets: () => [],
	};
}

function namespace<T extends { fetch(request: Request): Promise<Response> }>(
	create: (state: ReturnType<typeof durableState>) => T,
) {
	const objects = new Map<string, T>();
	return {
		objects,
		idFromName: (name: string) => name,
		get: (id: unknown) => {
			let object = objects.get(String(id));
			if (!object) objects.set(String(id), (object = create(durableState())));
			return object;
		},
	};
}

let emails: EmailMessage[];
let polarCalls: { path: string; body: any }[];
const realFetch = globalThis.fetch;
function environment() {
	const env = {
		API_URL: API,
		DASHBOARD_URL: DASHBOARD,
		EMAIL_FROM: "login@site.test",
		EMAIL: { send: async (message: EmailMessage) => void emails.push(message) },
		POLAR_API_URL: "https://polar.test",
		POLAR_ACCESS_TOKEN: "polar_oat_test",
		POLAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
		POLAR_PRO_MONTHLY: "pro-monthly",
		POLAR_PRO_YEARLY: "pro-yearly",
	} as ServiceEnv;
	const projects = namespace((state) => new PulsifyProject(state, env));
	const accounts = namespace((state) => new PulsifyAccount(state));
	const roots = namespace((state) => new PulsifyRoot(state as never, env));
	Object.assign(env, { PROJECTS: projects, ACCOUNTS: accounts, ROOTS: roots });
	return { env, projects, roots };
}

beforeEach(() => {
	emails = [];
	polarCalls = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = JSON.parse(String(init?.body ?? "{}"));
		polarCalls.push({ path: url.pathname, body });
		if (url.pathname === "/v1/checkouts/")
			return Response.json({ url: "https://polar.test/checkout/1" });
		if (url.pathname === "/v1/customer-sessions/")
			return Response.json({
				customer_portal_url: "https://polar.test/portal",
			});
		return Response.json({ inserted: body.events?.length ?? 0 });
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
	setSystemTime();
});

const post = (
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	new Request(`${API}${path}`, {
		method: "POST",
		headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

/** Sign up through the login link; returns the session cookie and the dashboard. */
async function signUp(env: ServiceEnv, email = "Ada@Example.com") {
	const sent = await handleServiceRequest(
		post("/account/login", { email }),
		env,
	);
	expect(await sent.json()).toEqual({ ok: true });
	const link = emails.at(-1)!.text.match(/https:\/\/\S+/)![0];
	const verified = await handleServiceRequest(new Request(link), env);
	expect(verified.status).toBe(302);
	expect(verified.headers.get("Location")).toBe(DASHBOARD);
	const cookie = verified.headers.get("Set-Cookie")!.split(";")[0]!;
	const response = await handleServiceRequest(
		new Request(`${API}/account`, { headers: { Cookie: cookie } }),
		env,
	);
	expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
	return {
		cookie,
		dashboard: (await response.json()) as Dashboard & { url: string },
	};
}

async function signedWebhook(body: string, secret = WEBHOOK_SECRET) {
	const id = "msg_1";
	const timestamp = String(Math.floor(Date.now() / 1000));
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(`${id}.${timestamp}.${body}`),
		),
	);
	return new Request(`${API}/polar/webhook`, {
		method: "POST",
		headers: {
			"webhook-id": id,
			"webhook-timestamp": timestamp,
			"webhook-signature": `v1,${btoa(String.fromCharCode(...signature))}`,
		},
		body,
	});
}

const stateChanged = (project: string, products: string[]) =>
	JSON.stringify({
		type: "customer.state_changed",
		data: {
			external_id: project,
			active_subscriptions: products.map((product_id) => ({ product_id })),
		},
	});

test("a login link creates the project, its secrets and a session", async () => {
	const { env } = environment();
	const { cookie, dashboard } = await signUp(env);
	expect(emails[0]!.to).toBe("ada@example.com");
	expect(dashboard).toMatchObject({
		email: "ada@example.com",
		plan: "free",
		usage: { messages: 0, connections: 0 },
		limits: { connections: 100, messages: 1_000_000 },
	});
	expect(dashboard.project).toMatch(/^[a-z2-7]{16}$/);
	expect(dashboard.url).toBe(`${API}/${dashboard.project}`);
	expect(dashboard.tokenSecret.length).toBeGreaterThanOrEqual(32);
	expect(dashboard.apiKey).toStartWith("pk_");

	// One email a minute; signing in again keeps the same project.
	await handleServiceRequest(
		post("/account/login", { email: "ada@example.com" }),
		env,
	);
	expect(emails).toHaveLength(1);

	const rotated = (await (
		await handleServiceRequest(
			post("/account/rotate", { secret: "api" }, { Cookie: cookie }),
			env,
		)
	).json()) as Dashboard;
	expect(rotated.apiKey).not.toBe(dashboard.apiKey);
	expect(rotated.tokenSecret).toBe(dashboard.tokenSecret);

	const logout = await handleServiceRequest(
		post("/account/logout", {}, { Cookie: cookie }),
		env,
	);
	expect(logout.status).toBe(204);
	const after = await handleServiceRequest(
		new Request(`${API}/account`, { headers: { Cookie: cookie } }),
		env,
	);
	expect(after.status).toBe(401);
});

test("the emailed code signs in like the link, with a daily limit of wrong codes", async () => {
	const { env } = environment();
	const typed = (code: string, email = "ada@example.com") =>
		handleServiceRequest(post("/account/code", { email, code }), env);
	expect((await typed("444444")).status).toBe(400);
	await handleServiceRequest(
		post("/account/login", { email: "ada@example.com" }),
		env,
	);
	const code = emails[0]!.subject.slice(0, 6);
	expect(emails[0]!.text).toContain(code);
	const wrong = code === "000000" ? "000001" : "000000";
	const signedIn = await typed(code);
	expect(signedIn.status).toBe(204);
	const cookie = signedIn.headers.get("Set-Cookie")!.split(";")[0]!;
	const dashboard = await handleServiceRequest(
		new Request(`${API}/account`, { headers: { Cookie: cookie } }),
		env,
	);
	expect(await dashboard.json()).toMatchObject({ email: "ada@example.com" });

	for (let attempt = 0; attempt < 20; attempt++)
		expect((await typed(wrong)).status).toBe(400);
	expect((await typed(code)).status).toBe(400);

	// The local service's fixed code works for any address that asked for one.
	env.DEV_LOGIN_CODE = "444444";
	expect((await typed("444444")).status).toBe(204);
	expect((await typed("444444", "grace@example.com")).status).toBe(400);
});

test("bad links, other origins and missing sessions are refused", async () => {
	const { env } = environment();
	await signUp(env);
	const forged = await handleServiceRequest(
		new Request(`${API}/account/verify?email=ada%40example.com&token=nope`),
		env,
	);
	expect(forged.headers.get("Location")).toBe(`${DASHBOARD}?login=expired`);
	const crossSite = await handleServiceRequest(
		post(
			"/account/login",
			{ email: "eve@example.com" },
			{ Origin: "https://evil.test" },
		),
		env,
	);
	expect(crossSite.status).toBe(403);
	const invalid = await handleServiceRequest(
		post("/account/login", { email: "nope" }),
		env,
	);
	expect(invalid.status).toBe(400);
	const anonymous = await handleServiceRequest(
		new Request(`${API}/account`, {
			headers: { Cookie: "pulsify_session=abcdefghijklmnop.guess" },
		}),
		env,
	);
	expect(anonymous.status).toBe(401);
});

test("plain HTTP is refused, so no secret travels in clear", async () => {
	const { env } = environment();
	const insecure = await handleServiceRequest(
		new Request("http://api.test/health"),
		env,
	);
	expect(insecure.status).toBe(403);
	const secure = await handleServiceRequest(new Request(`${API}/health`), env);
	expect(secure.status).toBe(200);
});

test("each project serves its own roots with its own secrets", async () => {
	const { env } = environment();
	const { dashboard: ada } = await signUp(env, "ada@example.com");
	const { dashboard: bob } = await signUp(env, "bob@example.com");
	const grant = (project: string, key: string) =>
		handleServiceRequest(
			new Request(`${API}/${project}/v1/roots/alice/grants`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${key}` },
				body: JSON.stringify({ subject: "u1", prefix: "alice", role: "owner" }),
			}),
			env,
		);
	const list = (project: string, key: string) =>
		handleServiceRequest(
			new Request(`${API}/${project}/v1/roots/alice/grants`, {
				headers: { Authorization: `Bearer ${key}` },
			}),
			env,
		).then((response) => response.json());

	expect((await grant(ada.project, ada.apiKey)).status).toBe(200);
	expect(await list(ada.project, ada.apiKey)).toEqual({
		grants: [{ subject: "u1", prefix: "alice", role: "owner" }],
	});
	// Same root name, other project: other object, other grants.
	expect(await list(bob.project, bob.apiKey)).toEqual({ grants: [] });
	expect((await grant(bob.project, ada.apiKey)).status).toBe(401);
	const unknown = await handleServiceRequest(
		new Request(`${API}/abcdefghijklmnop/v1/roots/alice/grants`),
		env,
	);
	expect(unknown.status).toBe(404);
});

test("a Free project over its limits refuses uploads and sockets", async () => {
	const { env, projects, roots } = environment();
	const { dashboard } = await signUp(env);
	const project = projects.objects.get(dashboard.project)!;
	expect(
		await project.report({
			root: "a",
			messages: 999_999,
			bytes: 1000,
			connections: 60,
		}),
	).toEqual({ writable: true, connectable: true });
	expect(
		await project.report({
			root: "b",
			messages: 1,
			bytes: 1000,
			connections: 41,
		}),
	).toEqual({ writable: false, connectable: false });

	// The root learns it when it reports, and answers uploads with LIMIT_EXCEEDED.
	await handleServiceRequest(
		new Request(`${API}/${dashboard.project}/v1/roots/alice/grants`, {
			headers: { Authorization: `Bearer ${dashboard.apiKey}` },
		}),
		env,
	);
	const root = roots.objects.get(`${dashboard.project}/alice`)!;
	const sent: Uint8Array[] = [];
	const socket = {
		send: (data: Uint8Array) => sent.push(data),
	} as unknown as WebSocket;
	const update = encodeMessage({
		kind: 4,
		docId: "alice",
		requestId: 7,
		vv: [],
		rows: [],
	});
	await root.webSocketMessage(socket, update.slice().buffer as ArrayBuffer);
	expect(decodeMessage(sent[0]!)).toMatchObject({
		kind: 6,
		docId: "alice",
		requestId: 7,
		code: "LIMIT_EXCEEDED",
	});
	const after = (await (
		await handleServiceRequest(
			new Request(`${API}/account`, {
				headers: {
					Cookie: await signUpCookie(env, projects, dashboard.project),
				},
			}),
			env,
		)
	).json()) as Dashboard;
	// The refused upload is counted with the root's next report.
	expect(after.usage).toEqual({
		messages: 1_000_000,
		bytes: 2000 + 4096,
		connections: 101,
	});
});

/** A fresh session for a project, without another login link. */
async function signUpCookie(
	_env: ServiceEnv,
	projects: ReturnType<typeof environment>["projects"],
	project: string,
) {
	const secret = await projects.objects.get(project)!.startSession();
	return `pulsify_session=${project}.${secret}`;
}

test("deleting a project wipes its roots, itself and the account", async () => {
	const { env, projects, roots } = environment();
	const { cookie, dashboard } = await signUp(env);
	const { project, apiKey } = dashboard;
	const grants = (method = "GET") =>
		handleServiceRequest(
			new Request(`${API}/${project}/v1/roots/alice/grants`, {
				method,
				headers: { Authorization: `Bearer ${apiKey}` },
				body:
					method === "PUT"
						? JSON.stringify({ subject: "u1", prefix: "alice", role: "owner" })
						: null,
			}),
			env,
		);
	// A root that no socket ever opened still reports, so the project lists it.
	expect((await grants("PUT")).status).toBe(200);
	const remove = () =>
		handleServiceRequest(post("/account/delete", {}, { Cookie: cookie }), env);

	// A subscription must end first: nothing is billed to a deleted project.
	const object = projects.objects.get(project)!;
	await object.setPlan("pro");
	expect((await remove()).status).toBe(409);
	expect((await grants()).status).toBe(200);
	await object.setPlan("free");

	const removed = await remove();
	expect(removed.status).toBe(204);
	expect(removed.headers.get("Set-Cookie")).toContain("Max-Age=0");
	// At once: no session, no project, whatever the secret.
	const session = await handleServiceRequest(
		new Request(`${API}/account`, { headers: { Cookie: cookie } }),
		env,
	);
	expect(session.status).toBe(401);
	expect((await grants()).status).toBe(404);

	// The alarm wipes the roots; the root refuses whatever still reaches it.
	const root = roots.objects.get(`${project}/alice`)!;
	const tables = () =>
		(root as any).durable.storage.sql
			.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
			.toArray().length;
	expect(tables()).toBeGreaterThan(0);
	await object.alarm();
	expect(tables()).toBe(0);
	// Then, once no gateway can still route to it, the project itself.
	const late = { root: "late", messages: 0, bytes: 0, connections: 0 };
	expect((await object.report(late)).writable).toBe(false);
	setSystemTime(new Date(Date.now() + 3 * 60_000));
	await object.alarm(); // wipes "late", woken during the deletion
	await object.alarm();
	expect(object.dashboard()).toBeNull();
	expect(
		(object as any).state.storage.sql.exec("SELECT * FROM roots").toArray(),
	).toEqual([]);

	// The address is free again: signing in starts a new, empty project.
	const again = await signUp(env);
	expect(again.dashboard.project).not.toBe(project);
	expect(again.dashboard.usage.bytes).toBe(0);
});
test("Polar webhooks set the plan; Pro usage is sent to Polar", async () => {
	const { env, projects } = environment();
	const { cookie, dashboard } = await signUp(env);
	const project = projects.objects.get(dashboard.project)!;

	const forged = await handleServiceRequest(
		await signedWebhook(
			stateChanged(dashboard.project, ["pro-monthly"]),
			"wrong",
		),
		env,
	);
	expect(forged.status).toBe(403);
	const upgraded = await handleServiceRequest(
		await signedWebhook(stateChanged(dashboard.project, ["pro-monthly"])),
		env,
	);
	expect(upgraded.status).toBe(202);
	expect(project.config()!.plan).toBe("pro");

	// Pro is never blocked; its usage goes to Polar on the alarm.
	expect(
		await project.report({
			root: "a",
			messages: 6_000_000,
			bytes: 2e9,
			connections: 1,
		}),
	).toEqual({ writable: true, connectable: true });
	await project.alarm();
	const ingested = polarCalls.filter(
		(call) => call.path === "/v1/events/ingest",
	);
	expect(ingested.flatMap((call) => call.body.events)).toEqual([
		{
			name: "cloud.messages",
			external_customer_id: dashboard.project,
			metadata: { count: 6_000_000 },
		},
		{
			name: "cloud.storage",
			external_customer_id: dashboard.project,
			metadata: { gb_days: 2 },
			external_id: `${dashboard.project}:storage:${new Date().toISOString().slice(0, 10)}`,
		},
	]);
	// Storage is sent once a day.
	await project.report({ root: "a", messages: 5, bytes: 2e9, connections: 1 });
	await project.alarm();
	expect(polarCalls.at(-1)!.body.events).toEqual([
		{
			name: "cloud.messages",
			external_customer_id: dashboard.project,
			metadata: { count: 5 },
		},
	]);

	const checkout = await handleServiceRequest(
		post("/account/checkout", { interval: "year" }, { Cookie: cookie }),
		env,
	);
	expect(await checkout.json()).toEqual({
		url: "https://polar.test/checkout/1",
	});
	expect(
		polarCalls.find((call) => call.path === "/v1/checkouts/")!.body,
	).toMatchObject({
		products: ["pro-yearly", "pro-monthly"],
		external_customer_id: dashboard.project,
		customer_email: "ada@example.com",
	});

	// Leaving Pro bills what is pending first.
	await project.report({ root: "a", messages: 3, bytes: 2e9, connections: 1 });
	await handleServiceRequest(
		await signedWebhook(stateChanged(dashboard.project, [])),
		env,
	);
	expect(polarCalls.at(-1)!.body.events[0]).toMatchObject({
		metadata: { count: 3 },
	});
	expect(project.config()!.plan).toBe("free");
});
