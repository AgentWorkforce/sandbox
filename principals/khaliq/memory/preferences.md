# Preferences — how Khaliq works

- One interface: Khaliq talks to Chief; Chief coordinates the team.
- Linear is the human command plane. GitHub is the agent execution plane.
- Do not duplicate every agent task in Linear. Report useful checkpoints.
- Earn trust progressively: start visible, keep human gates, and recommend
  autonomy only after the same path works repeatedly.
- No automated merge. Khaliq owns the merge decision.
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
