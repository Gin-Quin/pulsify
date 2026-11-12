#!/bin/sh
# Prepare a dedicated Ubuntu 24.04 x86-64 server for the database campaign, as
# root: toolchain, PostgreSQL, an empty disk mounted on /data, a steady CPU.
#   setup.sh DATA_DEVICE     an unused disk such as /dev/nvme1n1; it is formatted
set -eu
device="$1"
owner="${SUDO_USER:-root}"
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -y -q build-essential cmake clang libclang-dev pkg-config curl \
	ca-certificates nvme-cli rsync unzip postgresql-common
# PostgreSQL from its own repository, without the default cluster the package
# would create and start: the campaign runs its own under /data.
/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sed -i 's/^#\?create_main_cluster.*/create_main_cluster = false/' \
	/etc/postgresql-common/createcluster.conf
apt-get install -y -q "postgresql-${POSTGRES_MAJOR:-18}"

if ! mountpoint -q /data; then
	[ -z "$(lsblk -no MOUNTPOINT "$device" | tr -d '[:space:]')" ] ||
		{ echo "setup: $device is in use" >&2; exit 1; }
	mkfs.ext4 -q -F "$device"
	mkdir -p /data
	mount -o noatime "$device" /data
fi
chown "$owner" /data

# One thread per core, and no frequency scaling between two cells.
echo off >/sys/devices/system/cpu/smt/control
for governor in /sys/devices/system/cpu/cpufreq/policy*/scaling_governor; do
	echo performance >"$governor" 2>/dev/null || true # an offline thread refuses
done

su - "$owner" -c '[ -x ~/.cargo/bin/cargo ] ||
	curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal -q
[ -x ~/.bun/bin/bun ] || curl -fsSL https://bun.sh/install | bash'
echo "setup: done"
