import { Seo } from "~/components/Seo";
import { For } from "solid-js";
import { Button } from "~/components/Button";
import { Card } from "~/components/Card";
import { CodeBlock } from "~/components/CodeBlock";
import { Icon, type IconName } from "~/components/Icon";
import { Sky } from "~/components/Sky";
import styles from "~/components/Cloud.module.css";

const connect = `import { createCloudConnector } from "pulsify-cloud";
import { loadPulse } from "pulsify-core";
import { Notebook } from "./schema";

// One connector. No relay, no database, no migrations to run.
const cloud = createCloudConnector({
  url: "https://api.pulsify.cloud/<your-project>",
  token: () => fetch("/api/pulsify-token").then((response) => response.text()),
});

// The user's root and every note below it, over one socket.
const notebook = await loadPulse(Notebook, user.id, { connectors: [cloud] });
notebook.name = "Stored at the edge";`;

const features: { icon: IconName; title: string; text: string }[] = [
	{
		icon: "cube",
		title: "One isolated root per namespace",
		text: "A user, a team or a project is a root: its own single-threaded actor with its own storage. Capacity grows with the number of roots, with no shared database to size.",
	},
	{
		icon: "bolt",
		title: "One socket per user and root",
		text: "Every document of a root is multiplexed over one WebSocket. Clients subscribe to exactly the documents they load: the root, one note, or a whole subtree.",
	},
	{
		icon: "shield",
		title: "Built-in authentication",
		text: "Your backend signs an identity token. Each root keeps its own grant table of readers, editors and owners, and applies changes to open sockets immediately.",
	},
	{
		icon: "database",
		title: "Operations, not blobs",
		text: "Pulsify stores immutable patch rows, so the cloud answers version-vector queries with an indexed read. No document is decoded on the server.",
	},
	{
		icon: "cloud",
		title: "Global and pay as you go",
		text: "A root lives near its first user and idle sockets hibernate. You pay for activity and storage.",
	},
	{
		icon: "branch",
		title: "Open protocol, no lock-in",
		text: "The cloud speaks the same versioned binary protocol as the open-source relay, and stores rows in the same schema as the self-hosted stores.",
	},
];

const plans = [
	{
		name: "Free",
		price: "€0",
		text: "100 concurrent connections, 1M document opens and updates a month, 1 GB stored. Stops at the limits, never bills.",
	},
	{
		name: "Pro",
		price: "€25/month",
		text: "Or €250/year. 1,000 concurrent connections, 5M document opens and updates a month and 25 GB included. Beyond: €2 per million opens and updates, €0.50 per GB-month.",
	},
];

const steps = [
	"Sign in and copy your project URL and secrets.",
	"Grant roles and sign tokens from your backend.",
	"Point the cloud connector at it and ship.",
];

export default function Cloud() {
	return (
		<Sky>
			<main>
				<Seo
					title="Pulsify Cloud: sync without servers"
					description="A managed CRDT database for your pulses, on the edge. Swap the connector and never manage a database again."
				/>
				<section class={styles.hero}>
					<div class={styles.inner}>
						<h1 class={styles.title}>
							Pulsify Cloud.
							<br />
							<span class={styles.gradient}>Sync without servers.</span>
						</h1>
						<p class={styles.lead}>
							A managed CRDT database for your pulses. Swap the connector and
							never manage a database again.
						</p>
						<div class={styles.actions}>
							<Button href="/dashboard" icon="arrow">
								Start for free
							</Button>
							<Button href="/docs/cloud" variant="outline">
								Read the docs
							</Button>
						</div>
					</div>
				</section>

				<section class={styles.section}>
					<div class={styles.split}>
						<div>
							<p class={styles.eyebrow}>Three steps</p>
							<h2 class={styles.heading}>Same code, zero infrastructure</h2>
							<ol class={styles.steps}>
								<For each={steps}>{(step) => <li>{step}</li>}</For>
							</ol>
							<p class={styles.text}>
								Local connectors keep working, so your app still renders
								instantly and edits offline. The cloud is the durable, always-on
								peer.
							</p>
						</div>
						<CodeBlock title="app.ts" code={connect} />
					</div>
				</section>

				<section class={styles.section}>
					<p class={styles.eyebrow}>Under the hood</p>
					<h2 class={styles.heading}>One actor per root</h2>
					<p class={styles.lead}>
						A collaborative namespace is a tiny stateful service: one writer at
						a time, many readers, a log to persist. Pulsify Cloud runs each root
						as its own actor.
					</p>
					<div class={styles.grid}>
						<For each={features}>
							{(feature) => (
								<Card class={styles.feature}>
									<Icon name={feature.icon} size="1.6rem" class={styles.icon} />
									<h3 class={styles.featureTitle}>{feature.title}</h3>
									<p class={styles.text}>{feature.text}</p>
								</Card>
							)}
						</For>
					</div>
				</section>

				<section class={styles.section}>
					<p class={styles.eyebrow}>Pricing</p>
					<h2 class={styles.heading}>Pay for activity, not fan-out</h2>
					<p class={styles.lead}>
						Relay is included. Only what clients send counts: each document they
						open and each batch of changes they upload. Delivering one update to
						fifty peers counts once, and presence such as cursors is free.
					</p>
					<div class={`${styles.grid} ${styles.plans}`}>
						<For each={plans}>
							{(plan) => (
								<Card class={styles.feature}>
									<h3 class={styles.featureTitle}>{plan.name}</h3>
									<p class={styles.heading}>{plan.price}</p>
									<p class={styles.text}>{plan.text}</p>
								</Card>
							)}
						</For>
					</div>
					<p class={styles.footnote}>
						Prices exclude VAT, added at checkout for your country. Need more, a
						dedicated deployment or SSO? Enterprise is custom. The CRDT engine
						itself is free and open source:{" "}
						<a href="/pricing">compare what each option includes</a>.
					</p>
				</section>

				<section class={styles.section}>
					<Card class={styles.compare}>
						<div>
							<h2 class={styles.heading}>Cloud or self-hosted?</h2>
							<p class={styles.text}>
								Both use the open-source core and the same connector on the
								client.
							</p>
						</div>
						<table class={styles.table}>
							<thead>
								<tr>
									<th />
									<th>Pulsify Cloud</th>
									<th>Self-hosted</th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<th scope="row">Storage</th>
									<td>Managed, per root</td>
									<td>Your own database</td>
								</tr>
								<tr>
									<th scope="row">Relay</th>
									<td>Managed: changes reach other clients live</td>
									<td>You run the relay server</td>
								</tr>
								<tr>
									<th scope="row">Scaling</th>
									<td>Automatic, per root</td>
									<td>You size the relay and database</td>
								</tr>
								<tr>
									<th scope="row">Access control</th>
									<td>Built in: tokens and per-root grants</td>
									<td>Your upgrade handler</td>
								</tr>
								<tr>
									<th scope="row">Location</th>
									<td>Near the first user of each root, worldwide</td>
									<td>Anywhere you deploy</td>
								</tr>
								<tr>
									<th scope="row">Setup</th>
									<td>No setup: just a URL</td>
									<td>Relay + store, about 40 lines</td>
								</tr>
							</tbody>
						</table>
					</Card>
				</section>
			</main>
		</Sky>
	);
}
