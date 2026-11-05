# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|mixed|spread|burst|128|3842.5|23.184|102.908|147.900|257.869|0|39|13/87|
|bare-metal|postgres|mixed|spread|saturation|128|3740.4|21.743|101.696|144.718|144.718|0|42|10/90|
|bare-metal|postgres|mixed|hot|burst|128|2396.2|58.905|123.123|161.251|415.142|0|125|5/95|
|bare-metal|postgres|mixed|hot|saturation|128|2244.1|60.410|146.708|186.493|186.493|0|165|5/95|
|bare-metal|sqlite|mixed|spread|burst|128|2921.9|16.318|173.792|277.196|339.242|0|47|20/80|
|bare-metal|sqlite|mixed|spread|saturation|128|2691.9|17.383|183.170|284.947|284.947|0|31|14/86|
|bare-metal|sqlite|mixed|hot|burst|128|1815.7|20.494|270.059|484.340|549.176|0|317|33/67|
|bare-metal|sqlite|mixed|hot|saturation|128|1789.1|27.864|268.784|507.083|507.083|0|345|33/67|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|spread|burst|128|compact|100|384.3|3.904|155.249|158.988|258.763|0|39|13/87|
|bare-metal|postgres|spread|burst|128|read_delta|250|960.6|3.853|23.806|32.925|238.325|0|0|0/0|
|bare-metal|postgres|spread|burst|128|read_full|100|384.3|12.822|63.027|64.464|232.477|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_full|100|384.3|6.377|41.944|54.209|245.040|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_patch|450|1729.1|39.015|102.500|114.536|259.087|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|compact|100|374.0|22.742|153.350|163.908|163.908|0|42|10/90|
|bare-metal|postgres|spread|saturation|128|read_delta|250|935.1|3.266|24.083|31.290|31.290|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|read_full|100|374.0|13.897|63.317|66.681|66.681|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_full|100|374.0|6.270|39.948|47.499|47.499|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_patch|450|1683.2|39.034|99.963|114.853|114.853|0|0|0/0|
|bare-metal|postgres|hot|burst|128|compact|100|239.6|109.457|165.408|169.426|417.197|0|125|5/95|
|bare-metal|postgres|hot|burst|128|read_delta|250|599.1|1.874|24.477|30.034|331.547|0|0|0/0|
|bare-metal|postgres|hot|burst|128|read_full|100|239.6|4.681|64.272|65.599|319.546|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_full|100|239.6|2.650|32.777|38.575|318.940|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_patch|450|1078.3|68.719|114.755|125.266|385.005|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|compact|100|224.4|146.708|201.142|205.409|205.409|0|165|5/95|
|bare-metal|postgres|hot|saturation|128|read_delta|250|561.0|1.786|21.641|30.809|30.809|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|read_full|100|224.4|4.699|63.487|71.577|71.577|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_full|100|224.4|2.692|33.213|38.437|38.437|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_patch|450|1009.8|71.625|118.813|129.200|129.200|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|compact|100|292.2|12.298|308.848|339.686|340.156|0|47|20/80|
|bare-metal|sqlite|spread|burst|128|read_delta|250|730.5|0.980|55.301|57.148|307.189|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|read_full|100|292.2|2.032|52.535|59.349|303.664|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_full|100|292.2|32.296|199.217|318.130|334.210|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_patch|450|1314.9|34.549|182.264|247.580|339.418|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|compact|100|269.2|0.544|251.286|309.868|309.868|0|31|14/86|
|bare-metal|sqlite|spread|saturation|128|read_delta|250|673.0|1.132|56.214|61.718|61.718|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|read_full|100|269.2|2.035|61.130|65.773|65.773|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_full|100|269.2|51.760|205.666|337.192|337.192|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_patch|450|1211.3|41.241|193.636|289.575|289.575|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|compact|100|181.6|163.270|546.825|549.820|550.652|0|317|33/67|
|bare-metal|sqlite|hot|burst|128|read_delta|250|453.9|2.490|130.114|141.200|505.080|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|read_full|100|181.6|3.714|166.621|172.966|492.777|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_full|100|181.6|45.246|251.153|479.139|533.197|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_patch|450|817.1|39.654|268.751|357.255|541.097|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|compact|100|178.9|197.619|519.443|539.029|539.029|0|345|33/67|
|bare-metal|sqlite|hot|saturation|128|read_delta|250|447.3|2.569|103.492|110.631|110.631|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|read_full|100|178.9|3.730|132.571|135.704|135.704|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_full|100|178.9|39.924|268.001|381.672|381.672|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_patch|450|805.1|37.311|242.801|303.618|303.618|0|0|0/0|

8 completed cells, 8000 requests, 0 errors, 16 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
