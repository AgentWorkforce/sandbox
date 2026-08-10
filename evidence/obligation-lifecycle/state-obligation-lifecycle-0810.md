# Obligation lifecycle — lane state, 2026-08-10

Lane: `obligation-lead-0810` (lead, non-implementing). Issues: `AgentWorkforce/c2a#3` (protocol), `AgentWorkforce/relay#1474` (implementation). Everything below is also on GitHub; nothing load-bearing exists only here or in a DM.

## STATE

**The protocol design went through a full cycle today: designed, drafted into a PR, independently red-teamed, and materially revised. The revision is specified but not yet written into the spec.**

| Artifact | Location | Durable |
|---|---|---|
| Design decision (v1) | `c2a#3` comment `5244797992` | GitHub |
| Independent red-team report + lead's rulings (v2 — **current**) | `c2a#3` comment `5245270838` | GitHub |
| Spec PR — **DO NOT MERGE, pre-review shape** | `c2a#4`, branch `spec/obligation-lifecycle`, `df4394c` → `da545f4`, README only (+96/−1) | GitHub |
| Do-not-merge notice on the PR | `c2a#4` comment `5245277594` | GitHub |
| Implementation reconciliation | `relay#1474` comment `5244821890` | GitHub |

### What survived the red team

Author-side discharge (the load-bearing rule) — attacked, unbroken. Derived-over-mutable-field, for the authorship reason — unbroken; its problem is missing inputs, not the choice. No backoff — correct. The two readings of an author's own `done` genuinely collapse.

### What broke — three claims the v1 design made *for free*

1. **"Only `must_respond` creates an obligation" is wrong, and this is the central defect.** The spec sets `policy` from addressing — *"The host sets it; `addressedToMe` is the main input"*, and *When You Must Respond* opens with *"A human or agent DMs you."* Combined with "nothing auto-closes" and no backoff, **every DM opens a never-expiring obligation closable only by its sender** — including the acknowledgements Loop Prevention forbids answering. The v1 requirements table mapped the interim convention's text prefix onto `must_respond` and so **mapped a subset onto a superset**: the prefix carried the author's *intent to be blocked*; the policy carries the host's *determination that you were addressed*.
   **Ruling: the presence of the `obligation` object creates the obligation; `policy` keeps meaning "you were addressed."**

2. **"No new signal — the primitive already carries this" is wrong, and this was my error.** v1 cited *"A reaction on an agent's own message is an inbound signal back to it"* as proof the spec already distinguishes an author's reaction from a recipient's. It does not — it distinguishes *which message* is reacted to, and its own gloss (*"`done` means already handled"*) describes **others** reacting to your message. So the spec's current meaning of `done` on an obligating event is the recipient meaning v1 demoted to "a claim". **Unless that line is rewritten in the same change, a conformant host reads a recipient's ✅ as "already handled" and closes — the read-receipt bug in a different costume.**

3. **"Nothing new is stored" is wrong.** The Event Shape carries no `createdAt` (so the clock is host-local receipt time, and replay makes obligations either immortal or all-fire-at-once on reconnect), no recipient identity (so "what am I blocking" is not derivable at all), and no reaction event shape. And the argument v1 used against a separate record **applies equally to the derivation**: derived state is computed per observer and no authoritative log is named, so one host derives "discharged" while another derives "open at tier 2", with no arbiter. Retention closes it — any compaction window silently discharges everything older than it.

### Also ruled

- **`blocks` was a severity enum after all** — a three-value ordered enum used as the queue's primary sort key. The falsifiability defence fails because **the protocol has no workstream and no work event**, so the falsifier is not computable from anything C2A carries. Kept, falsifiability story dropped, repurposed as the obligation-creating marker (closes with #1).
- **Discharge authority sat with the least durable participant.** v1 argued a halted author cannot run its own retry, then failed to apply that to discharge — which is harder (a retry is a timer; a discharge is a model turn). Where agents exit on completing a brief, the flagship scenario is exactly where the author can never emit `done`. **Ruling: an obligation names a discharge delegate at creation, defaulting to the author's coordinator; the human tier is a normal closer, not a narrow hatch.**
- Rules added for reaction removal, terminal-rung behaviour, escalation coalescing, and the four unhandled signals (`seen`, `agree`, `claimed`, `unclear`). Full text in the rulings comment.

### Conformance — replaced, and this matters most

The v1 wording was satisfiable by an implementation that still has the bug. The worst route was self-inflicted: v1 bans `must_respond` over `digest`/`silent` because such a mode may never be seen as actionable, then specifies the return as a **`notify` knock — which the spec defines as content withheld until pulled.** A host can emit the knock into the same stream the original decayed into and pass. Also, *"must fail before the change"* proves only that a feature is new, not that the test targets the defect.

Replacement: one fixture, four arms, through the **production send path**, asserting **the recipient model took a turn**: (A) read + non-answering reply + recipient `done` + `seen` → MUST still return; (B) author/delegate discharges → MUST NOT return; (C) no signals → equal-interval returns at t/2t/3t then an observed escalation to a different recipient; (D) arm A with read state set and unset → identical. Plus a control: disable boomerang and confirm A and C **fail**. A and B are a pair — A alone passes an implementation that never discharges, B alone passes today's code doing nothing.

## NEXT

1. **Write the v2 shape into the spec.** `c2a#4` is the pre-review draft and must not be merged. Order: the `obligation`-creates-the-obligation change first (it closes two findings at once), then the additive schema work (`createdAt`, recipient identity, reaction event shape, named authoritative log, retention floor), then rewrite the own-message-reaction line so a recipient's ✅ cannot close an obligation.
2. **Then `relay#1474`.** Held deliberately until the protocol settles. Its reconciliation comment already overrides the issue's proposed `severity` enum.

**A successor needs no re-derivation.** `c2a#3` comment `5245270838` is self-contained: every finding, every ruling, and the replacement conformance fixture.

**Do not merge.** Khaliq owns the merge gate.

**Honest limits.** The v2 shape is *specified and reasoned*, not *written into the spec* — no PR carries it. It has had one adversarial pass; the revisions made in response to that pass have not themselves been reviewed by anyone but me. Two items are named as unresolved rather than fixed: at the terminal human rung the recipient and the permitted closer are the same party, so recipient-side discharge is reinstated there as a **stated exception**; and the escalation-coalescing rule is asserted but its interaction with per-recipient discharge is untested.
