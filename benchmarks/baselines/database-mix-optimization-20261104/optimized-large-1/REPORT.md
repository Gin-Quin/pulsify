# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|mixed|spread|burst|128|3613.9|25.914|109.838|154.591|273.569|0|38|10/90|
|bare-metal|postgres|mixed|spread|saturation|128|3710.1|23.049|101.901|146.208|146.208|0|38|10/90|
|bare-metal|postgres|mixed|hot|burst|128|2535.2|54.207|119.611|163.264|391.602|0|107|4/96|
|bare-metal|postgres|mixed|hot|saturation|128|2456.7|52.947|120.475|162.263|162.263|0|125|5/95|
|bare-metal|sqlite|mixed|spread|burst|128|2995.6|13.184|177.256|258.729|330.741|0|44|16/84|
|bare-metal|sqlite|mixed|spread|saturation|128|2760.5|17.229|172.485|263.771|263.771|0|32|13/87|
|bare-metal|sqlite|mixed|hot|burst|128|1838.0|23.845|270.026|420.440|541.665|0|298|39/61|
|bare-metal|sqlite|mixed|hot|saturation|128|1969.6|25.540|230.147|468.463|468.463|0|307|32/68|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|spread|burst|128|compact|100|361.4|5.844|164.143|175.748|273.233|0|38|10/90|
|bare-metal|postgres|spread|burst|128|read_delta|250|903.5|4.069|26.655|32.610|253.333|0|0|0/0|
|bare-metal|postgres|spread|burst|128|read_full|100|361.4|12.956|68.882|73.022|250.061|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_full|100|361.4|6.738|43.899|44.628|253.800|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_patch|450|1626.2|39.461|109.252|122.755|274.601|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|compact|100|371.0|3.579|156.372|167.328|167.328|0|38|10/90|
|bare-metal|postgres|spread|saturation|128|read_delta|250|927.5|3.944|23.453|31.348|31.348|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|read_full|100|371.0|11.522|60.745|65.777|65.777|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_full|100|371.0|7.133|37.123|42.476|42.476|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_patch|450|1669.5|42.369|101.464|114.428|114.428|0|0|0/0|
|bare-metal|postgres|hot|burst|128|compact|100|253.5|105.686|166.071|168.884|394.118|0|107|4/96|
|bare-metal|postgres|hot|burst|128|read_delta|250|633.8|1.781|21.232|25.659|323.314|0|0|0/0|
|bare-metal|postgres|hot|burst|128|read_full|100|253.5|4.988|57.420|60.485|312.831|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_full|100|253.5|2.714|35.372|46.147|312.164|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_patch|450|1140.8|63.185|114.885|124.778|365.676|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|compact|100|245.7|100.272|164.542|172.176|172.176|0|125|5/95|
|bare-metal|postgres|hot|saturation|128|read_delta|250|614.2|1.759|24.181|28.098|28.098|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|read_full|100|245.7|4.667|62.140|65.115|65.115|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_full|100|245.7|2.687|37.950|40.399|40.399|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_patch|450|1105.5|69.570|115.580|126.296|126.296|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|compact|100|299.6|15.922|238.981|279.773|328.113|0|44|16/84|
|bare-metal|sqlite|spread|burst|128|read_delta|250|748.9|0.918|56.135|63.490|305.101|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|read_full|100|299.6|1.917|56.663|60.201|300.200|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_full|100|299.6|27.626|177.489|258.729|329.347|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_patch|450|1348.0|32.684|192.208|299.748|331.717|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|compact|100|276.0|0.496|234.122|262.626|262.626|0|32|13/87|
|bare-metal|sqlite|spread|saturation|128|read_delta|250|690.1|1.106|48.561|62.765|62.765|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|read_full|100|276.0|2.117|64.038|71.372|71.372|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_full|100|276.0|41.970|189.458|263.771|263.771|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_patch|450|1242.2|45.781|186.066|277.773|277.773|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|compact|100|183.8|158.798|536.468|540.818|544.024|0|298|39/61|
|bare-metal|sqlite|hot|burst|128|read_delta|250|459.5|2.309|134.948|158.162|498.287|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|read_full|100|183.8|3.061|182.482|186.642|488.440|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_full|100|183.8|38.957|262.514|344.713|532.170|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_patch|450|827.1|39.002|270.983|333.280|534.871|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|compact|100|197.0|144.499|500.339|503.574|503.574|0|307|32/68|
|bare-metal|sqlite|hot|saturation|128|read_delta|250|492.4|2.153|118.943|132.805|132.805|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|read_full|100|197.0|3.150|140.066|152.038|152.038|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_full|100|197.0|43.019|218.784|295.530|295.530|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_patch|450|886.3|39.008|226.307|302.555|302.555|0|0|0/0|

8 completed cells, 8000 requests, 0 errors, 16 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
