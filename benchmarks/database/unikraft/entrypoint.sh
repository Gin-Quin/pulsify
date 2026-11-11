#!/bin/sh
# Run every selected engine and durability tier one after the other, alone, on a
# fresh data directory. Database files live under /data (the volume, a real
# disk); reports are gzipped under /results and served over HTTP on port 8080.
#   BENCH_BACKENDS  space-separated engines     BENCH_TIERS  strict and/or relaxed
#   BENCH_LABEL     environment name in reports  BENCH_ARGS   extra runner arguments
set -u
backends="${BENCH_BACKENDS:-sqlite rocksdb lmdb postgres valkey dragonfly}"
tiers="${BENCH_TIERS:-strict relaxed}"
label="${BENCH_LABEL:-unikraft}"
results=/results
work=/data/work
mkdir -p "$results" /data
# A CPU-bound instance with no traffic would otherwise be put on standby.
[ -w /uk/libukp/scale_to_zero_disable ] && echo + >/uk/libukp/scale_to_zero_disable
busybox httpd -p 8080 -h "$results"
{
	uname -a
	echo "cpus: $(nproc)"
	grep -E 'MemTotal|MemAvailable' /proc/meminfo
	echo "open files: $(ulimit -n)"
	df -k / /data
	grep -E ' (/|/data) ' /proc/mounts
} >"$results/environment.txt" 2>&1
cat "$results/environment.txt"

server=
stop_server() {
	[ -n "$server" ] || return 0
	kill -INT "$server" 2>/dev/null
	wait "$server" 2>/dev/null
	server=
}
wait_for() { # command that succeeds once the server answers
	i=0
	until "$@" >/dev/null 2>&1; do
		i=$((i + 1))
		if [ "$i" -gt 600 ] || ! kill -0 "$server" 2>/dev/null; then
			echo "bench: server did not start" >&2
			return 1
		fi
		sleep 0.1
	done
}
start_server() { # backend tier
	case "$1" in
	postgres)
		export PGDATA="$work/postgres" POSTGRES_PASSWORD=pulsify-benchmark
		docker-entrypoint.sh postgres -c listen_addresses=127.0.0.1 \
			-c max_connections=180 -c shared_buffers=128MB -c max_wal_size=128MB \
			-c min_wal_size=32MB -c checkpoint_timeout=60s >"$results/$label-$2-$1-server.log" 2>&1 &
		server=$!
		# initdb runs a temporary server first; wait for the final one on TCP.
		wait_for pg_isready -q -h 127.0.0.1 -U postgres
		;;
	valkey)
		fsync=always
		[ "$2" = relaxed ] && fsync=everysec
		valkey-server --dir "$work" --bind 127.0.0.1 --appendonly yes --appendfsync "$fsync" \
			--save "" >"$results/$label-$2-$1-server.log" 2>&1 &
		server=$!
		wait_for valkey-cli ping
		;;
	dragonfly)
		dragonfly --logtostderr --dir "$work" --bind 127.0.0.1 --aof \
			>"$results/$label-$2-$1-server.log" 2>&1 &
		server=$!
		if ! wait_for valkey-cli ping; then
			# The append-only file needs io_uring. Without it Dragonfly only
			# persists by snapshot: say so next to the numbers.
			echo "append-only file unavailable (no io_uring): snapshot persistence only" \
				>"$results/$label-$2-$1-persistence.txt"
			dragonfly --logtostderr --dir "$work" --bind 127.0.0.1 \
				>>"$results/$label-$2-$1-server.log" 2>&1 &
			server=$!
			wait_for valkey-cli ping
		fi
		;;
	esac
}

for tier in $tiers; do
	for backend in $backends; do
		# Dragonfly cannot flush before replying: relaxed tier only.
		[ "$backend" = dragonfly ] && [ "$tier" = strict ] && continue
		name="$label-$tier-$backend"
		rm -rf "$work"
		mkdir -p "$work"
		chmod 777 "$work"
		echo "bench: starting $name"
		if start_server "$backend" "$tier"; then
			# shellcheck disable=SC2086
			pulsify-db-bench --backend "$backend" --environment "$label" --durability "$tier" \
				--fixture /fixture.json --output "$results/$name.json" \
				--postgres-url "postgresql://postgres:pulsify-benchmark@127.0.0.1/postgres" \
				--sqlite-path "$work/native.sqlite" --data-path "$work/$backend" \
				--server-url redis://127.0.0.1:6379 ${BENCH_ARGS:-} 2>&1 | tee "$results/$name.log"
		else
			echo "server did not start" >"$results/$name.log"
		fi
		stop_server
		df -k /data | tail -1 >>"$results/$name.log"
		[ -f "$results/$name.json" ] && gzip -f "$results/$name.json"
		echo "bench: finished $name"
	done
done
rm -rf "$work"
ls -la "$results" >"$results/DONE"
echo "bench: all done"
# Stay up so the reports can be fetched.
while :; do sleep 3600; done
