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
- **Spawn across engines, not just Claude** (Khaliq, 2026-08-17). Chief had
  dispatched five lanes in one morning and only one was `codex`; the rest were
  `claude`. The roster's fleet nodes advertise `spawn:claude`, `spawn:codex`,
  `spawn:gemini` and `spawn:opencode`, and a lane's engine is Chief's choice at
  dispatch time — so defaulting every appointment to one model is a choice being
  made by habit rather than by fit. Mix them deliberately.
  The reason it matters beyond variety: this repo's own record shows codex
  cracking root causes that successive claude lanes circled for hours (the
  sf-mini broker trace, the Relayfile backend pair — two claude attempts went
  quiet, the third on codex found git-history-backed root causes in ~20
  minutes). Independent engines fail differently, which is the whole value of a
  second opinion on a hard defect.
  Note the constraint discovered the same day: **the `spawn` tool's `cli` enum
  is not a node capability.** It accepts `grok`, but no fleet node advertises
  `spawn:grok`, and the spawn is refused at dispatch. Read the node's
  `capabilities` from `query_nodes` before promising an engine. A node advertises
  `spawn:<cli>` for every distinct `cli` named in its teams roster, so adding an
  engine is a roster change plus a node restart, not a code change.
