import type { PulseVersionVector } from "../connection/PulseVersionVector.js";
import { validateVector } from "../connection/PulseVersionVector.js";
import { PulseError } from "../protocol/errors.js";
import { validateDocId } from "../protocol/validateDocId.js";
import {
	MAX_MESSAGE_ROWS,
	MAX_PATCH_BYTES,
	MAX_ROW_BATCH_NODES,
	MAX_VECTOR_ENTRIES,
} from "../protocol/limits.js";
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

-- One bounded page of what pulsify_missing returns. STABLE, so every read sees the snapshot of
-- the calling statement. The first row carries the document vector; when a budget stops the
-- page, a last row (sid, next_from, next_straddle) says where to resume. Actors are walked in
-- sid order from p_after_sid. Each one's rows and values are merged by keyset from its lower
-- bound, 64 keys and sizes at a time; a payload is read only for a row the page serves. Null
-- budgets are unbounded; the first row of a page is always served.
CREATE OR REPLACE FUNCTION pulsify_missing_page(
 p_doc_id text, p_sids bigint[], p_clocks bigint[],
 p_after_sid bigint, p_after_from bigint, p_after_straddle boolean,
 p_max_rows bigint, p_max_bytes bigint, p_max_nodes bigint, p_row_bytes bigint
) RETURNS TABLE(sid bigint, time_start bigint, span bigint, dependencies jsonb, operations bytea,
 vv jsonb, next_from bigint, next_straddle boolean)
-- Its statements are planned once for any document: a bitmap or sequential scan would read
-- every row of an actor where an ordered index scan stops after a batch.
LANGUAGE plpgsql STABLE SET jit=off SET enable_bitmapscan=off SET enable_seqscan=off AS $$
DECLARE
 v_actor record; v_held record; v_curr record; v_have boolean; v_pos bigint;
 v_from bigint; v_straddle boolean; v_op_from bigint; v_val_from bigint;
 c_start bigint; c_span bigint; c_deps jsonb; c_bytes bigint; c_value boolean;
 c_from bigint; c_straddle boolean;
 v_rows bigint := 0; v_bytes bigint := 0; v_nodes bigint := 0; v_size bigint; v_cost bigint;
BEGIN
 vv := (SELECT COALESCE(jsonb_agg(jsonb_build_array(c.sid,c.clock) ORDER BY c.sid),'[]'::jsonb)
  FROM pulsify_doc_clocks c WHERE c.doc_id=p_doc_id);
 RETURN NEXT;
 vv := NULL;
 FOR v_actor IN SELECT c.sid AS id,c.clock AS frontier,COALESCE(r.clock,0) AS known
  FROM pulsify_doc_clocks c LEFT JOIN unnest(p_sids,p_clocks) AS r(id,clock) ON r.id=c.sid
  WHERE c.doc_id=p_doc_id AND c.clock>COALESCE(r.clock,0) AND (p_after_sid IS NULL OR c.sid>=p_after_sid)
  ORDER BY c.sid
 LOOP
  IF v_actor.id=p_after_sid THEN v_from:=p_after_from; v_straddle:=p_after_straddle;
  ELSE v_from:=GREATEST(v_actor.known,1); v_straddle:=true;
  END IF;
  CONTINUE WHEN v_from>=v_actor.frontier;
  v_op_from:=v_from; v_val_from:=v_from;
  IF v_straddle THEN
   v_op_from:=COALESCE((SELECT o.time_start FROM pulsify_op_rows o WHERE o.doc_id=p_doc_id
    AND o.sid=v_actor.id AND o.time_start<=v_from ORDER BY o.time_start DESC LIMIT 1),v_from);
   v_val_from:=COALESCE((SELECT w.clock FROM pulsify_values w WHERE w.doc_id=p_doc_id
    AND w.sid=v_actor.id AND w.clock<=v_from ORDER BY w.clock DESC LIMIT 1),v_from);
  END IF;
  v_have:=false; v_pos:=LEAST(v_op_from,v_val_from);
  LOOP
   -- The next keys of both, then the frontier, which closes the last span.
   FOR v_held IN SELECT h.t,h.d,h.n,h.v FROM (
    (SELECT o.time_start AS t,o.dependencies AS d,octet_length(o.operations)::bigint AS n,false AS v
     FROM pulsify_op_rows o WHERE o.doc_id=p_doc_id AND o.sid=v_actor.id
     AND o.time_start>=GREATEST(v_op_from,v_pos) AND o.ready AND o.operations<>'\\x03010000'::bytea
     ORDER BY o.time_start LIMIT 64)
    UNION ALL
    (SELECT w.clock,w.dependencies,octet_length(w.operations)::bigint,true FROM pulsify_values w
     WHERE w.doc_id=p_doc_id AND w.sid=v_actor.id AND w.clock>=GREATEST(v_val_from,v_pos)
     ORDER BY w.clock LIMIT 64)
    UNION ALL SELECT v_actor.frontier,NULL::jsonb,NULL::bigint,NULL::boolean
   ) h ORDER BY h.t LIMIT 64
   LOOP
    c_start:=NULL;
    IF NOT v_have THEN
     -- No held row starts at or before v_from: a gap row covers up to the first one.
     IF v_held.t>v_from THEN
      c_start:=v_from; c_span:=v_held.t-v_from; c_bytes:=4; c_value:=NULL;
      c_deps:=CASE WHEN v_from>1 THEN jsonb_build_array(jsonb_build_array(v_actor.id,v_from)) ELSE '[]'::jsonb END;
      c_from:=v_from; c_straddle:=false;
     END IF;
    ELSIF NOT (v_straddle AND v_held.t<=v_from) THEN
     -- The held row before this one runs to it.
     c_start:=v_curr.t; c_span:=v_held.t-v_curr.t; c_deps:=v_curr.d; c_bytes:=v_curr.n; c_value:=v_curr.v;
     c_straddle:=v_straddle AND v_curr.t<v_from;
     c_from:=CASE WHEN c_straddle THEN v_from ELSE v_curr.t END;
    END IF;
    IF c_start IS NOT NULL THEN
     v_size:=c_bytes+jsonb_array_length(c_deps)*16+p_row_bytes;
     v_cost:=7+3*jsonb_array_length(c_deps);
     IF v_rows>0 AND (v_rows>=p_max_rows OR v_bytes+v_size>p_max_bytes OR v_nodes+v_cost>p_max_nodes) THEN
      sid:=v_actor.id; time_start:=NULL; span:=NULL; dependencies:=NULL; operations:=NULL;
      next_from:=c_from; next_straddle:=c_straddle;
      RETURN NEXT; RETURN;
     END IF;
     sid:=v_actor.id; time_start:=c_start; span:=c_span; dependencies:=c_deps;
     operations:=CASE
      WHEN c_value IS NULL THEN '\\x03010000'::bytea
      WHEN c_value THEN (SELECT w.operations FROM pulsify_values w
       WHERE w.doc_id=p_doc_id AND w.sid=v_actor.id AND w.clock=c_start LIMIT 1)
      ELSE (SELECT o.operations FROM pulsify_op_rows o
       WHERE o.doc_id=p_doc_id AND o.sid=v_actor.id AND o.time_start=c_start)
     END;
     RETURN NEXT;
     v_rows:=v_rows+1; v_bytes:=v_bytes+v_size; v_nodes:=v_nodes+v_cost;
    END IF;
    v_curr:=v_held; v_have:=true; v_pos:=v_held.t+1;
   END LOOP;
   EXIT WHEN v_curr.d IS NULL;
  END LOOP;
 END LOOP;
END;
$$;
`;

/** Where a page stopped: the actor, and the clock its next page starts from. */
type PostgresMissingCursor = {
	sid: number;
	from: number;
	straddle: boolean;
	vv: PulseVersionVector;
};

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
		{
			after,
			maxBytes = 2 * MAX_PATCH_BYTES,
			maxRows = MAX_MESSAGE_ROWS,
			maxNodes = MAX_ROW_BATCH_NODES,
		}: MissingPageOptions = {},
	): Promise<MissingPage> {
		validateDocId(docId);
		validateVector(remote);
		const cursor = after as PostgresMissingCursor | undefined;
		const budget = (value: number) =>
			Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
		const result = await this.query(
			"SELECT * FROM pulsify_missing_page($1::text,$2::bigint[],$3::bigint[],$4::bigint,$5::bigint,$6::boolean,$7::bigint,$8::bigint,$9::bigint,$10::bigint)",
			[
				docId,
				remote.map(([sid]) => sid),
				remote.map(([, clock]) => clock),
				cursor?.sid ?? null,
				cursor?.from ?? null,
				cursor?.straddle ?? null,
				budget(maxRows),
				budget(maxBytes),
				budget(maxNodes),
				// The per-row overhead SqlitePatchStore counts too.
				docId.length * 4 + 64,
			],
		);
		const live: PulseVersionVector = (
			result[0]!["vv"] as [number, number][]
		).map(([sid, clock]) => [Number(sid), Number(clock)]);
		// Actors served by earlier pages keep the frontier they were served to.
		const vv: PulseVersionVector = cursor
			? [
					...cursor.vv.filter(([sid]) => sid < cursor.sid),
					...live.filter(([sid]) => sid >= cursor.sid),
				]
			: live;
		const rows: StoredPatchRow[] = [];
		let next: PostgresMissingCursor | undefined;
		for (const row of result.slice(1))
			if (row["time_start"] !== null)
				rows.push(unpack({ ...row, doc_id: docId }));
			else
				next = {
					sid: Number(row["sid"]),
					from: Number(row["next_from"]),
					straddle: row["next_straddle"] === true,
					vv,
				};
		return { rows, vv, next };
	}
}
