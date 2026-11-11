import { POSTGRES_PATCH_SCHEMA } from "pulsify-core/storage";

/**
 * PostgreSQL replaces the per-root SQLite of a Durable Object: one database
 * holds every root of the instance, so grants carry their root. The Rust
 * server embeds this exact text (`server/sql/schema.sql`).
 */
export const UNIKRAFT_CLOUD_POSTGRES_SCHEMA: string = `${POSTGRES_PATCH_SCHEMA.trim()}

CREATE TABLE IF NOT EXISTS pulsify_cloud_grants (
 root text NOT NULL, subject text NOT NULL, prefix text NOT NULL,
 role text NOT NULL CHECK (role IN ('reader','editor','owner')),
 PRIMARY KEY (root, subject, prefix)
);
`;

/** Defaults of the image built from `packages/cloud-server/unikraft-cloud/Dockerfile`. */
export const UNIKRAFT_CLOUD_DEFAULTS = {
	/** The Rust server listens here; publish it with `-p 443:8080/tls+http`. */
	port: 8080,
	/** Mount a volume here to keep PostgreSQL's data across instances. */
	dataDirectory: "/data",
	/** PostgreSQL only listens on this Unix socket, never on the network. */
	postgresSocket: "/var/run/postgresql",
} as const;
