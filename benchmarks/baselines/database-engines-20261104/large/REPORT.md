# Native Rust concurrent database benchmark

**Incomplete backend matrices:** {"bare-metal/pgrust-columnar":"Incomplete after host reboot and severe query-memory amplification. Do not report a completed full-series mixed score."}

**Deployments not run:** {"bare-metal/alloydb":"No macOS native deployment configured; use Docker (Linux).","bare-metal/orioledb":"No macOS native deployment configured; use Docker (Linux)."}

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|pgrust-columnar|write_full|spread|burst|128|1728.6|67.155|147.285|184.880|572.543|0|0|0/0|
|bare-metal|pgrust-columnar|write_full|spread|saturation|128|1645.4|77.469|148.267|175.880|175.880|0|0|0/0|
|bare-metal|pgrust-columnar|write_full|hot|burst|128|1497.2|83.301|168.437|245.543|663.980|0|0|0/0|
|bare-metal|pgrust-columnar|write_full|hot|saturation|128|1279.6|96.103|196.993|251.150|251.150|0|0|0/0|
|bare-metal|pgrust-columnar|read_full|spread|burst|128|1003.5|94.972|307.230|433.826|988.235|0|0|0/0|
|bare-metal|pgrust-columnar|read_full|spread|saturation|128|901.4|71.480|405.401|573.420|573.420|0|0|0/0|
|bare-metal|pgrust-columnar|read_full|hot|burst|128|944.7|47.005|434.344|516.140|1052.244|0|0|0/0|
|bare-metal|pgrust-columnar|read_full|hot|saturation|128|943.0|82.785|377.053|516.508|516.508|0|0|0/0|
|bare-metal|pgrust-columnar|write_patch|spread|burst|128|804.8|151.226|179.092|196.471|1223.888|0|0|0/0|
|bare-metal|pgrust-columnar|write_patch|spread|saturation|128|2020.4|58.090|80.633|84.915|84.915|0|0|0/0|
|bare-metal|pgrust-columnar|write_patch|hot|burst|128|191.7|701.373|970.585|991.474|5168.949|0|0|0/0|
|bare-metal|pgrust-columnar|write_patch|hot|saturation|128|197.0|686.800|886.076|913.164|913.164|0|0|0/0|
|bare-metal|pgrust-columnar|compact|spread|burst|128|1.7|31383.636|69297.734|82060.727|248953.461|584|0|416/0|
|bare-metal|pgrust-row|write_full|spread|burst|128|2044.1|48.124|154.299|182.691|484.167|0|0|0/0|
|bare-metal|pgrust-row|write_full|spread|saturation|128|2014.1|56.988|129.784|165.177|165.177|0|0|0/0|
|bare-metal|pgrust-row|write_full|hot|burst|128|1939.9|66.527|109.993|151.163|511.601|0|0|0/0|
|bare-metal|pgrust-row|write_full|hot|saturation|128|2030.0|58.377|122.143|178.390|178.390|0|0|0/0|
|bare-metal|pgrust-row|read_full|spread|burst|128|1215.7|41.436|306.151|436.849|816.055|0|0|0/0|
|bare-metal|pgrust-row|read_full|spread|saturation|128|1311.2|60.661|265.977|329.169|329.169|0|0|0/0|
|bare-metal|pgrust-row|read_full|hot|burst|128|1389.0|49.417|290.953|386.365|714.599|0|0|0/0|
|bare-metal|pgrust-row|read_full|hot|saturation|128|1370.1|73.630|286.750|345.981|345.981|0|0|0/0|
|bare-metal|pgrust-row|write_patch|spread|burst|128|3739.3|31.423|40.361|44.785|264.404|0|0|0/0|
|bare-metal|pgrust-row|write_patch|spread|saturation|128|3716.5|32.480|43.985|47.819|47.819|0|0|0/0|
|bare-metal|pgrust-row|write_patch|hot|burst|128|1261.1|97.125|108.997|112.533|784.876|0|0|0/0|
|bare-metal|pgrust-row|write_patch|hot|saturation|128|1263.4|96.957|108.715|111.319|111.319|0|0|0/0|
|bare-metal|pgrust-row|compact|spread|burst|128|624.8|215.976|342.553|406.057|1593.627|0|0|1000/0|
|bare-metal|pgrust-row|compact|spread|saturation|128|595.7|212.020|399.530|479.414|479.414|0|0|1000/0|
|bare-metal|pgrust-row|compact|hot|burst|128|5886.6|3.171|153.771|166.459|166.686|0|127|1/999|
|bare-metal|pgrust-row|compact|hot|saturation|128|5751.8|3.658|155.851|170.667|170.667|0|127|1/999|
|bare-metal|pgrust-row|read_delta|spread|burst|128|5350.8|20.194|40.441|43.929|184.852|0|0|0/0|
|bare-metal|pgrust-row|read_delta|spread|saturation|128|5474.0|20.098|40.631|44.590|44.590|0|0|0/0|
|bare-metal|pgrust-row|read_delta|hot|burst|128|6067.3|18.501|34.221|36.836|163.488|0|0|0/0|
|bare-metal|pgrust-row|read_delta|hot|saturation|128|5648.0|19.809|37.784|40.550|40.550|0|0|0/0|
|bare-metal|pgrust-row|mixed|spread|burst|128|1243.6|30.501|502.370|635.034|797.663|0|57|14/86|
|bare-metal|pgrust-row|mixed|spread|saturation|128|1273.4|42.739|487.183|562.867|562.867|0|38|8/92|
|bare-metal|pgrust-row|mixed|hot|burst|128|1032.4|116.631|322.242|385.204|963.965|0|121|5/95|
|bare-metal|pgrust-row|mixed|hot|saturation|128|1118.4|116.586|318.498|374.787|374.787|0|124|5/95|
|bare-metal|postgres|write_full|spread|burst|128|2066.6|53.457|134.247|169.008|482.235|0|0|0/0|
|bare-metal|postgres|write_full|spread|saturation|128|2462.8|48.570|153.771|232.955|232.955|0|0|0/0|
|bare-metal|postgres|write_full|hot|burst|128|2430.3|11.358|238.715|283.267|407.703|0|0|0/0|
|bare-metal|postgres|write_full|hot|saturation|128|2331.0|47.733|149.436|232.730|232.730|0|0|0/0|
|bare-metal|postgres|read_full|spread|burst|128|1234.0|38.840|332.866|483.686|805.250|0|0|0/0|
|bare-metal|postgres|read_full|spread|saturation|128|1305.4|83.847|293.159|328.361|328.361|0|0|0/0|
|bare-metal|postgres|read_full|hot|burst|128|1335.0|56.869|292.413|379.616|742.260|0|0|0/0|
|bare-metal|postgres|read_full|hot|saturation|128|1289.8|70.801|278.942|394.249|394.249|0|0|0/0|
|bare-metal|postgres|write_patch|spread|burst|128|4152.8|28.916|36.476|39.359|237.906|0|0|0/0|
|bare-metal|postgres|write_patch|spread|saturation|128|4072.8|29.399|37.120|40.497|40.497|0|0|0/0|
|bare-metal|postgres|write_patch|hot|burst|128|1352.7|92.156|99.185|101.890|730.634|0|0|0/0|
|bare-metal|postgres|write_patch|hot|saturation|128|1361.7|91.415|97.835|100.141|100.141|0|0|0/0|
|bare-metal|postgres|compact|spread|burst|128|729.4|54.660|528.039|773.704|1366.716|0|0|1000/0|
|bare-metal|postgres|compact|spread|saturation|128|709.2|59.066|576.813|702.458|702.458|0|0|1000/0|
|bare-metal|postgres|compact|hot|burst|128|6895.6|3.122|129.605|142.085|142.170|0|127|1/999|
|bare-metal|postgres|compact|hot|saturation|128|6574.9|3.045|136.447|148.894|148.894|0|127|1/999|
|bare-metal|postgres|read_delta|spread|burst|128|5423.9|19.469|34.345|37.080|181.841|0|0|0/0|
|bare-metal|postgres|read_delta|spread|saturation|128|5266.2|20.610|33.795|36.322|36.322|0|0|0/0|
|bare-metal|postgres|read_delta|hot|burst|128|6301.9|17.122|28.489|30.085|156.747|0|0|0/0|
|bare-metal|postgres|read_delta|hot|saturation|128|6377.5|17.572|26.420|29.509|29.509|0|0|0/0|
|bare-metal|postgres|mixed|spread|burst|128|1444.5|39.560|446.112|513.886|686.577|0|43|10/90|
|bare-metal|postgres|mixed|spread|saturation|128|1387.0|25.198|469.982|588.251|588.251|0|53|9/91|
|bare-metal|postgres|mixed|hot|burst|128|1208.7|104.581|279.764|325.498|823.770|0|124|5/95|
|bare-metal|postgres|mixed|hot|saturation|128|1242.8|102.720|282.221|325.775|325.775|0|131|5/95|
|bare-metal|sqlite|write_full|spread|burst|128|438.1|0.766|1308.586|1944.764|1958.385|0|0|0/0|
|bare-metal|sqlite|write_full|spread|saturation|128|509.5|0.758|1194.879|1544.746|1544.746|0|0|0/0|
|bare-metal|sqlite|write_full|hot|burst|128|419.1|0.754|1102.212|1843.295|1843.506|0|0|0/0|
|bare-metal|sqlite|write_full|hot|saturation|128|575.7|0.749|1021.749|1517.696|1517.696|0|0|0/0|
|bare-metal|sqlite|read_full|spread|burst|128|941.6|133.772|199.632|230.070|1057.598|0|0|0/0|
|bare-metal|sqlite|read_full|spread|saturation|128|1105.6|105.688|265.728|339.965|339.965|0|0|0/0|
|bare-metal|sqlite|read_full|hot|burst|128|914.6|21.770|420.188|706.736|1087.627|0|0|0/0|
|bare-metal|sqlite|read_full|hot|saturation|128|863.8|42.712|431.072|573.886|573.886|0|0|0/0|
|bare-metal|sqlite|write_patch|spread|burst|128|901.9|0.130|571.785|901.682|901.847|0|0|0/0|
|bare-metal|sqlite|write_patch|spread|saturation|128|895.9|0.108|279.783|703.005|703.005|0|0|0/0|
|bare-metal|sqlite|write_patch|hot|burst|128|1439.1|0.062|227.166|482.020|482.306|0|0|0/0|
|bare-metal|sqlite|write_patch|hot|saturation|128|1454.4|0.063|215.268|581.838|581.838|0|0|0/0|
|bare-metal|sqlite|compact|spread|burst|128|176.2|4.554|3781.919|4714.748|4923.867|0|0|1000/0|
|bare-metal|sqlite|compact|spread|saturation|128|199.3|4.328|3548.633|4277.333|4277.333|0|0|1000/0|
|bare-metal|sqlite|compact|hot|burst|128|1625.0|1.137|158.636|407.206|407.468|0|127|1/999|
|bare-metal|sqlite|compact|hot|saturation|128|1075.2|1.521|187.183|503.533|503.533|0|127|1/999|
|bare-metal|sqlite|read_delta|spread|burst|128|1502.0|52.721|233.717|383.105|662.991|0|0|0/0|
|bare-metal|sqlite|read_delta|spread|saturation|128|1528.8|72.852|200.268|235.285|235.285|0|0|0/0|
|bare-metal|sqlite|read_delta|hot|burst|128|1229.4|24.852|405.775|444.068|811.926|0|0|0/0|
|bare-metal|sqlite|read_delta|hot|saturation|128|1156.9|39.450|309.665|436.975|436.975|0|0|0/0|
|bare-metal|sqlite|mixed|spread|burst|128|1022.9|1.130|502.464|759.061|805.480|0|38|36/64|
|bare-metal|sqlite|mixed|spread|saturation|128|695.9|0.739|600.864|1018.381|1018.381|0|40|43/57|
|bare-metal|sqlite|mixed|hot|burst|128|977.0|1.341|485.660|905.284|905.521|0|66|42/58|
|bare-metal|sqlite|mixed|hot|saturation|128|979.9|1.949|587.902|832.607|832.607|0|72|46/54|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|pgrust-row|spread|burst|128|compact|100|124.4|102.708|625.349|699.170|793.640|0|57|14/86|
|bare-metal|pgrust-row|spread|burst|128|read_delta|250|310.9|3.643|33.516|36.524|740.574|0|0|0/0|
|bare-metal|pgrust-row|spread|burst|128|read_full|100|124.4|10.429|73.875|80.047|734.656|0|0|0/0|
|bare-metal|pgrust-row|spread|burst|128|write_full|100|124.4|7.601|61.025|72.679|735.548|0|0|0/0|
|bare-metal|pgrust-row|spread|burst|128|write_patch|450|559.6|72.486|488.498|642.255|801.343|0|0|0/0|
|bare-metal|pgrust-row|spread|saturation|128|compact|100|127.3|3.223|570.668|579.068|579.068|0|38|8/92|
|bare-metal|pgrust-row|spread|saturation|128|read_delta|250|318.4|3.997|36.843|39.941|39.941|0|0|0/0|
|bare-metal|pgrust-row|spread|saturation|128|read_full|100|127.3|8.644|76.534|82.534|82.534|0|0|0/0|
|bare-metal|pgrust-row|spread|saturation|128|write_full|100|127.3|7.708|47.973|59.706|59.706|0|0|0/0|
|bare-metal|pgrust-row|spread|saturation|128|write_patch|450|573.0|72.824|481.732|501.279|501.279|0|0|0/0|
|bare-metal|pgrust-row|hot|burst|128|compact|100|103.2|322.242|398.968|404.524|968.242|0|121|5/95|
|bare-metal|pgrust-row|hot|burst|128|read_delta|250|258.1|1.707|31.943|35.118|698.517|0|0|0/0|
|bare-metal|pgrust-row|hot|burst|128|read_full|100|103.2|4.141|67.487|74.441|659.536|0|0|0/0|
|bare-metal|pgrust-row|hot|burst|128|write_full|100|103.2|3.334|44.176|50.379|658.937|0|0|0/0|
|bare-metal|pgrust-row|hot|burst|128|write_patch|450|464.6|133.335|309.233|311.839|883.655|0|0|0/0|
|bare-metal|pgrust-row|hot|saturation|128|compact|100|111.8|308.884|380.527|383.519|383.519|0|124|5/95|
|bare-metal|pgrust-row|hot|saturation|128|read_delta|250|279.6|1.692|32.071|35.119|35.119|0|0|0/0|
|bare-metal|pgrust-row|hot|saturation|128|read_full|100|111.8|3.905|70.000|74.880|74.880|0|0|0/0|
|bare-metal|pgrust-row|hot|saturation|128|write_full|100|111.8|3.322|47.375|53.297|53.297|0|0|0/0|
|bare-metal|pgrust-row|hot|saturation|128|write_patch|450|503.3|129.122|312.141|318.726|318.726|0|0|0/0|
|bare-metal|postgres|spread|burst|128|compact|100|144.5|51.732|524.859|563.101|669.372|0|43|10/90|
|bare-metal|postgres|spread|burst|128|read_delta|250|361.1|2.853|30.915|32.638|647.859|0|0|0/0|
|bare-metal|postgres|spread|burst|128|read_full|100|144.5|8.497|65.635|71.498|642.319|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_full|100|144.5|6.285|48.070|50.408|644.984|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_patch|450|650.0|56.448|442.949|465.510|689.628|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|compact|100|138.7|101.151|569.631|675.838|675.838|0|53|9/91|
|bare-metal|postgres|spread|saturation|128|read_delta|250|346.8|2.472|26.678|28.848|28.848|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|read_full|100|138.7|8.333|63.419|66.518|66.518|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_full|100|138.7|5.579|40.897|49.672|49.672|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_patch|450|624.2|62.760|462.479|592.017|592.017|0|0|0/0|
|bare-metal|postgres|hot|burst|128|compact|100|120.9|278.083|334.067|336.580|827.188|0|124|5/95|
|bare-metal|postgres|hot|burst|128|read_delta|250|302.2|1.488|25.144|29.133|625.261|0|0|0/0|
|bare-metal|postgres|hot|burst|128|read_full|100|120.9|3.530|62.579|68.067|606.542|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_full|100|120.9|2.850|43.599|46.044|606.201|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_patch|450|543.9|131.622|271.711|277.484|757.811|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|compact|100|124.3|279.361|330.915|337.250|337.250|0|131|5/95|
|bare-metal|postgres|hot|saturation|128|read_delta|250|310.7|1.418|26.262|28.079|28.079|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|read_full|100|124.3|2.472|59.743|61.982|61.982|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_full|100|124.3|2.793|42.066|48.598|48.598|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_patch|450|559.3|116.577|273.577|279.985|279.985|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|compact|100|102.3|2.086|759.061|974.712|975.300|0|38|36/64|
|bare-metal|sqlite|spread|burst|128|read_delta|250|255.7|0.890|63.741|81.381|435.137|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|read_full|100|102.3|2.467|79.723|84.818|428.753|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_full|100|102.3|2.138|595.406|708.449|805.480|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_patch|450|460.3|0.202|588.112|701.672|808.698|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|compact|100|69.6|2.073|713.837|860.269|860.269|0|40|43/57|
|bare-metal|sqlite|spread|saturation|128|read_delta|250|174.0|0.651|57.983|76.435|76.435|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|read_full|100|69.6|1.350|69.552|80.695|80.695|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_full|100|69.6|1.260|604.961|1032.672|1032.672|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_patch|450|313.2|0.192|799.432|1224.267|1224.267|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|compact|100|97.7|5.296|722.128|1001.374|1001.658|0|66|42/58|
|bare-metal|sqlite|hot|burst|128|read_delta|250|244.2|1.297|87.861|99.417|398.876|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|read_full|100|97.7|1.877|128.751|136.962|391.952|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_full|100|97.7|1.922|500.773|810.149|810.412|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_patch|450|439.6|0.142|573.994|910.468|910.883|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|compact|100|98.0|10.013|691.965|868.103|868.103|0|72|46/54|
|bare-metal|sqlite|hot|saturation|128|read_delta|250|245.0|1.835|105.328|126.368|126.368|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|read_full|100|98.0|2.887|148.239|154.374|154.374|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_full|100|98.0|2.345|592.979|916.188|916.188|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_patch|450|440.9|0.463|603.277|891.377|891.377|0|0|0/0|

85 completed cells, 85000 requests, 584 errors, 142 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
