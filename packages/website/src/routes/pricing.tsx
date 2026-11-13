import { Title } from "@solidjs/meta";
import { useNavigate } from "@solidjs/router";
import { createSignal, For, type JSX, Show } from "solid-js";
import {
	api,
	type Account,
	ApiError,
	messageOf,
	rememberUpgrade,
} from "~/components/account";
import { Button } from "~/components/Button";
import { Card } from "~/components/Card";
import { setSignedIn } from "~/components/Header";
import { Icon, type IconName } from "~/components/Icon";
import { Sky } from "~/components/Sky";
import styles from "~/components/Cloud.module.css";
import dashboard from "~/components/Dashboard.module.css";

/** `true` renders a check mark. Columns: CRDT engine, Cloud Free, Cloud Pro. */
const rows: [string, ...(string | true)[]][] = [
	["Price", "Free, forever", "€0", "€25/month or €250/year"],
	["License", "Apache 2.0", "Hosted service", "Hosted service"],
	["Typed documents, rich text and presence", true, true, true],
	["React, Vue, Solid and Svelte bindings", true, true, true],
	["ProseMirror, Lexical and CodeMirror bindings", true, true, true],
	["Local persistence and offline editing", true, true, true],
	[
		"Relay and storage",
		"You host them, on your database",
		"Managed",
		"Managed",
	],
	[
		"Access control",
		"Your upgrade handler",
		"Tokens and per-root grants",
		"Tokens and per-root grants",
	],
	["Concurrent connections", "Unmetered", "100", "1,000"],
	[
		"Messages a month",
		"Unmetered",
		"1 million",
		"5 million, then €2 per million",
	],
	["Storage", "Unmetered", "1 GB", "10 GB, then €0.50 per GB-month"],
	[
		"Beyond messages or storage",
		"Not applicable",
		"Uploads stop, reading keeps working",
		"Billed, never blocked",
	],
];

function Plan(props: {
	icon: IconName;
	name: string;
	price: string;
	text: string;
	children: JSX.Element;
}) {
	return (
		<Card class={styles.feature}>
			<Icon name={props.icon} size="1.6rem" class={styles.icon} />
			<h2 class={styles.featureTitle}>{props.name}</h2>
			<p class={styles.heading}>{props.price}</p>
			<p class={styles.text}>{props.text}</p>
			<div class={styles.planActions}>{props.children}</div>
		</Card>
	);
}

export default function Pricing() {
	const navigate = useNavigate();
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string>();

	/** Straight to the Polar checkout; signed out, the dashboard resumes it after sign-in. */
	async function upgrade() {
		setBusy(true);
		setError(undefined);
		try {
			const account = await api<Account>("");
			// Already subscribed: the dashboard manages billing, no second checkout.
			if (account.plan === "pro") return navigate("/dashboard");
			// Monthly or yearly is picked on the checkout page.
			location.href = (await api<{ url: string }>("checkout", {})).url;
		} catch (cause) {
			if (cause instanceof ApiError && cause.status === 401) {
				rememberUpgrade();
				setSignedIn(false);
				navigate("/sign-in");
			} else setError(messageOf(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Sky>
			<main class={styles.starryTop}>
				<Title>Pricing · Pulsify</Title>
				<section class={`${styles.section} ${styles.plansHead}`}>
					<h1 class={styles.title}>
						Free CRDT engine.
						<br />
						<span class={styles.gradient}>
							Distributed, scalable cloud on the edge.
						</span>
					</h1>
					<div class={styles.grid}>
						<Plan
							icon="layers"
							name="CRDT engine"
							price="Free, forever"
							text="Open source under Apache 2.0. Use it in any product, commercial or not, and host it on your own servers. No account, no key, no limit."
						>
							<Button href="/docs" variant="outline">
								Read the docs
							</Button>
						</Plan>
						<Plan
							icon="cloud"
							name="Cloud Free"
							price="€0"
							text="The managed relay and storage, for prototypes and small apps. Stops at its limits and never bills."
						>
							<Button href="/dashboard" icon="arrow">
								Get started
							</Button>
						</Plan>
						<Plan
							icon="bolt"
							name="Cloud Pro"
							price="€25/month"
							text="Or €250/year. Ten times the storage and connections, and usage beyond the included amounts is billed instead of blocked."
						>
							<Button icon="arrow" disabled={busy()} onClick={upgrade}>
								Go Pro
							</Button>
							<Show when={error()}>
								<p class={dashboard.error} role="alert">
									{error()}
								</p>
							</Show>
						</Plan>
					</div>
				</section>

				<section class={styles.section}>
					<Card class={styles.compare}>
						<h2 class={styles.heading}>What is included</h2>
						<p class={styles.text}>
							In the cloud, only messages sent by clients count: delivering one
							change to fifty peers is one message, and presence such as cursors
							does not count.
						</p>
						<div class={styles.scroll}>
							<table class={`${styles.table} ${styles.highlightLast}`}>
								<thead>
									<tr>
										<th />
										<th>CRDT engine</th>
										<th>Cloud Free</th>
										<th>Cloud Pro</th>
									</tr>
								</thead>
								<tbody>
									<For each={rows}>
										{([label, ...cells]) => (
											<tr>
												<th scope="row">{label}</th>
												<For each={cells}>
													{(cell) => (
														<td
															aria-label={
																cell === true ? "Included" : undefined
															}
														>
															{cell === true ? (
																<Icon
																	name="check"
																	size="1.2em"
																	class={styles.icon}
																/>
															) : (
																cell
															)}
														</td>
													)}
												</For>
											</tr>
										)}
									</For>
								</tbody>
							</table>
						</div>
						<p class={styles.footnote}>
							Cloud prices exclude VAT, added at checkout for your country.
							Polar, our reseller, sells the subscriptions under our{" "}
							<a href="/legal/terms">Terms of Service</a>: they renew until you
							cancel from the dashboard, and paid periods are not refunded.
							Above the connection limit of a plan, new sockets are refused and
							open ones stay open. Need more, a dedicated deployment or SSO?
							Enterprise is custom.
						</p>
						<div class={styles.actions}>
							<Button href="/cloud" variant="outline">
								About Pulsify Cloud
							</Button>
							<Button href="/dashboard" icon="arrow">
								Start for free
							</Button>
						</div>
					</Card>
				</section>
			</main>
		</Sky>
	);
}
