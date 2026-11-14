import { Seo } from "~/components/Seo";
import { useSearchParams } from "@solidjs/router";
import {
	createEffect,
	createSignal,
	For,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import {
	api,
	type Account,
	ApiError,
	messageOf,
	takeUpgrade,
} from "~/components/account";
import { Button } from "~/components/Button";
import { Card } from "~/components/Card";
import { CodeBlock } from "~/components/CodeBlock";
import { setSignedIn } from "~/components/Header";
import { Icon } from "~/components/Icon";
import { Sky } from "~/components/Sky";
import cloud from "~/components/Cloud.module.css";
import styles from "~/components/Dashboard.module.css";
import { SignInCard } from "./sign-in";

const count = new Intl.NumberFormat("en");
const decimal = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });

/** Decimal units, like the plans: 1 GB is 10⁹ bytes. */
const formatBytes = (bytes: number) =>
	bytes >= 1e9
		? `${decimal.format(bytes / 1e9)} GB`
		: `${decimal.format(bytes / 1e6)} MB`;

const installCode = "npm install pulsify-core pulsify-cloud";

const envCode = (url: string) => `PULSIFY_URL=${url}
PULSIFY_TOKEN_SECRET=<copy it from Project above>
PULSIFY_API_KEY=<copy it from Project above>`;

const backendCode = `import { createCloudClient, signCloudToken } from "pulsify-cloud";

const cloud = createCloudClient({
  url: process.env.PULSIFY_URL!,
  credential: process.env.PULSIFY_API_KEY!,
});

// Where your app creates a user: they own the documents under their ID.
export async function onSignUp(user: { id: string }) {
  await cloud.grant({ subject: user.id, prefix: user.id, role: "owner" });
}

// GET /api/pulsify-token, behind your session middleware.
export async function pulsifyToken(user: { id: string }) {
  const token = await signCloudToken(
    { subject: user.id },
    process.env.PULSIFY_TOKEN_SECRET!,
    { expiresIn: "15m" },
  );
  return new Response(token);
}`;

const connectorCode = (
	url: string,
) => `import { createCloudConnector } from "pulsify-cloud";
import { loadPulse } from "pulsify-core";

export const cloud = createCloudConnector({
  url: "${url}",
  token: () => fetch("/api/pulsify-token").then((response) => response.text()),
});

// Any pulse loaded or created with this connector syncs live.
const notebook = await loadPulse(Notebook, user.id, { connectors: [cloud] });`;

export default function Dashboard() {
	const [params, setParams] = useSearchParams();
	// undefined while loading, null when signed out.
	const [account, setAccount] = createSignal<Account | null>();
	const [loadError, setLoadError] = createSignal<string>();
	const [error, setError] = createSignal<string>();
	const [busy, setBusy] = createSignal<string>();
	const [expired, setExpired] = createSignal(false);
	const [upgraded, setUpgraded] = createSignal(false);
	createEffect(() => {
		if (account() !== undefined) setSignedIn(account() !== null);
	});
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

	function remove() {
		if (
			!confirm(
				"Delete this project? Every document it stores and your account are erased, and its URL and secrets stop working at once. This cannot be undone.",
			)
		)
			return;
		void run("delete", async () => {
			await api("delete", {});
			setExpired(false);
			setAccount(null);
		});
	}

	/** Loads the account; Pro picked on the pricing page while signed out goes on to the checkout. */
	async function enter() {
		await load();
		if (!account()) return;
		if (takeUpgrade() && account()?.plan === "free")
			void redirect("checkout", "checkout", {});
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
		void enter();
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
		<Sky class={styles.fullHeight}>
			<Seo title="Dashboard · Pulsify Cloud" noindex />
			<Switch
				fallback={
					<main class={styles.page}>
						<span class={styles.loader} role="status" aria-label="Loading" />
					</main>
				}
			>
				<Match when={account() === null && !loadError()}>
					<main class={`${styles.page} ${styles.signIn}`}>
						<SignInCard
							expired={expired()}
							onSignIn={() => {
								setExpired(false);
								setAccount(undefined); // The loader, not the form, until the account is in.
								void enter();
							}}
						/>
					</main>
				</Match>
				<Match when={account() || loadError()}>
					<main class={styles.page}>
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

						<Switch>
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
												{current().plan === "pro" ? "Pro" : "Free"} plan, this
												month
											</h2>
											<For
												each={[
													{
														label: "Document opens and updates",
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
															uploads stop with <code>LIMIT_EXCEEDED</code>;
															loading and receiving keep working. Above the
															connection limit, new sockets are refused. Pro
															prices exclude VAT, added at checkout for your
															country. Polar, our reseller, sells the
															subscription under our{" "}
															<a href="/legal/terms">Terms of Service</a>.
														</p>
														<div class={styles.actions}>
															<Button
																icon="arrow"
																disabled={busy() === "checkout"}
																onClick={() =>
																	redirect("checkout", "checkout", {})
																}
															>
																Upgrade to Pro
															</Button>
														</div>
													</>
												}
											>
												<p class={cloud.text}>
													Usage above the included amounts is billed, not
													blocked: €2 per million opens and updates and €0.50
													per GB-month, excluding VAT. Above the connection
													limit, new sockets are refused.
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
											<ol class={`${cloud.steps} ${styles.steps}`}>
												<li>
													<p>
														<strong>Install</strong> the packages in your app.
													</p>
													<CodeBlock title="terminal" code={installCode} />
												</li>
												<li>
													<p>
														<strong>Configure your backend</strong> with the
														three values above. Never commit them.
													</p>
													<CodeBlock
														title=".env"
														code={envCode(current().url)}
													/>
												</li>
												<li>
													<p>
														<strong>Grant and sign on your backend:</strong>{" "}
														give each new user the owner role on their
														documents, and serve signed-in users a short-lived
														token.
													</p>
													<CodeBlock title="backend.ts" code={backendCode} />
												</li>
												<li>
													<p>
														<strong>Connect your client</strong> and load your
														pulses through the connector.
													</p>
													<CodeBlock
														title="cloud.ts"
														code={connectorCode(current().url)}
													/>
												</li>
											</ol>
											<p class={cloud.text}>
												The <a href="/docs/cloud/tutorial">tutorial</a> builds a
												full notes app on these steps.{" "}
												<a href="/docs/cloud/authentication">Authentication</a>{" "}
												covers roles, sharing and public documents.
											</p>
										</Card>

										<Card class={styles.panel}>
											<h2 class={styles.panelTitle}>Delete project</h2>
											<p class={cloud.text}>
												Erases the project, every document it stores and your
												account. It cannot be undone.{" "}
												<Show when={current().plan === "pro"}>
													Cancel your subscription from "Manage billing" first:
													the project can be deleted once it is back on Free.
												</Show>
											</p>
											<div class={styles.actions}>
												<Button
													variant="outline"
													disabled={
														busy() === "delete" || current().plan === "pro"
													}
													onClick={remove}
												>
													{busy() === "delete" ? "Deleting…" : "Delete project"}
												</Button>
											</div>
										</Card>
									</>
								)}
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
				</Match>
			</Switch>
		</Sky>
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
