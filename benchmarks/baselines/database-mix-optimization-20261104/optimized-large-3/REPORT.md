# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|mixed|spread|burst|128|3449.7|17.210|114.420|163.541|286.472|0|40|14/86|
|bare-metal|postgres|mixed|spread|saturation|128|3830.5|23.395|102.117|141.257|141.257|0|39|10/90|
|bare-metal|postgres|mixed|hot|burst|128|2357.3|65.068|121.751|160.452|421.862|0|129|5/95|
|bare-metal|postgres|mixed|hot|saturation|128|2445.0|56.558|123.308|158.742|158.742|0|133|5/95|
|bare-metal|sqlite|mixed|spread|burst|128|3095.9|13.261|160.859|244.324|320.386|0|28|14/86|
|bare-metal|sqlite|mixed|spread|saturation|128|2899.9|14.398|174.107|257.348|257.348|0|30|13/87|
|bare-metal|sqlite|mixed|hot|burst|128|1808.6|28.344|265.985|494.585|550.838|0|314|34/66|
|bare-metal|sqlite|mixed|hot|saturation|128|1791.1|23.807|260.692|525.767|525.767|0|316|32/68|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|spread|burst|128|compact|100|345.0|8.690|173.115|265.939|275.854|0|40|14/86|
|bare-metal|postgres|spread|burst|128|read_delta|250|862.4|3.473|28.787|33.534|256.598|0|0|0/0|
|bare-metal|postgres|spread|burst|128|read_full|100|345.0|11.719|72.919|85.150|254.988|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_full|100|345.0|6.346|44.999|47.857|251.229|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_patch|450|1552.4|45.845|110.777|127.404|288.570|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|compact|100|383.0|3.865|151.531|157.550|157.550|0|39|10/90|
|bare-metal|postgres|spread|saturation|128|read_delta|250|957.6|3.858|23.705|33.861|33.861|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|read_full|100|383.0|11.951|64.922|67.832|67.832|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_full|100|383.0|6.546|34.604|40.700|40.700|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_patch|450|1723.7|39.983|101.111|113.962|113.962|0|0|0/0|
|bare-metal|postgres|hot|burst|128|compact|100|235.7|106.110|162.878|164.088|423.996|0|129|5/95|
|bare-metal|postgres|hot|burst|128|read_delta|250|589.3|1.938|22.451|28.695|340.012|0|0|0/0|
|bare-metal|postgres|hot|burst|128|read_full|100|235.7|4.506|59.469|62.820|326.425|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_full|100|235.7|2.707|31.823|39.168|325.545|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_patch|450|1060.8|73.401|112.255|121.751|395.443|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|compact|100|244.5|109.337|162.428|166.188|166.188|0|133|5/95|
|bare-metal|postgres|hot|saturation|128|read_delta|250|611.3|1.922|21.686|29.621|29.621|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|read_full|100|244.5|4.638|59.264|60.729|60.729|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_full|100|244.5|2.713|32.695|38.135|38.135|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_patch|450|1100.3|67.205|114.342|123.308|123.308|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|compact|100|309.6|0.417|205.270|310.912|317.399|0|28|14/86|
|bare-metal|sqlite|spread|burst|128|read_delta|250|774.0|0.933|53.880|62.793|289.300|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|read_full|100|309.6|1.829|49.501|58.100|283.324|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_full|100|309.6|37.901|147.760|227.153|320.438|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_patch|450|1393.2|35.468|183.091|266.780|321.780|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|compact|100|290.0|0.528|231.480|246.458|246.458|0|30|13/87|
|bare-metal|sqlite|spread|saturation|128|read_delta|250|725.0|1.006|30.041|55.466|55.466|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|read_full|100|290.0|1.824|52.777|58.764|58.764|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_full|100|290.0|39.761|196.795|259.105|259.105|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_patch|450|1305.0|41.171|194.158|287.455|287.455|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|compact|100|180.9|179.425|545.404|551.047|552.808|0|314|34/66|
|bare-metal|sqlite|hot|burst|128|read_delta|250|452.2|2.688|153.571|164.301|511.457|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|read_full|100|180.9|3.106|182.796|208.379|500.751|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_full|100|180.9|45.521|267.776|330.349|538.942|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_patch|450|813.9|41.887|253.431|282.010|545.536|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|compact|100|179.1|171.504|548.023|555.824|555.824|0|316|32/68|
|bare-metal|sqlite|hot|saturation|128|read_delta|250|447.8|3.010|99.257|106.469|106.469|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|read_full|100|179.1|4.954|130.503|143.418|143.418|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_full|100|179.1|44.176|246.883|371.626|371.626|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_patch|450|806.0|39.502|245.833|326.734|326.734|0|0|0/0|

8 completed cells, 8000 requests, 0 errors, 16 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
