import { For } from "solid-js";
import { BenchmarkTable } from "./BenchmarkTable";
import { GITHUB_URL } from "./links";
import {
	engineNames,
	formatCount,
	rankScore,
	scenarioLabel,
	type ComparisonColumn,
	type ComparisonRow,
	type TimingRun,
} from "~/data/benchmarks";
import results from "~/data/generated/timing-results.json";
import styles from "./Benchmarks.module.css";

const { crdt } = results as { crdt: TimingRun };
const scenarios = [...new Set(crdt.results.map((r) => r.scenario!))];
const env = crdt.environment;
const versions: Record<string, string> = {
	pulsify: "Native hybrid v3",
	"json-joy": env.jsonJoy,
	"yjs-v2": env.yjs!,
	"yjs-v1": env.yjs!,
	loro: `${env.loro} · WASM`,
};
const engines: ComparisonColumn[] = [
	"pulsify",
	"json-joy",
	"yjs-v2",
	"yjs-v1",
	"loro",
].map((id) => ({ id, label: engineNames[id], detail: versions[id] }));

function rows(type: "time" | "bytes"): ComparisonRow[] {
	return scenarios.flatMap((scenario) => {
		const measurements = crdt.results.filter((r) => r.scenario === scenario);
		if (
			type === "bytes" &&
			!measurements.some((r) => r.metrics?.bytes !== undefined)
		)
			return [];
		return [
			{
				id: scenario,
				...scenarioLabel(scenario),
				values: Object.fromEntries(
					measurements.map((r) => [
						r.participant!,
						{
							value:
								type === "bytes" ? r.metrics?.bytes : r.sampleMeanUs.median,
						},
					]),
				),
			},
		];
	});
}

/** How many rows Pulsify wins outright, out of how many. */
function wins(type: "time" | "bytes") {
	const all = rows(type);
	return {
		won: all.filter(
			(row) =>
				rankScore(
					row.values.pulsify?.value,
					Object.values(row.values).map((v) => v.value),
				) === "best",
		).length,
		total: all.length,
	};
}

/** One representative scenario, drawn as bars: Pulsify highlighted, every value labelled. */
function HeroChart() {
	const bars = crdt.results
		.filter((r) => r.scenario === "initial-load+materialize/1000")
		.map((r) => ({ id: r.participant!, value: r.sampleMeanUs.median }))
		.sort((a, b) => a.value - b.value);
	const max = Math.max(...bars.map((bar) => bar.value));
	return (
		<figure class={styles.chart}>
			<figcaption>
				Open a 1,000-item document
				<small>Load + materialize · µs, lower is better</small>
			</figcaption>
			<For each={bars}>
				{(bar) => (
					<div class={styles.bar} data-engine={bar.id}>
						<span>{engineNames[bar.id]}</span>
						<div>
							<i style={{ width: `${(bar.value / max) * 85}%` }} />
							<b>{formatCount(bar.value)}</b>
						</div>
					</div>
				)}
			</For>
		</figure>
	);
}

export function BenchmarkHero() {
	const time = wins("time");
	const bytes = wins("bytes");
	return (
		<header class={styles.hero}>
			<div>
				<p class={styles.eyebrow}>Benchmarks</p>
				<h1>
					Pulsify, <span>measured.</span>
				</h1>
				<p class={styles.heroLead}>
					Pulsify against json-joy, Yjs and Loro on the same workloads. In every
					row, <b data-rank="best">green</b> is the best result and{" "}
					<b data-rank="worst">red</b> the worst.
				</p>
				<dl class={styles.heroStats}>
					<div>
						<dt>
							{time.won}
							<small>/{time.total}</small>
						</dt>
						<dd>scenarios where Pulsify is the fastest</dd>
					</div>
					<div>
						<dt>
							{bytes.won}
							<small>/{bytes.total}</small>
						</dt>
						<dd>scenarios where it sends the fewest bytes</dd>
					</div>
				</dl>
				<p class={styles.environment}>
					{env.cpu} · {env.runtime.replace("bun-", "Bun ")} ·{" "}
					{crdt.parameters.warmup} warmups + {crdt.parameters.samples} samples ·{" "}
					{new Date(crdt.generatedAt).toLocaleDateString("en-US", {
						dateStyle: "long",
						timeZone: "UTC",
					})}
				</p>
			</div>
			<HeroChart />
		</header>
	);
}

export function SourceLink(props: { path: string; children?: string }) {
	return (
		<a
			class={styles.sourceLink}
			href={`${GITHUB_URL}/blob/main/${props.path}`}
			target="_blank"
			rel="noopener noreferrer"
		>
			{props.children ?? "Raw data"} <span aria-hidden="true">↗</span>
		</a>
	);
}

export function CrdtBenchmarks() {
	return (
		<section id="crdt" class={styles.section} aria-labelledby="crdt-title">
			<div class={styles.sectionHead}>
				<h2 id="crdt-title">CRDT engines</h2>
				<SourceLink path={crdt.path} />
			</div>
			<p class={styles.lead}>
				The same editable document in every engine: a string, a nested map and a
				list of editable objects. Median time per operation.
			</p>
			<BenchmarkTable
				caption="Operation time"
				unit="µs/op"
				columns={engines}
				rows={rows("time")}
			/>
			<BenchmarkTable
				caption="Payload size"
				unit="bytes/op"
				columns={engines}
				rows={rows("bytes")}
			/>
		</section>
	);
}
