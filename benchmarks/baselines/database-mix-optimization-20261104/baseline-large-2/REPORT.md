# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|mixed|spread|burst|128|1240.7|21.752|543.693|650.045|800.186|0|44|10/90|
|bare-metal|postgres|mixed|spread|saturation|128|1526.8|24.830|428.026|489.593|489.593|0|38|8/92|
|bare-metal|postgres|mixed|hot|burst|128|1221.0|98.368|279.764|332.010|816.400|0|124|5/95|
|bare-metal|postgres|mixed|hot|saturation|128|1190.2|102.117|288.201|340.772|340.772|0|132|5/95|
|bare-metal|sqlite|mixed|spread|burst|128|1128.1|0.772|465.690|677.339|759.987|0|35|41/59|
|bare-metal|sqlite|mixed|spread|saturation|128|911.7|0.719|568.073|878.655|878.655|0|40|42/58|
|bare-metal|sqlite|mixed|hot|burst|128|919.4|1.376|466.810|776.456|777.346|0|68|42/58|
|bare-metal|sqlite|mixed|hot|saturation|128|924.9|1.444|460.470|672.340|672.340|0|76|47/53|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|spread|burst|128|compact|100|124.1|67.882|610.082|677.986|802.426|0|44|10/90|
|bare-metal|postgres|spread|burst|128|read_delta|250|310.2|2.465|24.830|29.253|737.349|0|0|0/0|
|bare-metal|postgres|spread|burst|128|read_full|100|124.1|9.123|65.417|69.512|737.343|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_full|100|124.1|5.442|43.597|44.425|738.750|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_patch|450|558.3|60.622|540.166|669.825|802.526|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|compact|100|152.7|2.026|492.352|512.163|512.163|0|38|8/92|
|bare-metal|postgres|spread|saturation|128|read_delta|250|381.7|2.584|24.227|27.863|27.863|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|read_full|100|152.7|7.428|62.366|65.177|65.177|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_full|100|152.7|5.419|53.256|60.569|60.569|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_patch|450|687.1|55.900|425.561|436.771|436.771|0|0|0/0|
|bare-metal|postgres|hot|burst|128|compact|100|122.1|276.686|336.284|339.094|818.917|0|124|5/95|
|bare-metal|postgres|hot|burst|128|read_delta|250|305.2|1.425|26.164|28.957|589.246|0|0|0/0|
|bare-metal|postgres|hot|burst|128|read_full|100|122.1|3.774|58.165|63.866|572.464|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_full|100|122.1|2.699|41.364|51.441|572.556|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_patch|450|549.4|111.482|271.653|279.430|749.427|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|compact|100|119.0|285.305|344.194|348.179|348.179|0|132|5/95|
|bare-metal|postgres|hot|saturation|128|read_delta|250|297.5|1.459|25.966|28.055|28.055|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|read_full|100|119.0|3.847|61.734|66.499|66.499|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_full|100|119.0|2.669|41.425|45.798|45.798|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_patch|450|535.6|115.738|275.360|285.077|285.077|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|compact|100|112.8|1.138|544.233|759.694|760.085|0|35|41/59|
|bare-metal|sqlite|spread|burst|128|read_delta|250|282.0|0.701|71.867|82.952|396.691|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|read_full|100|112.8|3.509|89.693|93.376|393.008|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_full|100|112.8|1.374|565.281|673.499|687.380|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_patch|450|507.6|0.164|471.177|774.736|775.813|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|compact|100|91.2|1.648|654.019|758.414|758.414|0|40|42/58|
|bare-metal|sqlite|spread|saturation|128|read_delta|250|227.9|0.646|67.402|85.017|85.017|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|read_full|100|91.2|1.315|84.441|89.007|89.007|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_full|100|91.2|1.154|679.591|989.753|989.753|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_patch|450|410.3|0.152|574.461|888.207|888.207|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|compact|100|91.9|7.795|512.649|614.603|615.067|0|68|42/58|
|bare-metal|sqlite|hot|burst|128|read_delta|250|229.9|1.437|117.975|129.835|406.847|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|read_full|100|91.9|1.991|146.487|152.491|400.989|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_full|100|91.9|1.355|457.831|575.034|611.520|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_patch|450|413.7|0.132|567.205|878.938|879.301|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|compact|100|92.5|21.637|476.018|563.937|563.937|0|76|47/53|
|bare-metal|sqlite|hot|saturation|128|read_delta|250|231.2|1.523|86.837|91.384|91.384|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|read_full|100|92.5|2.107|115.998|128.287|128.287|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_full|100|92.5|1.031|467.254|672.141|672.141|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_patch|450|416.2|0.157|562.598|776.056|776.056|0|0|0/0|

8 completed cells, 8000 requests, 0 errors, 16 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
