import type { JSX } from "solid-js";

export interface TimingResult {
	name: string;
	scenario?: string;
	participant?: string;
	sampleMeanUs: { median: number };
	metrics?: Record<string, number>;
}

export interface TimingRun {
	path: string;
	generatedAt: string;
	environment: {
		cpu: string;
		runtime: string;
		jsonJoy: string;
		yjs?: string;
		loro?: string;
	};
	parameters: { samples: number; warmup: number };
	results: TimingResult[];
}

export interface DatabaseSummary {
	errors: number;
	throughput_per_sec: number;
	service: Record<"p50_ms" | "p99_ms", number>;
}

export interface DatabaseRun {
	engine: string;
	/** Cores online on the server: the clients and the database share them. */
	cores: number;
	/** Edits in the history of the document the clients work on. */
	edits: number;
	/** strict: flushed to disk before the acknowledgement. relaxed: acknowledged first. */
	durability: string;
	cells: { scenario: string; clients: number; summary: DatabaseSummary }[];
}

export interface DatabaseCampaign {
	runs: DatabaseRun[];
	/** Per engine: its data directory after the last cell, and the payload it holds. */
	sizes: Record<string, { bytes: number; storedBytes: number }>;
}

export interface ComparisonColumn {
	id: string;
	label: string;
	detail?: string;
	/** Shown in an info bubble next to the label: what biases this column. */
	help?: string;
}

export interface ComparisonValue {
	value?: number;
	detail?: JSX.Element;
	missing?: string;
	/** The cell had errors: shown as a fail icon whose tooltip is this text. */
	failed?: string;
}

export interface ComparisonRow {
	id: string;
	label: string;
	detail?: string;
	/** Shown in an info bubble next to the label. */
	help?: string;
	values: Record<string, ComparisonValue>;
}

/** Rank the original values, before display rounding. Equal scores share a rank. */
export function rankScore(
	value: number | undefined,
	values: (number | undefined)[],
	direction: "lower" | "higher" = "lower",
): "best" | "worst" | undefined {
	const finite = values.filter(
		(v): v is number => v !== undefined && Number.isFinite(v),
	);
	if (value === undefined || !Number.isFinite(value) || finite.length < 2)
		return;
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

export const formatCount = (value: number) =>
	value.toLocaleString("en-US", { maximumFractionDigits: 0 });

export const engineNames: Record<string, string> = {
	pulsify: "Pulsify",
	"json-joy": "json-joy",
	"yjs-v2": "Yjs V2",
	loro: "Loro",
	"yjs-v1": "Yjs V1",
	postgres: "PostgreSQL",
	sqlite: "SQLite",
	alloydb: "AlloyDB Omni",
	orioledb: "OrioleDB",
	"pgrust-row": "pgrust row",
	"pgrust-columnar": "pgrust columnar",
	rocksdb: "RocksDB",
	"rocksdb-mutex": "RocksDB · mutex",
	leveldb: "LevelDB",
	lmdb: "LMDB",
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
};

/** Plain-language help for the scenarios whose name does not speak for itself. */
export const scenarioHelp: Record<string, string> = {
	"create+encode":
		"Creates the document, then serializes its whole state to bytes, ready to send to another peer.",
	"export-first":
		"Serializes an existing document to bytes for the first time, with nothing cached.",
	"export-repeat":
		"Serializes the same document again without any edit in between. Shows whether an engine reuses its previous encoding.",
	"read-count":
		"Reads one nested number through each library’s API. At a few nanoseconds per read, the differences are mostly noise.",
	mutate:
		"Changes one number and commits it locally, on a document that already carries this many edits in its history. Nothing is encoded or sent.",
	"edit+encode":
		"Commits one edit, then encodes only that change as an update to send to other peers.",
	"delta-roundtrip":
		"One edit travels to a second peer: encode the change, import it on the other side and read the new value. In memory, without a network.",
	"initial-load+materialize":
		"A new peer imports a full document and turns it into a plain JSON value. This is what opening a document costs.",
	"offline-merge":
		"Two peers each make 100 edits while disconnected, then exchange their changes and merge them.",
	"upstream-map-conflict":
		"16 peers change the same key at the same time. One peer imports all 16 updates and resolves the conflict.",
	compact:
		"Rewrites a document’s stored history into fewer segments, without losing any edit. On a single document nearly every attempt finds the work already done, so this row mostly times that check.",
	read_delta:
		"Reads only the edits a client is missing, given the versions it already has.",
	mixed:
		"45% patch appends, 25% reads from a version vector, 10% full writes, 10% full reads and 10% compactions.",
};

export function scenarioLabel(scenario: string) {
	const [name, size] = scenario.split("/");
	return {
		label: scenarioNames[name] ?? name,
		detail: size.startsWith("history-")
			? `${formatCount(Number(size.slice(8)))} prior edits`
			: size === "100-per-peer"
				? "100 offline edits per peer"
				: size === "16-peers"
					? "16 concurrent peers"
					: `${formatCount(Number(size))} editable items`,
		help: scenarioHelp[name],
	};
}
