#!/bin/sh
# Run one engine's whole matrix on a server prepared by setup.sh:
#   cores 1/4/8 × history 100/1,000/10,000 edits × strict/relaxed × 1/16/128 clients,
# six scenarios each, on one hot document. The database is created once and
# nothing is deleted from it: its size on disk is measured after the last cell.
#   campaign.sh ENGINE [RESULTS_DIR]     ENGINE: sqlite postgres rocksdb leveldb lmdb
# BENCH_CORES, BENCH_PROFILES, BENCH_TIERS, BENCH_CLIENTS, BENCH_REQUESTS and
# BENCH_SCENARIOS narrow or change the matrix.
set -eu
engine="$1"
results="${2:-/data/results}/$engine"
cores="${BENCH_CORES:-1 4 8}"
profiles="${BENCH_PROFILES:-edits-100 edits-1000 edits-10000}"
tiers="${BENCH_TIERS:-strict relaxed}"
clients="${BENCH_CLIENTS:-1,16,128}"
requests="${BENCH_REQUESTS:-2000}"
scenarios="${BENCH_SCENARIOS:-mixed,read_delta,read_full,write_patch,compact,write_full}"
# One memory budget for every engine that has a cache of its own.
cache_mib=16384

root=$(cd "$(dirname "$0")/../../.." && pwd)
PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$(ls -d /usr/lib/postgresql/*/bin | tail -1):$PATH"
bench="$root/crates/pulsify-db-bench/target/release/pulsify-db-bench"
fixtures=/data/fixtures
data="/data/$engine"
socket=/tmp
ulimit -n 65536

set_cores() { # keep the first $1 cores online; SMT is off, so one CPU is one core
	for cpu in /sys/devices/system/cpu/cpu[0-9]*; do
		id=${cpu##*cpu}
		[ "$id" -gt 0 ] || continue
		if [ "$id" -lt "$1" ]; then state=1; else state=0; fi
		echo "$state" | sudo tee "$cpu/online" >/dev/null 2>&1 || true
	done
	# A core that comes back gets the default frequency governor again.
	for governor in /sys/devices/system/cpu/cpufreq/policy*/scaling_governor; do
		echo performance | sudo tee "$governor" >/dev/null 2>&1 || true # offline ones refuse
	done
	[ "$(nproc)" -eq "$1" ] || { echo "campaign: wanted $1 cores, have $(nproc)" >&2; exit 1; }
}
stop_postgres() { [ "$engine" != postgres ] || pg_ctl -D "$data" -m fast -w stop >/dev/null 2>&1 || true; }
trap 'stop_postgres; set_cores 4096 2>/dev/null || true' EXIT

# A copy of the sources without their repository carries its commit in COMMIT.
BENCH_COMMIT=$(git -C "$root" rev-parse HEAD 2>/dev/null || cat "$root/COMMIT" 2>/dev/null || true)
export BENCH_COMMIT
mkdir -p "$results" "$fixtures"
# One compiler for every bundled engine; LevelDB only builds with Clang.
[ -x "$bench" ] || CC=clang CXX=clang++ cargo build --release --locked \
	--manifest-path "$root/crates/pulsify-db-bench/Cargo.toml"
for profile in $profiles; do
	[ -f "$fixtures/$profile-$requests.json" ] ||
		bun "$root/benchmarks/database/native-fixtures.ts" generate \
			"$fixtures/$profile-$requests.json" "$profile" 128 "$requests"
done
{
	date -u +%Y-%m-%dT%H:%M:%SZ
	uname -srm
	. /etc/os-release && echo "$PRETTY_NAME"
	lscpu | grep -E 'Model name|^CPU\(s\)|On-line|Off-line|Thread|L3'
	grep MemTotal /proc/meminfo
	lsblk -dno NAME,SIZE,MODEL
	grep ' /data ' /proc/mounts
	rustc --version
	bun --version
	postgres --version
	echo "commit $BENCH_COMMIT"
} >"$results/environment.txt" 2>&1

rm -rf "$data"
case "$engine" in
postgres)
	initdb -D "$data" -U bench --auth=trust --locale=C --encoding=UTF8 >/dev/null
	cat >>"$data/postgresql.conf" <<CONF
listen_addresses = ''
unix_socket_directories = '$socket'
max_connections = 200
shared_buffers = ${cache_mib}MB
effective_cache_size = 64GB
work_mem = 64MB
maintenance_work_mem = 1GB
wal_buffers = 64MB
max_wal_size = 32GB
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9
wal_compression = lz4
default_toast_compression = lz4
random_page_cost = 1.1
effective_io_concurrency = 200
jit = off
CONF
	pg_ctl -D "$data" -l "$results/server.log" -w start >/dev/null
	createdb -h "$socket" -U bench bench
	pg_ctl -D "$data" -m fast -w stop >/dev/null
	;;
sqlite) mkdir -p "$data" ;;
esac

for n in $cores; do
	set_cores "$n"
	for profile in $profiles; do
		for tier in $tiers; do
			name="$engine-${n}cpu-$profile-$tier"
			echo "campaign: $name $(date -u +%H:%M:%S)" | tee -a "$results/campaign.log"
			# The server shares the online cores with its clients, and restarts
			# here as an embedded engine reopens its files.
			[ "$engine" != postgres ] || pg_ctl -D "$data" -l "$results/server.log" -w start >/dev/null
			"$bench" --backend "$engine" --environment f4-metal-small \
				--fixture "$fixtures/$profile-$requests.json" --output "$results/$name.json" \
				--durability "$tier" --keep-data --no-events --cache-mib "$cache_mib" \
				--concurrency "$clients" --requests "$requests" --scenarios "$scenarios" \
				--topologies hot --modes saturation \
				--data-path "$data" --sqlite-path "$data/pulsify.sqlite" \
				--sqlite-mmap-bytes 274877906944 \
				--postgres-url "host=$socket user=bench dbname=bench" \
				2>>"$results/campaign.log" || echo "campaign: $name ended with errors" | tee -a "$results/campaign.log"
			if [ "$engine" = postgres ]; then
				psql -h "$socket" -U bench -Atc "SELECT pg_database_size('bench')" bench >"$results/database-bytes.txt"
				pg_ctl -D "$data" -m fast -w stop >/dev/null
			fi
			# Replay representative histories through Pulsify itself, then drop their frames.
			bun "$root/benchmarks/database/native-fixtures.ts" verify "$results/$name.json" | tee -a "$results/campaign.log"
			gzip -f "$results/$name.json"
		done
	done
done

sync
{
	printf '{"engine":"%s","bytes":%s,"allocatedBytes":%s' "$engine" \
		"$(du -sb "$data" | cut -f1)" "$(du -sB1 "$data" | cut -f1)"
	[ "$engine" != postgres ] || printf ',"databaseBytes":%s,"walBytes":%s' \
		"$(cat "$results/database-bytes.txt")" "$(du -sb "$data/pg_wal" | cut -f1)"
	printf '}\n'
} >"$results/size.json"
du -ab --max-depth=1 "$data" | sort -n | tail -40 >"$results/size-detail.txt"
echo "campaign: $engine done $(date -u +%H:%M:%S) $(cat "$results/size.json")" | tee -a "$results/campaign.log"
