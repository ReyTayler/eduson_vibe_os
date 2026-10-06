#!/usr/bin/env python3
"""Read-only inventory for a dedicated Vibe OS PoC server; Python 3.10+.

No package installation, disk formatting, firewall changes or environment dump.
A root-only namespace probe runs /bin/true in short-lived private namespaces.
This inventory is evidence for T0; it is not a passed security/load gate.
"""

import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path


def command(argv, timeout=10):
    executable = shutil.which(argv[0])
    if executable is None:
        return {"status": "missing", "tool": argv[0]}
    try:
        completed = subprocess.run(
            [executable, *argv[1:]], capture_output=True, text=True,
            timeout=timeout, check=False,
        )
        return {
            "status": "ok" if completed.returncode == 0 else "error",
            "exit_code": completed.returncode,
            "stdout": completed.stdout[:32768].strip(),
            "stderr": completed.stderr[:4096].strip(),
        }
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"status": "error", "error_type": type(error).__name__}


def read_text(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as source:
            return source.read(1024 * 1024)
    except OSError:
        return None


def main():
    if platform.system() != "Linux":
        print(json.dumps({"status": "unsupported_host", "required": "Linux"}))
        return 2

    release_text = read_text("/etc/os-release") or ""
    release = {}
    for line in release_text.splitlines():
        if "=" in line and not line.startswith("#"):
            key, value = line.split("=", 1)
            if key in {"ID", "VERSION_ID", "PRETTY_NAME"}:
                release[key] = value.strip('"')

    memory = read_text("/proc/meminfo") or ""
    matched = re.search(r"^MemTotal:\s+(\d+)\s+kB$", memory, re.MULTILINE)
    memory_mib = int(matched.group(1)) // 1024 if matched else None
    kernel = platform.release()
    config = read_text("/boot/config-" + kernel)
    required_config = [
        "CONFIG_CGROUPS", "CONFIG_MEMCG", "CONFIG_CGROUP_PIDS",
        "CONFIG_BLK_CGROUP", "CONFIG_NAMESPACES", "CONFIG_NET_NS",
        "CONFIG_PID_NS", "CONFIG_SECCOMP", "CONFIG_SECCOMP_FILTER",
        "CONFIG_XFS_FS", "CONFIG_XFS_QUOTA",
    ]
    config_values = {}
    for option in required_config:
        match = re.search(r"^" + option + r"=(.+)$", config or "", re.MULTILINE)
        config_values[option] = match.group(1) if match else "unknown"

    controllers_text = read_text("/sys/fs/cgroup/cgroup.controllers")
    controllers = sorted((controllers_text or "").split())
    tools = {
        name: shutil.which(name) is not None
        for name in ["git", "node", "pnpm", "python3", "go", "cc", "make",
                     "nsjail", "nft", "unshare", "xfs_quota", "mkfs.xfs"]
    }
    namespace_probe = {"status": "not_probed", "reason": "root_required"}
    if os.geteuid() == 0:
        namespace_probe = command([
            "unshare", "--mount", "--net", "--pid", "--fork", "--ipc", "--uts", "/bin/true",
        ])
    root_space = shutil.disk_usage("/")
    report = {
        "scope": "read-only preflight; no deployment or isolation gate passed",
        "os": release,
        "architecture": platform.machine(),
        "kernel": kernel,
        "effective_uid": os.geteuid(),
        "cpu_count": os.cpu_count(),
        "memory_mib": memory_mib,
        "root_disk_free_gib": round(root_space.free / (1024 ** 3), 2),
        "systemd": command(["systemd", "--version"]),
        "cgroup_mount": command(["findmnt", "-J", "-o", "SOURCE,TARGET,FSTYPE,OPTIONS", "/sys/fs/cgroup"]),
        "cgroup_v2_controllers": controllers,
        "required_controllers_missing": sorted(set(["cpu", "memory", "pids", "io"]) - set(controllers)),
        "block_devices": command(["lsblk", "-J", "-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT"]),
        "kernel_options": config_values,
        "tools_available": tools,
        "python": sys.version.split()[0],
        "node": command(["node", "--version"]),
        "namespace_probe": namespace_probe,
        "note": "Unknown kernel options require later verification; an existing device is not permission to format it.",
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
