/** Deployment choices are separate from workload, schema and reporting. */
export const engines = {
	postgres: {
		image: "postgres:16-alpine",
		native: "postgres",
		accessMethod: "heap",
	},
	sqlite: { image: null, native: "sqlite", accessMethod: null },
	alloydb: {
		image: "google/alloydbomni:17.10.0",
		native: null,
		accessMethod: "heap",
	},
	orioledb: {
		image: "orioledb/orioledb:latest-pg17",
		native: null,
		accessMethod: "orioledb",
	},
	"pgrust-row": {
		image: "malisper/pgrust:v0.4-beta",
		native: "pgrust",
		accessMethod: "heap",
	},
	"pgrust-columnar": {
		image: "malisper/pgrust:v0.4-beta",
		native: "pgrust",
		accessMethod: "pgrcolumnar",
	},
} as const;
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
