export {
	PostgresPatchStore,
	POSTGRES_PATCH_SCHEMA,
	type PostgresQuery,
} from "./storage/postgres.js";
export {
	SqlitePatchStore,
	SQLITE_PATCH_SCHEMA,
	SQLITE_PACKED_MIGRATION,
	type SqliteCompactCursor,
	type SqliteCompactOptions,
	type SqliteCompactResult,
	type SqliteConnection,
	type SqlitePatchStoreOptions,
} from "./storage/sqlite.js";
// What a store reads from a row to keep the last value only of a field
// without history: see docs/STORAGE.md.
export { GAP_OPERATIONS, isGap, lastRegisterOf } from "./core/operations.js";
export {
	encodeStoredRow,
	decodeStoredRow,
	encodePackedRow,
	decodePackedRows,
	MAX_PACKED_BYTES,
	rowsFromFrame,
	type PatchStore,
	type DocumentStore,
	type MissingPage,
	type MissingPageOptions,
	type StoredPatchRow,
	type AppendResult,
} from "./storage/rows.js";

export { coversDocument, documentPrefixes } from "./storage/documents.js";
