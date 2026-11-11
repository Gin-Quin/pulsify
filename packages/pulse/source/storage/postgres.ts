import type { PulseVersionVector } from "../connection/PulseVersionVector.js";
import { validateVector } from "../connection/PulseVersionVector.js";
import { validateDocId } from "../protocol/validateDocId.js";
import { MAX_VECTOR_ENTRIES } from "../protocol/limits.js";
import {
	rowsFromFrame,
	validateRows,
	type AppendResult,
	type PatchStore,
	type StoredPatchRow,
} from "./rows.js";

export type PostgresQuery = (
	sql: string,
	parameters?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

/** Versioned schema; payloads travel as bytea, never as JSON or base64. */
export const POSTGRES_PATCH_SCHEMA: string = `
CREATE TABLE IF NOT EXISTS pulsify_op_rows (
 doc_id text NOT NULL, sid bigint NOT NULL CHECK(sid >= 65536),
 time_start bigint NOT NULL CHECK(time_start > 0), span bigint NOT NULL CHECK(span > 0),
 time_end bigint GENERATED ALWAYS AS (time_start + span) STORED,
 dependencies jsonb NOT NULL, operations bytea NOT NULL CHECK(octet_length(operations) BETWEEN 1 AND 1048576),
 ready boolean NOT NULL DEFAULT false, PRIMARY KEY(doc_id,sid,time_start),
 CHECK(time_start + span <= 9007199254740991)
);
CREATE INDEX IF NOT EXISTS pulsify_rows_frontier ON pulsify_op_rows(doc_id,sid,time_end);
CREATE INDEX IF NOT EXISTS pulsify_rows_pending ON pulsify_op_rows(doc_id) WHERE NOT ready;
CREATE TABLE IF NOT EXISTS pulsify_doc_clocks (
 doc_id text NOT NULL, sid bigint NOT NULL, clock bigint NOT NULL, PRIMARY KEY(doc_id,sid)
);
CREATE OR REPLACE VIEW pulsify_dangling_op_rows AS SELECT * FROM pulsify_op_rows WHERE NOT ready;

CREATE OR REPLACE FUNCTION pulsify_append(
 p_doc_id text, p_metadata jsonb, p_payloads bytea[]
) RETURNS TABLE(inserted integer, ready integer, pending integer)
LANGUAGE plpgsql SET jit=off AS $$
DECLARE
 v_inserted integer := 0; v_ready integer := 0;
 v_item jsonb; v_sid bigint; v_start bigint; v_span bigint; v_deps jsonb;
 v_previous pulsify_op_rows%ROWTYPE; v_neighbour record;
 candidate record; v_changed boolean; v_fast boolean;
BEGIN
 -- All appenders to a document use this transactional lock. Hash collisions only serialize unrelated documents.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_doc_id, 1932));
 IF jsonb_typeof(p_metadata) <> 'array' OR jsonb_array_length(p_metadata) <> cardinality(p_payloads) THEN
  RAISE EXCEPTION 'Invalid segment batch';
 END IF;
 IF jsonb_array_length(p_metadata)=1 THEN
  -- Keep the one-row path small: it should not pay for batch window functions and self joins.
  v_item:=p_metadata->0; v_sid:=(v_item->>0)::bigint; v_start:=(v_item->>1)::bigint;
  v_span:=(v_item->>2)::bigint; v_deps:=v_item->3;
  SELECT * INTO v_previous FROM pulsify_op_rows WHERE doc_id=p_doc_id AND sid=v_sid AND time_start=v_start;
  IF FOUND THEN
   IF v_previous.span<>v_span OR v_previous.dependencies<>v_deps OR v_previous.operations<>p_payloads[1] THEN
    RAISE EXCEPTION 'Conflicting storage segment';
   END IF;
  ELSE
   FOR v_neighbour IN
    (SELECT time_start,time_end,dependencies FROM pulsify_op_rows WHERE doc_id=p_doc_id AND sid=v_sid AND time_start<v_start ORDER BY time_start DESC LIMIT 1)
    UNION ALL
    (SELECT time_start,time_end,dependencies FROM pulsify_op_rows WHERE doc_id=p_doc_id AND sid=v_sid AND time_start>v_start ORDER BY time_start LIMIT 1)
   LOOP
    IF (v_start<v_neighbour.time_end AND v_neighbour.time_start<v_start+v_span) OR
     (v_neighbour.time_start<v_start AND COALESCE((SELECT (d->>1)::bigint FROM jsonb_array_elements(v_deps) d WHERE (d->>0)::bigint=v_sid),0)<v_neighbour.time_end) OR
     (v_neighbour.time_start>v_start AND COALESCE((SELECT (d->>1)::bigint FROM jsonb_array_elements(v_neighbour.dependencies) d WHERE (d->>0)::bigint=v_sid),0)<v_start+v_span)
    THEN RAISE EXCEPTION 'Overlapping segments or actor history fork'; END IF;
   END LOOP;
   INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations) VALUES(p_doc_id,v_sid,v_start,v_span,v_deps,p_payloads[1]);
   v_inserted:=1;
  END IF;
 ELSE
 -- Validate the whole batch with set operations rather than per-row SQL statements.
 IF EXISTS (
  WITH input AS (SELECT value,ordinality AS n FROM jsonb_array_elements(p_metadata) WITH ORDINALITY)
  SELECT 1 FROM input a JOIN input b ON a.value->0=b.value->0 AND a.value->1=b.value->1 AND a.n<b.n
  WHERE a.value<>b.value OR p_payloads[a.n]<>p_payloads[b.n]
 ) THEN RAISE EXCEPTION 'Conflicting storage segment'; END IF;
 IF EXISTS (
  SELECT 1 FROM jsonb_array_elements(p_metadata) WITH ORDINALITY i(value,n)
  JOIN pulsify_op_rows o ON o.doc_id=p_doc_id AND o.sid=(i.value->>0)::bigint AND o.time_start=(i.value->>1)::bigint
  WHERE o.span<>(i.value->>2)::bigint OR o.dependencies<>i.value->3 OR o.operations<>p_payloads[i.n]
 ) THEN RAISE EXCEPTION 'Conflicting storage segment'; END IF;
 IF EXISTS (
  WITH input AS (
   SELECT DISTINCT ON ((value->>0)::bigint,(value->>1)::bigint)
    (value->>0)::bigint AS sid,(value->>1)::bigint AS start,(value->>2)::bigint AS span,value->3 AS deps
   FROM jsonb_array_elements(p_metadata)
  ), adjacency AS (
   SELECT *,lag(start+span) OVER(PARTITION BY sid ORDER BY start) AS previous_end FROM input
  )
  SELECT 1 FROM adjacency i WHERE i.previous_end IS NOT NULL AND
   (i.previous_end>i.start OR COALESCE((SELECT (d->>1)::bigint FROM jsonb_array_elements(i.deps) d WHERE (d->>0)::bigint=i.sid),0)<i.previous_end)
 ) THEN RAISE EXCEPTION 'Overlapping segments or actor history fork'; END IF;
 IF EXISTS (
  WITH input AS (
   SELECT (value->>0)::bigint AS sid,(value->>1)::bigint AS start,(value->>2)::bigint AS span,value->3 AS deps
   FROM jsonb_array_elements(p_metadata)
  )
  SELECT 1 FROM input i CROSS JOIN LATERAL (
   (SELECT time_start,time_end,dependencies FROM pulsify_op_rows WHERE doc_id=p_doc_id AND sid=i.sid AND time_start<i.start ORDER BY time_start DESC LIMIT 1)
   UNION ALL
   (SELECT time_start,time_end,dependencies FROM pulsify_op_rows WHERE doc_id=p_doc_id AND sid=i.sid AND time_start>i.start ORDER BY time_start LIMIT 1)
  ) n WHERE (i.start<n.time_end AND n.time_start<i.start+i.span) OR
   (n.time_start<i.start AND COALESCE((SELECT (d->>1)::bigint FROM jsonb_array_elements(i.deps) d WHERE (d->>0)::bigint=i.sid),0)<n.time_end) OR
   (n.time_start>i.start AND COALESCE((SELECT (d->>1)::bigint FROM jsonb_array_elements(n.dependencies) d WHERE (d->>0)::bigint=i.sid),0)<i.start+i.span)
 ) THEN RAISE EXCEPTION 'Overlapping segments or actor history fork'; END IF;
 INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations)
  SELECT p_doc_id,(value->>0)::bigint,(value->>1)::bigint,(value->>2)::bigint,value->3,p_payloads[n]
  FROM jsonb_array_elements(p_metadata) WITH ORDINALITY i(value,n)
  ON CONFLICT(doc_id,sid,time_start) DO NOTHING;
 GET DIAGNOSTICS v_inserted = ROW_COUNT;
 -- The common case is an actor's causally closed batch. Prove closure once and promote it in bulk.
 WITH input AS (
  SELECT DISTINCT ON ((value->>0)::bigint,(value->>1)::bigint)
   (value->>0)::bigint AS sid,(value->>1)::bigint AS start,(value->>2)::bigint AS span,value->3 AS deps
  FROM jsonb_array_elements(p_metadata)
 ), adjacency AS (
  SELECT *,lag(start+span) OVER(PARTITION BY sid ORDER BY start) AS previous_end FROM input
 )
 SELECT NOT EXISTS (
  SELECT 1 FROM adjacency i LEFT JOIN pulsify_doc_clocks own ON own.doc_id=p_doc_id AND own.sid=i.sid
  WHERE i.start>GREATEST(COALESCE(i.previous_end,1),COALESCE(own.clock,1)) OR EXISTS (
   SELECT 1 FROM jsonb_array_elements(i.deps) d LEFT JOIN pulsify_doc_clocks c ON c.doc_id=p_doc_id AND c.sid=(d->>0)::bigint
   WHERE (d->>1)::bigint > CASE WHEN (d->>0)::bigint=i.sid THEN GREATEST(COALESCE(i.previous_end,0),COALESCE(own.clock,0)) ELSE COALESCE(c.clock,0) END
  )
 ) INTO v_fast;
 IF v_fast THEN
  WITH promoted AS (
   UPDATE pulsify_op_rows o SET ready=true FROM jsonb_array_elements(p_metadata) i
   WHERE o.doc_id=p_doc_id AND o.sid=(i->>0)::bigint AND o.time_start=(i->>1)::bigint AND NOT o.ready
   RETURNING o.sid,o.time_end
  ), clocks AS (
   INSERT INTO pulsify_doc_clocks(doc_id,sid,clock) SELECT p_doc_id,sid,MAX(time_end) FROM promoted GROUP BY sid
   ON CONFLICT(doc_id,sid) DO UPDATE SET clock=GREATEST(pulsify_doc_clocks.clock,EXCLUDED.clock) RETURNING sid
  ) SELECT COUNT(*)::integer INTO v_ready FROM promoted;
 END IF;
 END IF;
 IF (SELECT COUNT(*) FROM (
  SELECT sid FROM pulsify_doc_clocks WHERE doc_id=p_doc_id
  UNION SELECT sid FROM pulsify_op_rows WHERE doc_id=p_doc_id AND NOT pulsify_op_rows.ready
 ) actors) > ${MAX_VECTOR_ENTRIES} THEN RAISE EXCEPTION 'Document actor limit exceeded'; END IF;
 -- Only pending metadata is read. Payloads and the materialized document are never fetched.
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
    UPDATE pulsify_op_rows SET ready=true WHERE doc_id=p_doc_id AND sid=candidate.sid AND time_start=candidate.time_start;
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
			row.dependencies,
		]);
		const result = await this.query(
			"SELECT * FROM pulsify_append($1::text,$2::text::jsonb,$3::bytea[])",
			[docId, JSON.stringify(metadata), rows.map((row) => row.operations)],
		);
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
				`WITH remote(sid,clock) AS (SELECT * FROM unnest($2::bigint[],$3::bigint[]))
 SELECT o.doc_id,o.sid,o.time_start,o.span,o.dependencies,o.operations
 FROM pulsify_op_rows o LEFT JOIN remote r ON r.sid=o.sid
 WHERE o.doc_id=$1 AND o.ready AND o.time_end>COALESCE(r.clock,0) ORDER BY o.sid,o.time_start`,
				[docId, remote.map(([sid]) => sid), remote.map(([, clock]) => clock)],
			)
		).map(unpack);
	}
}
