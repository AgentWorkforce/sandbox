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
