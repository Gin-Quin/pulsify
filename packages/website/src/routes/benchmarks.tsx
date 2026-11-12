import { Meta, Title } from "@solidjs/meta";
import { createSignal, For, onCleanup, onMount } from "solid-js";
import {
	BenchmarkHero,
	CrdtBenchmarks,
	SourceLink,
} from "~/components/BenchmarkTimings";
import { DatabaseBenchmarks } from "~/components/BenchmarkDatabases";
import { CodeBlock } from "~/components/CodeBlock";
import { Sky } from "~/components/Sky";
import styles from "~/components/Benchmarks.module.css";

const sections = [
	["crdt", "CRDT engines"],
	["databases", "Databases"],
	["methodology", "Methodology"],
];

export default function Benchmarks() {
	const [active, setActive] = createSignal<string>();
	onMount(() => {
		// The active tab is the last section whose top has passed the upper third of the viewport.
		const update = () =>
			setActive(
				sections.findLast(
					([id]) =>
						document.getElementById(id)!.getBoundingClientRect().top <=
						window.innerHeight / 3,
				)?.[0],
			);
		update();
		addEventListener("scroll", update, { passive: true });
		onCleanup(() => removeEventListener("scroll", update));
	});
	return (
		<Sky>
			<main class={styles.page}>
				<Title>Benchmarks · Pulsify, json-joy, Yjs & Loro</Title>
				<Meta
					name="description"
					content="Pulsify benchmarks against json-joy, Yjs and Loro: operation times, payload sizes and database load."
				/>
				<div class={styles.container}>
					<BenchmarkHero />
					<nav class={styles.sectionNav} aria-label="Benchmark sections">
						<For each={sections}>
							{([id, label]) => (
								<a
									href={`#${id}`}
									aria-current={active() === id ? "true" : undefined}
								>
									{label}
								</a>
							)}
						</For>
					</nav>
					<CrdtBenchmarks />
					<DatabaseBenchmarks />
					<section
						id="methodology"
						class={styles.section}
						aria-labelledby="method-title"
					>
						<div class={styles.sectionHead}>
							<h2 id="method-title">Methodology</h2>
							<SourceLink path="benchmarks/README.md">
								Full methodology & archive
							</SourceLink>
						</div>
						<ul class={styles.method}>
							<li>
								CRDT engines: every sample starts from fresh replicas, in a
								shuffled engine order. Setup, GC and verification are outside
								the timed work.
							</li>
							<li>
								CRDT scores are medians of per-sample averages. Differences
								below 1 µs can be noise.
							</li>
							<li>
								Databases: one engine at a time on the same server, each with a
								configuration tuned for this workload. The unused cores are
								taken offline; the clients share the others with the database.
							</li>
							<li>
								Each database score is one batch of 2,000 requests, measured
								once. Its documents are stored before the timer starts, and
								every history is checked row for row afterwards.
							</li>
							<li>
								A difference under 10% between two databases is not a ranking.
								Compare them within one durability tier; a batch is not a
								capacity estimate.
							</li>
						</ul>
						<CodeBlock
							title="Reproduce from the repository root"
							code={`bun run bench:crdt  # CRDT engines\n# Databases, on a dedicated Ubuntu server\nsudo sh benchmarks/database/dedicated/setup.sh /dev/nvme1n1\nsh benchmarks/database/dedicated/campaign.sh postgres`}
						/>
					</section>
				</div>
			</main>
		</Sky>
	);
}
