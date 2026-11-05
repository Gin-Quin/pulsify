# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|docker|postgres|mixed|spread|burst|128|1599.1|24.113|365.383|433.737|614.851|0|45|9/91|
|docker|postgres|mixed|spread|saturation|128|1981.5|34.291|243.681|306.480|306.480|0|41|9/91|
|docker|postgres|mixed|hot|burst|128|671.3|149.347|416.541|721.672|1485.973|0|156|5/95|
|docker|postgres|mixed|hot|saturation|128|655.6|139.781|374.326|690.114|690.114|0|135|5/95|
|docker|sqlite|mixed|spread|burst|128|437.4|2.035|1154.777|1662.661|1675.975|0|38|40/60|
|docker|sqlite|mixed|spread|saturation|128|438.0|2.886|1054.893|1766.456|1766.456|0|34|35/65|
|docker|sqlite|mixed|hot|burst|128|422.1|1.887|959.235|1871.653|1872.073|0|57|54/46|
|docker|sqlite|mixed|hot|saturation|128|459.3|2.401|943.703|1457.241|1457.241|0|67|45/55|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|docker|postgres|spread|burst|128|compact|100|159.9|96.689|451.312|470.741|550.180|0|45|9/91|
|docker|postgres|spread|burst|128|read_delta|250|399.8|1.824|33.526|66.475|562.653|0|0|0/0|
|docker|postgres|spread|burst|128|read_full|100|159.9|7.514|116.978|147.709|557.458|0|0|0/0|
|docker|postgres|spread|burst|128|write_full|100|159.9|7.429|51.389|67.866|560.189|0|0|0/0|
|docker|postgres|spread|burst|128|write_patch|450|719.6|71.348|359.127|380.773|620.876|0|0|0/0|
|docker|postgres|spread|saturation|128|compact|100|198.2|6.175|323.191|365.912|365.912|0|41|9/91|
|docker|postgres|spread|saturation|128|read_delta|250|495.4|2.313|67.726|81.099|81.099|0|0|0/0|
|docker|postgres|spread|saturation|128|read_full|100|198.2|8.934|95.127|108.751|108.751|0|0|0/0|
|docker|postgres|spread|saturation|128|write_full|100|198.2|8.749|46.952|101.729|101.729|0|0|0/0|
|docker|postgres|spread|saturation|128|write_patch|450|891.7|66.775|242.040|292.627|292.627|0|0|0/0|
|docker|postgres|hot|burst|128|compact|100|67.1|411.265|840.267|853.448|1489.434|0|156|5/95|
|docker|postgres|hot|burst|128|read_delta|250|167.8|1.447|48.762|74.724|1122.539|0|0|0/0|
|docker|postgres|hot|burst|128|read_full|100|67.1|2.202|68.429|86.413|1065.941|0|0|0/0|
|docker|postgres|hot|burst|128|write_full|100|67.1|4.213|37.747|89.034|1064.872|0|0|0/0|
|docker|postgres|hot|burst|128|write_patch|450|302.1|287.815|390.133|407.468|1405.342|0|0|0/0|
|docker|postgres|hot|saturation|128|compact|100|65.6|358.965|738.565|818.447|818.447|0|135|5/95|
|docker|postgres|hot|saturation|128|read_delta|250|163.9|1.504|37.944|71.620|71.620|0|0|0/0|
|docker|postgres|hot|saturation|128|read_full|100|65.6|2.993|68.654|83.939|83.939|0|0|0/0|
|docker|postgres|hot|saturation|128|write_full|100|65.6|4.570|46.589|70.590|70.590|0|0|0/0|
|docker|postgres|hot|saturation|128|write_patch|450|295.0|335.760|371.792|379.229|379.229|0|0|0/0|
|docker|sqlite|spread|burst|128|compact|100|43.7|4.196|1190.256|1366.768|1382.931|0|38|40/60|
|docker|sqlite|spread|burst|128|read_delta|250|109.3|0.624|80.973|121.885|971.339|0|0|0/0|
|docker|sqlite|spread|burst|128|read_full|100|43.7|1.266|114.939|133.235|950.290|0|0|0/0|
|docker|sqlite|spread|burst|128|write_full|100|43.7|5.333|1271.209|1474.099|1586.605|0|0|0/0|
|docker|sqlite|spread|burst|128|write_patch|450|196.8|3.444|1255.847|1965.339|1965.770|0|0|0/0|
|docker|sqlite|spread|saturation|128|compact|100|43.8|3.736|1214.633|1424.969|1424.969|0|34|35/65|
|docker|sqlite|spread|saturation|128|read_delta|250|109.5|0.672|56.459|66.634|66.634|0|0|0/0|
|docker|sqlite|spread|saturation|128|read_full|100|43.8|1.409|83.223|93.746|93.746|0|0|0/0|
|docker|sqlite|spread|saturation|128|write_full|100|43.8|5.297|1161.693|1773.240|1773.240|0|0|0/0|
|docker|sqlite|spread|saturation|128|write_patch|450|197.1|6.406|1356.642|1872.025|1872.025|0|0|0/0|
|docker|sqlite|hot|burst|128|compact|100|42.2|7.063|959.235|1334.145|1335.998|0|57|54/46|
|docker|sqlite|hot|burst|128|read_delta|250|105.5|1.141|99.971|116.854|856.578|0|0|0/0|
|docker|sqlite|hot|burst|128|read_full|100|42.2|1.637|119.834|136.180|835.150|0|0|0/0|
|docker|sqlite|hot|burst|128|write_full|100|42.2|6.517|1566.664|1976.946|1977.079|0|0|0/0|
|docker|sqlite|hot|burst|128|write_patch|450|189.9|3.870|1260.453|2163.682|2164.071|0|0|0/0|
|docker|sqlite|hot|saturation|128|compact|100|45.9|22.251|1060.469|1366.845|1366.845|0|67|45/55|
|docker|sqlite|hot|saturation|128|read_delta|250|114.8|1.136|87.489|107.691|107.691|0|0|0/0|
|docker|sqlite|hot|saturation|128|read_full|100|45.9|1.611|116.981|119.454|119.454|0|0|0/0|
|docker|sqlite|hot|saturation|128|write_full|100|45.9|5.378|1055.598|2078.728|2078.728|0|0|0/0|
|docker|sqlite|hot|saturation|128|write_patch|450|206.7|5.277|956.652|1564.957|1564.957|0|0|0/0|

8 completed cells, 8000 requests, 0 errors, 16 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
