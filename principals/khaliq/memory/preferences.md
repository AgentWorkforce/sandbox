# Preferences — how Khaliq works

- One interface: Khaliq talks to Chief; Chief coordinates the team.
- Linear is the human command plane. GitHub is the agent execution plane.
- Do not duplicate every agent task in Linear. Report useful checkpoints.
- Earn trust progressively: start visible, keep human gates, and recommend
  autonomy only after the same path works repeatedly.
- No automated merge. Khaliq owns the merge decision. **One scoped exception,
  granted 2026-08-06 in Khaliq's own words:** "also for the cloud dashboard
  updates you have permission to deploy after verifying that everything works
  fully 100%". It covers the verified production Cloud dashboard changes on
  `cloud-worktrees/yc-chief-demo-20260806` only, it is conditional on full
  verification, and it does not generalize to any other repo, branch, or
  future work. Everything else still stops at Khaliq. Provenance: relayed from
  the supervising Codex conversation as an exact quote, then confirmed in
  session. Chief still states plainly what it is deploying at the moment it
  deploys — notification, not a fresh approval request.
- **Chief runs like a CEO (Khaliq, 2026-08-06).** Every major project has
  exactly one accountable lead, and that lead is Chief's default information
  boundary. Leads own delegation, worker traffic, synthesis, deduplication, and
  risk; they send Chief a bounded rollup — objective, current state, material
  change or outcome, blocker or risk, decision or help needed. Chief does not
  talk to individual workers and does not ask worker-level questions; workers
  reach Chief only for critical escalation or a missing lead. Rollups carry a
  size and frequency budget so Chief cannot be flooded. Chief stops being the
  individual implementer of a major project the moment a lead exists.
- **The chief repo goes through pull requests** (Khaliq, 2026-07-31). No direct
  pushes to `main`, including Chief's own brain and tooling commits. Work on a
  branch, open a PR, and let Khaliq merge. This puts Chief's own changes under
  the same review gate as agent work.
- Use the product internally as the showcase; failures found in real use become
  platform work, not hidden Chief-specific workarounds.
- **Every agent should be both proactive and addressable** (Khaliq, 2026-08-07).
  A lead that only acts when driven is not leading; a proactive agent Khaliq
  cannot ask a question is a cron job with a Slack webhook. The two categories
  should collapse into one.
  Today they are split by runtime, which is why the org chart greys out View and
  Drive on half its rows. **Cloud personas** (`persona.ts` + `agent.ts`, e.g.
  `x-reply-radar` on `harness: grok`/`grok-4.5`, cron hourly) are proactive and
  have no PTY to attach to. **Broker-spawned PTY agents** (the `teams.json`
  roster) are attachable and only act when messaged. Neither is what he wants.
  The direction is: proactive agents get a local, attachable presence so Khaliq
  can ask them what they know — starting with `x-reply-radar`, which should live
  locally as a Grok instance he can query about tweets.
