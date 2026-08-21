/**
 * Vercel Sandbox live benchmark — CLI.
 *
 *   op run -- npx tsx scripts/vercel-bench.ts canary   # n=1
 *   op run -- npx tsx scripts/vercel-bench.ts full     # n=7 + burst probe
 *   op run -- npx tsx scripts/vercel-bench.ts sweep    # audit only
 *
 * This file is deliberately thin: credentials, durable ledger I/O, and argv.
 * Every safety guard — ledger-before-use, the sandbox cap, verified cleanup,
 * the independent sweep — lives in `src/vercel/bench.ts` and is unit-tested
 * against a fake runtime in `src/vercel/bench.test.ts`. Guards that have never
 * been exercised are not guards, and the first place to find that out should
 * not be a real billing account.
 *
 * Credentials come from the environment, populated from 1Password at invocation
 * time via `op run`. Nothing here reaches into a vault, and no credential is
 * ever written to the ledger or the results file.
 */

import { appendFileSync, closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  runBenchmark,
  type BenchMode,
  type LedgerEvent,
} from "../src/vercel/bench.js";
import { VercelSandboxRuntime } from "../src/vercel/runtime.js";

const MAX_SANDBOXES = 16;
const MAX_VCPUS = 2; // the provider default; not raised for a benchmark
const BURST_WIDTH = 8;
const SANDBOX_TIMEOUT_MS = 120_000; // every sandbox self-terminates in 2 minutes

const RUN_ID = process.env.BENCH_RUN_ID ?? `run-${Date.now().toString(36)}`;
const PREFIX = `awf-bench-${RUN_ID}`.slice(0, 40).toLowerCase();
const LEDGER = resolve(process.cwd(), `vercel-bench-${RUN_ID}.ledger`);
const RESULTS = resolve(process.cwd(), `vercel-bench-${RUN_ID}.json`);

/**
 * Append and fsync. The fsync is the point: an entry still sitting in the page
 * cache when the process dies is an entry that was never written, and the whole
 * reason to ledger before creating is to survive exactly that crash.
 */
function ledger(entry: LedgerEvent): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  const fd = openSync(LEDGER, "a");
  try {
    appendFileSync(fd, `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function runtime(): VercelSandboxRuntime {
  const token = process.env.VERCEL_TOKEN ?? process.env.VERCEL_OIDC_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId) {
    throw new Error(
      "Missing credentials. Vercel Sandbox needs VERCEL_TOKEN (or "
        + "VERCEL_OIDC_TOKEN) plus VERCEL_TEAM_ID and VERCEL_PROJECT_ID. "
        + "Populate them at invocation time, e.g. "
        + "`op run -- npx tsx scripts/vercel-bench.ts canary`.",
    );
  }
  return new VercelSandboxRuntime({
    token,
    teamId,
    projectId,
    namePrefix: PREFIX,
    defaultHomeDir: "/vercel/sandbox",
    vcpus: MAX_VCPUS,
    sandboxTimeoutMs: SANDBOX_TIMEOUT_MS,
    createTimeoutMs: 180_000,
    lookupTimeoutMs: 20_000,
    execTimeoutMs: 60_000,
    deleteTimeoutMs: 90_000,
    retryDeadlineMs: 180_000,
    pollIntervalMs: 750,
  });
}

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? "canary") as BenchMode;
  if (!["canary", "full", "sweep"].includes(mode)) {
    throw new Error(`unknown mode "${mode}"; expected canary, full, or sweep`);
  }
  const report = await runBenchmark(
    {
      runtime: runtime(),
      ledger,
      prefix: PREFIX,
      runId: RUN_ID,
      limits: {
        maxSandboxes: MAX_SANDBOXES,
        vcpus: MAX_VCPUS,
        burstWidth: BURST_WIDTH,
      },
    },
    mode,
  );

  writeFileSync(RESULTS, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nledger:  ${LEDGER}\nresults: ${RESULTS}`);

  if (!report.clean) {
    console.error(
      `\nFAIL: cleanup was not clean — destroyed ${report.cleanup.destroyed}, `
        + `verified gone ${report.cleanup.verifiedGone}, `
        + `survivors ${report.cleanup.survivors.length}. See the ledger.`,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
