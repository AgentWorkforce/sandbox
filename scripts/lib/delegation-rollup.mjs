/**
 * Lead rollups — the reporting half of Chief's CEO model.
 *
 * The lead is Chief's information boundary. That boundary is only real if
 * routine worker chatter stops at the lead and arrives at Chief as a bounded
 * summary. A boundary that forwards everything is a relay, not a boundary.
 *
 * Two behaviours have to hold at once, and they pull against each other:
 *
 *   1. A flood must collapse. Fifty workers each reporting "tests pass" is one
 *      sentence to Chief, not fifty messages.
 *   2. A critical escalation must still get through, immediately, even mid-
 *      flood and even inside a rate-limit window.
 *
 * Both directions are tested. An exception path nobody tested is an exception
 * path that does not work, and the exception path here is the one that carries
 * the bad news.
 *
 * The escalation channel deliberately keeps its own window state. If a
 * critical event reset the routine timer, a burst of escalations would
 * suppress the routine rollup that gives them context; if a routine rollup
 * reset the escalation path, an escalation could be delayed by good news.
 * They do not share state.
 */

/** Defaults matching the rollup contract Chief hands its leads. */
export const DEFAULT_ROLLUP_LIMITS = {
  /** No more than one routine rollup per half hour. */
  minIntervalMs: 30 * 60 * 1000,
  /** Hard word cap on the rendered rollup. */
  maxWords: 250,
  /** Individual worker events itemized before the rest are counted, not shown. */
  maxItems: 12,
};

const SEVERITIES = ["routine", "critical"];

function words(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean);
}

function oneLine(text, wordCap) {
  const parts = words(text);
  if (parts.length <= wordCap) return parts.join(" ");
  return `${parts.slice(0, wordCap).join(" ")}…`;
}

/**
 * Render a bounded rollup from buffered events.
 *
 * Truncation is always *stated* — "+7 more" and an explicit trimmed note —
 * never silent. A summary that quietly drops half its input reads as full
 * coverage, which is worse than reporting less and saying so.
 */
export function renderRollup(events, { header = "", limits = {} } = {}) {
  const { maxWords, maxItems } = { ...DEFAULT_ROLLUP_LIMITS, ...limits };

  const shown = events.slice(0, maxItems);
  const hidden = events.length - shown.length;

  const lines = [];
  if (header) lines.push(header);
  for (const event of shown) {
    const who = event.worker ? `${event.worker}: ` : "";
    lines.push(`- ${who}${oneLine(event.summary, 24)}`);
  }
  if (hidden > 0) lines.push(`- +${hidden} more worker events not itemized`);

  let text = lines.join("\n");
  let trimmed = false;
  if (words(text).length > maxWords) {
    // Drop whole items from the tail rather than cutting mid-line, then say so.
    while (lines.length > (header ? 2 : 1) && words(lines.join("\n")).length > maxWords) {
      lines.pop();
      trimmed = true;
    }
    const dropped = events.length - (lines.length - (header ? 1 : 0));
    if (trimmed) lines.push(`- +${dropped} more worker events trimmed to fit the word cap`);
    text = lines.join("\n");
  }

  return {
    text,
    eventCount: events.length,
    itemized: shown.length,
    withheld: Math.max(0, events.length - shown.length),
    truncated: hidden > 0 || trimmed,
    wordCount: words(text).length,
  };
}

/**
 * Buffer worker events and decide, per event, what the lead sends onward.
 *
 * `record` returns `null` when the event was absorbed, or the message to
 * deliver to Chief. Nothing material means silence — that is a return value,
 * not an omission.
 */
export function createRollupAggregator({
  header = "",
  limits = {},
  now = () => Date.now(),
} = {}) {
  const resolved = { ...DEFAULT_ROLLUP_LIMITS, ...limits };
  let buffer = [];
  let lastRoutineEmit = null;

  function normalize(event) {
    const severity = SEVERITIES.includes(event?.severity)
      ? event.severity
      : "routine";
    return {
      severity,
      worker: event?.worker ?? null,
      summary: event?.summary ?? "",
      at: event?.at ?? null,
    };
  }

  function emitRollup(at) {
    if (buffer.length === 0) return null;
    const rollup = renderRollup(buffer, { header, limits: resolved });
    buffer = [];
    lastRoutineEmit = at;
    return { kind: "rollup", ...rollup };
  }

  return {
    /** Events absorbed since the last routine emit. Exposed for tests and status. */
    get pending() {
      return buffer.length;
    },

    record(event) {
      const at = now();
      const normalized = normalize(event);

      // Critical bypasses the interval entirely and is never buffered. It also
      // does not touch `lastRoutineEmit`, so the routine cadence survives an
      // escalation storm and still delivers the context around it.
      if (normalized.severity === "critical") {
        return {
          kind: "escalation",
          text: `ESCALATION${normalized.worker ? ` (${normalized.worker})` : ""}: ${oneLine(normalized.summary, resolved.maxWords)}`,
          worker: normalized.worker,
          bypassedInterval: lastRoutineEmit !== null,
        };
      }

      buffer.push(normalized);

      // First routine event starts the clock rather than emitting immediately;
      // otherwise the head of every flood escapes the collapse.
      if (lastRoutineEmit === null) {
        lastRoutineEmit = at;
        return null;
      }
      if (at - lastRoutineEmit < resolved.minIntervalMs) return null;
      return emitRollup(at);
    },

    /** Force out whatever is buffered — end of a fan-out, or shutdown. */
    flush() {
      return emitRollup(now());
    },
  };
}
