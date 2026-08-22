#!/usr/bin/env node
/**
 * Reap leaked ephemeral sandboxes across providers.
 *
 * Contract (see LaunchOptions.ephemeralUntil / .attributionTag docs):
 *   an instance is reap-eligible IFF it carries BOTH
 *     - metadata `_sandbox.attributionTag` (any non-empty value), AND
 *     - metadata `_sandbox.ephemeralUntil` parseable as a millis timestamp
 *       whose value is strictly in the past at reap time.
 *
 * A label-based sweep (`metadata.ephemeral === 'true'` etc.) is explicitly
 * NOT implemented — it would delete healthy warm-lease instances that
 * legitimately carry the same label. See the Agent37 leak diagnosis dated
 * 2026-08-22 for the incident this contract prevents.
 *
 * Defaults to DRY-RUN. Callers must pass `--apply` to actually issue
 * deletes. Prints per-instance verdict (reap / skip + reason).
 *
 * Usage:
 *   npx tsx scripts/reap-ephemeral.ts --provider agent37 [--apply] [--tag <expected>]
 *   npx tsx scripts/reap-ephemeral.ts --provider agent37 --apply --tag bench:sandbox-provider-comparison-0819
 *
 * Env:
 *   AGENT37_API_KEY  — required for --provider agent37 (or ~/.agentworkforce/provider-creds/AGENT37_API_KEY)
 *   AGENT37_API_URL  — hosting-plane origin; default https://api.agent37.com
 *
 * Exit codes:
 *   0  no eligible leaks OR reap succeeded
 *   1  bad args
 *   2  provider auth / network failure
 *   3  one or more DELETEs failed
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { argv, env, exit, stdout } from "node:process";

export type ReapCandidate = {
  id: string;
  attributionTag: string | null;
  ephemeralUntilMs: number | null;
  status: string | null;
  raw: unknown;
};

export type ReapVerdict =
  | { kind: "reap"; id: string; attributionTag: string; ephemeralUntilMs: number }
  | { kind: "skip-no-attribution"; id: string }
  | { kind: "skip-no-deadline"; id: string; attributionTag: string }
  | { kind: "skip-malformed-deadline"; id: string; attributionTag: string; raw: string }
  | { kind: "skip-tag-mismatch"; id: string; got: string; expected: string }
  | { kind: "skip-not-yet-past"; id: string; attributionTag: string; ephemeralUntilMs: number; nowMs: number };

/**
 * Pure, testable classifier: given the candidate metadata + wall clock + an
 * optional expected tag, decide the verdict. All I/O lives elsewhere so this
 * is directly unit-testable against every branch.
 */
export function classifyCandidate(
  candidate: ReapCandidate,
  opts: { nowMs: number; expectedTag?: string },
): ReapVerdict {
  if (candidate.attributionTag === null || candidate.attributionTag.length === 0) {
    return { kind: "skip-no-attribution", id: candidate.id };
  }
  if (opts.expectedTag !== undefined && candidate.attributionTag !== opts.expectedTag) {
    return {
      kind: "skip-tag-mismatch",
      id: candidate.id,
      got: candidate.attributionTag,
      expected: opts.expectedTag,
    };
  }
  if (candidate.ephemeralUntilMs === null) {
    return { kind: "skip-no-deadline", id: candidate.id, attributionTag: candidate.attributionTag };
  }
  if (!Number.isFinite(candidate.ephemeralUntilMs)) {
    return {
      kind: "skip-malformed-deadline",
      id: candidate.id,
      attributionTag: candidate.attributionTag,
      raw: String(candidate.ephemeralUntilMs),
    };
  }
  if (candidate.ephemeralUntilMs >= opts.nowMs) {
    return {
      kind: "skip-not-yet-past",
      id: candidate.id,
      attributionTag: candidate.attributionTag,
      ephemeralUntilMs: candidate.ephemeralUntilMs,
      nowMs: opts.nowMs,
    };
  }
  return {
    kind: "reap",
    id: candidate.id,
    attributionTag: candidate.attributionTag,
    ephemeralUntilMs: candidate.ephemeralUntilMs,
  };
}

/**
 * Extract a ReapCandidate from an Agent37 instance record. Preserves nulls
 * rather than coercing them so the classifier can report a precise reason.
 */
export function candidateFromAgent37Instance(inst: unknown): ReapCandidate {
  const record = (inst ?? {}) as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const metadata = (record.metadata ?? {}) as Record<string, unknown>;
  const rawTag = metadata["_sandbox.attributionTag"];
  const rawDeadline = metadata["_sandbox.ephemeralUntil"];
  const status = typeof record.status === "string" ? record.status : null;
  const ephemeralUntilMs =
    typeof rawDeadline === "string" && rawDeadline.length > 0
      ? Number(rawDeadline)
      : typeof rawDeadline === "number"
        ? rawDeadline
        : null;
  return {
    id,
    attributionTag: typeof rawTag === "string" && rawTag.length > 0 ? rawTag : null,
    ephemeralUntilMs,
    status,
    raw: inst,
  };
}

type Args = {
  provider: string;
  apply: boolean;
  expectedTag?: string;
};

function parseArgs(argsv: readonly string[]): Args {
  let provider = "";
  let apply = false;
  let expectedTag: string | undefined;
  for (let i = 0; i < argsv.length; i += 1) {
    const a = argsv[i];
    if (a === "--provider") {
      provider = argsv[i + 1] ?? "";
      i += 1;
    } else if (a === "--apply") {
      apply = true;
    } else if (a === "--tag") {
      expectedTag = argsv[i + 1] ?? "";
      i += 1;
    } else if (a === "--help" || a === "-h") {
      stdout.write(
        "usage: reap-ephemeral --provider <name> [--apply] [--tag <expected>]\n",
      );
      exit(0);
    } else {
      stdout.write(`unknown arg: ${a}\n`);
      exit(1);
    }
  }
  if (!provider) {
    stdout.write("error: --provider is required (agent37)\n");
    exit(1);
  }
  return { provider, apply, expectedTag };
}

function readAgent37Key(): string {
  const fromEnv = env.AGENT37_API_KEY;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  const path = join(homedir(), ".agentworkforce/provider-creds/AGENT37_API_KEY");
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    stdout.write(
      "error: AGENT37_API_KEY missing (checked env and ~/.agentworkforce/provider-creds/AGENT37_API_KEY)\n",
    );
    exit(2);
  }
}

async function reapAgent37(args: Args): Promise<number> {
  const key = readAgent37Key();
  const baseUrl = (env.AGENT37_API_URL ?? "https://api.agent37.com").replace(/\/$/, "");
  const listResp = await fetch(`${baseUrl}/v1/instances`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!listResp.ok) {
    stdout.write(`error: list failed http=${listResp.status}\n`);
    return 2;
  }
  const listBody = (await listResp.json()) as unknown;
  const items = extractInstanceArray(listBody);
  const nowMs = Date.now();
  const verdicts = items.map((it) => classifyCandidate(candidateFromAgent37Instance(it), { nowMs, expectedTag: args.expectedTag }));

  const reap = verdicts.filter((v): v is Extract<ReapVerdict, { kind: "reap" }> => v.kind === "reap");
  const skips = verdicts.filter((v) => v.kind !== "reap");

  stdout.write(`provider=agent37 total=${items.length} eligible=${reap.length} skipped=${skips.length} dry_run=${!args.apply}\n`);
  for (const s of skips) {
    stdout.write(`  skip ${s.id.padEnd(20)} ${s.kind}\n`);
  }
  if (reap.length === 0) return 0;
  for (const r of reap) {
    stdout.write(
      `  ${args.apply ? "REAP" : "would-reap"} ${r.id.padEnd(20)} tag=${r.attributionTag} deadline=${new Date(r.ephemeralUntilMs).toISOString()}\n`,
    );
  }
  if (!args.apply) return 0;

  let failed = 0;
  for (const r of reap) {
    const del = await fetch(`${baseUrl}/v1/instances/${encodeURIComponent(r.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (!del.ok && del.status !== 404) {
      failed += 1;
      stdout.write(`  ERR delete ${r.id} http=${del.status}\n`);
    } else {
      stdout.write(`  ok  delete ${r.id} http=${del.status}\n`);
    }
  }
  return failed === 0 ? 0 : 3;
}

export function extractInstanceArray(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    if (Array.isArray(rec.data)) return rec.data;
    if (Array.isArray(rec.instances)) return rec.instances;
  }
  return [];
}

async function main(): Promise<void> {
  const args = parseArgs(argv.slice(2));
  if (args.provider !== "agent37") {
    stdout.write(`error: provider "${args.provider}" not yet supported (only agent37)\n`);
    exit(1);
  }
  const code = await reapAgent37(args);
  exit(code);
}

// Skip the CLI dispatch when imported by tests.
const isDirectRun = import.meta.url === `file://${argv[1]}`;
if (isDirectRun) {
  void main();
}
