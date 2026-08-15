#!/bin/bash
# Re-spawn the rostered residents from teams.json after a node restart.
# The fleet nodes run with --no-spawn, so residents do NOT return on their own.
# Usage: ./restore-residents.sh <node>        e.g. ./restore-residents.sh chief-broker
set -uo pipefail
NODE="${1:?usage: restore-residents.sh <node>}"
cd "$(dirname "$0")"
python3 - "$NODE" <<'PY'
import json, subprocess, sys, time
node = sys.argv[1]
teams = json.load(open('teams.json'))
for a in teams.get('agents', []):
    name = a.get('name')
    task = a.get('task') or a.get('brief') or a.get('objective') or ''
    if not name or not task:
        print(f"  SKIP {name}: no task in roster"); continue
    r = subprocess.run(["agent-relay","fleet","spawn", a.get('cli','claude'),
                        "--name", name, "--node", node, "--task", task],
                       capture_output=True, text=True, timeout=180)
    status = "?"
    try:
        status = (json.loads(r.stdout).get("invocation") or {}).get("status", "?")
    except Exception:
        pass
    print(f"  spawn {name} -> rc={r.returncode} status={status}")
    time.sleep(3)
print("  NOTE: spawns take ~30-60s to appear. Verify with:")
print(f"    ssh {node} 'ps -ax | grep \"[a]gent-relay-broker pty\" | grep -o \"--agent-name [a-z0-9-]*\"'")
PY
