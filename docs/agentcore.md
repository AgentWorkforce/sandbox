# AWS Bedrock AgentCore Code Interpreter adapter

Evidence discipline used throughout this document, carried over from the
Vercel and Modal adapters:

- **OBSERVED** — measured by this repository against the live API, with the
  run that produced it named.
- **DOCUMENTED** — stated by AWS's own docs, API reference, or SDK types.
- **INFERRED** — reasoned from the two above. Never treated as measurement.

**Status at time of writing: no rung above DOCUMENTED.** This adapter has not
yet been run against a live AWS account — see [Credential status](#credential-status).
Every capability cell in `capabilities.ts` and every number in
[Live benchmark](#live-benchmark) is a placeholder for evidence, not evidence.

## Configuration and ownership

Install the exact peers this adapter was built against:

```bash
npm install @aws-sdk/client-bedrock-agentcore@3.1115.0 @aws-sdk/client-bedrock-agentcore-control@3.1115.0
```

`AgentCoreSandboxRuntime` takes explicit `credentials`, `region`,
`interpreter`, and `defaultHomeDir`. Credentials are never read from ambient
process state implicitly (DOCUMENTED design choice, matching the Vercel and
Modal adapters) — a caller picks exactly one of:

- `{ type: "static", accessKeyId, secretAccessKey, sessionToken? }` — IAM user
  keys, or STS/SSO temporary credentials with `sessionToken`.
- `{ type: "default-chain" }` — an explicit, named opt-in to the AWS SDK's own
  credential resolution (env vars, shared config file, an EC2/ECS/Lambda
  role, an SSO cache). This is the standard way to run under an assumed IAM
  role and is common enough in AWS-native deployments to support directly,
  but the adapter never reaches it silently — the caller names it, exactly
  like every other field.

### Identity: session vs. code interpreter

AWS splits this API into two resources this adapter deliberately keeps
distinct:

- A **code interpreter** (control plane, `bedrock-agentcore-control`) is a
  named, account-scoped *environment definition* — execution role, network
  mode, VPC config. It is closer to a Vercel `image` or a Modal `App` than to
  a sandbox instance.
- A **session** (data plane, `bedrock-agentcore`) is the ephemeral, billable
  unit started against a code interpreter, bounded by `sessionTimeoutSeconds`
  (DOCUMENTED default 900s / 15 min, max 28,800s / 8h).

`RuntimeHandle.id` carries the **session id**. `AgentCoreSandboxRuntime`
resolves (and, for an `owned` interpreter source, lazily creates) one code
interpreter per instance and reuses it across every `launch()` call —
`destroy()` stops a session, it does not delete the shared interpreter. Call
`deleteOwnedCodeInterpreter()` explicitly once every session against it is
done; this is intentionally not part of `SandboxRuntime`/`WorkflowRuntime`
for the same reason a provider's shared image type is not deleted per handle
elsewhere in this package.

### Label lookup has no server-side home

`StartCodeInterpreterSession` accepts only a non-unique `name` string
(DOCUMENTED, API reference) — there is no tags/labels field on a session,
unlike the code interpreter resource itself. `findAllByLabels` therefore
searches only this runtime instance's own in-process registrations: real
within one process, empty in every other one, the same "degrades to `[]`"
shape the Vercel adapter's docs describe for providers without real
server-side label search. `warmLease` is declared **false**, structurally —
see `capabilities.ts`.

### Reattachment

`getById` calls `GetCodeInterpreterSession(codeInterpreterIdentifier,
sessionId)`, which re-resolves a still-`READY` session from a bare id,
including across a process restart — as long as the caller's runtime config
resolves to the same code interpreter (fixed deterministically by
`AgentCoreInterpreterSource.name` for an `owned` source). Unlike Vercel's
`Sandbox.get`, this has no resume side effect to worry about: `GetSession` is
a pure read.

## Network mode: VPC is the default, SANDBOX requires an explicit, warned opt-in

**This is the load-bearing security decision in this adapter, and it is not
negotiable behind a config default.**

In March 2026, BeyondTrust's Phantom Labs publicly disclosed that
AgentCore's `SANDBOX` network mode — despite blocking general internet
traffic — still permits outbound DNS A/AAAA record queries. That residual DNS
path was sufficient to build a complete covert command-and-control and
data-exfiltration channel: commands delivered via DNS A-record responses
(IP octets encoding base64 command chunks), output exfiltrated via
DNS-subdomain queries to an attacker-controlled nameserver. Unit 42 and the
Cloud Security Alliance corroborated the finding independently. AWS's
response was not a platform-level fix to `SANDBOX` mode; it updated
documentation to state that `SANDBOX` mode permits DNS resolution and to
recommend `VPC` mode plus a Route 53 Resolver DNS Firewall for customers who
need real network isolation. ([BeyondTrust](https://www.beyondtrust.com/blog/entry/pwning-aws-agentcore-code-interpreter),
[Unit 42](https://unit42.paloaltonetworks.com/bypass-of-aws-sandbox-network-isolation-mode/),
[Cloud Security Alliance](https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-sandbox-dns-exfiltration-bedrock-langsm/).)

`AgentCoreNetworkConfig` (`config.ts`) encodes AWS's own recommendation as a
type-level default: omitting `mode` (or omitting `network` structure
entirely down to just `{ vpc: {...} }`) resolves to `"VPC"` and *requires*
`vpc.subnetIds` / `vpc.securityGroupIds` — there is no safe subnet or
security group to invent, so construction fails loudly rather than picking
one. Reaching `SANDBOX` — or `PUBLIC` — requires the caller to spell out
`mode` explicitly. Choosing `SANDBOX` additionally logs a `console.warn`
naming the DNS-exfiltration hazard and AWS's own mitigation at construction
time, every time, so it cannot be opted into silently by a config file nobody
re-reads.

`PUBLIC` mode is not specifically warned: it is intentionally
full-internet-access and carries a different, well-understood risk profile
than a "sandboxed" mode that turns out not to be one.

## S3 integration (large files, 100 MB inline / 5 GB via S3)

The 100 MB inline-upload limit and 5 GB S3 path are DOCUMENTED
(AWS Code Interpreter overview). The S3 path is **not** a distinct API
operation — it is `executeCommand` running `aws s3 cp` inside the session,
which only works when the code interpreter's `executionRoleArn` grants
`s3:GetObject`/`s3:PutObject` on the target bucket/prefix and trusts
`bedrock-agentcore.amazonaws.com` to assume it (DOCUMENTED, S3 integration
guide). This adapter plumbs `executionRoleArn` through to
`CreateCodeInterpreter` (`AgentCoreInterpreterSource.executionRoleArn`) but
does **not** provision the role itself — same division of responsibility as
`namePrefix` on other adapters. **Provisioning that IAM role is a Khaliq
action item** if the S3 path is needed; see
[Credential status](#credential-status).

## Exec, files, and deadlines

`executeCommand` takes a bare `command` string with no `cwd`/`env` fields of
its own (DOCUMENTED — absent from every AWS example, including the S3
integration sample). Both are folded into the command text: `cd` for the
working directory, `export` for each variable, every value single-quoted so
no caller-supplied value is ever interpreted as shell syntax.

`writeFiles` documents only a `text` content field, not a binary one
(DOCUMENTED, file-operations guide sample). Buffer uploads — and any string
source whose first 8 KB contains a NUL byte — are shipped as a base64
sidecar file and decoded in-session with `python3` (a guaranteed-present
runtime), rather than assuming an unconfirmed binary content type on the
vendor API. Downloads go through `executeCommand` (`base64 <path>`) rather
than the inferred `readFiles` action, for the same reason: this sidesteps an
unconfirmed binary-safety question in the vendor response schema entirely,
at the cost of a slightly larger request/response for big files.

AWS SDK v3 clients accept a per-call `abortSignal` on `.send()`, so unlike
the Vercel adapter's fetch-wrapping trick, deadlines here are passed straight
through to each command — no `AsyncLocalStorage` needed. Every remote
operation still gets its own explicit deadline (create-interpreter, launch,
lookup, exec, file, destroy), and a composite operation (e.g. `destroy`'s
stop-then-verify-terminated poll) shares **one** `Deadline` budget across all
of its round trips, for the same reason the Vercel adapter's docs give: a
fresh timeout per round trip lets a caller who asked for N seconds wait a
multiple of N.

The vendor boundary (`internal/sdk.ts`) is a checked assignment, not a cast,
matching the pattern `vercel-adapter-0821` and `modal-adapter-0821` both
adopted: each SDK result is assigned through the structural `*Like`
interface, so a vendor signature change breaks the build in the one file
that owns the boundary instead of surfacing later as a runtime failure
against a live session.

## Lifecycle: no stop/start, structurally

`GetCodeInterpreterSession.status` is documented as `READY | TERMINATED`
only — there is no resumable stopped state. `StopCodeInterpreterSession` is
a terminal transition with no corresponding start/resume call. This is
exactly the shape the Modal adapter's `lifecycle: false` already documents
for `Sandbox.terminate()`, and this adapter makes the same choice for the
same reason: `start`/`stop` are omitted from the class entirely rather than
shipping a `stop` that cannot be undone under a name implying it can.
`destroy()` is the only teardown path, and it stops the session and
verifies `TERMINATED` before forgetting the local registration — retaining
the registration on verification failure so cleanup can be retried, the same
discipline `VercelDestroyVerificationError` documents.

## Credential status

**No AWS credentials or IAM role are configured in the environment this
adapter was built in** (no `~/.aws/` directory, no `AWS_ACCESS_KEY_ID` /
`AWS_PROFILE` in the shell, `aws sts get-caller-identity` does not return).
This is a blocker for every live-verification item below, reported per the
"blocked-lane-reports-fast" rule rather than assumed away.

What's needed, exactly, to unblock:

1. Either `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`
   if temporary) for a principal with the `bedrock-agentcore*` actions listed
   below, **or** confirmation that an assumable-role default credential chain
   is already configured and reachable from this environment.
2. `AWS_REGION` (or an explicit region passed to the runtime).
3. An IAM execution role ARN, with a trust policy allowing
   `bedrock-agentcore.amazonaws.com` to assume it, for any live test that
   exercises the S3 large-file path or otherwise needs the code interpreter
   to reach other AWS services.
4. For a `VPC`-mode live canary specifically: at least one subnet id and one
   security group id in the target account/region — `VPC` mode is this
   adapter's default and the mode the canary should exercise first.

Minimum IAM policy (DOCUMENTED, resource-and-session-management guide):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "bedrock-agentcore:CreateCodeInterpreter",
      "bedrock-agentcore:StartCodeInterpreterSession",
      "bedrock-agentcore:InvokeCodeInterpreter",
      "bedrock-agentcore:StopCodeInterpreterSession",
      "bedrock-agentcore:DeleteCodeInterpreter",
      "bedrock-agentcore:ListCodeInterpreters",
      "bedrock-agentcore:GetCodeInterpreter",
      "bedrock-agentcore:GetCodeInterpreterSession",
      "bedrock-agentcore:ListCodeInterpreterSessions"
    ],
    "Resource": "arn:aws:bedrock-agentcore:<region>:<account-id>:code-interpreter/*"
  }]
}
```

Until this is resolved, this PR ships with mocked/contract tests only. No
number in this document past this line is a measurement.

## Live benchmark

**Not yet run — blocked on [Credential status](#credential-status).** The
harness (`bench.ts`, unit-tested against a fake runtime in `bench.test.ts`)
is ready to execute an n=1 canary and n=7 full bench the moment credentials
land. Planned measurements, unchanged from the charter:

- Cold create p50/p95 (interpreter resolution + session start).
- Ready + first-exec latency.
- **Idle-billing measurement.** AWS's pricing page states active-consumption
  billing with I/O wait and idle time free, but does not say whether that
  extends to session *memory* or only CPU. `runIdleHoldCanary` holds one
  session idle for a configurable window (charter: 5 minutes) and destroys
  it, but — important limitation to state up front — **it cannot itself
  produce a confirmed dollar figure**: AWS Cost Explorer / Cost and Usage
  Report data typically lands with several hours to a day of latency, well
  outside any single benchmark run. What the canary produces instead is a
  correlation key (session id + start/end timestamps) for a follow-up Cost
  Explorer query filtered to that window, run the next day. This two-step
  protocol — live canary now, cost read-back later — is the honest way to
  answer this question; a same-run "confirmed" idle-billing number would be
  fabricated.
- Concurrency ceiling, checked against the account's actual AgentCore
  service quotas *before* bursting (never burst-until-throttle blind).
- Cleanup discipline: `destroyed` vs. `verifiedGone` counts from the n=7 run.
- Delivered shape vs. requested (region, network mode actually applied).
- Cost projection: published rates cross-checked against measured
  cold-create + exec + idle-hold timings.

## CloudTrail / audit observability

DOCUMENTED at a shape level, not yet OBSERVED: the Code Interpreter overview
states the tool provides "CloudTrail logging capabilities," and every
`bedrock-agentcore*` / `bedrock-agentcore-control*` API call is a standard
AWS API call, so standard CloudTrail semantics apply — `eventSource:
bedrock-agentcore.amazonaws.com` / `bedrock-agentcore-control.amazonaws.com`,
request/response parameters, `requestID`, `sourceIPAddress`, `userIdentity`,
retention governed by the account's trail configuration (90-day CloudTrail
Event History by default; unlimited via an S3-backed trail). This is
analogous to the audit-api surface `cloud-daytona-transitions-0821` is
consuming for Daytona — exact field-level shape is a live-verification item
once credentials land, not something to assert from the docs alone.

## Regional availability

Not yet enumerated against the live `bedrock-agentcore` service; the AWS
examples default every snippet to a `<Region>` placeholder rather than
listing supported regions, so this is deferred to the live-verification pass
rather than guessed here.

## Capability status

| Capability | Declared | Basis |
| --- | --- | --- |
| `asyncExec` | false | No submit-then-poll pair in the AgentCore API; `InvokeCodeInterpreter` is one synchronous call per action. |
| `reattach` | true | `getById` over `GetCodeInterpreterSession`. |
| `detachedLaunch` | false | `StartCodeInterpreterSession` resolves only once the session exists; no mid-boot handle to hand back. |
| `warmLease` | false, structural | No tags/labels field on a session (DOCUMENTED, API reference) — not pending, there is nothing to promote. |
| `lifecycle` | false, structural | `status` is `READY \| TERMINATED` only; no resumable stopped state (DOCUMENTED). |

Bootstrap-plane (`RuntimeCapabilities`): `pty: false`, `snapshots: false`,
`isolation: "strong"`, `persistentHandle: true`, `streamingLogs: false` (the
provider genuinely streams `InvokeCodeInterpreter` events server-side; this
port buffers to a single `RunScriptResult`, same distinction the Modal
adapter draws for `Command.logs()`).

All `AgentCoreObservedCapabilities` cells — including
`idleMemoryBillingConfirmedFree`, the load-bearing economics question this
adapter exists partly to answer — start `false` and are promoted only in a
commit that also records the dated live evidence, never from API-doc shape.

## References

- [Code Interpreter tool overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html)
- [Resource and session management / IAM permissions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-resource-session-management.html)
- [S3 integration via execution role](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-s3-integration.html)
- [File operations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-file-operations.html)
- [`CreateCodeInterpreter` API reference](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateCodeInterpreter.html)
- [`StartCodeInterpreterSession` API reference](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_StartCodeInterpreterSession.html)
- [`GetCodeInterpreterSession` API reference](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_GetCodeInterpreterSession.html)
- [BeyondTrust: Pwning AI Code Interpreters in AWS Bedrock AgentCore](https://www.beyondtrust.com/blog/entry/pwning-aws-agentcore-code-interpreter)
- [Unit 42: Cracks in the Bedrock — Escaping the AWS AgentCore Sandbox](https://unit42.paloaltonetworks.com/bypass-of-aws-sandbox-network-isolation-mode/)
- [Cloud Security Alliance: AI Sandbox DNS Exfiltration research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-sandbox-dns-exfiltration-bedrock-langsm/)
