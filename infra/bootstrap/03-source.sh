#!/usr/bin/env bash
set -euo pipefail
upstream=/opt/vibe-os/build/deepseek-harness
if ! test -d "$upstream/.git"; then
  runuser -u vibe-build -- git clone --filter=blob:none --no-checkout https://github.com/deepseek-ai/deepseek-harness.git "$upstream" > /var/log/vibe-os-build/harness-clone.log 2>&1
fi
runuser -u vibe-build -- git -C "$upstream" fetch origin 5badb15009ae1756c3afe0ae0cef1faafc290ccc >> /var/log/vibe-os-build/harness-clone.log 2>&1
runuser -u vibe-build -- git -C "$upstream" checkout --detach 5badb15009ae1756c3afe0ae0cef1faafc290ccc >> /var/log/vibe-os-build/harness-clone.log 2>&1
runuser -u vibe-build -- git -C "$upstream" rev-parse HEAD
nsjail=/opt/vibe-os/build/nsjail
if ! test -d "$nsjail/.git"; then
  runuser -u vibe-build -- git clone --recursive https://github.com/google/nsjail.git "$nsjail" > /var/log/vibe-os-build/nsjail-clone.log 2>&1
fi
runuser -u vibe-build -- git -C "$nsjail" fetch origin 4ff54a6e0d5b65a0e1633d6e2fd1425ba6c882ce
runuser -u vibe-build -- git -C "$nsjail" checkout --detach 4ff54a6e0d5b65a0e1633d6e2fd1425ba6c882ce
runuser -u vibe-build -- git -C "$nsjail" submodule update --init --recursive
runuser -u vibe-build -- git -C "$nsjail" rev-parse HEAD
