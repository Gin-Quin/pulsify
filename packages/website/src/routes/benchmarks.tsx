import { Meta, Title } from "@solidjs/meta";
import { For } from "solid-js";
import { BenchmarkLegend } from "~/components/BenchmarkTable";
import { CrdtBenchmarks, ProtocolBenchmarks, SourceLink, timingRuns } from "~/components/BenchmarkTimings";
import { DatabaseBenchmarks } from "~/components/BenchmarkDatabases";
import { CodeBlock } from "~/components/CodeBlock";
import styles from "~/components/Benchmarks.module.css";

const reports = [
	{ title: "Native hybrid v3", scope: "Current engine, state exchange and remaining limits", path: "benchmarks/HYBRID-TRANSPORT.md" },
	{ title: "Native core", scope: "Initial engine rewrite and the preceding baseline", path: "benchmarks/CORE-RESULTS.md" },
	{ title: "Grouped transport", scope: "Exact-history batching and encoding", path: "benchmarks/GROUPED-TRANSPORT.md" },
	{ title: "Compiled preparation", scope: "Creation, import and append A/B diagnostics", path: "benchmarks/COMPILED-PREPARATION.md" },
	{ title: "Scalar commits", scope: "General vs specialized scalar commit diagnostics", path: "benchmarks/SCALAR-COMMITS.md" },
	{ title: "Offline merge", scope: "Matched campaigns and instrumented phase timings", path: "benchmarks/OFFLINE-MERGE.md" },
	{ title: "Scalar-run prototype", scope: "Historical warm-run experiments before integration", path: "benchmarks/SCALAR-RUN-PROTOTYPE.md" },
	{ title: "Independent audit", scope: "Fairness review and corrective recheck", path: "benchmarks/INDEPENDENT-AUDIT.md" },
	{ title: "Deferred encoding", scope: "Previous engine · local writes and memory trade-offs", path: "benchmarks/LAZY-ENCODING.md" },
	{ title: "Runtime simplification", scope: "Previous engine · copies and traversal costs", path: "benchmarks/RUNTIME-SIMPLIFICATION.md" },
	{ title: "Validation removal", scope: "Previous engine · additional generic validator", path: "benchmarks/SCHEMA-VALIDATION-REMOVAL.md" },
	{ title: "Database incident & recovery", scope: "Incomplete matrices, timeouts, OOM and fresh probes", path: "benchmarks/baselines/database-engines-20261104/SUMMARY.md" },
];

export default function Benchmarks() {
	return (
		<main class={styles.page}>
			<Title>Benchmarks · Pulsify, json-joy, Yjs & Loro</Title>
			<Meta name="description" content="Complete Pulsify benchmarks against json-joy, Yjs and Loro: operation times, payload sizes, proxy overhead, protocol codecs and database load, with best and worst results highlighted." />
			<div class={styles.container}>
				<header class={styles.hero}>
					<div class={styles.heroMeta}><span class={styles.eyebrow}>Pulsify / Benchmarks</span><span class={styles.date}><i /> Recorded November 4, 2026</span></div>
					<h1>Performance,<br /><span>in full.</span></h1>
					<p class={styles.heroLead}>Creation, edits, synchronization and storage. Explore the complete recorded results for Pulsify, json-joy, Yjs and Loro, with every win and every trade-off in view.</p>
					<div class={styles.heroBottom}><p>Real workloads. Shared fixtures. Open methodology.</p><a href="#crdt">Explore the results <span aria-hidden="true">↓</span></a></div>
				</header>
				<div class={styles.stats}>
					<a href="#crdt"><span class={styles.statIndex}>01 / Engine comparison</span><strong>95<span>measurements</span></strong><p>Pulsify · json-joy · Yjs V2 / V1 · Loro</p><span class={styles.statArrow} aria-hidden="true">↗</span></a>
					<a href="#protocol"><span class={styles.statIndex}>02 / Protocol & connectors</span><strong>35<span>cases</span></strong><p>Codecs, acknowledged sync & heap diagnostics</p><span class={styles.statArrow} aria-hidden="true">↗</span></a>
					<a href="#databases"><span class={styles.statIndex}>03 / Database comparison</span><strong>6<span>engines</span></strong><p>957,000 checkpointed requests, failures included</p><span class={styles.statArrow} aria-hidden="true">↗</span></a>
				</div>
				<nav class={styles.sectionNav} aria-label="Benchmark sections"><a href="#crdt">CRDT engines</a><a href="#protocol">Protocol & connectors</a><a href="#databases">Databases</a><a href="#methodology">Methodology</a><a href="#archive">Research archive</a></nav>
				<div class={styles.readingGuide}><BenchmarkLegend /><p>Timings and payloads: lower is better. Throughput: higher is better. Unmeasured or interrupted cases are never treated as zero.</p></div>
				<CrdtBenchmarks />
				<ProtocolBenchmarks />
				<DatabaseBenchmarks />
				<section id="methodology" class={styles.section} aria-labelledby="method-title">
					<div class={styles.sectionHead}><div><p class={styles.eyebrow}>04 / Read the numbers</p><h2 id="method-title">Measured carefully. Read in context.</h2></div><SourceLink path="benchmarks/README.md">Full methodology</SourceLink></div>
					<div class={styles.methodGrid}>
						<div><span class={styles.methodIndex}>01</span><h3>One machine, fresh state</h3><p>Apple M4, 10 cores, ARM64, Bun 1.4.4. The CRDT suite uses 5 warmups and 25 measured samples, fresh replicas and a fixed-seed shuffled participant order. Fixture preparation, schema compilation, GC, verification and cleanup are outside timing.</p></div>
						<div><span class={styles.methodIndex}>02</span><h3>Sample averages, not event tails</h3><p>The CRDT median and p95 summarize per-sample average operation times. They are not individual-event latency percentiles. Nanosecond-scale differences can reflect noise; these runs do not establish statistical significance or a universal engine ranking.</p></div>
						<div><span class={styles.methodIndex}>03</span><h3>The same task, different histories</h3><p>Every engine gets editable nested containers. Pulsify uses an explicit compiled application schema. Local edits exclude binary encoding; the encoding and synchronization cases add that work explicitly. Loro is warmed Node WASM; its module load and compilation are excluded.</p></div>
						<div><span class={styles.methodIndex}>04</span><h3>CPU, network and storage are distinct</h3><p>The CRDT round trip is synchronous and in memory. Connector results include acknowledgement. Database results use finite 1,000-request batches and durable storage; they are not steady-state capacity estimates. Native macOS and Docker Linux are separate deployments.</p></div>
					</div>
					<div class={styles.reproduce}><div><h3>Reproduce the results</h3><p>Run on a quiet machine and keep each report. Compare matching runtimes, library versions, hardware, fixtures and iteration counts.</p><SourceLink path="benchmarks/database/README.md">Database setup & commands</SourceLink></div><CodeBlock title="From the repository root" code={`# Full CRDT comparison: 5 warmups, 25 samples\nbun run bench:crdt --output benchmarks/results/new.json \\\n  --markdown benchmarks/results/new.md\n\n# Supplementary protocol and connector suite\nbun run bench --output benchmarks/results/protocol-new.json\n\n# Native / Docker database campaign\nbun run bench:database`} /></div>
				</section>
				<section id="archive" class={styles.section} aria-labelledby="archive-title">
					<div class={styles.sectionHead}><div><p class={styles.eyebrow}>05 / Research archive</p><h2 id="archive-title">The work behind the numbers</h2></div><SourceLink path="benchmarks/README.md">Browse all records</SourceLink></div>
					<p class={styles.lead}>Use the recorded-run selectors above to explore {timingRuns.crdt.length} CRDT campaigns and {timingRuns.supplementary.length} supplementary campaigns. The database selector also preserves native FoundationDB results, fresh probes and individual tuning runs. These reports document the separate optimization experiments and their limits.</p>
					<div class={styles.tableWrap} role="region" aria-label="Benchmark research archive" tabindex="0"><table class={`${styles.table} ${styles.archiveTable}`}><caption>Reports, diagnostics and historical context</caption><thead><tr><th scope="col">Report</th><th scope="col">What it covers</th><th scope="col">Original record</th></tr></thead><tbody><For each={reports}>{report => <tr><th scope="row">{report.title}</th><td>{report.scope}</td><td><SourceLink path={report.path}>Read report</SourceLink></td></tr>}</For></tbody></table></div>
				</section>
			</div>
		</main>
	);
}
