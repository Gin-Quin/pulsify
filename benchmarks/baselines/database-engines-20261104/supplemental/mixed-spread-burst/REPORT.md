# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|docker|pgrust-columnar|mixed|spread|burst|128|336.3|59.897|2484.387|2568.876|2941.236|0|40|11/89|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|docker|pgrust-columnar|spread|burst|128|compact|100|33.6|6.348|2580.954|2603.743|2902.803|0|40|11/89|
|docker|pgrust-columnar|spread|burst|128|read_delta|250|84.1|4.078|72.254|111.959|2845.947|0|0|0/0|
|docker|pgrust-columnar|spread|burst|128|read_full|100|33.6|8.898|111.807|128.891|2836.307|0|0|0/0|
|docker|pgrust-columnar|spread|burst|128|write_full|100|33.6|10.687|106.425|128.345|2835.862|0|0|0/0|
|docker|pgrust-columnar|spread|burst|128|write_patch|450|151.3|134.265|2481.134|2520.648|2960.572|0|0|0/0|

1 completed cells, 1000 requests, 0 errors, 2 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
