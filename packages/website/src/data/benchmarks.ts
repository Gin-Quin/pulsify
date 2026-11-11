import type { JSX } from "solid-js";

export type TimingMetric = "median" | "p95" | "min" | "max";

export interface TimingResult {
	name: string;
	scenario?: string;
	participant?: string;
	iterations: number;
	sampleMeanUs: Record<TimingMetric, number>;
	opsPerSecond: number;
	metrics?: Record<string, number>;
}

export interface TimingRun {
	id: string;
	label: string;
	path: string;
	historical: boolean;
	generatedAt: string;
	commit: string;
	dirty: boolean;
	environment: {
		cpu: string;
		cores: number;
		runtime: string;
		platform: string;
		arch: string;
		jsonJoy: string;
		yjs?: string;
		loro?: string;
		codec: string;
	};
	parameters: { samples: number; warmup: number; pulsifyEngine?: string };
	descriptions?: Record<string, string>;
	results: TimingResult[];
	memory: Record<string, number>;
}

export interface DatabaseSummary {
	requests: number;
	success: number;
	errors: number;
	throughput_per_sec: number;
	service: Record<"p50_ms" | "p95_ms" | "p99_ms" | "max_ms", number>;
	queue: Record<"p50_ms" | "p95_ms" | "p99_ms" | "max_ms", number>;
	latency: Record<"p50_ms" | "p95_ms" | "p99_ms" | "max_ms", number>;
	retries: number;
	useful_compactions: number;
	noop_compactions: number;
	removed_segments: number;
	useful_compactions_per_sec: number;
}

export interface DatabaseCell {
	scenario: string;
	mode: string;
	topology: string;
	concurrency: number;
	maximum_active: number;
	summary: DatabaseSummary;
	operations: Record<string, DatabaseSummary>;
}

export interface DatabaseRun {
	path: string;
	backend: string;
	environment: string;
	profile: string;
	version: string;
	plannedCells: number;
	cells: DatabaseCell[];
}

export interface DatabaseCampaign {
	id: string;
	label: string;
	path: string;
	note: string;
	runs: DatabaseRun[];
}

export interface ComparisonColumn {
	id: string;
	label: string;
	detail?: string;
}

export interface ComparisonValue {
	value?: number;
	detail?: JSX.Element;
	missing?: string;
	failed?: boolean;
}

export interface ComparisonRow {
	id: string;
	label: string;
	detail?: string;
	description?: string;
	values: Record<string, ComparisonValue>;
}

/** Rank the original values, before display rounding. Equal scores share a rank. */
export function rankScore(
	value: number | undefined,
	values: (number | undefined)[],
	direction: "lower" | "higher" = "lower",
): "best" | "worst" | undefined {
	const finite = values.filter((v): v is number => v !== undefined && Number.isFinite(v));
	if (value === undefined || !Number.isFinite(value) || finite.length < 2) return;
	const min = Math.min(...finite);
	const max = Math.max(...finite);
	if (min === max) return;
	if (value === (direction === "lower" ? min : max)) return "best";
	if (value === (direction === "lower" ? max : min)) return "worst";
}

export function formatScore(value: number): string {
	return value.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: value !== 0 && Math.abs(value) < 0.1 ? 4 : 2,
	});
}

export const formatCount = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 0 });

export const engineNames: Record<string, string> = {
	pulsify: "Pulsify",
	"json-joy": "json-joy",
	"yjs-v2": "Yjs V2",
	loro: "Loro",
	"yjs-v1": "Yjs V1",
	"native-json-joy": "json-joy",
	"pulsify-direct": "Pulsify direct",
	"pulsify-proxy": "Pulsify public",
	postgres: "PostgreSQL",
	sqlite: "SQLite",
	alloydb: "AlloyDB Omni",
	orioledb: "OrioleDB",
	"pgrust-row": "pgrust row",
	"pgrust-columnar": "pgrust columnar",
	foundationdb: "FoundationDB",
};

export const scenarioNames: Record<string, string> = {
	create: "Create document",
	"create+encode": "Create + encode",
	"export-first": "First export",
	"export-repeat": "Repeated export",
	"read-count": "Read cached field",
	mutate: "Commit scalar edit",
	"list-append": "Append editable object",
	"edit+encode": "Edit + encode",
	"delta-roundtrip": "Incremental round trip",
	"initial-load+materialize": "Load + materialize",
	"offline-merge": "Two-peer offline merge",
	"upstream-map-conflict": "Concurrent map conflict",
	write_full: "Write full document",
	read_full: "Read full history",
	write_patch: "Append patch",
	compact: "Lossless compaction",
	read_delta: "Read from version vector",
	mixed: "Mixed workload",
	load_materialize: "Load + materialize",
	read_delta_materialize: "Read delta + materialize",
	read_full_compacted: "Read compacted history",
	read_delta_compacted: "Read compacted delta",
};

export function scenarioLabel(scenario: string) {
	const [name, size] = scenario.replace(/^proxy-overhead\//, "").split("/");
	return {
		label: scenarioNames[name] ?? (name.startsWith("mutate-history") ? "Commit scalar edit" : name),
		detail: size?.startsWith("history-")
			? `${formatCount(Number(size.slice(8)))} prior edits`
			: name.startsWith("mutate-history-")
				? `${formatCount(Number(name.slice(15)))} prior edits`
				: size === "100-per-peer"
					? "100 offline edits per peer"
					: size === "16-peers"
						? "16 concurrent peers"
						: size ? `${formatCount(Number(size))} editable items` : "Cached nested field",
	};
}
