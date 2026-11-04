export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_PATCH_BYTES = 1024 * 1024;
export const MAX_MESSAGE_ROWS = 4096;
export const MAX_VECTOR_ENTRIES = 1024;
// Keep outgoing batches compatible with the independent Rust relay's budget.
export const MAX_SCHEMA_NODES = 300_000;
// The largest sync envelope has a vector plus eleven fixed schema nodes.
export const MAX_ROW_BATCH_NODES =
	MAX_SCHEMA_NODES - (3 * MAX_VECTOR_ENTRIES + 16);
