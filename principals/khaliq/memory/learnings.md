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
- **A dispatch gate must fail closed.** AR-448 was duplicated because the
  writeback that releases the claim depends on Relayfile, Relayfile was down,
  the failure was non-fatal, and the run proceeded — leaving the issue looking
  ready with a PR already open. If the claim cannot be written, abort the
  dispatch; a queue that silently re-offers claimed work is worse than a queue
  that stalls.
