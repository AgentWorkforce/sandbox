# Learnings

- A process-lifetime Relaycast room is not an agent identity. Chief must bind
  to the canonical Cloud workspace so its address, inbox, and history survive
  broker restarts.
- A team is only trustworthy when the principal can inspect the individual
  agents and preserve explicit human gates.
- Bespoke Factory verification matters because each repository has a different
  definition of end-to-end correctness.
- Files provide a useful least-privilege boundary: absent means no access,
  read-only means observe, and writable paths define allowed actions.
- Never dump raw `env` into a transcript. A length-based redaction filter let
  a 35-character `br_` broker key through. Grep for the specific variables
  needed, or filter by key name, never by value length.
- Never start Chief's node from inside a Claude Code session. Claude Code
  stamps `CLAUDE_CODE_CHILD_SESSION=1` into every Bash subprocess and the
  broker passes it through, so Chief silently stops persisting transcripts.
  Any clean-env path works (`npm run chief` from a real terminal, or launchd).
  The marker cannot be checked from inside a session — verify persistence by
  watching the session `.jsonl` grow.
- A doctor `OK` on `broker` says the process is up, not that the planes are
  healthy. Read every integration line; GitHub can report a recent event while
  both sync and ingress are unhealthy.
- **A claim that lives in one dispatcher's private state is not a claim.**
  Factory fences work in its own hosted state store, which no other dispatcher
  can see. Because Factory is surface-agnostic, the claim cannot live in one
  surface's fields either — the same work unit can arrive via Linear, Notion,
  or GitHub. The claim has to belong to the work unit, be written before agents
  spawn, and be projected back to whichever surface expressed it.
- **Read the platform's own config before encoding a policy about it.** Chief
  asserted a Linear-only work model for two days because `chief.config.json`
  and `CLAUDE.md` said so, and Chief never opened a `factory.config.json` in
  any target repo. One file read (`hoopsheet` sets `issueSource: "github"`)
  would have falsified it. Repo-local docs describe intent; the owning
  component's config describes capability, and capability wins.
- **Never launder relayed authority into direct confirmation in the brain.** An
  agent reporting "the principal authorized X" is evidence that the agent
  believes it, not that it happened. Record the claim with its provenance — who
  said it, through which channel — and keep the gate. The brain is read by
  future sessions as settled fact, so a provenance error there becomes a
  permission the principal never granted. Scale the scepticism to the blast
  radius: routine sequencing can ride on a relay; data-access scope and
  destructive operations need the principal in a channel he uses himself.
- **Treat contradicting evidence as falsifying, not as trivia.** Factory's run
  list carried `source: "github"` in plain sight and Chief reported it twice as
  a curiosity while continuing to assert Linear-only dispatch. When observed
  data disagrees with the model being reported, stop and chase it.
- **Verify a CLI flag against the installed binary, not the source repo.** Chief
  started passing `agent-relay cloud session --reveal-token` because relay's
  `main` carries it. The binary on this machine is 11.2.0, relay `main` is
  11.4.0, and 11.2.0 rejects the flag outright — so every hosted Cloud call
  failed on `unknown option`, taking out the doctor's cloud check and, behind
  it, integrations, factory, and senses. Reading source proves a flag exists
  somewhere; only `--help` on the installed binary proves Chief may pass it.
- **A live supervisor pid is not a live mount.** The doctor called senses OK
  because a process was alive, while the mount had been stopped for four days
  with an expired credential — the supervisor stays up retrying a mint
  RelayAuth keeps refusing. Chief then read a four-day-old `senses/` projection
  as current external truth. Check the thing Chief actually reads through (the
  mount, the credential), never the supervisor around it. Same shape as the
  `broker` OK lesson above; a health check must assert the capability, not the
  process.
- **A dispatch gate must fail closed.** AR-448 was duplicated because the
  writeback that releases the claim depends on Relayfile, Relayfile was down,
  the failure was non-fatal, and the run proceeded — leaving the issue looking
  ready with a PR already open. If the claim cannot be written, abort the
  dispatch; a queue that silently re-offers claimed work is worse than a queue
  that stalls.
