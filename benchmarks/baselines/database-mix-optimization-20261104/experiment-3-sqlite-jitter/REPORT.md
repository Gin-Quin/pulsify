# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|sqlite|mixed|spread|burst|128|2326.2|17.715|222.676|325.830|426.695|0|38|13/87|
|bare-metal|sqlite|mixed|spread|saturation|128|2225.4|24.213|216.702|331.511|331.511|0|38|16/84|
|bare-metal|sqlite|mixed|hot|burst|128|1504.1|26.391|308.495|642.178|663.290|0|354|32/68|
|bare-metal|sqlite|mixed|hot|saturation|128|1420.2|35.583|330.558|682.473|682.473|0|392|36/64|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|sqlite|spread|burst|128|compact|100|232.6|1.122|275.718|325.000|405.509|0|38|13/87|
|bare-metal|sqlite|spread|burst|128|read_delta|250|581.6|1.128|77.685|89.783|395.944|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|read_full|100|232.6|2.342|84.822|90.994|388.450|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_full|100|232.6|48.329|233.624|317.812|426.322|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_patch|450|1046.8|40.320|261.382|364.016|427.537|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|compact|100|222.5|1.085|272.721|427.227|427.227|0|38|16/84|
|bare-metal|sqlite|spread|saturation|128|read_delta|250|556.3|1.233|74.276|81.401|81.401|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|read_full|100|222.5|2.738|76.591|83.595|83.595|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_full|100|222.5|46.770|218.908|328.663|328.663|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_patch|450|1001.4|49.391|249.161|370.899|370.899|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|compact|100|150.4|229.840|656.320|663.799|664.785|0|354|32/68|
|bare-metal|sqlite|hot|burst|128|read_delta|250|376.0|2.886|133.546|171.012|605.494|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|read_full|100|150.4|3.891|179.314|187.826|590.768|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_full|100|150.4|47.816|288.599|344.844|643.934|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_patch|450|676.9|41.764|284.679|373.928|651.440|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|compact|100|142.0|240.564|689.902|702.990|702.990|0|392|36/64|
|bare-metal|sqlite|hot|saturation|128|read_delta|250|355.0|3.149|141.075|156.106|156.106|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|read_full|100|142.0|4.693|163.057|177.681|177.681|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_full|100|142.0|43.330|316.284|380.064|380.064|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_patch|450|639.1|52.793|290.967|361.077|361.077|0|0|0/0|

4 completed cells, 4000 requests, 0 errors, 8 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
