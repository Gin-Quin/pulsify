import type { PulseVersionVector } from "../connection/PulseVersionVector.js";
import { validateVector } from "../connection/PulseVersionVector.js";
import { PulseError } from "../protocol/errors.js";
import { validateDocId } from "../protocol/validateDocId.js";
import { MAX_VECTOR_ENTRIES } from "../protocol/limits.js";
import { rowDependencies, rowOperations } from "../protocol/scalarRuns.js";
import {
	rowsFromFrame,
	validateRows,
	type AppendResult,
	type MissingPage,
	type MissingPageOptions,
	type PatchStore,
	type StoredPatchRow,
} from "./rows.js";

export type PostgresQuery = (
	sql: string,
	parameters?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

/**
 * Versioned schema; payloads travel as bytea, never as JSON or base64. A
 * ready last-value row is kept in `pulsify_values`, one per actor and
 * register, overwritten in place; `pulsify_register` reads its register.
 */
export const POSTGRES_PATCH_SCHEMA: string = `
CREATE TABLE IF NOT EXISTS pulsify_op_rows (
 doc_id text NOT NULL, sid bigint NOT NULL CHECK(sid >= 65536),
 time_start bigint NOT NULL CHECK(time_start > 0), span bigint NOT NULL CHECK(span > 0),
 time_end bigint GENERATED ALWAYS AS (time_start + span) STORED,
 dependencies jsonb NOT NULL, operations bytea NOT NULL CHECK(octet_length(operations) BETWEEN 1 AND 1048576),
 ready boolean NOT NULL DEFAULT false, PRIMARY KEY(doc_id,sid,time_start),
 CHECK(time_start + span <= 9007199254740991)
);
DROP INDEX IF EXISTS pulsify_rows_frontier;
CREATE INDEX IF NOT EXISTS pulsify_rows_pending ON pulsify_op_rows(doc_id) WHERE NOT ready;
CREATE TABLE IF NOT EXISTS pulsify_doc_clocks (
 doc_id text NOT NULL, sid bigint NOT NULL, clock bigint NOT NULL, PRIMARY KEY(doc_id,sid)
);
CREATE TABLE IF NOT EXISTS pulsify_values (
 doc_id text NOT NULL, sid bigint NOT NULL, register bytea NOT NULL, clock bigint NOT NULL,
 dependencies jsonb NOT NULL, operations bytea NOT NULL, PRIMARY KEY(doc_id,sid,register)
);
CREATE INDEX IF NOT EXISTS pulsify_values_clock ON pulsify_values(doc_id,sid,clock);
-- An unreleased layout indexed last-value rows by register in pulsify_op_rows:
-- its rows move to pulsify_values, and its gap rows are holes now.
DO $migrate$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
  AND table_name='pulsify_op_rows' AND column_name='register') THEN
  INSERT INTO pulsify_values(doc_id,sid,register,clock,dependencies,operations)
   SELECT doc_id,sid,register,time_start,dependencies,operations FROM pulsify_op_rows
   WHERE ready AND register IS NOT NULL ON CONFLICT DO NOTHING;
  DELETE FROM pulsify_op_rows WHERE ready AND (register IS NOT NULL OR operations='\\x03010000'::bytea);
  DROP VIEW IF EXISTS pulsify_dangling_op_rows;
  DROP INDEX IF EXISTS pulsify_rows_register;
  ALTER TABLE pulsify_op_rows DROP COLUMN register, DROP COLUMN IF EXISTS lamport;
 END IF;
END
$migrate$;
CREATE OR REPLACE VIEW pulsify_dangling_op_rows AS SELECT * FROM pulsify_op_rows WHERE NOT ready;
DROP FUNCTION IF EXISTS pulsify_append(text, jsonb, bytea[], bytea[]);
DROP FUNCTION IF EXISTS pulsify_settle(text, bigint, bigint);
DROP FUNCTION IF EXISTS pulsify_kill(text, bigint, bigint);

-- A varuint of a payload head, read as leniently as the TypeScript codec does: null past the end.
CREATE OR REPLACE FUNCTION pulsify_head_uint(p bytea, INOUT pos bigint, OUT value bigint)
LANGUAGE plpgsql IMMUTABLE SET jit=off AS $$
DECLARE v_byte integer; v_scale bigint := 1;
BEGIN
 value := 0;
 FOR i IN 0..8 LOOP
  IF pos >= length(p) THEN value := NULL; RETURN; END IF;
  v_byte := get_byte(p, pos::integer); pos := pos + 1;
  value := value + (v_byte & 127) * v_scale;
  IF value > 9007199254740991 THEN value := NULL; RETURN; END IF;
  IF v_byte < 128 THEN RETURN; END IF;
  v_scale := v_scale * 128;
 END LOOP;
 value := NULL;
END;
$$;

-- Mirror of lastRegisterOf: the register of a row that is one last-value write, or null.
-- Its head is version 3, lamport, schema, count 1, kind 7 or 8, target, field.
CREATE OR REPLACE FUNCTION pulsify_register(p bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE SET jit=off AS $$
DECLARE v_pos bigint := 0; v_value bigint; v_start bigint;
BEGIN
 SELECT h.pos,h.value INTO v_pos,v_value FROM pulsify_head_uint(p,v_pos) h;
 IF v_value IS DISTINCT FROM 3 THEN RETURN NULL; END IF;
 SELECT h.pos,h.value INTO v_pos,v_value FROM pulsify_head_uint(p,v_pos) h;
 IF v_value IS NULL THEN RETURN NULL; END IF;
 SELECT h.pos,h.value INTO v_pos,v_value FROM pulsify_head_uint(p,v_pos) h;
 IF v_value IS NULL THEN RETURN NULL; END IF;
 v_pos := v_pos + v_value;
 SELECT h.pos,h.value INTO v_pos,v_value FROM pulsify_head_uint(p,v_pos) h;
 IF v_value IS DISTINCT FROM 1 THEN RETURN NULL; END IF;
 SELECT h.pos,h.value INTO v_pos,v_value FROM pulsify_head_uint(p,v_pos) h;
 IF v_value IS NULL OR v_value NOT IN (7,8) THEN RETURN NULL; END IF;
 v_start := v_pos;
 SELECT h.pos,h.value INTO v_pos,v_value FROM pulsify_head_uint(p,v_pos) h;
 IF v_value IS NULL THEN RETURN NULL; END IF;
 v_pos := v_pos + v_value;
 SELECT h.pos,h.value INTO v_pos,v_value FROM pulsify_head_uint(p,v_pos) h;
 IF v_value IS NULL THEN RETURN NULL; END IF;
 IF v_value = 0 THEN
  SELECT h.pos,h.value INTO v_pos,v_value FROM pulsify_head_uint(p,v_pos) h;
  IF v_value IS NULL THEN RETURN NULL; END IF;
  v_pos := v_pos + v_value;
 ELSE
  SELECT h.pos,h.value INTO v_pos,v_value FROM pulsify_head_uint(p,v_pos) h;
  IF v_value IS NULL THEN RETURN NULL; END IF;
 END IF;
 IF v_pos > length(p) THEN RETURN NULL; END IF;
 RETURN substring(p FROM (v_start + 1)::integer FOR (v_pos - v_start)::integer);
END;
$$;

-- Each metadata item is [sid, start, span, dependencies]. A ready last-value row is upserted
-- as its actor's value of the register; a ready gap row only moves the frontier.
CREATE OR REPLACE FUNCTION pulsify_append(
 p_doc_id text, p_metadata jsonb, p_payloads bytea[]
) RETURNS TABLE(inserted integer, ready integer, pending integer)
LANGUAGE plpgsql SET jit=off AS $$
DECLARE
 v_inserted integer := 0; v_ready integer := 0; v_index integer;
 v_item jsonb; v_sid bigint; v_start bigint; v_span bigint; v_end bigint; v_deps jsonb;
 v_own bigint; v_reached bigint; v_ready_now boolean; v_operations bytea; v_register bytea;
 v_held record; v_neighbour record; candidate record; v_changed boolean;
BEGIN
 -- All appenders to a document use this transactional lock. Hash collisions only serialize unrelated documents.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_doc_id, 1932));
 IF jsonb_typeof(p_metadata) <> 'array' OR jsonb_array_length(p_metadata) <> cardinality(p_payloads) THEN
  RAISE EXCEPTION 'Invalid segment batch';
 END IF;
 FOR v_index IN 1..jsonb_array_length(p_metadata) LOOP
  v_item:=p_metadata->(v_index-1); v_sid:=(v_item->>0)::bigint; v_start:=(v_item->>1)::bigint;
  v_span:=(v_item->>2)::bigint; v_deps:=v_item->3; v_end:=v_start+v_span; v_operations:=p_payloads[v_index];
  v_own:=COALESCE((SELECT (d->>1)::bigint FROM jsonb_array_elements(v_deps) d WHERE (d->>0)::bigint=v_sid),0);
  v_reached:=COALESCE((SELECT clock FROM pulsify_doc_clocks WHERE doc_id=p_doc_id AND sid=v_sid),1);
  IF v_start<v_reached THEN
   -- Known, or replaced here: only its contents can conflict, with what is held at that clock,
   -- and only its span can say that more writes were replaced.
   SELECT operations INTO v_held FROM pulsify_op_rows WHERE doc_id=p_doc_id AND sid=v_sid AND time_start=v_start;
   IF NOT FOUND THEN
    SELECT operations INTO v_held FROM pulsify_values WHERE doc_id=p_doc_id AND sid=v_sid AND clock=v_start;
   END IF;
   IF FOUND AND v_held.operations<>'\\x03010000'::bytea AND v_operations<>'\\x03010000'::bytea AND v_held.operations<>v_operations THEN
    RAISE EXCEPTION 'Conflicting storage segment';
   END IF;
   IF v_end>v_reached THEN
    -- Rows that waited below the new frontier were replaced.
    DELETE FROM pulsify_op_rows o WHERE doc_id=p_doc_id AND sid=v_sid AND NOT o.ready AND time_start>=v_reached AND time_start<v_end;
    INSERT INTO pulsify_doc_clocks(doc_id,sid,clock) VALUES(p_doc_id,v_sid,v_end)
     ON CONFLICT(doc_id,sid) DO UPDATE SET clock=GREATEST(pulsify_doc_clocks.clock,EXCLUDED.clock);
    v_inserted:=v_inserted+1;
   END IF;
   CONTINUE;
  END IF;
  v_ready_now:=v_start=v_reached AND NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements(v_deps) d
   LEFT JOIN pulsify_doc_clocks c ON c.doc_id=p_doc_id AND c.sid=(d->>0)::bigint
   WHERE COALESCE(c.clock,0)<(d->>1)::bigint);
  SELECT span,operations INTO v_held FROM pulsify_op_rows WHERE doc_id=p_doc_id AND sid=v_sid AND time_start=v_start;
  IF FOUND THEN
   -- A waiting row with the same start: only contents conflict, and the longer span is kept.
   IF v_held.operations<>'\\x03010000'::bytea AND v_operations<>'\\x03010000'::bytea AND v_held.operations<>v_operations THEN
    RAISE EXCEPTION 'Conflicting storage segment';
   END IF;
   IF v_span>v_held.span THEN
    UPDATE pulsify_op_rows SET span=v_span WHERE doc_id=p_doc_id AND sid=v_sid AND time_start=v_start;
    -- The waiting rows it now covers were replaced.
    DELETE FROM pulsify_op_rows o WHERE doc_id=p_doc_id AND sid=v_sid AND NOT o.ready AND time_start>v_start AND time_start<v_end;
   END IF;
   CONTINUE;
  END IF;
  SELECT time_end INTO v_neighbour FROM pulsify_op_rows
   WHERE doc_id=p_doc_id AND sid=v_sid AND time_start<v_start ORDER BY time_start DESC LIMIT 1;
  IF FOUND THEN
   -- It starts among the writes a waiting row has replaced.
   IF v_neighbour.time_end>v_start THEN CONTINUE; END IF;
   IF v_own<v_neighbour.time_end THEN RAISE EXCEPTION 'Actor history fork'; END IF;
  END IF;
  SELECT dependencies INTO v_neighbour FROM pulsify_op_rows
   WHERE doc_id=p_doc_id AND sid=v_sid AND time_start>=v_end ORDER BY time_start LIMIT 1;
  IF FOUND AND COALESCE((SELECT (d->>1)::bigint FROM jsonb_array_elements(v_neighbour.dependencies) d WHERE (d->>0)::bigint=v_sid),0)<v_end THEN
   RAISE EXCEPTION 'Actor history fork';
  END IF;
  -- Rows still waiting that this row has replaced.
  DELETE FROM pulsify_op_rows o WHERE doc_id=p_doc_id AND sid=v_sid AND NOT o.ready AND time_start>v_start AND time_start<v_end;
  v_inserted:=v_inserted+1;
  IF v_ready_now THEN
   v_register:=pulsify_register(v_operations);
   IF v_register IS NOT NULL THEN
    INSERT INTO pulsify_values(doc_id,sid,register,clock,dependencies,operations)
     VALUES(p_doc_id,v_sid,v_register,v_start,v_deps,v_operations)
     ON CONFLICT(doc_id,sid,register) DO UPDATE SET clock=EXCLUDED.clock,dependencies=EXCLUDED.dependencies,operations=EXCLUDED.operations;
   ELSIF v_operations<>'\\x03010000'::bytea THEN
    INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations,ready)
     VALUES(p_doc_id,v_sid,v_start,v_span,v_deps,v_operations,true);
   END IF;
   INSERT INTO pulsify_doc_clocks(doc_id,sid,clock) VALUES(p_doc_id,v_sid,v_end)
    ON CONFLICT(doc_id,sid) DO UPDATE SET clock=GREATEST(pulsify_doc_clocks.clock,EXCLUDED.clock);
   v_ready:=v_ready+1;
  ELSE
   INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations,ready)
    VALUES(p_doc_id,v_sid,v_start,v_span,v_deps,v_operations,false);
  END IF;
 END LOOP;
 IF (SELECT COUNT(*) FROM (
  SELECT sid FROM pulsify_doc_clocks WHERE doc_id=p_doc_id
  UNION SELECT sid FROM pulsify_op_rows WHERE doc_id=p_doc_id AND NOT pulsify_op_rows.ready
 ) actors) > ${MAX_VECTOR_ENTRIES} THEN RAISE EXCEPTION 'Document actor limit exceeded'; END IF;
 -- Only pending metadata is read, and the payload of a row once it is ready.
 LOOP
  v_changed := false;
  FOR candidate IN SELECT sid,time_start,time_end,dependencies FROM pulsify_op_rows
   WHERE doc_id=p_doc_id AND NOT pulsify_op_rows.ready ORDER BY sid,time_start
  LOOP
   IF candidate.time_start=COALESCE((SELECT c.clock FROM pulsify_doc_clocks c WHERE c.doc_id=p_doc_id AND c.sid=candidate.sid),1) AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(candidate.dependencies) d
    LEFT JOIN pulsify_doc_clocks c ON c.doc_id=p_doc_id AND c.sid=(d->>0)::bigint
    WHERE COALESCE(c.clock,0)<(d->>1)::bigint
   ) THEN
    SELECT operations INTO v_held FROM pulsify_op_rows WHERE doc_id=p_doc_id AND sid=candidate.sid AND time_start=candidate.time_start;
    v_register:=pulsify_register(v_held.operations);
    IF v_register IS NOT NULL THEN
     INSERT INTO pulsify_values(doc_id,sid,register,clock,dependencies,operations)
      VALUES(p_doc_id,candidate.sid,v_register,candidate.time_start,candidate.dependencies,v_held.operations)
      ON CONFLICT(doc_id,sid,register) DO UPDATE SET clock=EXCLUDED.clock,dependencies=EXCLUDED.dependencies,operations=EXCLUDED.operations;
    END IF;
    IF v_register IS NOT NULL OR v_held.operations='\\x03010000'::bytea THEN
     DELETE FROM pulsify_op_rows WHERE doc_id=p_doc_id AND sid=candidate.sid AND time_start=candidate.time_start;
    ELSE
     UPDATE pulsify_op_rows SET ready=true WHERE doc_id=p_doc_id AND sid=candidate.sid AND time_start=candidate.time_start;
    END IF;
    INSERT INTO pulsify_doc_clocks(doc_id,sid,clock) VALUES(p_doc_id,candidate.sid,candidate.time_end)
     ON CONFLICT(doc_id,sid) DO UPDATE SET clock=GREATEST(pulsify_doc_clocks.clock,EXCLUDED.clock);
    v_ready := v_ready + 1; v_changed := true;
   END IF;
  END LOOP;
  EXIT WHEN NOT v_changed;
 END LOOP;
 RETURN QUERY SELECT v_inserted,v_ready,(SELECT COUNT(*)::integer FROM pulsify_op_rows WHERE doc_id=p_doc_id AND NOT pulsify_op_rows.ready);
END;
$$;

-- The rows a peer lacks. Spans are computed: each held row (a history row or a value) runs to
-- the next one of its actor, the last one to the frontier. Where no held row starts at or
-- before the point the peer's knowledge ends, a gap row covers up to the first one.
CREATE OR REPLACE FUNCTION pulsify_missing(p_doc_id text, p_sids bigint[], p_clocks bigint[])
RETURNS TABLE(sid bigint, time_start bigint, span bigint, dependencies jsonb, operations bytea)
LANGUAGE sql STABLE AS $$
 WITH remote(sid,clock) AS (SELECT * FROM unnest(p_sids,p_clocks)),
 actors AS (
  SELECT c.sid,c.clock AS frontier,GREATEST(COALESCE(r.clock,0),1) AS since
  FROM pulsify_doc_clocks c LEFT JOIN remote r ON r.sid=c.sid
  WHERE c.doc_id=p_doc_id AND c.clock>COALESCE(r.clock,0)),
 bounds AS MATERIALIZED (
  SELECT a.sid,a.frontier,a.since,
   COALESCE((SELECT p.time_start FROM pulsify_op_rows p
    WHERE p.doc_id=p_doc_id AND p.sid=a.sid AND p.time_start<=a.since
    ORDER BY p.time_start DESC LIMIT 1),0) AS op_from,
   COALESCE((SELECT w.clock FROM pulsify_values w
    WHERE w.doc_id=p_doc_id AND w.sid=a.sid AND w.clock<=a.since
    ORDER BY w.clock DESC LIMIT 1),0) AS val_from
  FROM actors a),
 held AS (
  SELECT o.sid,o.time_start,o.dependencies,o.operations FROM bounds a
   JOIN pulsify_op_rows o ON o.doc_id=p_doc_id AND o.sid=a.sid AND o.time_start>=a.op_from
   WHERE o.ready AND o.operations<>'\\x03010000'::bytea
  UNION ALL
  SELECT v.sid,v.clock,v.dependencies,v.operations FROM bounds a
   JOIN pulsify_values v ON v.doc_id=p_doc_id AND v.sid=a.sid AND v.clock>=a.val_from),
 spans AS (
  SELECT h.sid,h.time_start,COALESCE(LEAD(h.time_start) OVER (PARTITION BY h.sid ORDER BY h.time_start),a.frontier)
   -h.time_start AS span,h.dependencies,h.operations,a.since
  FROM held h JOIN bounds a ON a.sid=h.sid)
 SELECT s.sid,s.time_start,s.span,s.dependencies,s.operations FROM spans s WHERE s.time_start+s.span>s.since
 UNION ALL
 SELECT a.sid,a.since,COALESCE((SELECT MIN(h.time_start) FROM held h WHERE h.sid=a.sid),a.frontier)-a.since,
  CASE WHEN a.since>1 THEN jsonb_build_array(jsonb_build_array(a.sid,a.since)) ELSE '[]'::jsonb END,
  '\\x03010000'::bytea
 FROM bounds a WHERE NOT EXISTS (SELECT 1 FROM held h WHERE h.sid=a.sid AND h.time_start<=a.since)
 ORDER BY 1,2
$$;
`;

function unpack(row: Record<string, unknown>): StoredPatchRow {
	return {
		docId: row["doc_id"] as string,
		sid: Number(row["sid"]),
		clock: Number(row["time_start"]),
		span: Number(row["span"]),
		dependencies: row["dependencies"] as PulseVersionVector,
		operations: new Uint8Array(row["operations"] as Uint8Array),
	};
}

/** A complete append batch uses a single database round trip and one transaction. */
export class PostgresPatchStore implements PatchStore {
	constructor(private readonly query: PostgresQuery) {}
	async initialize(): Promise<void> {
		await this.query(POSTGRES_PATCH_SCHEMA);
	}
	async appendEncoded(frame: Uint8Array): Promise<AppendResult> {
		return this.append(rowsFromFrame(frame));
	}
	async append(rows: readonly StoredPatchRow[]): Promise<AppendResult> {
		const docId = validateRows(rows);
		if (docId === undefined) return { inserted: 0, ready: 0, pending: 0 };
		const metadata = rows.map((row) => [
			row.sid,
			row.clock,
			row.span,
			rowDependencies(row),
		]);
		const result = await this.query(
			"SELECT * FROM pulsify_append($1::text,$2::text::jsonb,$3::bytea[])",
			[docId, JSON.stringify(metadata), rows.map((row) => rowOperations(row))],
		).catch((error: unknown) => {
			// What the function raises, as the errors every other store throws.
			const message = error instanceof Error ? error.message : String(error);
			for (const [text, code] of [
				["Conflicting storage segment", "CONFLICT"],
				["Actor history fork", "CONFLICT"],
				["Document actor limit exceeded", "LIMIT_EXCEEDED"],
				["Invalid segment batch", "INVALID_MESSAGE"],
			] as const)
				if (message.includes(text))
					throw new PulseError(code, text, { cause: error });
			throw error;
		});
		const counts = result[0]!;
		return {
			inserted: Number(counts["inserted"]),
			ready: Number(counts["ready"]),
			pending: Number(counts["pending"]),
		};
	}
	async vector(docId: string): Promise<PulseVersionVector> {
		validateDocId(docId);
		return (
			await this.query(
				"SELECT sid,clock FROM pulsify_doc_clocks WHERE doc_id=$1 ORDER BY sid",
				[docId],
			)
		).map((row) => [Number(row["sid"]), Number(row["clock"])]);
	}
	async missing(
		docId: string,
		remote: PulseVersionVector,
	): Promise<StoredPatchRow[]> {
		validateDocId(docId);
		validateVector(remote);
		return (
			await this.query(
				"SELECT * FROM pulsify_missing($1::text,$2::bigint[],$3::bigint[])",
				[docId, remote.map(([sid]) => sid), remote.map(([, clock]) => clock)],
			)
		).map((row) => unpack({ ...row, doc_id: docId }));
	}
	async missingPage(
		docId: string,
		remote: PulseVersionVector,
		_options?: MissingPageOptions,
	): Promise<MissingPage> {
		validateDocId(docId);
		validateVector(remote);
		const result = await this.query(
			`SELECT
 CASE WHEN row_number() OVER () = 1 THEN (
  SELECT COALESCE(jsonb_agg(jsonb_build_array(sid, clock) ORDER BY sid), '[]'::jsonb)
  FROM pulsify_doc_clocks WHERE doc_id=$1::text
 ) END AS vv,
 m.sid, m.time_start, m.span, m.dependencies, m.operations
FROM (SELECT 1) AS anchor
LEFT JOIN pulsify_missing($1::text,$2::bigint[],$3::bigint[]) m ON true`,
			[docId, remote.map(([sid]) => sid), remote.map(([, clock]) => clock)],
		);
		const rawVv = (result[0]?.["vv"] as [number, number][] | undefined) ?? [];
		const vv: PulseVersionVector = rawVv.map(([sid, clock]) => [
			Number(sid),
			Number(clock),
		]);
		const rows: StoredPatchRow[] = [];
		for (const row of result)
			if (row["sid"] !== null && row["sid"] !== undefined)
				rows.push(unpack({ ...row, doc_id: docId }));
		return { rows, vv, next: undefined };
	}
}
