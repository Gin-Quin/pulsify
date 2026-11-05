# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|mixed|spread|burst|1|1458.2|0.648|0.826|2.420|680.586|0|0|66/34|
|bare-metal|postgres|mixed|spread|saturation|1|1469.8|0.649|0.835|2.413|2.413|0|0|66/34|
|bare-metal|postgres|mixed|hot|burst|1|1453.7|0.669|0.886|2.098|680.627|0|0|68/32|
|bare-metal|postgres|mixed|hot|saturation|1|1467.1|0.664|0.860|2.110|2.110|0|0|68/32|
|bare-metal|postgres|mixed|spread|burst|16|5086.6|1.901|7.870|27.693|193.294|0|18|50/50|
|bare-metal|postgres|mixed|spread|saturation|16|5116.5|1.916|7.436|27.836|27.836|0|29|56/44|
|bare-metal|postgres|mixed|hot|burst|16|1772.7|4.873|42.715|106.845|553.802|0|676|73/27|
|bare-metal|postgres|mixed|hot|saturation|16|1864.5|5.650|43.282|78.306|78.306|0|484|58/42|
|bare-metal|postgres|mixed|spread|burst|64|5401.8|4.429|46.642|57.054|179.754|0|29|17/83|
|bare-metal|postgres|mixed|spread|saturation|64|5348.1|3.760|47.547|57.470|57.470|0|34|21/79|
|bare-metal|postgres|mixed|hot|burst|64|1693.6|29.361|99.540|405.906|587.151|0|455|13/87|
|bare-metal|postgres|mixed|hot|saturation|64|1829.7|28.232|90.341|365.961|365.961|0|455|13/87|
|bare-metal|sqlite|mixed|spread|burst|1|9196.3|0.084|0.183|1.018|107.578|0|0|66/34|
|bare-metal|sqlite|mixed|spread|saturation|1|9202.9|0.085|0.181|0.914|0.914|0|0|66/34|
|bare-metal|sqlite|mixed|hot|burst|1|5421.9|0.109|0.554|0.611|180.954|0|0|68/32|
|bare-metal|sqlite|mixed|hot|saturation|1|5509.3|0.106|0.542|0.591|0.591|0|0|68/32|
|bare-metal|sqlite|mixed|spread|burst|16|7634.2|0.111|3.831|40.460|103.786|0|17|62/38|
|bare-metal|sqlite|mixed|spread|saturation|16|4954.4|0.110|2.133|61.060|61.060|0|11|62/38|
|bare-metal|sqlite|mixed|hot|burst|16|6555.5|0.163|3.870|61.678|121.804|0|27|58/42|
|bare-metal|sqlite|mixed|hot|saturation|16|4870.4|0.176|3.837|61.292|61.292|0|25|72/28|
|bare-metal|sqlite|mixed|spread|burst|64|3842.8|0.125|64.679|197.018|198.772|0|25|52/48|
|bare-metal|sqlite|mixed|spread|saturation|64|3864.4|0.126|65.133|149.013|149.013|0|21|49/51|
|bare-metal|sqlite|mixed|hot|burst|64|2772.5|0.281|63.046|197.886|202.545|0|46|59/41|
|bare-metal|sqlite|mixed|hot|saturation|64|2748.1|0.262|90.918|195.775|195.775|0|39|55/45|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|spread|burst|1|compact|100|145.8|0.801|14.393|15.333|653.159|0|0|66/34|
|bare-metal|postgres|spread|burst|1|read_delta|250|364.6|0.316|0.376|0.399|683.668|0|0|0/0|
|bare-metal|postgres|spread|burst|1|read_full|100|145.8|0.384|0.508|0.599|665.733|0|0|0/0|
|bare-metal|postgres|spread|burst|1|write_full|100|145.8|0.628|0.708|0.791|665.108|0|0|0/0|
|bare-metal|postgres|spread|burst|1|write_patch|450|656.2|0.668|0.719|0.822|680.586|0|0|0/0|
|bare-metal|postgres|spread|saturation|1|compact|100|147.0|0.813|14.608|15.144|15.144|0|0|66/34|
|bare-metal|postgres|spread|saturation|1|read_delta|250|367.5|0.316|0.361|0.379|0.379|0|0|0/0|
|bare-metal|postgres|spread|saturation|1|read_full|100|147.0|0.390|0.536|0.592|0.592|0|0|0/0|
|bare-metal|postgres|spread|saturation|1|write_full|100|147.0|0.616|0.678|0.729|0.729|0|0|0/0|
|bare-metal|postgres|spread|saturation|1|write_patch|450|661.4|0.668|0.708|0.835|0.835|0|0|0/0|
|bare-metal|postgres|hot|burst|1|compact|100|145.4|0.810|3.247|3.983|642.200|0|0|68/32|
|bare-metal|postgres|hot|burst|1|read_delta|250|363.4|0.607|0.777|0.816|684.962|0|0|0/0|
|bare-metal|postgres|hot|burst|1|read_full|100|145.4|0.575|0.812|0.854|661.145|0|0|0/0|
|bare-metal|postgres|hot|burst|1|write_full|100|145.4|0.638|0.718|0.815|658.591|0|0|0/0|
|bare-metal|postgres|hot|burst|1|write_patch|450|654.2|0.677|0.727|0.820|680.627|0|0|0/0|
|bare-metal|postgres|hot|saturation|1|compact|100|146.7|0.832|3.243|3.953|3.953|0|0|68/32|
|bare-metal|postgres|hot|saturation|1|read_delta|250|366.8|0.589|0.776|0.826|0.826|0|0|0/0|
|bare-metal|postgres|hot|saturation|1|read_full|100|146.7|0.565|0.823|0.857|0.857|0|0|0/0|
|bare-metal|postgres|hot|saturation|1|write_full|100|146.7|0.625|0.671|0.724|0.724|0|0|0/0|
|bare-metal|postgres|hot|saturation|1|write_patch|450|660.2|0.673|0.715|0.741|0.741|0|0|0/0|
|bare-metal|postgres|spread|burst|16|compact|100|508.7|3.341|28.803|30.657|190.552|0|18|50/50|
|bare-metal|postgres|spread|burst|16|read_delta|250|1271.6|0.881|1.130|1.798|192.691|0|0|0/0|
|bare-metal|postgres|spread|burst|16|read_full|100|508.7|1.009|1.529|2.250|187.219|0|0|0/0|
|bare-metal|postgres|spread|burst|16|write_full|100|508.7|1.728|2.154|2.382|187.560|0|0|0/0|
|bare-metal|postgres|spread|burst|16|write_patch|450|2289.0|3.052|8.401|27.454|194.454|0|0|0/0|
|bare-metal|postgres|spread|saturation|16|compact|100|511.6|3.158|29.252|31.213|31.213|0|29|56/44|
|bare-metal|postgres|spread|saturation|16|read_delta|250|1279.1|0.872|1.105|1.676|1.676|0|0|0/0|
|bare-metal|postgres|spread|saturation|16|read_full|100|511.6|1.022|1.834|2.136|2.136|0|0|0/0|
|bare-metal|postgres|spread|saturation|16|write_full|100|511.6|1.715|2.070|2.540|2.540|0|0|0/0|
|bare-metal|postgres|spread|saturation|16|write_patch|450|2302.4|2.977|7.945|27.661|27.661|0|0|0/0|
|bare-metal|postgres|hot|burst|16|compact|100|177.3|42.715|119.447|135.015|563.388|0|676|73/27|
|bare-metal|postgres|hot|burst|16|read_delta|250|443.2|1.154|1.927|2.218|549.776|0|0|0/0|
|bare-metal|postgres|hot|burst|16|read_full|100|177.3|0.893|2.206|2.351|532.287|0|0|0/0|
|bare-metal|postgres|hot|burst|16|write_full|100|177.3|0.800|1.430|1.820|530.456|0|0|0/0|
|bare-metal|postgres|hot|burst|16|write_patch|450|797.7|6.565|12.442|22.460|555.741|0|0|0/0|
|bare-metal|postgres|hot|saturation|16|compact|100|186.5|43.282|89.998|113.033|113.033|0|484|58/42|
|bare-metal|postgres|hot|saturation|16|read_delta|250|466.1|1.124|1.903|2.004|2.004|0|0|0/0|
|bare-metal|postgres|hot|saturation|16|read_full|100|186.5|0.987|1.979|2.172|2.172|0|0|0/0|
|bare-metal|postgres|hot|saturation|16|write_full|100|186.5|0.783|1.346|2.004|2.004|0|0|0/0|
|bare-metal|postgres|hot|saturation|16|write_patch|450|839.0|7.617|11.476|22.806|22.806|0|0|0/0|
|bare-metal|postgres|spread|burst|64|compact|100|540.2|0.890|56.891|59.400|167.486|0|29|17/83|
|bare-metal|postgres|spread|burst|64|read_delta|250|1350.4|1.111|6.121|6.736|165.069|0|0|0/0|
|bare-metal|postgres|spread|burst|64|read_full|100|540.2|1.306|7.034|7.551|161.545|0|0|0/0|
|bare-metal|postgres|spread|burst|64|write_full|100|540.2|2.292|5.327|10.494|162.236|0|0|0/0|
|bare-metal|postgres|spread|burst|64|write_patch|450|2430.8|18.107|49.056|57.304|182.518|0|0|0/0|
|bare-metal|postgres|spread|saturation|64|compact|100|534.8|0.874|57.500|65.843|65.843|0|34|21/79|
|bare-metal|postgres|spread|saturation|64|read_delta|250|1337.0|1.055|6.185|6.803|6.803|0|0|0/0|
|bare-metal|postgres|spread|saturation|64|read_full|100|534.8|1.237|7.010|7.383|7.383|0|0|0/0|
|bare-metal|postgres|spread|saturation|64|write_full|100|534.8|2.152|5.237|10.632|10.632|0|0|0/0|
|bare-metal|postgres|spread|saturation|64|write_patch|450|2406.7|17.760|49.153|57.146|57.146|0|0|0/0|
|bare-metal|postgres|hot|burst|64|compact|100|169.4|99.540|442.244|448.557|590.356|0|455|13/87|
|bare-metal|postgres|hot|burst|64|read_delta|250|423.4|0.938|5.701|6.108|500.154|0|0|0/0|
|bare-metal|postgres|hot|burst|64|read_full|100|169.4|0.811|6.551|7.016|452.545|0|0|0/0|
|bare-metal|postgres|hot|burst|64|write_full|100|169.4|0.826|4.112|9.166|450.858|0|0|0/0|
|bare-metal|postgres|hot|burst|64|write_patch|450|762.1|42.140|53.477|54.836|523.700|0|0|0/0|
|bare-metal|postgres|hot|saturation|64|compact|100|183.0|90.341|398.948|405.617|405.617|0|455|13/87|
|bare-metal|postgres|hot|saturation|64|read_delta|250|457.4|0.929|5.482|6.155|6.155|0|0|0/0|
|bare-metal|postgres|hot|saturation|64|read_full|100|183.0|0.755|6.610|6.813|6.813|0|0|0/0|
|bare-metal|postgres|hot|saturation|64|write_full|100|183.0|0.790|4.301|9.497|9.497|0|0|0/0|
|bare-metal|postgres|hot|saturation|64|write_patch|450|823.4|41.087|51.725|52.819|52.819|0|0|0/0|
|bare-metal|sqlite|spread|burst|1|compact|100|919.6|0.108|1.044|1.241|102.068|0|0|66/34|
|bare-metal|sqlite|spread|burst|1|read_delta|250|2299.1|0.111|0.146|0.162|108.202|0|0|0/0|
|bare-metal|sqlite|spread|burst|1|read_full|100|919.6|0.161|0.243|0.264|104.951|0|0|0/0|
|bare-metal|sqlite|spread|burst|1|write_full|100|919.6|0.118|0.158|1.202|104.723|0|0|0/0|
|bare-metal|sqlite|spread|burst|1|write_patch|450|4138.3|0.064|0.089|0.128|107.578|0|0|0/0|
|bare-metal|sqlite|spread|saturation|1|compact|100|920.3|0.113|1.069|1.258|1.258|0|0|66/34|
|bare-metal|sqlite|spread|saturation|1|read_delta|250|2300.7|0.108|0.150|0.166|0.166|0|0|0/0|
|bare-metal|sqlite|spread|saturation|1|read_full|100|920.3|0.157|0.241|0.257|0.257|0|0|0/0|
|bare-metal|sqlite|spread|saturation|1|write_full|100|920.3|0.123|0.161|0.922|0.922|0|0|0/0|
|bare-metal|sqlite|spread|saturation|1|write_patch|450|4141.3|0.064|0.093|0.125|0.125|0|0|0/0|
|bare-metal|sqlite|hot|burst|1|compact|100|542.2|0.129|0.254|0.434|165.454|0|0|68/32|
|bare-metal|sqlite|hot|burst|1|read_delta|250|1355.5|0.380|0.590|0.618|182.953|0|0|0/0|
|bare-metal|sqlite|hot|burst|1|read_full|100|542.2|0.333|0.587|0.612|173.513|0|0|0/0|
|bare-metal|sqlite|hot|burst|1|write_full|100|542.2|0.126|0.162|0.883|172.653|0|0|0/0|
|bare-metal|sqlite|hot|burst|1|write_patch|450|2439.9|0.059|0.097|0.127|180.954|0|0|0/0|
|bare-metal|sqlite|hot|saturation|1|compact|100|550.9|0.131|0.277|0.389|0.389|0|0|68/32|
|bare-metal|sqlite|hot|saturation|1|read_delta|250|1377.3|0.368|0.573|0.595|0.595|0|0|0/0|
|bare-metal|sqlite|hot|saturation|1|read_full|100|550.9|0.327|0.570|0.591|0.591|0|0|0/0|
|bare-metal|sqlite|hot|saturation|1|write_full|100|550.9|0.124|0.167|0.953|0.953|0|0|0/0|
|bare-metal|sqlite|hot|saturation|1|write_patch|450|2479.2|0.057|0.095|0.122|0.122|0|0|0/0|
|bare-metal|sqlite|spread|burst|16|compact|100|763.4|0.125|37.711|93.723|123.109|0|17|62/38|
|bare-metal|sqlite|spread|burst|16|read_delta|250|1908.5|0.142|0.232|1.822|95.727|0|0|0/0|
|bare-metal|sqlite|spread|burst|16|read_full|100|763.4|0.188|1.068|2.227|93.066|0|0|0/0|
|bare-metal|sqlite|spread|burst|16|write_full|100|763.4|0.138|1.481|39.183|103.786|0|0|0/0|
|bare-metal|sqlite|spread|burst|16|write_patch|450|3435.4|0.062|3.840|88.129|105.048|0|0|0/0|
|bare-metal|sqlite|spread|saturation|16|compact|100|495.4|0.126|37.330|113.446|113.446|0|11|62/38|
|bare-metal|sqlite|spread|saturation|16|read_delta|250|1238.6|0.134|0.255|1.822|1.822|0|0|0/0|
|bare-metal|sqlite|spread|saturation|16|read_full|100|495.4|0.184|1.155|2.310|2.310|0|0|0/0|
|bare-metal|sqlite|spread|saturation|16|write_full|100|495.4|0.136|3.994|10.187|10.187|0|0|0/0|
|bare-metal|sqlite|spread|saturation|16|write_patch|450|2229.5|0.062|3.720|91.031|91.031|0|0|0/0|
|bare-metal|sqlite|hot|burst|16|compact|100|655.6|0.174|22.657|122.738|126.972|0|27|58/42|
|bare-metal|sqlite|hot|burst|16|read_delta|250|1638.9|0.559|1.125|1.687|121.316|0|0|0/0|
|bare-metal|sqlite|hot|burst|16|read_full|100|655.6|0.453|1.234|1.962|117.526|0|0|0/0|
|bare-metal|sqlite|hot|burst|16|write_full|100|655.6|0.147|3.694|87.153|120.657|0|0|0/0|
|bare-metal|sqlite|hot|burst|16|write_patch|450|2950.0|0.068|8.636|61.678|127.684|0|0|0/0|
|bare-metal|sqlite|hot|saturation|16|compact|100|487.0|0.221|21.407|40.257|40.257|0|25|72/28|
|bare-metal|sqlite|hot|saturation|16|read_delta|250|1217.6|0.615|1.240|1.743|1.743|0|0|0/0|
|bare-metal|sqlite|hot|saturation|16|read_full|100|487.0|0.453|1.218|2.078|2.078|0|0|0/0|
|bare-metal|sqlite|hot|saturation|16|write_full|100|487.0|0.151|1.465|92.213|92.213|0|0|0/0|
|bare-metal|sqlite|hot|saturation|16|write_patch|450|2191.7|0.069|3.902|92.423|92.423|0|0|0/0|
|bare-metal|sqlite|spread|burst|64|compact|100|384.3|0.142|121.487|207.594|208.575|0|25|52/48|
|bare-metal|sqlite|spread|burst|64|read_delta|250|960.7|0.142|6.405|7.432|89.804|0|0|0/0|
|bare-metal|sqlite|spread|burst|64|read_full|100|384.3|0.198|7.328|7.876|86.986|0|0|0/0|
|bare-metal|sqlite|spread|burst|64|write_full|100|384.3|0.157|122.076|149.119|156.712|0|0|0/0|
|bare-metal|sqlite|spread|burst|64|write_patch|450|1729.2|0.067|96.651|203.283|203.894|0|0|0/0|
|bare-metal|sqlite|spread|saturation|64|compact|100|386.4|0.129|124.882|148.727|148.727|0|21|49/51|
|bare-metal|sqlite|spread|saturation|64|read_delta|250|966.1|0.143|4.918|6.630|6.630|0|0|0/0|
|bare-metal|sqlite|spread|saturation|64|read_full|100|386.4|0.197|6.595|7.186|7.186|0|0|0/0|
|bare-metal|sqlite|spread|saturation|64|write_full|100|386.4|0.147|115.672|137.446|137.446|0|0|0/0|
|bare-metal|sqlite|spread|saturation|64|write_patch|450|1739.0|0.071|94.780|203.408|203.408|0|0|0/0|
|bare-metal|sqlite|hot|burst|64|compact|100|277.3|0.315|151.751|207.831|209.612|0|46|59/41|
|bare-metal|sqlite|hot|burst|64|read_delta|250|693.1|0.652|4.824|5.711|110.342|0|0|0/0|
|bare-metal|sqlite|hot|burst|64|read_full|100|277.3|0.531|6.086|6.497|106.868|0|0|0/0|
|bare-metal|sqlite|hot|burst|64|write_full|100|277.3|0.165|63.046|253.776|255.575|0|0|0/0|
|bare-metal|sqlite|hot|burst|64|write_patch|450|1247.6|0.078|116.928|197.886|202.545|0|0|0/0|
|bare-metal|sqlite|hot|saturation|64|compact|100|274.8|0.302|123.206|128.494|128.494|0|39|55/45|
|bare-metal|sqlite|hot|saturation|64|read_delta|250|687.0|0.582|5.430|6.488|6.488|0|0|0/0|
|bare-metal|sqlite|hot|saturation|64|read_full|100|274.8|0.514|6.522|7.026|7.026|0|0|0/0|
|bare-metal|sqlite|hot|saturation|64|write_full|100|274.8|0.165|119.253|199.897|199.897|0|0|0/0|
|bare-metal|sqlite|hot|saturation|64|write_patch|450|1236.6|0.073|119.047|205.663|205.663|0|0|0/0|

24 completed cells, 24000 requests, 0 errors, 48 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
