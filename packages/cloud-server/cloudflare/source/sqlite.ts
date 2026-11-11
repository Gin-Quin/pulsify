import { type SqliteConnection } from "@pulsify/core/storage";

// Structural runtime types keep the workspace on one lib set instead of mixing
// DOM with @cloudflare/workers-types.
type SqlCursor = { toArray(): Record<string, unknown>[] };
export type DurableObjectStorageLike = {
	sql: { exec(query: string, ...bindings: unknown[]): SqlCursor };
	transactionSync<T>(work: () => T): T;
};

/** Adapt a Durable Object's synchronous SQLite API to Pulsify's SQLite stores. */
export function durableSqlite(
	storage: DurableObjectStorageLike,
): SqliteConnection {
	type Binding = Parameters<ReturnType<SqliteConnection["query"]>["run"]>;
	const bind = (values: Binding) =>
		values.map((value) =>
			value instanceof Uint8Array
				? value.buffer.slice(
						value.byteOffset,
						value.byteOffset + value.byteLength,
					)
				: value,
		);
	return {
		exec(query) {
			for (const statement of query.split(";"))
				if (statement.trim()) storage.sql.exec(statement);
		},
		query: (query) => ({
			run: (...values) => storage.sql.exec(query, ...bind(values)),
			all: (...values) => storage.sql.exec(query, ...bind(values)).toArray(),
			get: (...values) =>
				storage.sql.exec(query, ...bind(values)).toArray()[0] ?? null,
		}),
		transaction: (work) =>
			Object.assign(() => storage.transactionSync(work), {
				immediate: () => storage.transactionSync(work),
			}),
	};
}
