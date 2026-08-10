# Evidence — 2026-08-10

Harvested before a planned fleet restart. Everything here previously existed only
in DM threads or session-scoped scratchpads under `/private/tmp/claude-501/…`,
which do not survive a restart.

## `relay-1449/`
The live cross-node attach measurement. 9/9 attach failures across three fleet
nodes x three modes, raw `.err` per run, plus `bracketed-sf-proof.txt` — a nonce
round-trip from a different physical host that brackets the failures, proving the
target was mid-execution when attach could not see it. `NEGATIVE-CONTROL.md` is
the write-up. This is the "before" half of the pair; the "after" half does not
exist yet.

## `steward/`
Two steward state files, written by the only two agents that persisted state to
disk rather than to DMs. **These were more current than Chief's own sweeps for
several hours.** They carry the four ways `search_messages` fails silently, the
stranded-report inventory, and corrections both stewards made to their own
reports. Read these first after any restart.

## `harvested-0810/`
Lane deliverables rescued from session scratchpads:
- `relay-1449-contract-trace.md` — hop-by-hop trace of `attach`, where the node
  concept must enter, and the view-safety finding.
- `relay-1449-options-costing.md` — three designs costed against NAT, Cloud
  dependence, mode-scoped credentials and size, with the verdict.
- `identity-do-vs-d1-design-note.md` — the cloud-identity D1 analysis.
- `pr-shepherd-DESIGN-event-driven.md` — the V2 event-driven design, including
  the activity-vs-state boundary and the three questions it refused to build
  without.

Scanned for live credential patterns before committing; the one match is a
documented `rk_live_…` placeholder in prose, not a value.
