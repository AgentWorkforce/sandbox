# Gmail delegated-credential verification — 2026-08-10

## Verdict

The original check exited 1 because `relayfile status rw_7ccfea89` selected an
expired narrow read-scope credential, then attempted its Cloud re-mint fallback
through `AGENT_RELAY_BIN=/Users/khaliqgant/.local/bin/agent-relay-broker`.
That override is the broker binary, not the installed `agent-relay` CLI.

The Gmail-capable full-scope delegated credential for the same workspace **is
valid and correctly scoped**: Relayfile Cloud accepted it and returned HTTP 200
from the status endpoint. The narrow credential selected by `status` **is not
valid**: the same endpoint explicitly returned HTTP 401 `Token has expired`.

Therefore the prior blanket diagnosis — “delegated credentials are
expired/revoked and `agent-relay` is outdated” — was materially wrong. One
per-scope cache entry is expired; a separate same-workspace credential with the
read/write/ops/sync scopes needed by Gmail is live. The installed CLI is new
enough. The operational blocker is stale per-scope credential selection plus a
wrong `AGENT_RELAY_BIN` override.

No credential value appears in this report.

## Original check — READ from the lane transcript

Source session:

`/Users/khaliqgant/.codex/sessions/2026/08/10/rollout-2026-08-10T15-35-19-019febe2-885f-7fa2-850a-65335484b5a2.jsonl`

Original agent: `gmail-500-probe-0810`

Timestamp: `2026-08-10T14:08:38.355Z`

Command, verbatim:

```console
relayfile status rw_7ccfea89
```

Working directory, verbatim:

```text
/tmp/gmail-500-probe.XUk5fD/relayfile
```

Output, verbatim:

```text
error: refresh delegated relayfile credentials: delegated relayfile credentials expired or revoked. Re-bootstrap relayfile credentials with agent-relay cloud login.; cloud re-mint fallback failed: agent-relay CLI >= 8.7.0 required with `agent-relay cloud session --help`; run `npm install -g agent-relay@8.7.0` or update the sandbox image (error: unrecognized subcommand 'cloud'

Usage: agent-relay-broker <COMMAND>

For more information, try '--help'.)
```

Exit code: `1`.

## Exact rerun — RAN

The same command was rerun from the same working directory. It reproduced the
same output and exit code. The selected credential file was hashed before and
after; it was unchanged.

```text
error: refresh delegated relayfile credentials: delegated relayfile credentials expired or revoked. Re-bootstrap relayfile credentials with agent-relay cloud login.; cloud re-mint fallback failed: agent-relay CLI >= 8.7.0 required with `agent-relay cloud session --help`; run `npm install -g agent-relay@8.7.0` or update the sandbox image (error: unrecognized subcommand 'cloud'

Usage: agent-relay-broker <COMMAND>

For more information, try '--help'.)
EXIT_CODE=1
CREDENTIAL_FILE_UNCHANGED=yes
```

## Authentication discrimination — RAN

### Negative receipt: credential selected by `status`

The narrow credential is bound to workspace `rw_7ccfea89` and scope
`relayfile:fs:read:*`. Its recorded access expiry is
`2026-08-07T22:30:39Z`; its refresh expiry is
`2026-08-08T21:30:39Z`.

A direct read-only GET presented that stored bearer to the exact status
endpoint. The value was never printed:

```text
{"code":"unauthorized","message":"Token has expired","correlationId":"gmail-creds-verify-stale-read-20260810-1836z"}curl: (22) The requested URL returned error: 401

HTTP_STATUS=401
```

This is a server refusal and proves category 1 for this per-scope credential.
The response is not a 403 and does not name a workspace, path, or permission
mismatch.

### Positive receipt: Gmail-capable full-scope credential

The separate credential for the same workspace carried these effective scopes:

```text
relayfile:fs:read:*
relayfile:fs:write:*
relayfile:ops:read:*
relayfile:sync:read:*
relayfile:sync:trigger:*
```

Its recorded access expiry was `2026-08-10T19:26:04Z`; its refresh expiry was
`2026-08-11T18:26:04Z`. A direct read-only GET presented this bearer to the
same endpoint, with the value never printed. Curl exited 0 and the server
returned:

```text
HTTP_STATUS=200
workspaceId=rw_7ccfea89
providers=github:healthy,google-mail:error,linear:healthy,notion:lagging,slack:lagging,telegram:healthy
```

The actual HTTP response body began with:

```text
{"workspaceId":"rw_7ccfea89","providers":[{"provider":"github","status":"healthy"},{"provider":"google-mail","status":"error"}
```

The body continued with the other provider status records. The 200 response
proves this credential is accepted, bound to the intended workspace, and
authorized for the read operation. It rules out categories 1 and 3 for the
Gmail-capable credential.

## CLI/version discrimination — RAN and READ

Installed executable and version:

```text
$ command -v agent-relay
/Users/khaliqgant/.local/share/mise/installs/node/22.22.2/bin/agent-relay
$ agent-relay --version
11.4.2
```

The installed Relayfile package reports version `0.10.39`; its platform binary
reports VCS revision
`32852268f8d8cb99aaaea0cdc508088f041767aa`. The source at that revision
requires `agent-relay >= 8.7.0` and these three installed-binary help probes:

```text
agent-relay cloud session --help       exit 0
agent-relay workspace active --help    exit 0
agent-relay workspace switch --help    exit 0
```

All three succeeded. Installed `agent-relay` 11.4.2 satisfies the operation.

The environment, however, contains:

```text
AGENT_RELAY_BIN=/Users/khaliqgant/.local/bin/agent-relay-broker
```

Relayfile honors that override before PATH. The selected binary identifies as
`agent-relay-broker 11.4.2` and cannot execute the required command:

```text
$ /Users/khaliqgant/.local/bin/agent-relay-broker cloud session --help
error: unrecognized subcommand 'cloud'

Usage: agent-relay-broker <COMMAND>

For more information, try '--help'.
```

Exit code: `2`.

This is category 4: a wrong executable override. It is not category 2; the
installed CLI is not too old.

## Classification

1. Selected narrow read-only cache entry: **genuinely expired**, with a live
   HTTP 401 refusal.
2. Installed CLI too old: **ruled out**; 11.4.2 exceeds the 8.7.0 requirement
   and passes every required help probe.
3. Gmail-capable credential scoped wrongly: **ruled out**; same-workspace GET
   returned HTTP 200 and the credential carries read/write/ops/sync scopes.
4. Additional failure: **confirmed**; `AGENT_RELAY_BIN` points at
   `agent-relay-broker`, preventing Cloud re-mint fallback.

## Safety ledger

Performed: local file reads; installed-binary version/help reads; exact
read-only status rerun; two direct GET requests to the status endpoint.

Not performed: `relayfile pull`; login/logout; credential refresh; credential
mint, rotation, or persistence; workspace write; broker restart; checkout;
stash; merge.

The exact rerun reported `CREDENTIAL_FILE_UNCHANGED=yes`.
