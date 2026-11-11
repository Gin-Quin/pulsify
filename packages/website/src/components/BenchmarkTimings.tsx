import { createMemo, createSignal, For, Show } from "solid-js";
import { BenchmarkTable } from "./BenchmarkTable";
import { GITHUB_URL } from "./links";
import { engineNames, formatCount, formatScore, rankScore, scenarioLabel, type ComparisonColumn, type ComparisonRow, type TimingMetric, type TimingResult, type TimingRun } from "~/data/benchmarks";
import results from "~/data/generated/timing-results.json";
import styles from "./Benchmarks.module.css";

export const timingRuns = results as { crdt: TimingRun[]; supplementary: TimingRun[] };
const primaryColumns = ["pulsify", "json-joy", "yjs-v2", "loro", "yjs-v1"];
const proxyColumns = ["native-json-joy", "pulsify-direct", "pulsify-proxy"];
const metrics = ["median", "p95", "min", "max"] as const;

export function SourceLink(props: { path: string; children?: string }) {
	return <a class={styles.sourceLink} href={`${GITHUB_URL}/blob/main/${props.path}`} target="_blank" rel="noopener noreferrer">{props.children ?? "Source data"} <span aria-hidden="true">↗</span></a>;
}

export function RunSelector(props: { runs: TimingRun[]; run: TimingRun; onChange: (id: string) => void; id: string }) {
	return (
		<label class={`${styles.field} ${styles.runField}`} for={props.id}>
			Recorded run
			<select id={props.id} value={props.run.id} onChange={e => props.onChange(e.currentTarget.value)}>
				<For each={props.runs}>{run => <option value={run.id}>{run.label}</option>}</For>
			</select>
		</label>
	);
}

export function RunContext(props: { run: TimingRun }) {
	return (
		<div class={styles.runContext}>
			<p><strong>{props.run.environment.cpu}</strong> · {props.run.environment.runtime} · {props.run.parameters.warmup} warmups + {props.run.parameters.samples} measured samples · {props.run.generatedAt.slice(0, 10)}</p>
			<p>Revision <code>{props.run.commit?.slice(0, 7) || "archived source"}</code>{props.run.dirty ? " + working-tree changes" : " · clean source"} <SourceLink path={props.run.path} /></p>
			<Show when={props.run.historical}><p class={styles.warning}>Historical measurement. This run describes an earlier implementation; its scores are separate from the release reference.</p></Show>
		</div>
	);
}

export function TimingDetails(props: { run: TimingRun; results?: TimingResult[] }) {
	const rows = () => props.results ?? props.run.results;
	const peers = (row: TimingResult) => props.run.results.filter(r => (r.scenario ?? r.name) === (row.scenario ?? row.name));
	return (
		<details class={styles.disclosure}>
			<summary>All {rows().length} measurements <span>Iterations, median, p95, min, max, ops/s and payloads</span></summary>
			<p class={styles.note}>Timing columns show µs/op. The p95 is a percentile of sample averages, not individual-event tail latency. Highlights compare participants in the same scenario and metric.</p>
			<div class={styles.tableWrap} role="region" aria-label="All timing measurements" tabindex="0">
				<table class={`${styles.table} ${styles.detailsTable}`}>
					<caption>Complete timing measurements</caption>
					<thead><tr><th scope="col">Scenario / participant</th><th scope="col">Iterations</th><For each={metrics}>{m => <th scope="col">{m === "p95" ? "p95 avg." : m}<small>µs/op</small></th>}</For><th scope="col">Ops/s</th><th scope="col">Bytes/op</th></tr></thead>
					<tbody>
						<For each={rows()}>{row => (
							<tr>
								<th scope="row"><code>{row.scenario ?? row.name}</code><small>{engineNames[row.participant ?? ""] ?? row.participant}</small></th>
								<td>{formatCount(row.iterations)}</td>
								<For each={metrics}>{m => <td data-rank={rankScore(row.sampleMeanUs[m], peers(row).map(p => p.sampleMeanUs[m]))}>{formatScore(row.sampleMeanUs[m])}</td>}</For>
								<td data-rank={rankScore(row.opsPerSecond, peers(row).map(p => p.opsPerSecond), "higher")}>{formatCount(row.opsPerSecond)}</td>
								<td data-rank={rankScore(row.metrics?.bytes, peers(row).map(p => p.metrics?.bytes))}>{row.metrics?.bytes === undefined ? "—" : formatScore(row.metrics.bytes)}</td>
							</tr>
						)}</For>
					</tbody>
				</table>
			</div>
		</details>
	);
}

export function CrdtBenchmarks() {
	const [runId, setRunId] = createSignal(timingRuns.crdt[0].id);
	const run = createMemo(() => timingRuns.crdt.find(r => r.id === runId())!);
	const [metric, setMetric] = createSignal<TimingMetric>("median");
	const [query, setQuery] = createSignal("");
	const [category, setCategory] = createSignal("all");
	const scenarios = createMemo(() => [...new Set(run().results.map(r => r.scenario!))]);
	const filtered = (scenario: string) => {
		const text = `${scenario} ${scenarioLabel(scenario).label} ${scenarioLabel(scenario).detail}`.toLowerCase();
		const group = /^(create|export)/.test(scenario) ? "creation" : /^(read|mutate|list)/.test(scenario) ? "local" : "sync";
		return !scenario.startsWith("proxy-") && text.includes(query().toLowerCase().trim()) && (category() === "all" || category() === group);
	};
	const columns = (ids: string[]): ComparisonColumn[] => ids.map(id => ({
		id, label: engineNames[id], detail: id === "pulsify" ? "Native hybrid v3" : id.includes("json-joy") ? run().environment.jsonJoy : id.startsWith("yjs") ? run().environment.yjs : id === "loro" ? `${run().environment.loro} · Node WASM` : id === "pulsify-direct" ? "CoreModel.set" : "Public proxy",
	}));
	const rows = (type: "time" | "bytes" | "proxy"): ComparisonRow[] => scenarios().filter(s => type === "proxy" ? s.startsWith("proxy-") : filtered(s)).flatMap(scenario => {
		const measurements = run().results.filter(r => r.scenario === scenario);
		if (type === "bytes" && !measurements.some(r => r.metrics?.bytes !== undefined)) return [];
		return [{
			id: scenario, ...scenarioLabel(scenario), description: run().descriptions?.[scenario],
			values: Object.fromEntries(measurements.map(r => [r.participant!, {
				value: type === "bytes" ? r.metrics?.bytes : r.sampleMeanUs[metric()],
				detail: type !== "bytes" && metric() === "median" ? `p95 ${formatScore(r.sampleMeanUs.p95)}` : undefined,
			}])),
		}];
	});
	return (
		<section id="crdt" class={styles.section} aria-labelledby="crdt-title">
			<div class={styles.sectionHead}><div><p class={styles.eyebrow}>01 / CRDT engines</p><h2 id="crdt-title">The complete comparison</h2></div><SourceLink path="benchmarks/CRDT-COMPARISON.md">Report & methodology</SourceLink></div>
			<p class={styles.lead}>The same editable document in every engine: metadata, an atomic string, a nested map and a list of editable objects. All 18 primary scenarios, including the less flattering ones.</p>
			<div class={styles.toolbar}>
				<RunSelector runs={timingRuns.crdt} run={run()} onChange={setRunId} id="crdt-run" />
				<label class={styles.field}>Statistic<select value={metric()} onChange={e => setMetric(e.currentTarget.value as TimingMetric)}><option value="median">Median</option><option value="p95">p95 of averages</option><option value="min">Minimum</option><option value="max">Maximum</option></select></label>
				<label class={styles.field}>Scenarios<select value={category()} onChange={e => setCategory(e.currentTarget.value)}><option value="all">All scenarios</option><option value="creation">Creation & export</option><option value="local">Local reads & writes</option><option value="sync">Sync & merge</option></select></label>
				<label class={`${styles.field} ${styles.search}`}>Find a scenario<input type="search" placeholder="e.g. offline, 1000, create" value={query()} onInput={e => setQuery(e.currentTarget.value)} /></label>
			</div>
			<RunContext run={run()} />
			<BenchmarkTable caption="Operation time" unit="µs/op" columns={columns(primaryColumns).map(c => c.id === "pulsify" ? { ...c, detail: run().historical ? "Historical engine" : c.detail } : c)} rows={rows("time")} />
			<p class={styles.note}>Medians of per-sample averages; p95 appears below each median. A dash means that variant was not measured. Small differences, especially below 1 µs, can be JIT or scheduling noise.</p>

			<div class={styles.subhead}><h3>Transferred payloads</h3><span>Bytes per measured operation</span></div>
			<p class={styles.text}>CPU speed and network cost are different trade-offs. Offline merge counts both deltas; the 16-peer conflict counts the updates imported by one receiver. Network framing is excluded.</p>
			<BenchmarkTable caption="Transferred payload size" unit="bytes/op" columns={columns(primaryColumns)} rows={rows("bytes")} />
			<p class={styles.note}>The engines retain different histories. Pulsify retains exact rows at the producer and can send condensed scalar state; json-joy uses structural snapshots and deltas, Yjs uses default GC, and Loro uses history-bearing snapshots and updates.</p>

			<div class={styles.subhead}><h3>What does the public API cost?</h3><span>Same commit and journal path</span></div>
			<p class={styles.text}>Native json-joy, Pulsify’s direct setter and Pulsify’s public proxy, measured separately. Local writes do not encode binary data; tests verify identical exported bytes for the two Pulsify paths.</p>
			<BenchmarkTable caption="Public API overhead" unit="µs/op" columns={columns(proxyColumns)} rows={rows("proxy")} />
			<p class={styles.note}>Public minus direct includes setter checks and conversions as well as proxy traps. Small or negative differences between runs can reflect measurement noise.</p>
			<TimingDetails run={run()} />
			<details class={styles.disclosure}><summary>What each scenario measures <span>Timed work and exclusions</span></summary><dl class={styles.scenarios}><For each={scenarios()}>{scenario => <div><dt><code>{scenario}</code></dt><dd>{run().descriptions?.[scenario]}</dd></div>}</For></dl></details>
		</section>
	);
}

/** Give equivalent supplementary cases a shared scenario for honest highlighting. */
function supplementaryScenario(row: TimingResult): TimingResult {
	const [family, ...parts] = row.name.split("/");
	const group = family === "codec" || family === "json" ? "frame" : family === "operations" || family === "operations-json" ? "operations" : family === "core" || family === "json-joy" ? "local" : family;
	return { ...row, scenario: `${group}/${parts.join("/")}`, participant: family === "core" ? "pulsify" : family };
}

export function ProtocolBenchmarks() {
	const [runId, setRunId] = createSignal(timingRuns.supplementary[0].id);
	const run = createMemo(() => timingRuns.supplementary.find(r => r.id === runId())!);
	const normalized = createMemo(() => ({ ...run(), results: run().results.map(supplementaryScenario) }));
	const codecRows = (kind: "frame" | "operations", metric: "median" | "bytes") => [...new Set(normalized().results.filter(r => r.scenario!.startsWith(`${kind}/`)).map(r => r.scenario!))].map(scenario => ({
		id: scenario, label: scenario.includes("/encode/") ? "Encode" : "Decode", detail: `${scenario.split("/").at(-1)} operation rows`,
		values: Object.fromEntries(normalized().results.filter(r => r.scenario === scenario).map(r => [r.participant!, { value: metric === "bytes" ? r.metrics?.bytes : r.sampleMeanUs.median, detail: metric === "median" ? `${formatCount(r.metrics?.bytes ?? 0)} bytes · p95 ${formatScore(r.sampleMeanUs.p95)}` : undefined }])),
	}));
	const syncRows = () => run().results.filter(r => r.name.startsWith("sync/")).map(r => ({ id: r.name, label: r.name.replace("sync/", "").replaceAll("/", " · "), values: { pulsify: { value: r.sampleMeanUs.median, detail: `p95 ${formatScore(r.sampleMeanUs.p95)}` } } }));
	return (
		<section id="protocol" class={styles.section} aria-labelledby="protocol-title">
			<div class={styles.sectionHead}><div><p class={styles.eyebrow}>02 / Protocol & connectors</p><h2 id="protocol-title">Beyond the engine</h2></div><SourceLink path="benchmarks/README.md">Suite methodology</SourceLink></div>
			<p class={styles.lead}>35 supplementary cases cover frame codecs, operation codecs, local operations, acknowledged synchronization, initial loading and offline reconnects.</p>
			<div class={styles.toolbar}><RunSelector runs={timingRuns.supplementary} run={run()} onChange={setRunId} id="protocol-run" /></div>
			<RunContext run={run()} />
			<BenchmarkTable caption="Outer frame codecs" unit="µs/op" columns={[{ id: "codec", label: "Pulsify codec" }, { id: "json", label: "JSON + base64" }]} rows={codecRows("frame", "median")} />
			<p class={styles.note}>Outer decoding leaves operation bytes opaque. JSON represents binary leaves as base64 and does not perform Pulsify’s protocol checks. These are task-level wrappers, with different validation work.</p>
			<BenchmarkTable caption="Inner operation codecs" unit="µs/op" columns={[{ id: "operations", label: "Pulsify codec" }, { id: "operations-json", label: "JSON + base64" }]} rows={codecRows("operations", "median")} />
			<BenchmarkTable caption="Connector synchronization" unit="µs/op" columns={[{ id: "pulsify", label: "Pulsify", detail: "Median · p95 below" }]} rows={syncRows()} />
			<p class={styles.note}>Update cases include acknowledgement and convergence; the 5 ms variant delays each direction. Initial loading confirms public data availability. These are different workloads and are not ranked against each other.</p>
			<div class={styles.subhead}><h3>Retained heap diagnostics</h3><span>Pulsify only · not a cross-engine ranking</span></div>
			<div class={styles.facts}>
				<div><strong>{formatCount(run().memory.historyRows)}</strong><span>Retained history rows</span></div>
				<div><strong>{formatCount(run().memory.historyHeapBytes)} <small>B</small></strong><span>Retained-history JS heap</span></div>
				<div><strong>{formatCount(run().memory.lifecycleHeapDeltaBytes)} <small>B</small></strong><span>Create / destroy heap delta</span></div>
			</div>
			<p class={styles.note}>GC runs before and after preparation. These observations are neither RSS measurements nor proof of leak absence. JS heap cannot fairly rank a JavaScript engine against WASM memory. This suite uses the legacy typed-definition API without the explicit application schema of the primary comparison.</p>
			<TimingDetails run={normalized()} />
		</section>
	);
}
