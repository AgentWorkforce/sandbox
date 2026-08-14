---
status: active
owner: relay-spawn-metadata-overnight-0813
reports_to: chief
updated: 2026-08-13
repos: [relay, cloud, relaycast-cloud]
---

## Goal

Make every live agent publish real, declared organization/project/workstream/
objective metadata at registration time, so the Cloud dashboard's org chart
(`/dashboard/chief`) can group agents by their actual workstream instead of
inferring structure from name-slug parsing.

**Why this exists (found 2026-08-13 ~20:00-21:00Z by `cloud-chief-display-stale-0813`
and `cloud-org-tree-stale-0813`):** zero of ~900+ live agents in the workspace
carry `organization`/`project`/`workstream`/`role`/`task` metadata. The
dashboard's org tree is built entirely by regexing `<project>-<workstream>-<role>`
out of agent names. Concretely: shipping "nested under workstream" tonight
would still render flat, because 852 of 893 name-slug-derived "workstreams"
hold exactly one agent each.

## Now

Two halves, split by where agents are created:

1. **Cloud persona-deploy half** (~19 of ~22 typically-online agents) —
   `lib/proactive-runtime/relaycast-agent-identity.ts` +
   `relaycast-identity-provider.ts` in `AgentWorkforce/cloud`. Owner tonight:
   `cloud-agent-metadata-write-0813` (offline mid-task, uncommitted work
   rescued to branch `feat/persona-deployment-objective` by
   `cloud-metadata-rescue-0813` — verify it actually pushed before assuming
   this half is safe). Design decided by Khaliq via chief (21:40Z): explicit
   `objective` field, authored at deploy time, falling back to the persona's
   static description when unset. Do not re-litigate this design without a
   reason found in code — it was a real decision, not a default.

2. **Relay fleet-spawn half** (agents spawned via `agent-relay fleet spawn` /
   the MCP spawn tool onto physical/sandbox nodes — everything spawned
   tonight, including whatever spawned you if you're reading this as the new
   Chief resident). Owner: `relay-spawn-metadata-overnight-0813`, dispatched
   on finn-mini 2026-08-13 22:07Z, working overnight unsupervised. Job: find
   the real fleet-spawn registration path (relay's `packages/fleet/src/serve-node.ts`
   + relaycast-cloud's receiving side — verify from source, prior investigation
   not fully trusted), decide how workstream/project/objective get declared
   (likely new params alongside the existing `task` param on the spawn call),
   wire it through to the same metadata keys `lib/fleet/agents.ts` (cloud)
   already parses. PR only, no merge/deploy authorized.

## Next

1. Check whether `relay-spawn-metadata-overnight-0813` made progress or hit
   a design fork it flagged for Khaliq — read its DMs to "chief" first.
2. Check whether `cloud-metadata-rescue-0813`'s push actually landed (branch
   `feat/persona-deployment-objective`) — it was rescued under time pressure
   and not independently verified before this session ended.
3. Once both halves have real PRs, review them the same way every PR got
   reviewed tonight (read the diff, don't trust the self-report), then this
   workstream's actual acceptance criterion: re-run the dashboard and confirm
   at least one real agent renders a declared (not inferred) workstream.
4. Only after this lands does "nest agents under their workstream" on
   `/dashboard/chief` become buildable as more than a flat list — see the
   "Cloud dashboard information architecture" entry in `memory/projects.md`
   for that follow-on UI work, owned separately by `cloud-org-tree-stale-0813`
   / `cloud-3016-ci-review-fix-0813`.

## History

### 2026-08-13
- Workstream opened by chief after `cloud-chief-display-stale-0813` and
  `cloud-org-tree-stale-0813` independently confirmed, from the live roster,
  that the metadata gap is a write-path problem (nothing publishes it), not
  a display gap. Split into two owners because the two agent-creation paths
  (persona-deploy vs. fleet-spawn) are different repos with different
  registration code. See `workstreams/relayhistory-continuity-proof.md`'s
  2026-08-13 20:14Z/20:00Z entries for the broader cloud-dashboard context
  this sits inside, and `memory/projects.md`'s "Cloud dashboard information
  architecture" entry for Khaliq's original ask.
