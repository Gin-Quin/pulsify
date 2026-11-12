# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|docker|pgrust-columnar|mixed|hot|saturation|128|516.7|182.865|564.162|993.120|993.120|0|161|5/95|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|docker|pgrust-columnar|hot|saturation|128|compact|100|51.7|564.162|1080.769|1100.626|1100.626|0|161|5/95|
|docker|pgrust-columnar|hot|saturation|128|read_delta|250|129.2|1.594|62.096|81.499|81.499|0|0|0/0|
|docker|pgrust-columnar|hot|saturation|128|read_full|100|51.7|3.011|102.781|125.438|125.438|0|0|0/0|
|docker|pgrust-columnar|hot|saturation|128|write_full|100|51.7|4.929|53.147|86.549|86.549|0|0|0/0|
|docker|pgrust-columnar|hot|saturation|128|write_patch|450|232.5|350.600|535.447|541.791|541.791|0|0|0/0|

1 completed cells, 1000 requests, 0 errors, 2 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
