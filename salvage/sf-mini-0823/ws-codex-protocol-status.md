# ws-codex Protocol Investigation Status

**Date:** 2026-08-23
**Status:** BLOCKED

## BLOCKED: Contract file missing

The required input file `/tmp/ws-codex-protocol-contract.md` does not exist on this system.

### Evidence
- `find /tmp -maxdepth 1 -name 'ws-codex*'` — no matches
- `find /tmp -maxdepth 1 -name '*.md'` — no markdown files in /tmp
- Full directory listing of `/tmp/` shows no file with "ws-codex" or "protocol" in its name
- The closest files are:
  - `/tmp/migration-spec.md` (26KB, unrelated content)
  - `/tmp/daytona-doc.md` (37KB, unrelated content)

### Distinction
- **Observed:** `/tmp/ws-codex-protocol-contract.md` is absent from the filesystem
- **Schema-proven:** N/A — cannot evaluate without contract
- **Unproven:** N/A

### Resolution required
The contract file must be provided before the read-only investigation can proceed. This is a true blocker — no investigation can be conducted without the specification.

## REVIEW — abx-protocol-review

**Verdict: ACCEPT**

### Independent verification (re-ran, did not rely on oc's search)
- `ls -la /tmp/ws-codex-*` returns only this status file — no contract file.
- `find /tmp -maxdepth 2 -iname '*contract*'` — 0 hits.
- `find /tmp -maxdepth 2 -iname '*codex*'` — 0 hits.
- Full `ls -la /tmp/` inspected: no ws-codex-* other than the status file, no *.md matching the contract name.

The oc's observed claim ("contract file is absent from /tmp") is reproduced. The BLOCKED prefix is warranted and the observed/schema-proven/unproven distinction is used correctly (schema-proven and unproven are N/A because the contract itself is what a schema-proven line would cite).

### Corrections (informational, not blocking)
The oc's status is minimal but not wrong. Two additions would strengthen it without changing the verdict:

1. **The installed side of the comparison exists on this host and can be captured deterministically once the contract arrives.** Observable now:
   - `codex --version` → `codex-cli 0.144.4` at `/opt/homebrew/bin/codex`.
   - `codex app-server` subcommand exists (marked experimental) with children `daemon`, `proxy`, `generate-ts`, `generate-json-schema`. The last two are the objective machine-readable snapshot of the installed protocol.
   - `codex exec-server` subcommand exists (marked EXPERIMENTAL) — the standalone service the audit is meant to check.
   Recording this preface would let the requester see that only the contract is missing; the audit target is present and ready.

2. **The audit target of "#3121" is ambiguous without the contract.** #3121 could refer to `openai/codex#3121` (matches the "Codex app-server/exec-server protocol" framing), or to `AgentWorkforce/cloud#3121` (which the paired reviewer agentbox-review-codex-0823 is auditing as the live-session-migration design doc). The contract file was presumably the disambiguator. This ambiguity should be noted so the requester can also supply the repo when they resend the contract.

Neither addition changes the conclusion: without the contract there is no expected-behavior baseline to compare the installed protocol or #3121 against, and "we dumped the installed schema" is data collection, not an audit. ACCEPT the BLOCKED call.

### What is needed to unblock
Supply `/tmp/ws-codex-protocol-contract.md` and, ideally, the fully qualified repo for #3121. Once present, both reviewers can proceed against a real baseline.
