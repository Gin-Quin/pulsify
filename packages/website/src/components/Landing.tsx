import { For } from "solid-js";
import { Button } from "./Button";
import { Card } from "./Card";
import { CodeBlock } from "./CodeBlock";
import { Icon, type IconName } from "./Icon";
import { GITHUB_URL } from "./links";
import styles from "./Landing.module.css";

/* ---------------------------------------------------------------- Pillars */

type Pillar = {
	icon: IconName;
	tag: string;
	title: string;
	text: string;
	code?: { file: string; source: string };
	chips?: string[];
};

const pillars: Pillar[] = [
	{
		icon: "bolt",
		tag: "Local-first UI",
		title: "A document is a plain object",
		text: "Assign a field, push to an array. The UI re-renders instantly, the change is persisted and synced in the background. No stores, no reducers, no fetch-then-mutate.",
		code: {
			file: "editor.ts",
			source: `const note = await loadPulse(Note, "note-42");
subscribePulse(note, render);

note.title = "Shipped";      // rendered now
note.tags.push("launch");    // synced later`,
		},
	},
	{
		icon: "cloud",
		tag: "Offline",
		title: "Offline is the default, not a feature",
		text: "Writes never wait for the network. A tab that lost its connection keeps working, and when it comes back every edit merges without a conflict handler.",
		code: {
			file: "offline.ts",
			source: `disconnectPulse(note);        // airplane mode
note.body.insert(0, "Draft: ");

await connectPulse(note).synced;
// merged with everything your team did meanwhile`,
		},
	},
	{
		icon: "shield",
		tag: "Typed · Validated",
		title: "A CRDT that cannot be corrupted",
		text: "One schema gives you the TypeScript type, runtime validation of every local and remote write, and the wire format. A bad payload from a peer is rejected, not merged.",
		code: {
			file: "typed.ts",
			source: `note.tags.push(42);
// Type 'number' is not assignable to type 'string'`,
		},
	},
	{
		icon: "layers",
		tag: "Batteries included",
		title: "Everything around the CRDT, shipped",
		text: "The parts you would otherwise glue together yourself come in the box, and all speak the same protocol.",
		chips: [
			"Token auth",
			"Lazy migrations",
			"Sub-documents",
			"PostgreSQL · SQLite",
			"Rich text editors",
			"Hosted cloud",
		],
	},
];

export function Pillars() {
	return (
		<section id="why" class={styles.section}>
			<p class={styles.eyebrow}>Why Pulsify</p>
			<h2 class={styles.heading}>
				Local-first apps, without the hard parts
			</h2>
			<p class={styles.lead}>
				Write to an object. Pulsify renders it instantly, keeps it on the
				device, syncs it when it can and never lets a bad write in.
			</p>
			<div class={styles.pillars}>
				<For each={pillars}>
					{(pillar) => (
						<Card class={styles.pillar}>
							<div class={styles.pillarHead}>
								<Icon name={pillar.icon} size="1.75rem" class={styles.icon} />
								<span class={styles.tag}>{pillar.tag}</span>
							</div>
							<h3 class={styles.pillarTitle}>{pillar.title}</h3>
							<p class={styles.text}>{pillar.text}</p>
							{pillar.code && (
								<CodeBlock
									title={pillar.code.file}
									code={pillar.code.source}
									class={styles.pillarCode}
								/>
							)}
							{pillar.chips && (
								<ul class={styles.chips}>
									<For each={pillar.chips}>{(chip) => <li>{chip}</li>}</For>
								</ul>
							)}
						</Card>
					)}
				</For>
			</div>
		</section>
	);
}

/* --------------------------------------------------------------- Showcase */

const steps = [
	{
		title: "Define",
		text: "A codec schema is the single source of truth for types, validation and bytes.",
		file: "note.ts",
		code: `import { array, definePulse, object, richText } from "pulsify-core";

export const Note = definePulse("Note", object({
  title: "string",
  body: richText(),
  tags: array("string"),
})).materialize();`,
	},
	{
		title: "Edit",
		text: "A pulse is a plain object. Assign, push, splice. Every change becomes a patch.",
		file: "app.ts",
		code: `const note = createPulse(Note, {
  title: "Draft", body: "Hello", tags: [],
});

note.title = "Ready";
note.tags.push("review");
note.body.insert(5, " world");`,
	},
	{
		title: "Sync",
		text: "Add a connector. Offline edits merge on reconnection, no conflict code.",
		file: "sync.ts",
		code: `const connector = createWebSocketConnector(
  "wss://sync.example.com",
);
const note = await loadPulse(Note, "note-42", {
  connectors: [connector],
});

note.title = "Synced everywhere";`,
	},
];

export function Showcase() {
	return (
		<section class={styles.section}>
			<p class={styles.eyebrow}>Three steps</p>
			<h2 class={styles.heading}>Define. Edit. Sync.</h2>
			<p class={styles.lead}>
				No operation objects, no transactions to open, no conflict handlers.
				Write normal TypeScript and let the engine record it.
			</p>
			<div class={styles.steps}>
				<For each={steps}>
					{(step, index) => (
						<div class={styles.step}>
							<div class={styles.stepHead}>
								<span class={styles.stepIndex}>0{index() + 1}</span>
								<h3 class={styles.stepTitle}>{step.title}</h3>
							</div>
							<p class={styles.text}>{step.text}</p>
							<CodeBlock title={step.file} code={step.code} />
						</div>
					)}
				</For>
			</div>
		</section>
	);
}

/* ------------------------------------------------------------- Benchmarks */

type Series = "pulsify" | "yjs" | "loro";
const seriesLabel: Record<Series, string> = {
	pulsify: "Pulsify",
	yjs: "Yjs",
	loro: "Loro",
};

// Medians in µs/op from benchmarks/CRDT-COMPARISON.md (Apple M4, Bun 1.4.4).
const benchmarks: {
	title: string;
	detail: string;
	unit: string;
	values: Record<Series, number>;
}[] = [
	{
		title: "Create and encode",
		detail: "1,000-item document, first export",
		unit: "µs",
		values: { pulsify: 318.83, yjs: 505.6, loro: 4741.62 },
	},
	{
		title: "Initial load",
		detail: "Import 1,000 items and materialize a JSON view",
		unit: "µs",
		values: { pulsify: 367.44, yjs: 547.02, loro: 1624.77 },
	},
	{
		title: "Delta round trip",
		detail: "Edit, encode delta, import on a peer, read",
		unit: "µs",
		values: { pulsify: 12.42, yjs: 26.67, loro: 47.15 },
	},
	{
		title: "Single mutation",
		detail: "One field write after 5,000 edits of history",
		unit: "µs",
		values: { pulsify: 0.16, yjs: 0.93, loro: 1.26 },
	},
	{
		title: "Encoded size",
		detail: "Bytes for a 1,000-item document",
		unit: "KB",
		values: { pulsify: 17.03, yjs: 30.01, loro: 49.73 },
	},
];

const format = (value: number) =>
	value >= 100
		? Math.round(value).toLocaleString("en-US")
		: value.toFixed(value >= 10 ? 1 : 2);

function Bars(props: { values: Record<Series, number>; unit: string }) {
	const max = () => Math.max(...Object.values(props.values));
	const order: Series[] = ["pulsify", "yjs", "loro"];
	return (
		<ul class={styles.bars}>
			<For each={order}>
				{(series) => (
					<li class={styles.barRow} data-series={series}>
						<span class={styles.barLabel}>{seriesLabel[series]}</span>
						<span class={styles.barTrack}>
							<span
								class={styles.bar}
								style={{
									width: `${Math.max(
										1.5,
										(props.values[series] / max()) * 100,
									)}%`,
								}}
							/>
						</span>
						<span class={styles.barValue}>
							{format(props.values[series])} {props.unit}
						</span>
					</li>
				)}
			</For>
		</ul>
	);
}

export function Benchmarks() {
	return (
		<section id="benchmarks" class={styles.section}>
			<p class={styles.eyebrow}>Benchmarks</p>
			<h2 class={styles.heading}>Faster than Yjs. Much faster than Loro.</h2>
			<p class={styles.lead}>
				Same document, same edits, same machine. Pulsify's native engine skips
				binary encoding on local writes and compiles the schema into
				straight-line code. Lower is better.
			</p>
			<div class={styles.benchGrid}>
				<For each={benchmarks}>
					{(bench) => (
						<Card class={styles.bench}>
							<h3 class={styles.benchTitle}>{bench.title}</h3>
							<p class={styles.benchDetail}>{bench.detail}</p>
							<Bars values={bench.values} unit={bench.unit} />
						</Card>
					)}
				</For>
				<Card class={`${styles.bench} ${styles.benchNote}`}>
					<h3 class={styles.benchTitle}>How we measured</h3>
					<p class={styles.benchDetail}>
						Apple M4, Bun 1.4.4, Yjs 13.6.33 (V2 encoding), Loro 1.17.1 (WASM).
						Medians of 25 samples after warm-up, shuffled order, forced GC
						outside timing. Yjs still wins the two-peer offline merge scenario.
						Explore every number, json-joy, payload sizes and database results
						on the benchmarks page.
					</p>
					<Button href="/benchmarks" variant="outline" icon="arrow">
						Full results and method
					</Button>
				</Card>
			</div>
		</section>
	);
}

/* ---------------------------------------------------------------- Compare */

type Mark = true | false | string;
const rows: { feature: string; pulsify: Mark; yjs: Mark; loro: Mark }[] = [
	{ feature: "Schema with inferred types and runtime validation", pulsify: true, yjs: false, loro: false },
	{ feature: "Lazy, per-document migrations", pulsify: true, yjs: false, loro: false },
	{ feature: "Materialized public type over stored fields", pulsify: true, yjs: false, loro: false },
	{ feature: "Official PostgreSQL and SQLite storage", pulsify: true, yjs: "Community", loro: false },
	{ feature: "Sync queries without loading the document", pulsify: true, yjs: false, loro: false },
	{ feature: "Array move with preserved identity", pulsify: true, yjs: false, loro: true },
	{ feature: "Movable tree", pulsify: true, yjs: false, loro: true },
	{ feature: "Rich text with ProseMirror and Lexical bindings", pulsify: true, yjs: true, loro: "ProseMirror" },
];

function MarkCell(props: { value: Mark }) {
	return (
		<td class={styles.mark}>
			{props.value === true ? (
				<Icon name="check" class={styles.yes} />
			) : props.value === false ? (
				<Icon name="cross" class={styles.no} />
			) : (
				<span class={styles.partial}>{props.value}</span>
			)}
		</td>
	);
}

export function Compare() {
	return (
		<section class={styles.section}>
			<p class={styles.eyebrow}>Compared</p>
			<h2 class={styles.heading}>What you get out of the box</h2>
			<div class={styles.tableWrap}>
				<table class={styles.table}>
					<thead>
						<tr>
							<th />
							<th data-series="pulsify">Pulsify</th>
							<th>Yjs</th>
							<th>Loro</th>
						</tr>
					</thead>
					<tbody>
						<For each={rows}>
							{(row) => (
								<tr>
									<th scope="row">{row.feature}</th>
									<MarkCell value={row.pulsify} />
									<MarkCell value={row.yjs} />
									<MarkCell value={row.loro} />
								</tr>
							)}
						</For>
					</tbody>
				</table>
			</div>
		</section>
	);
}

/* ------------------------------------------------------------- Everywhere */

const runtimes = ["Browsers", "Bun", "Node 22+", "Deno 2", "Cloudflare Workers"];

export function Everywhere() {
	return (
		<section class={styles.section}>
			<div class={styles.split}>
				<div>
					<p class={styles.eyebrow}>One protocol</p>
					<h2 class={styles.heading}>From the browser to PostgreSQL</h2>
					<p class={styles.text}>
						A versioned binary envelope carries every change. The same frames
						go over WebSocket, in memory between tests, into a PostgreSQL row
						and through the Rust implementation of the protocol. Pick a local
						connector for instant rendering and a remote one for durability.
					</p>
					<ul class={styles.chips}>
						<For each={runtimes}>{(runtime) => <li>{runtime}</li>}</For>
					</ul>
					<div class={styles.cloudTeaser}>
						<Icon name="cloud" size="1.5rem" class={styles.icon} />
						<div>
							<strong>Pulsify Cloud is coming.</strong>
							<span class={styles.text}>
								{" "}
								A serverless sync backend on Cloudflare Durable Objects. One
								connector, no database to run.
							</span>
						</div>
						<Button href="/cloud" variant="outline" icon="arrow" size="sm">
							Learn more
						</Button>
					</div>
				</div>
				<img
					class={styles.diagram}
					src="/images/diagram-sync.png"
					alt="Web, mobile, local database, remote PostgreSQL and cloud storage synchronized through Pulsify"
					loading="lazy"
				/>
			</div>
		</section>
	);
}
