---
status: active
tldr: "Chat-replay work sits uncommitted on a feature branch; landing it unlocks the queue of unmerged branches behind it."
card: "Pear Chat Replay"
owner: pear
updated: 2026-07-29
repos: [pear]
---
# pear — observer stream + chat replay

**Goal:** pear consumes the relaycast observer stream and gets durable chat
history with replay.

**Now:** in flight on branch feature/pear-observer-stream with 15 uncommitted
files (chat-message-history.ts, chat-replay.ts + tests) wired through broker,
IPC and fleet node. Observer consumption is behind PEAR_OBSERVER_STREAM.
Local main is stale (07-01 vs origin 07-23).

**Next:** commit/land the chat-replay work; then the unmerged branch queue
(join-existing-workspace, observer-link-channel-reconcile, chat double-send
race, observer token/replay-gap, release-autoupdate).

## History
- 2026-07-29 — Backfilled: v1.0.0 notarized pipeline + software factory →
  @agent-relay/factory (Jun), terminal-fidelity test discipline (Jul), relay
  v9.2 → v11 dependency march. Hygiene: pear-mobile is an empty placeholder
  worktree 303 behind; three prunable /private/tmp worktrees.
