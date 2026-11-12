# Five engines on one dedicated server — 2026-11-11

Raw reports of the reference database campaign: PostgreSQL, SQLite, RocksDB,
LevelDB and LMDB on a Latitude.sh `f4.metal.small` in London, with 1, 4 and 8
cores. [Results](../../database/RESULTS.md) ·
[method and commands](../../database/README.md#dedicated-server).

| Folder | Content |
|---|---|
| `postgres`, `sqlite`, `rocksdb`, `leveldb`, `lmdb` | One report per (cores, history, durability) series: 18 cells each, 324 per engine. `size.json` is the data directory after the last cell, `environment.txt` the machine, `campaign.log` the runner's output |
| `control-a`, `control-b` | The same SQLite series on both servers, before the campaign |
| `repeat-a` | LevelDB's whole campaign again, on the other server |

Server A ran PostgreSQL and LMDB; server B ran SQLite, RocksDB and LevelDB.
The reports hold summaries, per-operation summaries and verification proofs,
not the per-request events. They were measured at commit `e4a071e` plus the
working-tree changes committed with them; the Rust sources were then formatted
with rustfmt and the default `--environment` label was renamed, without
changing behaviour.
