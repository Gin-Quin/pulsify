import { CloudError } from "pulsify-cloud";
import { errorResponse, jsonResponse } from "pulsify-cloud-server";
import { handleCloudRequest } from "pulsify-cloud-server/cloudflare";
import { call, type DurableNamespace, type DurableStub } from "./durable.js";
import { polar, verifyWebhook, type PolarEnv } from "./polar.js";
import type { Dashboard, Plan, ProjectConfig } from "./Project.js";
import { PROJECT_HEADER } from "./Root.js";

export type EmailMessage = {
	to: string;
	from: string | { email: string; name?: string };
	subject: string;
	text: string;
	html: string;
};
export type ServiceEnv = PolarEnv & {
	ROOTS: DurableNamespace;
	PROJECTS: DurableNamespace;
	ACCOUNTS: DurableNamespace;
	/** Cloudflare Email Sending binding. */
	EMAIL: { send(message: EmailMessage): Promise<unknown> };
	/** Sender of login links, on a domain onboarded to Email Sending. */
	EMAIL_FROM: string;
	/** This Worker's public origin, `https://api.pulsify.cloud`. */
	API_URL: string;
	/** The dashboard page, `https://pulsify.cloud/dashboard`. */
	DASHBOARD_URL: string;
	/** `bun run dev:service` only: a login code that signs in any address that asked for one. */
	DEV_LOGIN_CODE?: string;
	PULSIFY_COMPACT_AFTER_MS?: string;
};

const PROJECT_ID = /^[a-z2-7]{16}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_COOKIE = "pulsify_session";
const CONFIG_TTL_MS = 60_000;

const projectStub = (env: ServiceEnv, project: string): DurableStub =>
	env.PROJECTS.get(env.PROJECTS.idFromName(project));

// ponytail: per-isolate cache, so a rotated secret takes up to a minute everywhere.
const configs = new Map<string, { config: ProjectConfig | null; at: number }>();
async function projectConfig(
	env: ServiceEnv,
	project: string,
): Promise<ProjectConfig | null> {
	const cached = configs.get(project);
	if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config;
	const config = await call<ProjectConfig | null>(
		projectStub(env, project),
		"config",
	);
	configs.set(project, { config, at: Date.now() });
	return config;
}

/** `/<project>/v1/…`: the Pulsify Cloud protocol, with the project's secrets and roots. */
async function tenant(
	request: Request,
	env: ServiceEnv,
	project: string,
	path: string,
): Promise<Response> {
	const config = await projectConfig(env, project);
	if (!config)
		return errorResponse(new CloudError("NOT_FOUND", "Unknown project"));
	const url = new URL(request.url);
	url.pathname = path;
	const roots: DurableNamespace = {
		idFromName: (root) => env.ROOTS.idFromName(`${project}/${root}`),
		get: (id) => {
			const stub = env.ROOTS.get(id);
			return {
				fetch(forwarded) {
					const headers = new Headers(forwarded.headers);
					headers.set(PROJECT_HEADER, project);
					return stub.fetch(new Request(forwarded, { headers }));
				},
			};
		},
	};
	return handleCloudRequest(new Request(url, request), {
		PULSIFY_ROOTS: roots,
		PULSIFY_TOKEN_SECRET: config.tokenSecret,
		PULSIFY_API_KEY: config.apiKey,
	});
}

function cors(env: ServiceEnv): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": new URL(env.DASHBOARD_URL).origin,
		"Access-Control-Allow-Credentials": "true",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		Vary: "Origin",
	};
}

function readSession(request: Request) {
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const [name, value] = part.trim().split("=");
		if (name !== SESSION_COOKIE || !value) continue;
		const [project, secret] = value.split(".");
		if (project && secret && PROJECT_ID.test(project))
			return { project, secret };
	}
	return undefined;
}

function sessionCookie(value: string, maxAge: number): string {
	return `${SESSION_COOKIE}=${value}; Path=/account; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function sendLoginLink(
	env: ServiceEnv,
	email: string,
	link: string,
	code: string,
) {
	// `bun run dev:service` only: the API is never served over plain HTTP.
	if (env.API_URL.startsWith("http://"))
		console.log(`Login for ${email}: code ${code}, link ${link}`);
	await env.EMAIL.send({
		to: email,
		from: env.EMAIL_FROM,
		subject: `${code} is your Pulsify Cloud sign-in code`,
		text: `Your Pulsify Cloud sign-in code is ${code}. Or open this link:\n\n${link}\n\nBoth work for 15 minutes. If you did not ask for them, ignore this email.`,
		html: `<p>Your Pulsify Cloud sign-in code is <strong>${code}</strong>.</p><p>Or <a href="${link}">open the dashboard</a>.</p><p>Both work for 15 minutes. If you did not ask for them, ignore this email.</p>`,
	});
}

/** Starts a session in `project`, created on first sign-in; returns its cookie. */
async function signIn(env: ServiceEnv, project: string, email: string) {
	const stub = projectStub(env, project);
	await call(stub, "create", project, email);
	const secret = await call<string>(stub, "startSession");
	return sessionCookie(`${project}.${secret}`, 30 * 86_400);
}

const emailOf = (value: unknown) =>
	String(value ?? "")
		.trim()
		.toLowerCase();

/** `/account/…`: login links, the dashboard's data, secrets and billing. */
async function account(
	request: Request,
	env: ServiceEnv,
	action: string,
): Promise<Response> {
	const headers = cors(env);
	const json = (body: unknown, status = 200) =>
		Response.json(body, { status, headers });
	if (request.method === "OPTIONS")
		return new Response(null, { status: 204, headers });

	if (action === "verify" && request.method === "GET") {
		const url = new URL(request.url);
		const email = url.searchParams.get("email")?.toLowerCase() ?? "";
		const token = url.searchParams.get("token") ?? "";
		const project = EMAIL.test(email)
			? await call<string | null>(
					env.ACCOUNTS.get(env.ACCOUNTS.idFromName(email)),
					"verify",
					token,
				)
			: null;
		if (!project)
			return Response.redirect(`${env.DASHBOARD_URL}?login=expired`, 302);
		return new Response(null, {
			status: 302,
			headers: {
				Location: env.DASHBOARD_URL,
				"Set-Cookie": await signIn(env, project, email),
			},
		});
	}

	if (request.method !== "GET" && request.method !== "POST")
		return json({ error: "Method not allowed" }, 405);
	// Cookies are SameSite=Lax; this also stops other origins from posting.
	if (
		request.method === "POST" &&
		request.headers.get("Origin") !== headers["Access-Control-Allow-Origin"]
	)
		return json({ error: "Forbidden origin" }, 403);
	const body =
		request.method === "POST"
			? ((await request.json().catch(() => ({}))) as Record<string, unknown>)
			: {};

	if (action === "login" && request.method === "POST") {
		const email = emailOf(body["email"]);
		if (email.length > 254 || !EMAIL.test(email))
			return json({ error: "Enter a valid email address" }, 400);
		const login = await call<{ token: string; code: string } | null>(
			env.ACCOUNTS.get(env.ACCOUNTS.idFromName(email)),
			"login",
		);
		if (login)
			await sendLoginLink(
				env,
				email,
				`${env.API_URL}/account/verify?email=${encodeURIComponent(email)}&token=${login.token}`,
				login.code,
			);
		// The same answer whether the address has an account or was just mailed.
		return json({ ok: true });
	}

	if (action === "code" && request.method === "POST") {
		const email = emailOf(body["email"]);
		const code = String(body["code"] ?? "").trim();
		const project =
			EMAIL.test(email) && /^\d{6}$/.test(code)
				? await call<string | null>(
						env.ACCOUNTS.get(env.ACCOUNTS.idFromName(email)),
						"verifyCode",
						code,
						code === env.DEV_LOGIN_CODE,
					)
				: null;
		if (!project) return json({ error: "That code is wrong or expired" }, 400);
		return new Response(null, {
			status: 204,
			headers: { ...headers, "Set-Cookie": await signIn(env, project, email) },
		});
	}

	const session = readSession(request);
	const stub = session && projectStub(env, session.project);
	if (!session || !stub || !(await call(stub, "checkSession", session.secret)))
		return json({ error: "Sign in first" }, 401);
	const view = (dashboard: Dashboard | null) =>
		json({ ...dashboard, url: `${env.API_URL}/${session.project}` });

	switch (`${request.method} ${action}`) {
		case "GET ":
			return view(await call<Dashboard>(stub, "dashboard"));
		case "POST rotate": {
			const secret = body["secret"] === "api" ? "api" : "token";
			const dashboard = await call<Dashboard>(stub, "rotate", secret);
			configs.delete(session.project);
			return view(dashboard);
		}
		case "POST checkout": {
			const dashboard = (await call<Dashboard>(stub, "dashboard"))!;
			const checkout = await polar<{ url: string }>(env, "/v1/checkouts/", {
				// The checkout page offers both intervals; the first is preselected.
				products:
					body["interval"] === "year"
						? [env.POLAR_PRO_YEARLY, env.POLAR_PRO_MONTHLY]
						: [env.POLAR_PRO_MONTHLY, env.POLAR_PRO_YEARLY],
				external_customer_id: session.project,
				customer_email: dashboard.email,
				success_url: `${env.DASHBOARD_URL}?upgraded=1`,
				return_url: env.DASHBOARD_URL,
			});
			return json({ url: checkout.url });
		}
		case "POST billing": {
			const portal = await polar<{ customer_portal_url: string }>(
				env,
				"/v1/customer-sessions/",
				{
					external_customer_id: session.project,
					return_url: env.DASHBOARD_URL,
				},
			);
			return json({ url: portal.customer_portal_url });
		}
		case "POST delete": {
			const email = await call<string | null>(stub, "delete");
			if (!email)
				return json(
					{
						error:
							"Cancel your subscription from Manage billing first: a project can be deleted once it is back on Free.",
					},
					409,
				);
			await call(env.ACCOUNTS.get(env.ACCOUNTS.idFromName(email)), "delete");
			configs.delete(session.project);
			return new Response(null, {
				status: 204,
				headers: { ...headers, "Set-Cookie": sessionCookie("", 0) },
			});
		}
		case "POST logout":
			await call(stub, "endSession", session.secret);
			return new Response(null, {
				status: 204,
				headers: { ...headers, "Set-Cookie": sessionCookie("", 0) },
			});
	}
	return json({ error: "Not found" }, 404);
}

type CustomerState = {
	external_id?: string | null;
	active_subscriptions?: { product_id: string }[];
};

/** Polar's webhook: a customer's state sets its project's plan. */
async function webhook(request: Request, env: ServiceEnv): Promise<Response> {
	const body = await request.text();
	if (!(await verifyWebhook(body, request.headers, env.POLAR_WEBHOOK_SECRET)))
		return new Response("Invalid signature", { status: 403 });
	const event = JSON.parse(body) as { type: string; data: CustomerState };
	const project = event.data?.external_id;
	if (
		event.type === "customer.state_changed" &&
		project &&
		PROJECT_ID.test(project)
	) {
		const pro = [env.POLAR_PRO_MONTHLY, env.POLAR_PRO_YEARLY];
		const plan: Plan = (event.data.active_subscriptions ?? []).some((s) =>
			pro.includes(s.product_id),
		)
			? "pro"
			: "free";
		await call(projectStub(env, project), "setPlan", plan);
		configs.delete(project);
	}
	return new Response(null, { status: 202 });
}

export async function handleServiceRequest(
	request: Request,
	env: ServiceEnv,
): Promise<Response> {
	try {
		const url = new URL(request.url);
		const [, first = "", ...rest] = url.pathname.split("/");
		// Secrets, tokens and documents travel with every request: never in clear.
		if (url.protocol === "http:" && env.API_URL.startsWith("https:"))
			return new Response("Use https://", { status: 403 });
		if (url.pathname === "/health") return jsonResponse({ ok: true });
		if (first === "account")
			return await account(request, env, rest.join("/")).catch((error) => {
				console.error(error);
				return Response.json(
					{ error: "Something went wrong, try again" },
					{ status: 502, headers: cors(env) },
				);
			});
		if (url.pathname === "/polar/webhook" && request.method === "POST")
			return await webhook(request, env);
		if (PROJECT_ID.test(first))
			return await tenant(request, env, first, `/${rest.join("/")}`);
		throw new CloudError("NOT_FOUND", "Unknown route");
	} catch (error) {
		console.error(error);
		return errorResponse(error);
	}
}
