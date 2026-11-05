# Database engine load summary — 2026-11-04

934 checkpointed main cells, 934,000 requests, **584 recorded request errors**, 1558 Pulsify model replays and 255,074 exact storage histories. 18/20 main matrices completed. Fresh recovery probes are counted separately.

**Counts include completed cells only.** Requests interrupted before a cell checkpoint are not counted as successes or zero errors. Fatal backend failures and the host reboot are recorded in the phase contexts, container states and [intervention log](INTERVENTIONS.md). The native columnar incident has [separate diagnostics](columnar-memory-incident.json).

The mix is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads and 10% compaction attempts. Every checkpointed cell has 1,000 requests. All measured clients are Rust, with real Pulsify fixture/replay verification.

Medium: 64 paragraphs, 100 prior edits, 1/16/64 clients. Large: 256 paragraphs, 1,000 prior edits, 128 clients. Medium Docker was uncapped; after the native large memory incident and reboot, large Docker uses **4 GiB RAM and no swap per test container**. Native uses OS/default engine memory management. These profiles are not one continuous scaling curve.

## Matrix status

| Profile | Deployment | Engine | Completed cells | Recorded request errors | Pulsify replays |
|---|---|---|---:|---:|---:|
|medium|macOS native|pgrust columnar|72/72|0|120|
|medium|macOS native|pgrust row|72/72|0|120|
|medium|macOS native|PostgreSQL|72/72|0|120|
|medium|macOS native|SQLite|72/72|0|120|
|medium|Docker Linux|AlloyDB Omni|72/72|0|120|
|medium|Docker Linux|OrioleDB|72/72|0|120|
|medium|Docker Linux|pgrust columnar|72/72|0|120|
|medium|Docker Linux|pgrust row|72/72|0|120|
|medium|Docker Linux|PostgreSQL|72/72|0|120|
|medium|Docker Linux|SQLite|72/72|0|120|
|large|macOS native|pgrust columnar|13/24|584|22|
|large|macOS native|pgrust row|24/24|0|40|
|large|macOS native|PostgreSQL|24/24|0|40|
|large|macOS native|SQLite|24/24|0|40|
|large|Docker Linux|AlloyDB Omni|24/24|0|40|
|large|Docker Linux|OrioleDB|24/24|0|40|
|large|Docker Linux|pgrust columnar|9/24|0|16|
|large|Docker Linux|pgrust row|24/24|0|40|
|large|Docker Linux|PostgreSQL|24/24|0|40|
|large|Docker Linux|SQLite|24/24|0|40|

## Large mixed load: 128 clients, hot scope, saturation

Successful requests/s and service p99. A missing score means the full series did not reach this cell; fresh probes below are not silently substituted.

| Deployment | Engine | req/s / p99 ms | errors | useful/noop compactions | observed active |
|---|---|---:|---:|---:|---:|
|macOS native|PostgreSQL|1242.8 / 325.8|0|5/95|128|
|macOS native|SQLite|979.9 / 832.6|0|46/54|128|
|macOS native|pgrust row|1118.4 / 374.8|0|5/95|128|
|macOS native|pgrust columnar|not completed|—|—|—|
|Docker Linux|PostgreSQL|638.8 / 700.5|0|5/95|128|
|Docker Linux|SQLite|459.7 / 1572.8|0|50/50|128|
|Docker Linux|AlloyDB Omni|521.3 / 895.4|0|5/95|128|
|Docker Linux|OrioleDB|407.9 / 1530.1|0|6/94|128|
|Docker Linux|pgrust row|684.1 / 709.1|0|5/95|128|
|Docker Linux|pgrust columnar|not completed|—|—|—|

## Large mix: spread and burst

Spread targets eight scopes. Hot burst end-to-end p99 includes the sender queue for all 1,000 simultaneously admitted requests.

| Deployment | Engine | spread saturation req/s / service p99 ms | hot burst req/s | hot burst end-to-end p99 ms |
|---|---|---:|---:|---:|
|macOS native|PostgreSQL|1387.0 / 588.3|1208.7|823.8|
|macOS native|SQLite|695.9 / 1018.4|977.0|905.5|
|macOS native|pgrust row|1273.4 / 562.9|1032.4|964.0|
|macOS native|pgrust columnar|not completed|—|—|
|Docker Linux|PostgreSQL|1651.5 / 385.0|619.9|1606.3|
|Docker Linux|SQLite|458.2 / 1771.5|460.5|1860.1|
|Docker Linux|AlloyDB Omni|977.1 / 768.7|462.7|2153.4|
|Docker Linux|OrioleDB|421.4 / 2151.8|416.2|2396.8|
|Docker Linux|pgrust row|1504.3 / 444.4|679.9|1467.2|
|Docker Linux|pgrust columnar|not completed|—|—|

## Single-operation loads: large, 128 clients, spread, saturation

Entries are successful req/s / service p99 ms. Spread compaction uses 1,000 separate 33-row seeded histories; useful work is distinguished from hot-scope no-ops.

### macOS native

| Operation |PostgreSQL|SQLite|pgrust row|pgrust columnar|
|---|---:|---:|---:|---:|
|write_full|2462.8 / 233.0|509.5 / 1544.7|2014.1 / 165.2|1645.4 / 175.9|
|read_full|1305.4 / 328.4|1105.6 / 340.0|1311.2 / 329.2|901.4 / 573.4|
|write_patch|4072.8 / 40.5|895.9 / 703.0|3716.5 / 47.8|2020.4 / 84.9|
|compact|709.2 / 702.5|199.3 / 4277.3|595.7 / 479.4|not completed|
|read_delta|5266.2 / 36.3|1528.8 / 235.3|5474.0 / 44.6|not completed|

### Docker Linux

| Operation |PostgreSQL|SQLite|AlloyDB Omni|OrioleDB|pgrust row|pgrust columnar|
|---|---:|---:|---:|---:|---:|---:|
|write_full|2105.7 / 170.9|199.6 / 3984.8|2160.0 / 132.2|1960.6 / 168.8|1985.9 / 265.9|1711.8 / 256.3|
|read_full|1357.6 / 263.0|1305.2 / 164.9|1338.4 / 299.9|985.4 / 279.6|1393.5 / 242.0|905.9 / 287.8|
|write_patch|3216.0 / 54.1|263.0 / 3095.3|1771.7 / 99.1|2718.4 / 72.6|3555.0 / 47.6|not completed|
|compact|1135.4 / 313.1|141.1 / 5962.1|855.5 / 315.6|934.9 / 340.8|441.4 / 679.8|not completed|
|read_delta|5559.9 / 78.8|2251.3 / 96.0|4219.9 / 147.7|2144.8 / 176.3|4879.9 / 152.2|not completed|

## Medium hot mixed load

Each entry is req/s / service p99 ms.

| Deployment | Engine | 1 client | 16 clients | 64 clients |
|---|---|---:|---:|---:|
|macOS native|PostgreSQL|1464.7 / 1.9|1407.8 / 135.6|1472.1 / 456.8|
|macOS native|SQLite|4975.5 / 0.7|6359.0 / 57.5|2811.1 / 242.8|
|macOS native|pgrust row|1247.6 / 2.5|1085.9 / 165.8|1378.3 / 462.2|
|macOS native|pgrust columnar|561.9 / 15.0|371.4 / 507.6|563.4 / 1293.7|
|Docker Linux|PostgreSQL|835.2 / 2.8|828.9 / 218.8|750.8 / 822.6|
|Docker Linux|SQLite|920.5 / 5.2|639.9 / 751.4|480.6 / 1362.3|
|Docker Linux|AlloyDB Omni|441.0 / 7.5|434.7 / 547.2|433.5 / 1502.1|
|Docker Linux|OrioleDB|748.1 / 5.1|722.5 / 272.0|666.2 / 951.8|
|Docker Linux|pgrust row|590.1 / 4.9|781.1 / 229.1|755.1 / 819.5|
|Docker Linux|pgrust columnar|350.5 / 22.4|509.2 / 376.7|144.5 / 5613.7|

## Fresh isolated recovery probes

These use fresh server instances and do not inherit the preceding full-write/cleanup/compaction series. Their scores are separate observations, not replacements for missing main cells.

| Deployment | Engine | Operation | Topology | Mode | Clients | req/s / service p99 ms | errors | Evidence |
|---|---|---|---|---|---:|---:|---:|---|
|macOS native|pgrust columnar|read_delta|hot|burst|128|5863.5 / 34.0|0|[report](supplemental/read_delta-hot-burst/REPORT.md)|
|Docker Linux|pgrust columnar|read_delta|hot|burst|128|5909.5 / 62.0|0|[report](supplemental/read_delta-hot-burst/REPORT.md)|
|macOS native|pgrust columnar|read_delta|spread|burst|128|3332.7 / 75.4|0|[report](supplemental/read_delta-spread-burst/REPORT.md)|
|Docker Linux|pgrust columnar|read_delta|spread|burst|128|3046.1 / 114.5|0|[report](supplemental/read_delta-spread-burst/REPORT.md)|
|macOS native|pgrust columnar|read_delta|spread|saturation|128|3455.7 / 105.2|0|[report](supplemental/read_delta-spread-saturation/REPORT.md)|
|Docker Linux|pgrust columnar|read_delta|spread|saturation|128|3193.1 / 103.4|0|[report](supplemental/read_delta-spread-saturation/REPORT.md)|
|macOS native|pgrust columnar|mixed|spread|burst|128|328.3 / 2729.6|0|[report](supplemental/mixed-spread-burst/REPORT.md)|
|Docker Linux|pgrust columnar|mixed|spread|burst|128|336.3 / 2568.9|0|[report](supplemental/mixed-spread-burst/REPORT.md)|
|macOS native|pgrust columnar|mixed|hot|saturation|128|734.7 / 596.8|0|[report](supplemental/mixed-hot-saturation/REPORT.md)|
|Docker Linux|pgrust columnar|mixed|hot|saturation|128|516.7 / 993.1|0|[report](supplemental/mixed-hot-saturation/REPORT.md)|
|macOS native|pgrust columnar|compact|hot|burst|128|6282.2 / 156.1|0|[report](supplemental/compact-hot-burst/REPORT.md)|
|Docker Linux|pgrust columnar|compact|hot|burst|128|7653.9 / 126.5|0|[report](supplemental/compact-hot-burst/REPORT.md)|
|macOS native|pgrust columnar|compact|hot|saturation|128|6483.7 / 151.3|0|[report](supplemental/compact-hot-saturation/REPORT.md)|
|Docker Linux|pgrust columnar|compact|hot|saturation|128|7556.4 / 125.9|0|[report](supplemental/compact-hot-saturation/REPORT.md)|
|Docker Linux|pgrust columnar|write_patch|hot|saturation|128|354.1 / 444.2|0|[report](supplemental/write_patch-hot-saturation/REPORT.md)|
|macOS native|pgrust columnar|read_delta|hot|saturation|128|5585.1 / 38.0|0|[report](supplemental/read_delta-hot-saturation/REPORT.md)|
|Docker Linux|pgrust columnar|read_delta|hot|saturation|128|5972.9 / 96.2|0|[report](supplemental/read_delta-hot-saturation/REPORT.md)|
|macOS native|pgrust columnar|mixed|hot|burst|128|713.4 / 596.1|0|[report](supplemental/mixed-hot-burst/REPORT.md)|
|Docker Linux|pgrust columnar|mixed|hot|burst|128|544.0 / 839.0|0|[report](supplemental/mixed-hot-burst/REPORT.md)|
|macOS native|pgrust columnar|mixed|spread|saturation|128|329.3 / 2724.3|0|[report](supplemental/mixed-spread-saturation/REPORT.md)|
|Docker Linux|pgrust columnar|mixed|spread|saturation|128|352.6 / 2509.2|0|[report](supplemental/mixed-spread-saturation/REPORT.md)|
|Docker Linux|pgrust columnar|write_patch|spread|saturation|128|1611.7 / 117.9|0|[report](supplemental/write_patch-spread-saturation/REPORT.md)|
|Docker Linux|pgrust columnar|write_patch|hot|burst|128|355.2 / 401.3|0|[report](supplemental/write_patch-hot-burst/REPORT.md)|

### Attempt outcomes, including failures without a cell checkpoint

| Operation | Topology | Mode | Deployment request | Exit code | Safety guard |
|---|---|---|---|---:|---|
|mixed|hot|saturation|both|0|none|
|mixed|hot|burst|both|0|none|
|mixed|spread|saturation|both|0|none|
|mixed|spread|burst|both|0|none|
|read_delta|hot|saturation|both|0|none|
|read_delta|hot|burst|both|0|none|
|read_delta|spread|saturation|both|0|none|
|read_delta|spread|burst|both|0|none|
|compact|hot|saturation|both|0|none|
|compact|hot|burst|both|0|none|
|compact|spread|saturation|docker|1|none|
|compact|spread|burst|docker|1|none|
|write_patch|spread|saturation|docker|0|none|
|write_patch|hot|burst|docker|0|none|
|write_patch|hot|saturation|docker|0|none|

23 fresh probe cells, 23,000 requests, 0 recorded request errors.

## Interpretation and evidence

- [Medium detailed table](medium/REPORT.md) and [context](medium/context.json).
- [Native large checkpoints](large/REPORT.md) and [context](large/context-native.json).
- [Bounded Docker large table](large-docker/REPORT.md) and [context](large-docker/context.json); container-state files record OOM/exit status.
- [FoundationDB cleanup audit](FOUNDATIONDB-CLEANUP.md) and [archived Rust results](../../database/archive/FOUNDATIONDB-RESULTS.md).

Binary payloads, immutable histories, causal frontiers and lossless compaction are checked. Both OrioleDB tables use orioledb; both pgrust columnar tables use pgrcolumnar, with a non-unique point index replacing its unsupported primary key. Actual index definitions are recorded. Columnar vectors use locked transactional DELETE+INSERT because this beta lacks unique indexes/ON CONFLICT.

These are finite batches on one Apple M4 Mac, with a shared Rust reference adapter. It uses application SQL transactions; the production PostgreSQL adapter has a separate one-call PL/pgSQL path. Docker SQLite uses the runner writable layer; server data uses named volumes. Logical cleanup is DELETE + CHECKPOINT and does not reset physical files/tombstones. Engine maintenance can affect later cells. Results do not establish steady-state capacity, a universal Docker penalty, replicated durability or managed-cloud performance. AlloyDB here is local Omni 17.10.0. Aurora is excluded by the requested open-source condition.
