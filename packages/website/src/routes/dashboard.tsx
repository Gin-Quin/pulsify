import { Title } from "@solidjs/meta";
import { useSearchParams } from "@solidjs/router";
import {
	createSignal,
	For,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { Button } from "~/components/Button";
import { Card } from "~/components/Card";
import { CodeBlock } from "~/components/CodeBlock";
import { Icon } from "~/components/Icon";
import { PULSIFY_API } from "~/components/links";
import { Sky } from "~/components/Sky";
import cloud from "~/components/Cloud.module.css";
import styles from "~/components/Dashboard.module.css";

type Usage = { messages: number; bytes: number; connections: number };

type Account = {
	project: string;
	email: string;
	plan: "free" | "pro";
	tokenSecret: string;
	apiKey: string;
	url: string;
	usage: Usage;
	limits: Usage;
};

class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** `/account/<action>`: a GET without a body, a JSON POST with one. */
async function api<T>(action: string, body?: object): Promise<T> {
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

const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const count = new Intl.NumberFormat("en");
const decimal = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });

/** Decimal units, like the plans: 1 GB is 10⁹ bytes. */
const formatBytes = (bytes: number) =>
	bytes >= 1e9
		? `${decimal.format(bytes / 1e9)} GB`
		: `${decimal.format(bytes / 1e6)} MB`;

const connectorCode = (
	url: string,
) => `import { createCloudConnector } from "pulsify-cloud";

const cloud = createCloudConnector({
  url: "${url}",
  token: () => fetch("/api/pulsify-token").then((response) => response.text()),
});`;

export default function Dashboard() {
	const [params, setParams] = useSearchParams();
	// undefined while loading, null when signed out.
	const [account, setAccount] = createSignal<Account | null>();
	const [loadError, setLoadError] = createSignal<string>();
	const [error, setError] = createSignal<string>();
	const [busy, setBusy] = createSignal<string>();
	const [expired, setExpired] = createSignal(false);
	const [upgraded, setUpgraded] = createSignal(false);
	const timers: ReturnType<typeof setTimeout>[] = [];
	onCleanup(() => timers.forEach(clearTimeout));

	async function load() {
		setLoadError(undefined);
		try {
			setAccount(await api<Account>(""));
		} catch (cause) {
			if (cause instanceof ApiError && cause.status === 401) setAccount(null);
			else setLoadError(messageOf(cause));
		}
	}

	/** Runs one action at a time; a 401 means the session ended. */
	async function run(name: string, action: () => Promise<void>) {
		setBusy(name);
		setError(undefined);
		try {
			await action();
		} catch (cause) {
			if (cause instanceof ApiError && cause.status === 401) setAccount(null);
			setError(messageOf(cause));
		} finally {
			setBusy(undefined);
		}
	}

	function rotate(secret: "token" | "api") {
		const name =
			secret === "token" ? "PULSIFY_TOKEN_SECRET" : "PULSIFY_API_KEY";
		if (
			!confirm(
				`Rotate ${name}? The current value stops working within a minute: update your backend with the new one right away.`,
			)
		)
			return;
		void run(`rotate-${secret}`, async () => {
			setAccount(await api<Account>("rotate", { secret }));
		});
	}

	const redirect = (name: string, action: string, body: object) =>
		run(name, async () => {
			location.href = (await api<{ url: string }>(action, body)).url;
		});

	onMount(() => {
		setExpired(params.login === "expired");
		setUpgraded(params.upgraded === "1");
		if (params.login || params.upgraded)
			setParams({ login: undefined, upgraded: undefined }, { replace: true });
		void load();
		// The payment webhook can land a few seconds after the redirect.
		if (upgraded())
			for (const delay of [3_000, 8_000])
				timers.push(
					setTimeout(() => {
						if (account() && account()?.plan !== "pro") void load();
					}, delay),
				);
	});

	return (
		<Sky>
			<main class={styles.page}>
				<Title>Dashboard · Pulsify Cloud</Title>
				<header class={styles.head}>
					<div>
						<p class={cloud.eyebrow}>Pulsify Cloud</p>
						<h1 class={styles.title}>Dashboard</h1>
					</div>
					<Show when={account()}>
						{(current) => (
							<div class={styles.who}>
								<span>{current().email}</span>
								<span class={styles.plan} data-plan={current().plan}>
									{current().plan === "pro" ? "Pro" : "Free"}
								</span>
								<Button
									variant="outline"
									size="sm"
									disabled={busy() === "logout"}
									onClick={() =>
										run("logout", async () => {
											await api("logout", {});
											setExpired(false);
											setAccount(null);
										})
									}
								>
									Sign out
								</Button>
							</div>
						)}
					</Show>
				</header>

				<Show when={error()}>
					<p class={styles.error} role="alert">
						{error()}
					</p>
				</Show>

				<Switch
					fallback={
						<Card>
							<p class={cloud.text} role="status">
								Loading your project…
							</p>
						</Card>
					}
				>
					<Match when={account()}>
						{(current) => (
							<>
								<Show when={upgraded()}>
									<p class={styles.notice} role="status">
										Thanks, your project is now on Pro. It can take a few
										seconds to show.
									</p>
								</Show>

								<Card class={styles.panel}>
									<h2 class={styles.panelTitle}>Project</h2>
									<p class={cloud.text}>
										Your backend needs these three values. Keep both secrets
										server side.
									</p>
									<Field
										label="Cloud URL"
										value={current().url}
										hint="The url option of createCloudConnector and createCloudClient."
									/>
									<Field
										label="PULSIFY_TOKEN_SECRET"
										value={current().tokenSecret}
										hint="Signs your users' tokens."
										secret
										rotating={busy() === "rotate-token"}
										onRotate={() => rotate("token")}
									/>
									<Field
										label="PULSIFY_API_KEY"
										value={current().apiKey}
										hint="Manages grants and reads usage. Never ship it to a browser."
										secret
										rotating={busy() === "rotate-api"}
										onRotate={() => rotate("api")}
									/>
								</Card>

								<Card class={styles.panel}>
									<h2 class={styles.panelTitle}>
										{current().plan === "pro" ? "Pro" : "Free"} plan, this month
									</h2>
									<For
										each={[
											{
												label: "Messages",
												used: current().usage.messages,
												limit: current().limits.messages,
												format: (n: number) => count.format(n),
											},
											{
												label: "Storage",
												used: current().usage.bytes,
												limit: current().limits.bytes,
												format: formatBytes,
											},
											{
												label: "Live connections",
												used: current().usage.connections,
												limit: current().limits.connections,
												format: (n: number) => count.format(n),
											},
										]}
									>
										{(meter) => (
											<div class={styles.meter}>
												<div class={styles.meterHead}>
													<span>{meter.label}</span>
													<span>
														{meter.format(meter.used)} /{" "}
														{meter.format(meter.limit)}
													</span>
												</div>
												<div class={styles.bar} aria-hidden="true">
													<span
														data-full={meter.used >= meter.limit}
														style={{
															width: `${meter.limit > 0 ? Math.min(100, (meter.used / meter.limit) * 100) : 100}%`,
														}}
													/>
												</div>
											</div>
										)}
									</For>
									<Show
										when={current().plan === "pro"}
										fallback={
											<>
												<p class={cloud.text}>
													Free never bills. At the message or storage limit,
													uploads stop with <code>LIMIT_EXCEEDED</code>; loading
													and receiving keep working. Above the connection
													limit, new sockets are refused. Pro prices exclude
													VAT, added at checkout for your country.
												</p>
												<div class={styles.actions}>
													<Button
														icon="arrow"
														disabled={busy() === "checkout-month"}
														onClick={() =>
															redirect("checkout-month", "checkout", {
																interval: "month",
															})
														}
													>
														Upgrade, €25/month
													</Button>
													<Button
														variant="outline"
														disabled={busy() === "checkout-year"}
														onClick={() =>
															redirect("checkout-year", "checkout", {
																interval: "year",
															})
														}
													>
														Yearly, €250/year
													</Button>
												</div>
											</>
										}
									>
										<p class={cloud.text}>
											Usage above the included amounts is billed, not blocked:
											€2 per million messages and €0.50 per GB-month, excluding
											VAT. Above the connection limit, new sockets are refused.
										</p>
										<div class={styles.actions}>
											<Button
												variant="outline"
												disabled={busy() === "billing"}
												onClick={() => redirect("billing", "billing", {})}
											>
												Manage billing
											</Button>
										</div>
									</Show>
								</Card>

								<Card class={styles.panel}>
									<h2 class={styles.panelTitle}>Next steps</h2>
									<ol class={cloud.steps}>
										<li>
											Follow the <a href="/docs/cloud/tutorial">tutorial</a> to
											build a notes app on your project.
										</li>
										<li>
											Grant roles and sign tokens from your backend: see{" "}
											<a href="/docs/cloud/authentication">Authentication</a>.
										</li>
									</ol>
									<CodeBlock
										title="cloud.ts"
										code={connectorCode(current().url)}
									/>
								</Card>
							</>
						)}
					</Match>

					<Match when={account() === null}>
						<SignIn expired={expired()} />
					</Match>

					<Match when={loadError()}>
						<Card class={styles.panel}>
							<h2 class={styles.panelTitle}>Could not load your project</h2>
							<p class={styles.error} role="alert">
								{loadError()}
							</p>
							<div class={styles.actions}>
								<Button variant="outline" onClick={() => void load()}>
									Try again
								</Button>
							</div>
						</Card>
					</Match>
				</Switch>
			</main>
		</Sky>
	);
}

function SignIn(props: { expired: boolean }) {
	const [email, setEmail] = createSignal("");
	const [sentTo, setSentTo] = createSignal<string>();
	const [error, setError] = createSignal<string>();
	const [sending, setSending] = createSignal(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		setSending(true);
		setError(undefined);
		try {
			await api("login", { email: email().trim() });
			setSentTo(email().trim());
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setSending(false);
		}
	}

	return (
		<Card class={styles.panel}>
			<Show
				when={sentTo()}
				fallback={
					<>
						<Show when={props.expired}>
							<p class={styles.notice} role="alert">
								That sign-in link is invalid or expired. Ask for a new one
								below.
							</p>
						</Show>
						<h2 class={styles.panelTitle}>Sign in</h2>
						<p class={cloud.text}>
							We email you a sign-in link, no password. A new address gets a
							free project.
						</p>
						<form class={styles.form} onSubmit={submit}>
							<label class={styles.label} for="dashboard-email">
								Email
							</label>
							<div class={styles.row}>
								<input
									id="dashboard-email"
									class={styles.input}
									type="email"
									name="email"
									autocomplete="email"
									placeholder="you@example.com"
									required
									value={email()}
									onInput={(event) => setEmail(event.currentTarget.value)}
								/>
								<Button type="submit" icon="arrow" disabled={sending()}>
									{sending() ? "Sending…" : "Email me a link"}
								</Button>
							</div>
						</form>
						<Show when={error()}>
							<p class={styles.error} role="alert">
								{error()}
							</p>
						</Show>
					</>
				}
			>
				<h2 class={styles.panelTitle}>Check your inbox</h2>
				<p class={cloud.text} role="status">
					If <strong>{sentTo()}</strong> is a valid address, a sign-in link is
					on its way. It works for 15 minutes. Nothing after a minute? Check
					your spam folder, then ask for a new link: we send at most one per
					minute.
				</p>
				<div class={styles.actions}>
					<Button variant="outline" onClick={() => setSentTo(undefined)}>
						Send another link
					</Button>
				</div>
			</Show>
		</Card>
	);
}

function Field(props: {
	label: string;
	value: string;
	hint: string;
	secret?: boolean;
	rotating?: boolean;
	onRotate?: () => void;
}) {
	const [shown, setShown] = createSignal(false);
	const [copied, setCopied] = createSignal(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(timer));

	async function copy() {
		try {
			await navigator.clipboard.writeText(props.value);
		} catch {
			return; // Clipboard blocked: the value can still be selected by hand.
		}
		setCopied(true);
		clearTimeout(timer);
		timer = setTimeout(() => setCopied(false), 2_000);
	}

	const visible = () => !props.secret || shown();
	return (
		<div class={styles.field}>
			<span class={styles.label}>{props.label}</span>
			<div class={styles.valueRow}>
				<code class={styles.value}>
					{visible() ? props.value : "•".repeat(32)}
				</code>
				<div class={styles.tools}>
					<Show when={props.secret}>
						<button
							class={styles.tool}
							type="button"
							aria-pressed={shown()}
							aria-label={`${shown() ? "Hide" : "Show"} ${props.label}`}
							onClick={() => setShown(!shown())}
						>
							<Icon name="eye" size="1em" />
							{shown() ? "Hide" : "Show"}
						</button>
					</Show>
					<button
						class={styles.tool}
						type="button"
						aria-label={`Copy ${props.label}`}
						onClick={() => void copy()}
					>
						<Icon name={copied() ? "check" : "copy"} size="1em" />
						{copied() ? "Copied" : "Copy"}
					</button>
					<Show when={props.onRotate}>
						<button
							class={styles.tool}
							type="button"
							aria-label={`Rotate ${props.label}`}
							disabled={props.rotating}
							onClick={() => props.onRotate?.()}
						>
							<Icon name="sync" size="1em" />
							{props.rotating ? "Rotating…" : "Rotate"}
						</button>
					</Show>
				</div>
			</div>
			<p class={styles.hint}>{props.hint}</p>
		</div>
	);
}
