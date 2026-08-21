/**
 * Vercel Sandbox live benchmark harness — vercel-adapter-0821.
 *
 * Run from the lane worktree:
 *   op run -- npx tsx scripts/vercel-bench.ts canary   # n=1
 *   op run -- npx tsx scripts/vercel-bench.ts full     # n=7 + burst probe
 *   op run -- npx tsx scripts/vercel-bench.ts sweep    # audit anything the lane owns
 *
 * Discipline this harness enforces, not merely intends:
 *  - LEDGER BEFORE USE. Every sandbox name is appended to the ledger and fsynced
 *    *before* the create call goes out, so a crash between submit and response
 *    still leaves a reapable record. A name we never wrote down is a name we
 *    cannot clean up.
 *  - BOUNDED COST. Hard caps on count, vCPUs and sandbox timeout. The run
 *    aborts rather than exceeding them.
 *  - VERIFIED GONE. Every sandbox is destroyed through the adapter's verified
 *    path, and the run ends with an independent prefix audit. destroyed and
 *    verifiedGone are reported as separate numbers; if they disagree, that is
 *    the finding.
 *
 * Credentials are read from the environment, which the operator populates from
 * 1Password at invocation time (`op run -- npx tsx ...`). Nothing here reaches
 * into a vault itself, and no credential is ever written to the ledger or the
 * results file.
 */

import { appendFileSync, closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { VercelSandboxRuntime } from "../src/vercel/runtime.js";

// --- bounds -----------------------------------------------------------------

const MAX_SANDBOXES = 16;          // absolute ceiling for one invocation
const MAX_VCPUS = 2;               // provider default; not raised for a benchmark
const SANDBOX_TIMEOUT_MS = 120_000; // every sandbox self-terminates in 2 minutes
const BURST_WIDTH = 8;             // concurrency probe width, inside MAX_SANDBOXES

const RUN_ID = process.env.BENCH_RUN_ID ?? `run-${Date.now().toString(36)}`;
const PREFIX = `awf-bench-${RUN_ID}`.slice(0, 40).toLowerCase();
const LEDGER = resolve(process.cwd(), `vercel-bench-${RUN_ID}.ledger`);
const RESULTS = resolve(process.cwd(), `vercel-bench-${RUN_ID}.json`);

// --- ledger -----------------------------------------------------------------

function ledger(event: string, name: string, extra: Record<string, unknown> = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, name, ...extra });
  const fd = openSync(LEDGER, "a");
  try {
    appendFileSync(fd, `${line}\n`);
    fsyncSync(fd); // durable before the API call, or the record is worthless
  } finally {
    closeSync(fd);
  }
}

// --- runtime ----------------------------------------------------------------

function runtime(): VercelSandboxRuntime {
  const token = process.env.VERCEL_TOKEN ?? process.env.VERCEL_OIDC_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId) {
    throw new Error(
      "Missing credentials. Vercel Sandbox needs VERCEL_TOKEN (or VERCEL_OIDC_TOKEN) "
        + "plus VERCEL_TEAM_ID and VERCEL_PROJECT_ID. Populate them from 1Password at "
        + "invocation time, e.g. `op run -- npx tsx vercel-bench.ts canary`.",
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

// --- measurement ------------------------------------------------------------

type Sample = {
  index: number;
  createMs: number;
  stateAfterCreate: string;
  firstExecMs: number;
  execExitCode: number | null;
  execOutput: string;
  vcpus?: number;
  memoryMiB?: number;
  activeCpuMs?: number;
  wallClockMs?: number;
  destroyMs?: number;
  destroyed: boolean;
  verifiedGone: boolean;
  error?: string;
};

async function measureOne(rt: VercelSandboxRuntime, index: number): Promise<Sample> {
  const sample: Sample = {
    index,
    createMs: NaN,
    stateAfterCreate: "unknown",
    firstExecMs: NaN,
    execExitCode: null,
    execOutput: "",
    destroyed: false,
    verifiedGone: false,
  };
  const intended = `${PREFIX}-s${index}`;
  ledger("intent", intended, { index });
  let handle;
  try {
    const t0 = performance.now();
    handle = await rt.launch({ name: intended, labels: { bench: RUN_ID } });
    sample.createMs = performance.now() - t0;
    sample.stateAfterCreate = handle.state ?? "unknown";
    ledger("created", handle.id, { createMs: Math.round(sample.createMs) });

    const t1 = performance.now();
    const exec = await rt.runScript(handle, {
      command: "nproc; free -m | awk '/Mem:/{print $2}'; echo READY",
      timeoutMs: 60_000,
    });
    sample.firstExecMs = performance.now() - t1;
    sample.execExitCode = exec.exitCode;
    sample.execOutput = exec.output.trim();

    // Delivered shape, straight from the provider's own listing.
    const owned = await rt.listOwned({ includeTerminated: true });
    const row = owned.find((entry) => entry.name === handle!.id);
    sample.vcpus = row?.vcpus;
    sample.memoryMiB = row?.memoryMiB;
    sample.activeCpuMs = row?.activeCpuMs;
    sample.wallClockMs = row?.wallClockMs;
  } catch (error) {
    sample.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    ledger("error", intended, { error: sample.error });
  } finally {
    if (handle) {
      const t2 = performance.now();
      try {
        await rt.destroy(handle); // verified: throws unless absence is confirmed
        sample.destroyMs = performance.now() - t2;
        sample.destroyed = true;
        sample.verifiedGone = true;
        ledger("destroyed-verified", handle.id, { destroyMs: Math.round(sample.destroyMs) });
      } catch (error) {
        sample.destroyed = true;
        sample.verifiedGone = false;
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        ledger("destroy-unverified", handle.id, { error: message });
      }
    }
  }
  return sample;
}

function percentile(values: number[], p: number): number {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * clean.length) - 1;
  return clean[Math.min(Math.max(rank, 0), clean.length - 1)]!;
}

/**
 * Cost for one sandbox-hour at the observed shape.
 *
 * Active CPU excludes I/O wait; provisioned memory does NOT — it is wall-clock.
 * That asymmetry is the whole point of the projection, so both lines are always
 * reported separately rather than as one blended number.
 */
function project(vcpus: number, utilisation: number) {
  const memoryGb = vcpus * 2;
  const cpu = vcpus * utilisation * 0.128;
  const memory = memoryGb * 0.0212;
  return {
    utilisation,
    cpuPerHour: Number(cpu.toFixed(4)),
    memoryPerHour: Number(memory.toFixed(4)),
    totalPerHour: Number((cpu + memory).toFixed(4)),
  };
}

// --- probes -----------------------------------------------------------------

async function burstProbe(rt: VercelSandboxRuntime) {
  ledger("burst-start", PREFIX, { width: BURST_WIDTH });
  const names = Array.from({ length: BURST_WIDTH }, (_, i) => `${PREFIX}-b${i}`);
  for (const name of names) ledger("intent", name, { burst: true });
  const settled = await Promise.allSettled(
    names.map((name) => rt.launch({ name, labels: { bench: RUN_ID, kind: "burst" } })),
  );
  const admitted = settled.filter((r) => r.status === "fulfilled").length;
  const rejections = settled
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => (r.reason instanceof Error ? `${r.reason.name}: ${r.reason.message}` : String(r.reason)));

  let verifiedGone = 0;
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    try {
      await rt.destroy(result.value);
      verifiedGone += 1;
      ledger("destroyed-verified", result.value.id, { burst: true });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      ledger("destroy-unverified", result.value.id, { burst: true, error: message });
    }
  }
  return {
    width: BURST_WIDTH,
    admitted,
    rejected: rejections.length,
    rejections: rejections.slice(0, 4),
    verifiedGone,
    // The provider's allocation rate ramps with sustained use and decays after
    // ~10 idle minutes, so this is the rate in force right now, not a ceiling.
    caveat: "dynamic vCPU allocation rate — measures the current rate, not a fixed cap",
  };
}

/** Independent audit: nothing under this lane's prefix may survive the run. */
async function sweep(rt: VercelSandboxRuntime) {
  const survivors = await rt.listOwned({ includeTerminated: true, states: null });
  for (const entry of survivors) {
    ledger("survivor", entry.name, { status: entry.providerStatus });
  }
  return survivors;
}

// --- main -------------------------------------------------------------------

async function main() {
  const mode = process.argv[2] ?? "canary";
  const rt = runtime();
  const started = new Date().toISOString();
  ledger("run-start", PREFIX, { mode, maxSandboxes: MAX_SANDBOXES, vcpus: MAX_VCPUS });

  const samples: Sample[] = [];
  let burst: Awaited<ReturnType<typeof burstProbe>> | null = null;

  try {
    if (mode === "sweep") {
      const survivors = await sweep(rt);
      console.log(JSON.stringify({ mode, survivors }, null, 2));
      return;
    }
    const n = mode === "full" ? 7 : 1;
    if (n + (mode === "full" ? BURST_WIDTH : 0) > MAX_SANDBOXES) {
      throw new Error("run would exceed MAX_SANDBOXES");
    }
    for (let i = 0; i < n; i += 1) {
      samples.push(await measureOne(rt, i));
    }
    if (mode === "full") {
      burst = await burstProbe(rt);
    }
  } finally {
    const survivors = await sweep(rt).catch(() => null);
    const createMs = samples.map((s) => s.createMs);
    const observedVcpus = samples.find((s) => s.vcpus)?.vcpus ?? MAX_VCPUS;
    const results = {
      runId: RUN_ID,
      prefix: PREFIX,
      mode,
      started,
      finished: new Date().toISOString(),
      sdk: "@vercel/sandbox@3.0.1",
      n: samples.length,
      coldCreate: {
        p50Ms: Math.round(percentile(createMs, 50)),
        p95Ms: Math.round(percentile(createMs, 95)),
        minMs: Math.round(Math.min(...createMs)),
        maxMs: Math.round(Math.max(...createMs)),
      },
      firstExecMs: {
        p50Ms: Math.round(percentile(samples.map((s) => s.firstExecMs), 50)),
        p95Ms: Math.round(percentile(samples.map((s) => s.firstExecMs), 95)),
      },
      readyStateAfterCreate: [...new Set(samples.map((s) => s.stateAfterCreate))],
      deliveredShape: {
        vcpus: [...new Set(samples.map((s) => s.vcpus).filter(Boolean))],
        memoryMiB: [...new Set(samples.map((s) => s.memoryMiB).filter(Boolean))],
        documented: "1 or even 2-32 vCPUs, default 2; 2 GB memory per vCPU",
      },
      cleanup: {
        created: samples.filter((s) => !Number.isNaN(s.createMs)).length,
        destroyed: samples.filter((s) => s.destroyed).length + (burst?.admitted ?? 0),
        verifiedGone: samples.filter((s) => s.verifiedGone).length + (burst?.verifiedGone ?? 0),
        survivorsAfterSweep: survivors?.length ?? "sweep-failed",
        survivors: survivors?.map((s) => s.name) ?? [],
      },
      burst,
      costProjection: {
        shape: `${observedVcpus} vCPU / ${observedVcpus * 2} GB`,
        note:
          "Active CPU excludes I/O wait; provisioned memory is billed on WALL CLOCK. "
          + "The memory line is a floor an idle-heavy agent cannot duck.",
        perHour: [1.0, 0.5, 0.1, 0.0].map((u) => project(observedVcpus, u)),
      },
      errors: samples.filter((s) => s.error).map((s) => ({ index: s.index, error: s.error })),
    };
    writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
    ledger("run-end", PREFIX, {
      destroyed: results.cleanup.destroyed,
      verifiedGone: results.cleanup.verifiedGone,
      survivors: results.cleanup.survivorsAfterSweep,
    });
    console.log(JSON.stringify(results, null, 2));
    console.log(`\nledger:  ${LEDGER}\nresults: ${RESULTS}`);
    if (survivors && survivors.length > 0) {
      console.error(`\nFAIL: ${survivors.length} sandbox(es) survived the run — see ledger.`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
