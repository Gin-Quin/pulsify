# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|pgrust-columnar|mixed|hot|burst|128|713.4|131.590|546.341|596.144|1397.933|0|133|5/95|
|docker|pgrust-columnar|mixed|hot|burst|128|544.0|158.317|542.899|838.971|1833.640|0|157|5/95|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|pgrust-columnar|hot|burst|128|compact|100|71.3|537.337|600.813|612.175|1401.516|0|133|5/95|
|bare-metal|pgrust-columnar|hot|burst|128|read_delta|250|178.3|1.681|28.418|31.530|1036.853|0|0|0/0|
|bare-metal|pgrust-columnar|hot|burst|128|read_full|100|71.3|4.037|71.653|74.074|1003.588|0|0|0/0|
|bare-metal|pgrust-columnar|hot|burst|128|write_full|100|71.3|3.714|97.172|99.512|1002.563|0|0|0/0|
|bare-metal|pgrust-columnar|hot|burst|128|write_patch|450|321.0|182.795|542.574|546.399|1292.620|0|0|0/0|
|docker|pgrust-columnar|hot|burst|128|compact|100|54.4|542.834|950.560|1023.064|1837.955|0|157|5/95|
|docker|pgrust-columnar|hot|burst|128|read_delta|250|136.0|1.495|39.744|63.885|1389.116|0|0|0/0|
|docker|pgrust-columnar|hot|burst|128|read_full|100|54.4|2.524|89.120|96.320|1328.501|0|0|0/0|
|docker|pgrust-columnar|hot|burst|128|write_full|100|54.4|5.056|34.066|60.236|1326.319|0|0|0/0|
|docker|pgrust-columnar|hot|burst|128|write_patch|450|244.8|344.405|521.754|530.181|1718.151|0|0|0/0|

2 completed cells, 2000 requests, 0 errors, 4 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
