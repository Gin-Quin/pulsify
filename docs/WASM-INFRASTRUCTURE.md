# Wasm serverless infrastructure: research notes

Research from 2026-11-11, not a plan. Nothing here is implemented.

**Decision.** Pulsify Cloud starts on Cloudflare Durable Objects. A custom
infrastructure is revisited once the customer base justifies it. Bun was
considered as the runtime and rejected; WebAssembly stays the target.

How to read the claims:

- **measured**: from this repository's benchmarks.
- **published**: from a provider or project page read on 2026-11-11. Prices
  change and vary by city.
- **memory**: recalled, not checked. Verify before relying on it.

## Idea

Durable Objects, with three differences:

- Instances are WebAssembly micro-instances rather than JavaScript isolates or
  full VMs, and start in well under a millisecond.
- Storage is a choice per instance (SQLite, an embedded key-value engine, a
  plain file system, a shared PostgreSQL) on an attached volume, not SQLite
  only.
- The vCPU share and RAM of an instance are configurable.

The guest must reach HTTP, WebSocket and its database through bridges that cost
as little as possible. For Pulsify, one instance would hold one root, the unit
of placement that [CLOUD.md](CLOUD.md) already maps to one Durable Object.

## Concept

### Host

A Rust host embedding **Wasmtime**. Writing a runtime is not part of the work.

- **Start-up**: modules precompiled ahead of time, the pooling allocator and
  copy-on-write memory images. Instantiation is microseconds (memory).
- **Threads**: one per core, I/O through io_uring. An instance stays on its
  core unless it is stolen (see [Load management](#load-management)).
- **Guest ABI**: a custom, event-driven one on a core module. The guest exports
  `on_request`, `on_message(ptr, len)` and `on_completion(id)` and runs each to
  completion without blocking. This is the Durable Object model. It avoids
  Wasmtime's async fibers and the copies of the component model's canonical ABI
  on the hot path.
- **Hibernation**: the host keeps the WebSocket, evicts the instance and
  recreates it when a message arrives. In-memory state is lost, as on Durable
  Objects.

### Bridges

A call from the guest to the host costs nanoseconds to tens of nanoseconds
(memory). Copies and the number of round trips are what cost.

| Bridge | Design | Real cost |
|---|---|---|
| WebSocket | Host terminates TLS and framing, writes the payload straight into the guest's linear memory | One copy and one call |
| HTTP | Host parses, passes a compact binary head and the body in chunks | Same |
| SQLite, key-value | Native library in the host behind imported functions; results written in batches into a guest buffer | Near native if not one call per column |
| File system | Volume directory preopened through WASI | One system call |
| PostgreSQL | Separate process over a Unix socket | 10 to 20 µs per query at least (memory) |

The same bridge, guest code calling `storage_read` and `storage_write` into a
RocksDB owned by the host, has run in production for years in NEAR, Substrate
and CosmWasm (memory). Their code is the closest prior art for the storage ABI.

### Storage per instance

- **SQLite** fits exactly: one file, opened in microseconds, no background
  thread, a single writer like the instance itself. WAL with exclusive locking
  also works on a network volume.
- **File system** is a preopened directory. Large files go through io_uring so
  they do not block the core.
- **Key-value**: see [Storage engines](#storage-engines).
- **PostgreSQL does not fit the model.** It cannot be embedded; a cluster per
  instance costs tens of megabytes and hundreds of milliseconds. It can only be
  a shared service with one database per tenant and pooling.

Memory used by a native engine lives in the host, not in the guest's linear
memory. The RAM cap of an instance must count it (SQLite cache, write buffers)
or the quota means nothing.

### Sizing an instance

- **RAM**: a cap on linear memory plus the engine memory above. Past 4 GiB it
  needs memory64, which is slower.
- **vCPU**: an instance is single-threaded, so this is a share of CPU time
  enforced by epoch interruption, not a number of cores. More than one vCPU per
  instance means more instances.

### What bites

- **Durability against latency.** An fsync costs milliseconds. Group commit,
  and outgoing messages held until the write is durable (Durable Objects'
  output gates).
- **Compute ceiling.** Wasm runs 1.2 to 2 times slower than native code
  (memory).
- **Distribution is most of the work**: one instance per ID, routing to the
  right node, volume replication and migration, failover. On one node with
  local NVMe none of it exists.
- **Third-party code** adds Spectre hardening, billing and strict quotas. SQL
  from an untrusted guest also reaches a native SQLite inside the host.

### Runtime choices that were ruled out

- **Bun instead of Wasmtime.** Its bridges already exist and TypeScript runs at
  full speed, but it has no sandbox inside a process: isolating an instance
  means a process of tens of megabytes that starts in milliseconds (memory),
  one to two orders of magnitude less dense. Third-party code would need a
  micro-VM on top. Rejected.
- **Both runtimes behind one host.** Feasible, but it doubles the ABI and the
  isolation model. Not before a real need.
- **JavaScript guests on Wasmtime** embed an interpreter without a JIT and run
  ten to a hundred times slower (memory). Guests are Rust, Zig or C.

## Prior art

No service does all of it, and none exposes RocksDB to Wasm guests.

| Service | What it does | What is missing |
|---|---|---|
| SpacetimeDB | Wasm modules (Wasmtime) run inside the database; clients subscribe over WebSocket | One home-made engine (in memory plus a commit log), no choice of store, no volumes |
| Golem | Durable Wasm workers: all in-memory state persisted through a replayed operation log | No embedded database; the log lives in Redis then blob storage |
| Spin (Fermyon, now Akamai) | Wasm with SQLite, key-value and outbound PostgreSQL | Stateless instances per request; an inbound WebSocket trigger was proposed, shipping not confirmed |
| Wasmer Edge | Full Wasm servers (WASIX), persistent volumes, PostgreSQL | A running-server model, not one instance per ID; WebSocket not confirmed |
| Rivet | Open-source Durable Objects: stateful actors, WebSockets, SQLite per actor | Actors are JavaScript. RocksDB is its own persistence when self-hosted, not an API for the actor |

SpacetimeDB's source is the closest to the Wasm, database and WebSocket bridges
described here and is worth reading before writing any.

## Storage engines

No engine beats RocksDB everywhere. On Pulsify's workload LMDB often does.

Mixed workload on one hot document, 16 clients, requests per second
(**measured**,
[campaign of 2026-11-11](../benchmarks/baselines/database-engines-20261111/README.md)):

| Tier, host | RocksDB | LMDB |
|---|---:|---:|
| Relaxed, macOS native | 8,720 | 10,879 |
| Relaxed, Docker | 6,610 | 10,613 |
| Relaxed, VPS | 1,155 | 3,190 |
| Strict, VPS | 273 | 532 |
| Strict, Docker | 719 | 462 |

LevelDB also stays ahead of RocksDB on isolated relaxed writes, by half again
to twice. One run per cell: differences under about 20% are not a ranking.

| Engine | Strength | Weakness |
|---|---|---|
| LMDB | Reads and stable latency; one file, no compaction, no background thread, instant open | Random-write-heavy loads, data larger than RAM, no compression, maximum size fixed up front, poor on network volumes |
| libmdbx | LMDB without those practical limits (self-adjusting size, longer keys); 0.14.2 in May 2026 | Hosted outside GitHub, partly developed in private |
| RocksDB | The all-rounder; cache, memory budget and compaction threads can be shared across many databases in one process | Heavier per database, C++ build |
| LevelDB | Fast isolated writes here | One compaction thread shared by every database of a process; 4 MiB write buffer and 8 MiB cache each by default |
| Fjall 3 | Pure Rust LSM; keyspaces share one journal, which suits thousands of small databases | About 50 to 60% of RocksDB's throughput according to one unofficial note |
| SlateDB | LSM written straight to object storage: removes volume replication | A durable write costs tens of milliseconds (memory) |
| Speedb | RocksDB fork promising fewer write stalls | Could not confirm it is still maintained |

**Leaning**: SQLite and the file system first; LMDB as the default key-value
engine because it matches a micro-instance (single writer, one file, nothing in
the background); RocksDB as the option for write-heavy or larger-than-RAM
instances.

**Not measured**: thousands of small databases, each on one core. The campaign
above measured one database under many clients. That missing case decides.

## Hosting

Requirements: NVMe, a provisioning API, good cost for performance, at least 12
locations worldwide, managed hardware. Fast CPUs are welcome.

### Providers (published)

| Provider | Locations | API | Recent entry-level server with NVMe | Billing | Main limit |
|---|---|---|---|---|---|
| Latitude.sh | 20 cities listed (page header says 26), with Latin America, Tokyo, Sydney | REST, Terraform, SDKs | EPYC 4244P, 6 cores, 48 GB: $296/month | Hourly, 20 TB egress included | About twice OVHcloud's price |
| OVHcloud | 13 sites for the Advance range; no Latin America or Japan | Full REST, IPMI included | EPYC 4244P, 6 cores, 32 GB: $147/month | Monthly, unmetered traffic outside Asia-Pacific | Poor customer reviews (3.2 on G2) |
| DataPacket | 67 sites | GraphQL: reads and power confirmed, ordering not confirmed | EPYC 4245P, 6 cores: $207/month | Monthly, unmetered traffic | Delivery in hours, up to a day |
| Vultr | Up to 24 cities for bare metal | REST | EPYC 4245P, 6 cores, 32 GB: $295/month | Hourly | Prices from third-party pages; the official page refused the request |
| Gcore | 25 sites | REST, with prices | From €156/month in Frankfurt | Per minute | CPU details not checked |
| Hivelocity | 40+ sites | REST, Terraform | Instant catalogue is old Xeons on SATA SSD, $65 to $112/month plus a per-city surcharge | Monthly | Outside Tampa, Dallas and Los Angeles, up to a week |
| Zenlayer | 60+ cities | Console, Terraform | Xeon Silver 4216: $509 to $709/month | Monthly | Old CPUs, expensive |

Ruled out by the 12 locations: Cherry Servers, phoenixNAP (six), Hetzner
(dedicated servers in Germany and Finland only, memory). Equinix Metal closed
on 2026-06-30. Leaseweb's ordering API covers a few predefined configurations.

**Leaning**: Latitude.sh, the only one meeting the four requirements with
recent CPUs everywhere, and hourly billing allows benchmarking before
committing. OVHcloud if the load is steady and cost comes first. DataPacket if
egress becomes the main cost, once its API is confirmed to automate ordering
and reinstalls. Megaport bought Latitude.sh in November 2025.

### Cores or frequency

Total throughput follows cores times speed per core; frequency alone only sets
the latency of one request. The metric is (cores × speed per core) / price.
Simultaneous instances are more likely bounded by RAM than by cores, because
an instance waits almost all the time: at an assumed 50 µs per event, one core
handles 20,000 events per second. Watch RAM per core when sizing.

Latitude.sh, cores × GHz per $100 a month (published prices; the GHz shown are
base frequencies, an approximation):

| Plan | CPU | Cores × GHz | $/month | Per $100 |
|---|---|---:|---:|---:|
| f4.metal.small | EPYC 4484PX | 12 × 4.4 | 398 | 13.3 |
| f4.metal.medium | EPYC 4564P | 16 × 4.5 | 555 | 13.0 |
| m4.metal.medium | EPYC 9124 | 16 × 3.0 | 456 | 10.5 |
| c4.metal.large | EPYC 9655P | 96 × 2.6 | 2,920 | 8.5 |
| m4.metal.small | EPYC 4244P | 6 × 3.8 | 296 | 7.7 |
| f4.metal.large | EPYC 9275F | 24 × 4.1 | 1,916 | 5.1 |
| rs4.metal.xlarge | EPYC 9554P | 64 × 3.1 | 3,971 | 5.0 |
| m4.metal.large | EPYC 9254 | 24 × 2.9 | 1,482 | 4.7 |
| rs4.metal.large | EPYC 9354P | 32 × 3.25 | 2,351 | 4.4 |
| m4.metal.xlarge | EPYC 9455P | 48 × 3.15 | 3,475 | 4.4 |

**Pick: f4.metal.medium.** The 2% gap to f4.metal.small is below the precision
of the metric, and it has 16 identical cores (the 4484PX has 3D cache on half
of its cores only, memory), 2.5 times the NVMe and the same 8 GB per core. The
large plans mostly pay for RAM and storage: if RAM becomes the limit,
f4.metal.large (768 GB for $1,916) gives almost twice the RAM per dollar.

### Hivelocity's old Xeons

Same metric; "adjusted" divides by about 1.4 for 2015 to 2019 cores, which do
that much less work per GHz than recent ones (memory).

| Offer | Cores × GHz | $/month | Raw | Adjusted | Disk | Sites |
|---|---:|---:|---:|---:|---|---|
| Xeon E-2336 (2021), 16 GB | 6 × 2.9 | 65 | 26.8 | ~22 | SATA SSD | Toronto |
| Xeon E3-1230 v5 (2015), 32 GB | 4 × 3.4 | 65 | 20.9 | ~15 | SATA SSD | Atlanta |
| Xeon E-2236 (2019), 16 GB | 6 × 3.4 | 97 | 21.0 | ~15 | SATA SSD | 6 cities |
| Threadripper PRO 7965WX | 24 × 4.2 | 750 | 13.4 | 13.4 | NVMe | not recorded |

They give as much compute per dollar as Latitude.sh or more, and the E3 gives
twice the RAM per dollar. They fail two requirements: no NVMe, and each $65
offer exists in one city. The six-city offer shows a $55 to $75 surcharge in
Europe and California; if it is added to the price, it drops to about 9
adjusted. Each request is also about twice as slow, and the same capacity
takes three to four times as many machines. On comparable recent hardware the
two providers are level. Hivelocity's full catalogue was not visible: the
configurable store and the inventory API need a key.

## Load management

Overload is prevented at admission, by reserving capacity. Balancing between
threads only corrects imbalance.

### Before: make overload impossible by construction

- **Reservation.** Each instance declares its vCPU and RAM quota. A node
  accepts an instance only while the sum of reservations stays under its
  capacity times a ratio. At 1.0 on RAM, exceeding it is impossible; CPU can be
  over-reserved, since instances mostly wait.
- **Placement by two random choices.** For a new instance, draw two nodes in
  the nearest region and take the one with more free reservation. Nearly as
  good as "least loaded", without the herd effect of stale load data.
- **Memory fixed at start-up.** A fixed number of instance slots (Wasmtime's
  pooling allocator) and bounded queues everywhere. Saturation becomes a
  refusal, never an out-of-memory.

Consistent hashing is not needed: a directory from ID to node is required
anyway to guarantee one instance per ID, and it routes the requests.

### During: work stealing between threads

- **The stolen unit is a whole instance with its message queue**, between two
  events. Message order and single-threaded execution are preserved; the
  transfer is a change of owner and a few cache misses.
- **An idle core steals.** It draws two cores and takes half of the waiting
  instances of the busier one. While no core is idle, nothing moves and caches
  stay warm.
- **Inside a core**, weighted round-robin by vCPU quota, with a CPU budget per
  event enforced by epoch interruption, so no instance can hold a core.

Tokio's multi-thread runtime already steals work this way: one task per
instance gives it for free. Start there; write a strict-affinity scheduler
only if a benchmark shows migrations cost too much.

### Under overload: slow down and refuse, without falling

- **The signal is the time events wait in the queue**, not its length or CPU
  usage. Events waiting more than 5 ms for 100 ms in a row (CoDel's classic
  values) mean the core is overloaded.
- **WebSocket**: stop reading the socket. TCP flow control slows the client;
  nothing is lost and memory does not grow.
- **HTTP**: refuse at once with 503 and `Retry-After`. Refusing costs far less
  than serving late.
- **RAM**: evict idle instances, oldest first. Recreating one takes
  microseconds.
- **If it lasts**: close the node to new placements, then move instances away
  (hibernate, copy the file, update the directory). The slow path, about a
  second per instance.

### No neural network in the loop

Queue wait, RAM and reservations are measured exactly, so there is nothing to
predict, and a model gives no guarantee precisely on the spikes it has never
seen. One model per machine also lacks data and cannot be diagnosed.
Prediction may advise, never command: tuning the over-reservation ratio,
pre-warming instances likely to wake, forecasting capacity to order. Start
with a moving average or last week's 99th percentile; a learned model, a single
global one, only after months of traces and a measured gap.

## Open questions

- Own code only, or third-party code too? The second adds Spectre hardening,
  billing and strict quotas.
- Thousands of small databases on one core each: LMDB or RocksDB?
- Does strict durability on a rented NVMe server match the campaign's numbers?
  Hourly billing at Latitude.sh makes this a few dollars to answer.
- Does DataPacket's GraphQL schema expose ordering and reinstalls?
- First step when the time comes: a single-node prototype (Wasmtime, HTTP,
  WebSocket, native SQLite) with a benchmark of each bridge.

## Sources

Prior art:
[Spin 4.1](https://spinframework.dev/blog/announcing-spin-4-1),
[WebSockets in WASI cloud](https://bytecodealliance.github.io/zulip-archive/stream/356481-wasi-cloud/topic/Websockets.html),
[Golem persistence](https://learn.golem.cloud/docs/operate/persistence),
[SpacetimeDB docs](https://spacetimedb.com/docs/llms.txt),
[Wasmer Edge volumes](https://docs.wasmer.io/edge/learn/volumes),
[Rivet and Durable Objects](https://rivet.dev/compare/rivet-vs-cloudflare-durable-objects/),
[Rivet architecture](https://rivet.dev/docs/general/architecture/).

Storage engines:
[Fjall 3](https://fjall-rs.github.io/post/fjall-3),
[unofficial Fjall note](https://edmondo-vault.pages.dev/2---Areas/Tech/Programming/Rust/Fjall),
[rust-storage-bench](https://github.com/marvin-j97/rust-storage-bench),
[libmdbx](https://libmdbx.dqdkfa.ru/intro.html),
[Speedb](https://github.com/speedb-io/speedb/discussions/271),
[SlateDB](https://dev.co/databases/open-source/slatedb).

Hosting:
[Latitude.sh pricing](https://www.latitude.sh/pricing),
[Latitude.sh locations](https://www.latitude.sh/locations),
[OVHcloud dedicated servers](https://us.ovhcloud.com/dedicated-servers/),
[OVHcloud Advance](https://us.ovhcloud.com/dedicated-servers/advance/),
[DataPacket servers](https://www.datapacket.com/dedicated-servers),
[DataPacket API](https://api.datapacket.com/),
[Hivelocity pricing](https://www.hivelocity.net/pricing),
[Hivelocity dedicated servers](https://www.hivelocity.net/dedicated-servers/),
[Hivelocity locations](https://www.hivelocity.net/amd-dedicated-servers/),
[Vultr bare metal, third party](https://googiehost.com/blog/best-bare-metal-servers/),
[Gcore bare metal](https://gcore.com/docs/cloud/bare-metal-servers/about-bare-metal-servers.md),
[Zenlayer bare metal](https://cloud.zenlayer.com/bmc),
[Leaseweb ordering API](https://kb.leaseweb.com/?p=13597),
[Equinix Metal closure](https://novoserve.com/equinix-metal-alternatives).
