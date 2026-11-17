import { createSignal, createUniqueId, For, type JSX } from "solid-js";
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
	visual?: () => JSX.Element;
	tiles?: { icon: IconName; label: string }[];
};

/* Offline: three states, one line. */
const offlineSteps: { icon: IconName; title: string; text: string }[] = [
	{ icon: "cloud", title: "Online", text: "Edits sync" },
	{ icon: "cross", title: "Offline", text: "Edits queue locally" },
	{ icon: "check", title: "Back online", text: "Everything merges" },
];

function OfflineVisual() {
	return (
		<ol class={`${styles.visual} ${styles.steps3}`}>
			<For each={offlineSteps}>
				{(step, index) => (
					<li data-step={index()}>
						<span class={styles.node}>
							<Icon name={step.icon} size="1.1rem" />
						</span>
						<strong>{step.title}</strong>
						<span>{step.text}</span>
					</li>
				)}
			</For>
		</ol>
	);
}

/* Typed: a schema gate in front of the document. */
const writes = [
	{ ok: true, field: 'title: "Shipped"' },
	{ ok: true, field: 'tags: ["launch"]' },
	{ ok: false, field: "tags: [42]" },
];

function TypedVisual() {
	return (
		<ul
			class={styles.visual}
			aria-label="Valid writes are merged, invalid ones rejected"
		>
			<For each={writes}>
				{(write) => (
					<li class={styles.write} data-ok={write.ok}>
						<Icon name={write.ok ? "check" : "cross"} size="1rem" />
						<code>{write.field}</code>
						<span>{write.ok ? "merged" : "rejected"}</span>
					</li>
				)}
			</For>
		</ul>
	);
}

const pillars: Pillar[] = [
	{
		icon: "bolt",
		tag: "Local-first UI",
		title: "A document is a plain object",
		text: "Assign a field, push to an array. The UI re-renders instantly, the change is persisted and synced in the background. No stores, no reducers, no fetch-then-mutate.",
		code: {
			file: "editor.ts",
			source: `const note = await loadPulse(Note, "note-42");

note.title = "Shipped";      // rendered and synced
note.tags.push("launch");    // in one batch`,
		},
	},
	{
		icon: "cloud",
		tag: "Offline",
		title: "Offline is the default, not a feature",
		text: "Writes never wait for the network. A tab that lost its connection keeps working, and when it comes back every edit merges without a conflict handler.",
		visual: OfflineVisual,
	},
	{
		icon: "shield",
		tag: "Typed · Validated",
		title: "A CRDT that cannot be corrupted",
		text: "One schema gives you the TypeScript type, runtime validation of every local and remote write, and the wire format. A bad payload from a peer is rejected, not merged.",
		visual: TypedVisual,
	},
	{
		icon: "layers",
		tag: "Batteries included",
		title: "Everything around the CRDT, shipped",
		text: "The parts you would otherwise glue together yourself come in the box, and all speak the same protocol.",
		tiles: [
			{ icon: "shield", label: "Token auth" },
			{ icon: "branch", label: "Lazy migrations" },
			{ icon: "cube", label: "Sub-documents" },
			{ icon: "database", label: "Your database" },
			{ icon: "window", label: "Rich text editors" },
			{ icon: "cloud", label: "Hosted cloud" },
		],
	},
];

export function Pillars() {
	return (
		<section id="why" class={styles.section}>
			<p class={styles.eyebrow}>Why Pulsify</p>
			<h2 class={styles.heading}>Local-first apps, without the hard parts</h2>
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
							{pillar.visual?.()}
							{pillar.tiles && (
								<ul class={styles.tiles}>
									<For each={pillar.tiles}>
										{(tile) => (
											<li>
												<Icon
													name={tile.icon}
													size="1.1rem"
													class={styles.icon}
												/>
												{tile.label}
											</li>
										)}
									</For>
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

/* ------------------------------------------------------------- Frameworks */

// Logos from simple-icons (CC0), in 24×24 units.
const frameworks: {
	name: string;
	href: string;
	color: string;
	logo: string;
	file: string;
	code: string;
}[] = [
	{
		name: "React",
		href: "/docs/frontend/react",
		color: "#61dafb",
		logo: "M14.23 12.004a2.236 2.236 0 0 1-2.235 2.236 2.236 2.236 0 0 1-2.236-2.236 2.236 2.236 0 0 1 2.235-2.236 2.236 2.236 0 0 1 2.236 2.236zm2.648-10.69c-1.346 0-3.107.96-4.888 2.622-1.78-1.653-3.542-2.602-4.887-2.602-.41 0-.783.093-1.106.278-1.375.793-1.683 3.264-.973 6.365C1.98 8.917 0 10.42 0 12.004c0 1.59 1.99 3.097 5.043 4.03-.704 3.113-.39 5.588.988 6.38.32.187.69.275 1.102.275 1.345 0 3.107-.96 4.888-2.624 1.78 1.654 3.542 2.603 4.887 2.603.41 0 .783-.09 1.106-.275 1.374-.792 1.683-3.263.973-6.365C22.02 15.096 24 13.59 24 12.004c0-1.59-1.99-3.097-5.043-4.032.704-3.11.39-5.587-.988-6.38-.318-.184-.688-.277-1.092-.278zm-.005 1.09v.006c.225 0 .406.044.558.127.666.382.955 1.835.73 3.704-.054.46-.142.945-.25 1.44-.96-.236-2.006-.417-3.107-.534-.66-.905-1.345-1.727-2.035-2.447 1.592-1.48 3.087-2.292 4.105-2.295zm-9.77.02c1.012 0 2.514.808 4.11 2.28-.686.72-1.37 1.537-2.02 2.442-1.107.117-2.154.298-3.113.538-.112-.49-.195-.964-.254-1.42-.23-1.868.054-3.32.714-3.707.19-.09.4-.127.563-.132zm4.882 3.05c.455.468.91.992 1.36 1.564-.44-.02-.89-.034-1.345-.034-.46 0-.915.01-1.36.034.44-.572.895-1.096 1.345-1.565zM12 8.1c.74 0 1.477.034 2.202.093.406.582.802 1.203 1.183 1.86.372.64.71 1.29 1.018 1.946-.308.655-.646 1.31-1.013 1.95-.38.66-.773 1.288-1.18 1.87-.728.063-1.466.098-2.21.098-.74 0-1.477-.035-2.202-.093-.406-.582-.802-1.204-1.183-1.86-.372-.64-.71-1.29-1.018-1.946.303-.657.646-1.313 1.013-1.954.38-.66.773-1.286 1.18-1.868.728-.064 1.466-.098 2.21-.098zm-3.635.254c-.24.377-.48.763-.704 1.16-.225.39-.435.782-.635 1.174-.265-.656-.49-1.31-.676-1.947.64-.15 1.315-.283 2.015-.386zm7.26 0c.695.103 1.365.23 2.006.387-.18.632-.405 1.282-.66 1.933-.2-.39-.41-.783-.64-1.174-.225-.392-.465-.774-.705-1.146zm3.063.675c.484.15.944.317 1.375.498 1.732.74 2.852 1.708 2.852 2.476-.005.768-1.125 1.74-2.857 2.475-.42.18-.88.342-1.355.493-.28-.958-.646-1.956-1.1-2.98.45-1.017.81-2.01 1.085-2.964zm-13.395.004c.278.96.645 1.957 1.1 2.98-.45 1.017-.812 2.01-1.086 2.964-.484-.15-.944-.318-1.37-.5-1.732-.737-2.852-1.706-2.852-2.474 0-.768 1.12-1.742 2.852-2.476.42-.18.88-.342 1.356-.494zm11.678 4.28c.265.657.49 1.312.676 1.948-.64.157-1.316.29-2.016.39.24-.375.48-.762.705-1.158.225-.39.435-.788.636-1.18zm-9.945.02c.2.392.41.783.64 1.175.23.39.465.772.705 1.143-.695-.102-1.365-.23-2.006-.386.18-.63.406-1.282.66-1.933zM17.92 16.32c.112.493.2.968.254 1.423.23 1.868-.054 3.32-.714 3.708-.147.09-.338.128-.563.128-1.012 0-2.514-.807-4.11-2.28.686-.72 1.37-1.536 2.02-2.44 1.107-.118 2.154-.3 3.113-.54zm-11.83.01c.96.234 2.006.415 3.107.532.66.905 1.345 1.727 2.035 2.446-1.595 1.483-3.092 2.295-4.11 2.295-.22-.005-.406-.05-.553-.132-.666-.38-.955-1.834-.73-3.703.054-.46.142-.944.25-1.438zm4.56.64c.44.02.89.034 1.345.034.46 0 .915-.01 1.36-.034-.44.572-.895 1.095-1.345 1.565-.455-.47-.91-.993-1.36-1.565z",
		file: "NoteTitle.tsx",
		code: `import { useLoadPulse } from "pulsify-react";
import { Note } from "./note";

// Inside <Suspense>: it suspends until the note is loaded.
export function NoteTitle({ id }: { id: string }) {
  const note = useLoadPulse(Note, id);
  return (
    <input
      value={note.title}
      onChange={(e) => (note.title = e.target.value)}
    />
  );
}`,
	},
	{
		name: "Vue",
		href: "/docs/frontend/vue",
		color: "#4fc08d",
		logo: "M24,1.61H14.06L12,5.16,9.94,1.61H0L12,22.39ZM12,14.08,5.16,2.23H9.59L12,6.41l2.41-4.18h4.43Z",
		file: "NoteTitle.vue",
		code: `<script setup lang="ts">
import { loadReactivePulse } from "pulsify-vue";
import { Note } from "./note";

const props = defineProps<{ id: string }>();
// Inside <Suspense>: setup waits for the note.
const note = await loadReactivePulse(Note, props.id);
</script>

<template>
  <input v-model="note.title" />
</template>`,
	},
	{
		name: "Svelte",
		href: "/docs/frontend/svelte",
		color: "#ff3e00",
		logo: "M10.354 21.125a4.44 4.44 0 0 1-4.765-1.767 4.109 4.109 0 0 1-.703-3.107 3.898 3.898 0 0 1 .134-.522l.105-.321.287.21a7.21 7.21 0 0 0 2.186 1.092l.208.063-.02.208a1.253 1.253 0 0 0 .226.83 1.337 1.337 0 0 0 1.435.533 1.231 1.231 0 0 0 .343-.15l5.59-3.562a1.164 1.164 0 0 0 .524-.778 1.242 1.242 0 0 0-.211-.937 1.338 1.338 0 0 0-1.435-.533 1.23 1.23 0 0 0-.343.15l-2.133 1.36a4.078 4.078 0 0 1-1.135.499 4.44 4.44 0 0 1-4.765-1.766 4.108 4.108 0 0 1-.702-3.108 3.855 3.855 0 0 1 1.742-2.582l5.589-3.563a4.072 4.072 0 0 1 1.135-.499 4.44 4.44 0 0 1 4.765 1.767 4.109 4.109 0 0 1 .703 3.107 3.943 3.943 0 0 1-.134.522l-.105.321-.286-.21a7.204 7.204 0 0 0-2.187-1.093l-.208-.063.02-.207a1.255 1.255 0 0 0-.226-.831 1.337 1.337 0 0 0-1.435-.532 1.231 1.231 0 0 0-.343.15L8.62 9.368a1.162 1.162 0 0 0-.524.778 1.24 1.24 0 0 0 .211.937 1.338 1.338 0 0 0 1.435.533 1.235 1.235 0 0 0 .344-.151l2.132-1.36a4.067 4.067 0 0 1 1.135-.498 4.44 4.44 0 0 1 4.765 1.766 4.108 4.108 0 0 1 .702 3.108 3.857 3.857 0 0 1-1.742 2.583l-5.589 3.562a4.072 4.072 0 0 1-1.135.499m10.358-17.95C18.484-.015 14.082-.96 10.9 1.068L5.31 4.63a6.412 6.412 0 0 0-2.896 4.295 6.753 6.753 0 0 0 .666 4.336 6.43 6.43 0 0 0-.96 2.396 6.833 6.833 0 0 0 1.168 5.167c2.229 3.19 6.63 4.135 9.812 2.108l5.59-3.562a6.41 6.41 0 0 0 2.896-4.295 6.756 6.756 0 0 0-.665-4.336 6.429 6.429 0 0 0 .958-2.396 6.831 6.831 0 0 0-1.167-5.168Z",
		file: "NoteTitle.svelte",
		code: `<script lang="ts">
  import { loadSveltePulse } from "pulsify-svelte";
  import { Note } from "$lib/note";

  let { id }: { id: string } = $props();
  // Loaded again when the ID changes.
  const note = $derived(await loadSveltePulse(Note, id));
</script>

<input bind:value={note.title} />`,
	},
	{
		name: "Solid",
		href: "/docs/frontend/solid",
		color: "#518ac8",
		logo: "M11.558.788A9.082 9.082 0 0 0 9.776.99l-.453.15c-.906.303-1.656.755-2.1 1.348l-.301.452-2.035 3.528c.426-.387.974-.698 1.643-.894h.001l.613-.154h.001a8.82 8.82 0 0 1 1.777-.206c2.916-.053 6.033 1.148 8.423 2.36 2.317 1.175 3.888 2.32 3.987 2.39L24 5.518c-.082-.06-1.66-1.21-3.991-2.386-2.393-1.206-5.521-2.396-8.45-2.343zM8.924 5.366a8.634 8.634 0 0 0-1.745.203l-.606.151c-1.278.376-2.095 1.16-2.43 2.108-.334.948-.188 2.065.487 3.116.33.43.747.813 1.216 1.147L12.328 10h.001a6.943 6.943 0 0 1 6.013 1.013l2.844-.963c-.17-.124-1.663-1.2-3.91-2.34-2.379-1.206-5.479-2.396-8.352-2.344zm5.435 4.497a6.791 6.791 0 0 0-1.984.283L2.94 13.189 0 18.334l9.276-2.992a6.945 6.945 0 0 1 7.408 2.314v.001c.695.903.89 1.906.66 2.808l2.572-4.63c.595-1.041.45-2.225-.302-3.429a6.792 6.792 0 0 0-5.255-2.543zm-3.031 5.341a6.787 6.787 0 0 0-2.006.283L.008 18.492c.175.131 2.02 1.498 4.687 2.768 2.797 1.332 6.37 2.467 9.468 1.712l.454-.152h.002c1.278-.376 2.134-1.162 2.487-2.09.353-.93.207-2.004-.541-2.978a6.791 6.791 0 0 0-5.237-2.548z",
		file: "NoteTitle.tsx",
		code: `import { Show } from "solid-js";
import { createPulseResource } from "pulsify-solid";
import { Note } from "./note";

export function NoteTitle(props: { id: string }) {
  const [note] = createPulseResource(Note, () => props.id);
  return (
    <Show when={note()}>
      {(note) => (
        <input
          value={note().title}
          onInput={(e) => (note().title = e.currentTarget.value)}
        />
      )}
    </Show>
  );
}`,
	},
];

export function Frameworks() {
	const [active, setActive] = createSignal(0);
	const id = createUniqueId();
	return (
		<section class={styles.section}>
			<div class={styles.split}>
				<div>
					<p class={styles.eyebrow}>Any frontend</p>
					<h2 class={styles.heading}>Works with your framework</h2>
					<p class={styles.text}>
						React, Vue, Svelte and Solid each get a small binding that makes
						pulses reactive. A component reads a field and re-renders when it
						changes, locally or from a peer. Writing is still an assignment.
					</p>
					<div class={styles.frameworks} role="tablist">
						<For each={frameworks}>
							{(framework, index) => (
								<button
									type="button"
									role="tab"
									id={`${id}-tab-${index()}`}
									aria-controls={`${id}-panel-${index()}`}
									aria-selected={active() === index()}
									style={{ "--brand": framework.color }}
									onClick={() => setActive(index())}
								>
									<svg viewBox="0 0 24 24" aria-hidden="true">
										<path d={framework.logo} />
									</svg>
									{framework.name}
								</button>
							)}
						</For>
					</div>
					<Button
						href={frameworks[active()].href}
						variant="outline"
						icon="arrow"
						size="sm"
					>
						{`The ${frameworks[active()].name} guide`}
					</Button>
				</div>
				{/* Every panel is rendered, so the server HTML and hydration agree. */}
				<div class={styles.frameworkCode}>
					<For each={frameworks}>
						{(framework, index) => (
							<div
								role="tabpanel"
								id={`${id}-panel-${index()}`}
								aria-labelledby={`${id}-tab-${index()}`}
								hidden={active() !== index()}
							>
								<CodeBlock title={framework.file} code={framework.code} />
							</div>
						)}
					</For>
				</div>
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
			<h2 class={styles.heading}>Fastest CRDT engine.</h2>
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
	{
		feature: "Schema with inferred types and runtime validation",
		pulsify: true,
		yjs: false,
		loro: false,
	},
	{
		feature: "Lazy, per-document migrations",
		pulsify: true,
		yjs: false,
		loro: false,
	},
	{
		feature: "Materialized public type over stored fields",
		pulsify: true,
		yjs: false,
		loro: false,
	},
	{
		feature: "Official PostgreSQL and SQLite storage",
		pulsify: true,
		yjs: "Community",
		loro: false,
	},
	{
		feature: "Sync queries without loading the document",
		pulsify: true,
		yjs: false,
		loro: false,
	},
	{
		feature: "Array move with preserved identity",
		pulsify: true,
		yjs: false,
		loro: true,
	},
	{ feature: "Movable tree", pulsify: true, yjs: false, loro: true },
	{
		feature: "Rich text with ProseMirror and Lexical bindings",
		pulsify: true,
		yjs: true,
		loro: "ProseMirror",
	},
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

const runtimes = ["Browsers", "Bun", "Node 22+", "Cloudflare Workers"];

/** The schema beside the text: a 2×2 grid of nodes, in viewBox units. */
const schemaNodes: {
	x: number;
	y: number;
	icon: IconName;
	name: string;
	detail: string;
	tone: string;
}[] = [
	{
		x: 20,
		y: 20,
		icon: "window",
		name: "Your app",
		detail: "Pulsify CRDT",
		tone: "var(--color-accent)",
	},
	{
		x: 340,
		y: 20,
		icon: "server",
		name: "Sync server",
		detail: "Relays frames",
		tone: "var(--color-violet)",
	},
	{
		x: 20,
		y: 236,
		icon: "database",
		name: "Local database",
		detail: "Instant rendering",
		tone: "var(--color-accent-2)",
	},
	{
		x: 340,
		y: 236,
		icon: "database",
		name: "Your database",
		detail: "Durability",
		tone: "var(--color-secondary)",
	},
];

/** Links between the nodes, and the label beside each. */
const schemaLinks = [
	{ d: "M220 62H340", x: 280, y: 50, anchor: "middle", label: "WebSocket" },
	{
		d: "M120 104V236",
		x: 132,
		y: 175,
		anchor: "start",
		label: "Local connector",
	},
	{ d: "M440 104V236", x: 428, y: 175, anchor: "end", label: "Database row" },
] as const;

function SyncSchema() {
	return (
		<svg
			class={styles.diagram}
			viewBox="0 0 560 340"
			role="img"
			aria-label="Your app syncs with its local database through a local connector, and over WebSocket with a sync server that stores the same frames in your database"
		>
			<For each={schemaLinks}>
				{(link) => (
					<>
						<path class={styles.schemaLink} d={link.d} />
						<text
							class={styles.schemaLabel}
							x={link.x}
							y={link.y}
							text-anchor={link.anchor}
						>
							{link.label}
						</text>
					</>
				)}
			</For>
			<For each={schemaNodes}>
				{(node) => (
					<g style={{ color: node.tone }}>
						<rect
							class={styles.schemaNode}
							x={node.x}
							y={node.y}
							width="200"
							height="84"
							rx="16"
						/>
						<g transform={`translate(${node.x + 18} ${node.y + 28})`}>
							<Icon name={node.icon} size="28" />
						</g>
						<text class={styles.schemaName} x={node.x + 58} y={node.y + 40}>
							{node.name}
						</text>
						<text class={styles.schemaDetail} x={node.x + 58} y={node.y + 62}>
							{node.detail}
						</text>
					</g>
				)}
			</For>
		</svg>
	);
}

export function Everywhere() {
	return (
		<section class={styles.section}>
			<div class={styles.split}>
				<div>
					<p class={styles.eyebrow}>One protocol</p>
					<h2 class={styles.heading}>From the browser to the database</h2>
					<p class={styles.text}>
						A versioned binary envelope carries every change. The same frames go
						over WebSocket, in memory between tests, into a database row and
						through the Rust implementation of the protocol. Pick a local
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
								A managed sync backend. One connector, no database to run.
							</span>
						</div>
						<Button href="/cloud" variant="outline" icon="arrow" size="sm">
							Learn more
						</Button>
					</div>
				</div>
				<SyncSchema />
			</div>
		</section>
	);
}
