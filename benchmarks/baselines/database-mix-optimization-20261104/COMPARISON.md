# Mixed workload optimization comparison

3 baseline runs and 3 optimized runs; median completed requests/s per cell. Same fixture SHA-256: `2eac65ad652a6539884ac16a4f413d56119ecda971b09b4b932dff87d63e6fbb`. Exact 45/25/10/10/10 mix, durable commits, fresh private database per campaign.

48000 audited requests, zero request errors, 96 Pulsify materialization proofs and 5016 exact histories.

| Deployment / engine / clients / topology / admission | Before req/s | After req/s | Gain | p99 before → after ms |
|---|---:|---:|---:|---:|
| bare-metal/postgres/128/spread/burst | 1240.7 | 3613.9 | +191.3% | 650.0 → 154.6 |
| bare-metal/postgres/128/spread/saturation | 1526.8 | 3740.4 | +145.0% | 489.6 → 146.2 |
| bare-metal/postgres/128/hot/burst | 1258.7 | 2513.9 | +99.7% | 332.0 → 161.3 |
| bare-metal/postgres/128/hot/saturation | 1190.2 | 2244.1 | +88.6% | 340.8 → 177.5 |
| bare-metal/sqlite/128/spread/burst | 1125.5 | 2921.9 | +159.6% | 677.3 → 272.4 |
| bare-metal/sqlite/128/spread/saturation | 911.7 | 2760.5 | +202.8% | 821.7 → 263.8 |
| bare-metal/sqlite/128/hot/burst | 922.8 | 1815.7 | +96.8% | 705.5 → 484.3 |
| bare-metal/sqlite/128/hot/saturation | 924.9 | 1879.2 | +103.2% | 672.3 → 482.2 |

**Every cell ≥30%: PASS.**

Compaction is attempted on every scheduled request; useful work varies with races. Useful compactions and removed segments are reported as min–max across repetitions.

| Cell | Useful before → after | Removed segments before → after |
|---|---:|---:|
| bare-metal/postgres/128/spread/burst | 10–11 → 10–14 | 7970–7971 → 7970–7975 |
| bare-metal/postgres/128/spread/saturation | 8–11 → 10–16 | 7968–7971 → 7970–7981 |
| bare-metal/postgres/128/hot/burst | 5–5 → 4–5 | 1123–1126 → 1119–1123 |
| bare-metal/postgres/128/hot/saturation | 5–5 → 5–5 | 1121–1125 → 1123–1134 |
| bare-metal/sqlite/128/spread/burst | 37–45 → 16–20 | 8040–8055 → 7977–7983 |
| bare-metal/sqlite/128/spread/saturation | 39–44 → 9–14 | 8041–8074 → 7970–7975 |
| bare-metal/sqlite/128/hot/burst | 42–52 → 32–39 | 1224–1232 → 1146–1160 |
| bare-metal/sqlite/128/hot/saturation | 47–47 → 32–35 | 1220–1228 → 1149–1154 |

These are finite batches on one workstation. Results characterize these storage adapters and deployments. The jittered SQLite busy handler can trade additional wakeups/CPU for shorter lock waits; no claim is made about long-running capacity or CPU efficiency.
