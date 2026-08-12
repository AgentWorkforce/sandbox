---
status: active
owner: unassigned
previous_owner: trajectory-lead-0811v3
reports_to: agent-coordination-lead-0811
updated: 2026-08-11
repos: [chief, relayhistory, relaycast, cloud]
---

Goal: Chief owns the memory logic and the data encoding for agent trajectories —
one writer, one schema, one place a new session reads to know what is true.

## Now — 2026-08-11 — Khaliq's ruling, unimplemented

**Khaliq, 2026-08-11:** *"ultimately i think that memory logic and data encoding
should live in chief."* Stated while opening `intent-trajectory-lineage`, and it
settles a question that workstream would otherwise have had to ask.

**What it decides.** The trajectory chain — intent → Linear issue → conversation
pointers → PRs → review → deploy → runtime — needs somewhere to define *what a
memory is* and *how it is encoded*. That is not Linear (a surface), not relaycast
(a transport and message store), and not relayhistory (a per-node session index).
**It is Chief.** Those systems supply records; Chief defines the schema those
records are read into and is the single writer of the durable interpretation.

**Why this is the right seat, and it is consistent with what already works here.**
Chief is already the continuity owner and already the one writer — §7 of
`CLAUDE.md` exists precisely to stop two writers corrupting continuity, and
`OPERATING.md` states the invariant to protect is *the decision and the state it
writes*, one writer and one decider, while execution can happen anywhere. Memory
encoding is a decision-plane concern by that rule, not an execution-plane one.

**What exists today is a convention, not an encoding.** The brain is markdown
under `principals/<slug>/` with four memory files, dated journal entries, and
workstreams carrying frontmatter. It is readable and it is versioned in git, and
those are real properties worth keeping. But:

- `memory/learnings.md` is **84KB** and `open-threads.md` **41KB** in one file
  each. There is no addressable unit, so nothing can point *at* a memory.
- Frontmatter is enforced by nothing. A malformed workstream fails silently.
- There is no id, so a trajectory pointer has nothing stable to reference.
- Nothing links a memory to the conversation or PR that produced it — which is
  exactly what `intent-trajectory-lineage` needs to exist.

**The gap that makes this urgent rather than tidy:** a trajectory pointer needs a
durable target. Today Chief's memory has no addressable unit to be the target of
one.

## Consumer requirements — from trajectory-lead-0811v3

These are what `intent-trajectory-lineage` and `pr-shepherd` need to READ from
Chief's memory encoding. Chief defines the schema; these are the consumer's
requirements, not implementation decisions.

**Minimum addressable unit:**
```
{
  id:          stable, opaque, does not change on content edit (e.g. mem_xxxx)
  type:        "learning" | "decision" | "person" | "project" | "preference" | "open-thread"
  content:     the memory text
  created_at:  ISO timestamp
  provenance:  {
    kind:      "conversation" | "pr" | "journal"
    ref:       ai-hist session UUID | GitHub PR url | journal date
    system:    "ai-hist" | "github" | "journal"
  }
  superseded_by: mem_xxxx | null  (null = current; non-null = archived)
}
```

**Why each field is load-bearing:**
- `id`: a trajectory pointer needs a stable target. Without an id, a pointer references
  a line number in a 84KB file — broken on next edit.
- `provenance.ref`: closes the loop from memory back to the conversation or PR that
  produced it. This is what makes a future implementer able to read the memory and
  then read the evidence behind it.
- `superseded_by`: memories get updated. Without supersession, updating a memory is
  ambiguous — did the old fact go away, or is there a chain? Null = current fact.
- `type`: needed for the groom/digest operations to stay scoped.

**What trajectory-lead does NOT need to decide:** file format, validator technology,
migration plan. Chief decides those. trajectory-lead just needs to be able to write
`mem_xxxx` into a pointer and have it resolve six months later.

**The single MVP ask:** even before the full migration, an `id` field in workstream
frontmatter (e.g. `id: ws_intent-trajectory-lineage`) lets trajectory pointers
reference workstreams durably today. This is a one-field addition per file and
requires no migration of the large memory files.

## Next

1. ~~**Appoint a lead.**~~ trajectory-lead-0811v3 coordinating; decisions are Chief's.
2. **Specify the encoding before changing any file.** Consumer requirements above
   are the input. An addressable memory unit with a stable id, a type, a provenance
   pointer, and a supersession relationship. Markdown + frontmatter is a fine carrier
   if the schema is enforced; the schema is the deliverable, not the file format.
3. **Make it validated.** An unenforced invariant is a convention — the schema
   needs the validator that enforces it, wired into something that actually runs
   on this repo, and the CI line that runs it must be named.
4. **Migrate without losing the audit trail.** Git is the brain's audit trail and
   journal history is never rewritten. Splitting the two large memory files is a
   migration, not an edit — it needs a plan that preserves provenance.
5. **Publish the read contract** that `intent-trajectory-lineage` and
   `pr-shepherd` consume, so both point at real ids rather than inventing their
   own.

**MVP unblock (suggestion for Chief):** add `id:` to workstream frontmatter now
(e.g. `id: ws_intent-trajectory-lineage`). One field per file, no migration of
the large memory files, lets trajectory pointers reference workstreams today. Full
encoding spec can follow.

## History

- **2026-08-11 cleanup checkpoint** — the coordinating trajectory session was
  released after completing its consumer requirements. The encoding itself is
  still unimplemented and requires a new owner; decisions remain Chief's.
- **2026-08-11** — Opened by Chief on Khaliq's ruling that memory logic and data
  encoding live in Chief. Nothing implemented; the ruling is the artifact.
  See [[intent-trajectory-lineage]], which is blocked on the pointer target this
  workstream defines.
- **2026-08-11 ~05:45Z** — trajectory-lead-0811v3 appointed as coordinating lead
  (decisions remain Chief's). Consumer requirements added above: minimum addressable
  unit spec from trajectory-lead's perspective. MVP unblock suggestion filed to Chief.
