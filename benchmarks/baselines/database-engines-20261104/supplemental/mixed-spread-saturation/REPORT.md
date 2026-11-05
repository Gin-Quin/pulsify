# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|pgrust-columnar|mixed|spread|saturation|128|329.3|51.633|2653.015|2724.256|2724.256|0|43|9/91|
|docker|pgrust-columnar|mixed|spread|saturation|128|352.6|58.586|2435.609|2509.176|2509.176|0|44|9/91|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|pgrust-columnar|spread|saturation|128|compact|100|32.9|111.186|2740.821|2775.175|2775.175|0|43|9/91|
|bare-metal|pgrust-columnar|spread|saturation|128|read_delta|250|82.3|4.797|39.676|42.261|42.261|0|0|0/0|
|bare-metal|pgrust-columnar|spread|saturation|128|read_full|100|32.9|9.238|87.531|88.831|88.831|0|0|0/0|
|bare-metal|pgrust-columnar|spread|saturation|128|write_full|100|32.9|10.116|78.707|154.936|154.936|0|0|0/0|
|bare-metal|pgrust-columnar|spread|saturation|128|write_patch|450|148.2|106.130|2648.809|2671.449|2671.449|0|0|0/0|
|docker|pgrust-columnar|spread|saturation|128|compact|100|35.3|57.184|2561.730|2577.541|2577.541|0|44|9/91|
|docker|pgrust-columnar|spread|saturation|128|read_delta|250|88.1|3.143|60.144|103.036|103.036|0|0|0/0|
|docker|pgrust-columnar|spread|saturation|128|read_full|100|35.3|7.398|138.275|152.985|152.985|0|0|0/0|
|docker|pgrust-columnar|spread|saturation|128|write_full|100|35.3|10.646|88.485|118.198|118.198|0|0|0/0|
|docker|pgrust-columnar|spread|saturation|128|write_patch|450|158.7|108.581|2438.943|2475.997|2475.997|0|0|0/0|

2 completed cells, 2000 requests, 0 errors, 4 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
