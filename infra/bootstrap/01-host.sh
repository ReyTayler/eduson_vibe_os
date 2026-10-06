#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l
install -d -m 0755 /var/log/vibe-os-build
python3 /root/vibe-os-bootstrap/preflight.py > /var/log/vibe-os-build/preflight-before.json
apt-get update > /var/log/vibe-os-build/apt-update.log 2>&1
apt-get -y -o Dpkg::Options::=--force-confold full-upgrade > /var/log/vibe-os-build/apt-upgrade.log 2>&1
apt-get install -y ca-certificates curl git build-essential musl-tools python3 python3-venv libprotobuf-dev protobuf-compiler libnl-route-3-dev flex bison pkg-config libseccomp-dev xfsprogs nftables nginx jq unzip > /var/log/vibe-os-build/apt-build-deps.log 2>&1
if ! id vibe-build >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash vibe-build
fi
install -d -m 0755 /opt/vibe-os /opt/vibe-os/toolchain /opt/vibe-os/releases
install -d -o vibe-build -g vibe-build -m 0750 /opt/vibe-os/build
printf '%s\n' 'HOST_PACKAGES_READY'
uname -r
systemd --version
if test -e /var/run/reboot-required; then
  cat /var/run/reboot-required
fi
