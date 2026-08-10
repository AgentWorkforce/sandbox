import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ROLLUP_LIMITS,
  createRollupAggregator,
  renderRollup,
} from "./delegation-rollup.mjs";

/** A controllable clock — the interval behaviour is the thing under test. */
function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      return t;
    },
  };
}

const routine = (worker, summary) => ({ severity: "routine", worker, summary });
const critical = (worker, summary) => ({ severity: "critical", worker, summary });

// --------------------------------------------------------------- collapse

test("a flood collapses into one bounded rollup", () => {
  const time = clock();
  const agg = createRollupAggregator({ header: "worker events", now: time.now });

  // Fifty workers all reporting inside the window.
  const emitted = [];
  for (let i = 0; i < 50; i += 1) {
    const out = agg.record(routine(`worker-${i}`, "tests pass"));
    if (out) emitted.push(out);
  }

  assert.deepEqual(emitted, [], "nothing escapes the window");
  assert.equal(agg.pending, 50);

  const rollup = agg.flush();
  assert.equal(rollup.kind, "rollup");
  assert.equal(rollup.eventCount, 50);
  assert.ok(
    rollup.wordCount <= DEFAULT_ROLLUP_LIMITS.maxWords,
    `rollup must respect the word cap, got ${rollup.wordCount}`,
  );
  assert.ok(
    rollup.itemized <= DEFAULT_ROLLUP_LIMITS.maxItems,
    "rollup must respect the item cap",
  );
});

test("the head of a flood does not escape the collapse", () => {
  const time = clock();
  const agg = createRollupAggregator({ now: time.now });
  // The very first routine event starts the clock rather than being forwarded.
  assert.equal(agg.record(routine("w1", "started")), null);
  assert.equal(agg.pending, 1);
});

test("what a rollup drops, it says it dropped", () => {
  const events = Array.from({ length: 40 }, (_, i) =>
    routine(`worker-${i}`, "finished a unit of work"),
  );
  const rollup = renderRollup(events, { header: "40 events" });

  assert.equal(rollup.truncated, true);
  assert.match(rollup.text, /\+\d+ more/, "silent truncation reads as full coverage");
  assert.equal(rollup.eventCount, 40);
});

test("a rollup under the caps is reported whole and untruncated", () => {
  const rollup = renderRollup([routine("w1", "opened the PR")], { header: "one event" });
  assert.equal(rollup.truncated, false);
  assert.equal(rollup.withheld, 0);
  assert.match(rollup.text, /w1: opened the PR/);
});

// ------------------------------------------------------------------ cadence

test("routine rollups are rate limited, then released once the window passes", () => {
  const time = clock();
  const agg = createRollupAggregator({ now: time.now });

  agg.record(routine("w1", "one"));
  time.advance(DEFAULT_ROLLUP_LIMITS.minIntervalMs - 1);
  assert.equal(agg.record(routine("w2", "two")), null, "still inside the window");

  time.advance(2);
  const out = agg.record(routine("w3", "three"));
  assert.ok(out, "the window has passed, the rollup goes out");
  assert.equal(out.kind, "rollup");
  assert.equal(out.eventCount, 3);
  assert.equal(agg.pending, 0, "emitting clears the buffer");
});

test("an empty flush is silence, not an empty message", () => {
  const agg = createRollupAggregator({ now: clock().now });
  assert.equal(agg.flush(), null);
});

// --------------------------------------------------------------- escalation

test("a critical escalation gets through immediately, mid-flood", () => {
  const time = clock();
  const agg = createRollupAggregator({ now: time.now });

  for (let i = 0; i < 20; i += 1) agg.record(routine(`worker-${i}`, "tests pass"));

  const out = agg.record(critical("worker-7", "the dispatch gate cannot record its claim"));
  assert.ok(out, "an escalation must never be swallowed by the rate limit");
  assert.equal(out.kind, "escalation");
  assert.equal(out.bypassedInterval, true);
  assert.match(out.text, /ESCALATION \(worker-7\)/);
  assert.match(out.text, /cannot record its claim/);
});

test("an escalation is never buffered and never displaces routine reporting", () => {
  const time = clock();
  const agg = createRollupAggregator({ now: time.now });

  agg.record(routine("w1", "one"));
  agg.record(critical("w2", "blocked on a gate"));
  assert.equal(agg.pending, 1, "the escalation was delivered, not buffered");

  // The escalation must not have reset the routine window in either direction:
  // the rollup still goes out on its own schedule.
  time.advance(DEFAULT_ROLLUP_LIMITS.minIntervalMs);
  const out = agg.record(routine("w3", "three"));
  assert.ok(out, "an escalation storm must not suppress the routine rollup");
  assert.equal(out.eventCount, 2, "only routine events belong in the rollup");
});

test("an escalation before any routine traffic still gets through", () => {
  const agg = createRollupAggregator({ now: clock().now });
  const out = agg.record(critical("w1", "cloud branch conflict"));
  assert.equal(out.kind, "escalation");
  assert.equal(out.bypassedInterval, false, "there was no window to bypass yet");
});

test("an unlabelled event is treated as routine, not as an escalation", () => {
  const agg = createRollupAggregator({ now: clock().now });
  assert.equal(agg.record({ worker: "w1", summary: "no severity given" }), null);
  assert.equal(agg.pending, 1);
});
