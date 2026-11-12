/** Deployment choices are separate from workload, schema and reporting. */
export const engines = {
	postgres: {
		image: "postgres:16-alpine",
		accessMethod: "heap",
	},
	sqlite: { image: null, accessMethod: null },
	alloydb: {
		image: "google/alloydbomni:17.10.0",
		accessMethod: "heap",
	},
	orioledb: {
		image: "orioledb/orioledb:latest-pg17",
		accessMethod: "orioledb",
	},
	"pgrust-row": {
		image: "malisper/pgrust:v0.4-beta",
		accessMethod: "heap",
	},
	"pgrust-columnar": {
		image: "malisper/pgrust:v0.4-beta",
		accessMethod: "pgrcolumnar",
	},
	// Embedded in the runner, like SQLite: no server, no image.
	rocksdb: { image: null, accessMethod: null },
	// RocksDB without its transaction layer: a mutex in the runner instead.
	"rocksdb-mutex": { image: null, accessMethod: null },
	lmdb: { image: null, accessMethod: null },
	leveldb: { image: null, accessMethod: null },
	// In-memory servers: the whole dataset lives in RAM.
	valkey: {
		image: "valkey/valkey:9.0.3-alpine",
		accessMethod: null,
	},
	dragonfly: {
		image: "docker.dragonflydb.io/dragonflydb/dragonfly:v2.1.0",
		accessMethod: null,
	},
	// Curiosity: a wide-column store with no interactive transactions, and an
	// analytical engine with no row locks. See their adapters for the workarounds.
	scylla: { image: "scylladb/scylla:latest", accessMethod: null },
	clickhouse: {
		image: "clickhouse/clickhouse-server:25.7",
		accessMethod: null,
	},
} as const;
/** Address the runner uses for each non-PostgreSQL server, inside the Compose network. */
export const serverUrls: Record<string, string> = {
	valkey: "redis://valkey:6379",
	dragonfly: "redis://dragonfly:6379",
	scylla: "scylla:9042",
	clickhouse: "http://clickhouse:8123",
};
/** Engines with no flush-before-acknowledge mode: they only run in the relaxed tier. */
export const relaxedOnly = new Set<string>(["dragonfly"]);
export type Backend = keyof typeof engines;
export const pgSettings = [
	"-c",
	"max_connections=180",
	"-c",
	"shared_buffers=128MB",
	"-c",
	"max_wal_size=128MB",
	"-c",
	"min_wal_size=32MB",
	"-c",
	"checkpoint_timeout=60s",
];
