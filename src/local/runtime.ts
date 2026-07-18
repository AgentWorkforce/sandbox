import { Buffer } from "node:buffer";

import type { RuntimeHandle } from "../types.js";
import type {
  AsyncRunStartResult,
  AsyncRunStatus,
  RunScriptResult,
  SandboxCountOptions,
  SandboxLookupOptions,
  SandboxRuntime,
} from "../port.js";

export type LocalSandboxRuntimeOptions = {
  baseUrl: string;
  authToken: string;
};

const DEFAULT_LOCAL_SANDBOX_LOOKUP_TIMEOUT_MS = 10_000;

type LocalSandboxRecord = {
  id?: string;
  sandboxId?: string;
  state?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
  homeDir?: string;
  workdir?: string;
};

export class LocalSandboxRuntime implements SandboxRuntime {
  readonly id = "local";

  // Both true, declared explicitly rather than by omission so the reasoning is
  // on the record: `start`/`stop` issue real HTTP and only degrade to a no-op
  // when the mini-sandbox server answers 501, and `findAllByLabels` is a real
  // server-side query. Declaring lifecycle false here would make the delivery
  // path skip stop calls that a capable server does honor.
  readonly declaredCapabilities = { warmLease: true, lifecycle: true } as const;

  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor(options: LocalSandboxRuntimeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.authToken = options.authToken;
  }

  async findByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle | null> {
    const handles = await this.findAllByLabels(labels, options);
    const excludedIds = new Set(options.excludeIds ?? []);
    return handles.find((handle) => !excludedIds.has(handle.id)) ?? null;
  }

  async findAllByLabels(
    labels: Record<string, string>,
    options: SandboxLookupOptions = {},
  ): Promise<RuntimeHandle[]> {
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const limit = options.limit ?? options.pageSize;
    const handles: RuntimeHandle[] = [];
    let cursor: string | undefined;
    do {
      const url = new URL(`${this.baseUrl}/sandboxes`);
      for (const [key, value] of Object.entries(labels)) {
        url.searchParams.append(key, value);
        url.searchParams.append(`label.${key}`, value);
      }
      if (limit) {
        url.searchParams.set("limit", String(limit));
      }
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }

      const response = await globalThis.fetch(url, {
        headers: this.headers(),
      });
      if (response.status === 404 || response.status === 501) {
        return handles;
      }
      await assertOk(response, "find local sandbox");
      const body = await response.json() as {
        items?: LocalSandboxRecord[];
        sandboxes?: LocalSandboxRecord[];
        nextCursor?: unknown;
        nextToken?: unknown;
      };
      const items = body.items ?? body.sandboxes ?? [];
      handles.push(
        ...items
          .filter((item) => matchesState(item, states))
          .map((item) => handleFromLocalRecord(item)),
      );
      cursor = readNextCursor(body, cursor);
    } while (cursor);
    return handles;
  }

  async countByLabels(
    labels: Record<string, string>,
    options: SandboxCountOptions = {},
  ): Promise<number> {
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const maxCount = options.maxCount === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.maxCount));
    if (maxCount === 0) {
      return 0;
    }
    const configuredPageSize = options.limit ?? options.pageSize;
    const deadline = localSandboxLookupDeadline(options.timeoutMs);
    let count = 0;
    let cursor: string | undefined;

    do {
      const url = new URL(`${this.baseUrl}/sandboxes`);
      for (const [key, value] of Object.entries(labels)) {
        url.searchParams.append(key, value);
        url.searchParams.append(`label.${key}`, value);
      }
      const remainingCount = Number.isFinite(maxCount) ? maxCount - count : undefined;
      const requestLimit = remainingCount === undefined
        ? configuredPageSize
        : Math.min(configuredPageSize ?? remainingCount, remainingCount);
      if (requestLimit) {
        url.searchParams.set("limit", String(requestLimit));
      }
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }

      const response = await awaitLocalSandboxLookupOperation(
        globalThis.fetch(url, { headers: this.headers() }),
        deadline,
        "counting matching sandboxes",
      );
      if (response.status === 404 || response.status === 501) {
        return count;
      }
      await awaitLocalSandboxLookupOperation(
        assertOk(response, "count local sandboxes"),
        deadline,
        "checking the local sandbox count response",
      );
      const body = await awaitLocalSandboxLookupOperation(
        response.json() as Promise<{
          items?: LocalSandboxRecord[];
          sandboxes?: LocalSandboxRecord[];
          nextCursor?: unknown;
          nextToken?: unknown;
        }>,
        deadline,
        "reading the local sandbox count response",
      );
      for (const item of body.items ?? body.sandboxes ?? []) {
        if (!matchesState(item, states)) {
          continue;
        }
        count += 1;
        if (count >= maxCount) {
          return count;
        }
      }
      cursor = readNextCursor(body, cursor);
    } while (cursor);
    return count;
  }

  async launch(options: {
    name?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    createTimeoutSeconds?: number;
  } = {}): Promise<RuntimeHandle> {
    const response = await globalThis.fetch(`${this.baseUrl}/sandboxes`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        name: options.name,
        env: options.env ?? {},
        envVars: options.env ?? {},
        labels: options.labels ?? {},
        timeoutSeconds: options.createTimeoutSeconds,
      }),
    });
    await assertOk(response, "create local sandbox");
    return handleFromLocalRecord(await response.json() as LocalSandboxRecord);
  }

  async launchDetached(options: {
    name?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    createTimeoutSeconds?: number;
  } = {}): Promise<RuntimeHandle> {
    return this.launch(options);
  }

  async getById(
    id: string,
    options: { states?: readonly string[] | null; owned?: boolean } = {},
  ): Promise<RuntimeHandle | null> {
    const response = await globalThis.fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    });
    if (response.status === 404) {
      return null;
    }
    await assertOk(response, "get local sandbox");
    const handle = handleFromLocalRecord(await response.json() as LocalSandboxRecord);
    return matchesState(handle, options.states === undefined ? null : options.states) ? handle : null;
  }

  async uploadBundle(handle: RuntimeHandle, options: {
    files: Array<{ source: string | Buffer; destination: string }>;
  }): Promise<void> {
    const response = await globalThis.fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}/files`, {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify({
        entries: options.files.map((file) => ({
          source: Buffer.isBuffer(file.source)
            ? file.source.toString("base64")
            : Buffer.from(file.source, "utf8").toString("base64"),
          destination: file.destination,
        })),
      }),
    });
    await assertOk(response, "upload local sandbox files");
  }

  async runScript(handle: RuntimeHandle, options: {
    command: string;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<RunScriptResult> {
    const response = await globalThis.fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}/exec`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        command: options.command,
        sessionId: options.sessionId,
        env: options.env,
        timeoutSeconds: options.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined,
      }),
    });
    await assertOk(response, "execute local sandbox command");
    const body = await response.json() as Partial<RunScriptResult> & {
      result?: string;
    };
    return {
      output: body.output ?? body.stdout ?? body.stderr ?? body.result ?? "",
      ...(body.stdout ? { stdout: body.stdout } : {}),
      ...(body.stderr ? { stderr: body.stderr } : {}),
      exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
      ...(body.cmdId ? { cmdId: body.cmdId } : {}),
    };
  }

  async startScript(handle: RuntimeHandle, options: {
    command: string;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    suppressInputEcho?: boolean;
  }): Promise<AsyncRunStartResult> {
    const response = await globalThis.fetch(
      `${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}/exec/async`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          command: options.command,
          sessionId: options.sessionId,
          env: options.env,
          timeoutSeconds: options.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined,
        }),
      },
    );
    await assertOk(response, "start local sandbox command");
    const body = await response.json() as Partial<AsyncRunStartResult>;
    if (!body.sessionId || !body.commandId) {
      throw new Error("Local sandbox async command did not return sessionId and commandId");
    }
    return { sessionId: body.sessionId, commandId: body.commandId };
  }

  async getScriptStatus(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<AsyncRunStatus> {
    const response = await globalThis.fetch(
      this.asyncExecUrl(handle, sessionId, commandId),
      { headers: this.headers() },
    );
    await assertOk(response, "inspect local sandbox command");
    const body = await response.json() as Partial<AsyncRunStatus>;
    return { exitCode: typeof body.exitCode === "number" ? body.exitCode : null };
  }

  async getScriptLogs(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<RunScriptResult> {
    const response = await globalThis.fetch(
      `${this.asyncExecUrl(handle, sessionId, commandId)}/logs`,
      { headers: this.headers() },
    );
    await assertOk(response, "read local sandbox command logs");
    const body = await response.json() as Partial<RunScriptResult>;
    return {
      output: body.output ?? body.stdout ?? body.stderr ?? "",
      ...(typeof body.stdout === "string" ? { stdout: body.stdout } : {}),
      ...(typeof body.stderr === "string" ? { stderr: body.stderr } : {}),
      exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
      cmdId: body.cmdId ?? commandId,
    };
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    const response = await globalThis.fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (response.status === 404) {
      return;
    }
    await assertOk(response, "delete local sandbox");
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    const response = await globalThis.fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}/stop`, {
      method: "POST",
      headers: this.headers(),
    });
    if (response.status === 404 || response.status === 501) {
      return;
    }
    await assertOk(response, "stop local sandbox");
  }

  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const response = await globalThis.fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}/start`, {
      method: "POST",
      headers: this.headers(),
    });
    if (response.status === 404 || response.status === 501) {
      return handle;
    }
    await assertOk(response, "start local sandbox");
    const body = await response.json().catch(() => null) as LocalSandboxRecord | null;
    return body ? handleFromLocalRecord(body) : { ...handle, state: "STARTED" };
  }

  private headers(json = false): Record<string, string> {
    return {
      authorization: `Bearer ${this.authToken}`,
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  private asyncExecUrl(handle: RuntimeHandle, sessionId: string, commandId: string): string {
    return `${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}/exec/async/${encodeURIComponent(sessionId)}/${encodeURIComponent(commandId)}`;
  }
}

function handleFromLocalRecord(record: LocalSandboxRecord): RuntimeHandle {
  const id = record.sandboxId ?? record.id;
  if (!id) {
    throw new Error("Local sandbox response is missing sandboxId");
  }
  return {
    id,
    ...((record.state ?? record.status) ? { state: record.state ?? record.status } : {}),
    ...(record.createdAt ? { createdAt: record.createdAt } : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    ...(record.lastActivityAt ? { lastActivityAt: record.lastActivityAt } : {}),
    ...(record.homeDir ? { homeDir: record.homeDir } : {}),
    ...(record.workdir ? { workdir: record.workdir } : {}),
  };
}

function readNextCursor(
  body: { nextCursor?: unknown; nextToken?: unknown; cursor?: unknown },
  currentCursor?: string,
): string | undefined {
  for (const value of [body.nextCursor, body.nextToken, body.cursor]) {
    if (typeof value === "string" && value.length > 0 && value !== currentCursor) {
      return value;
    }
  }
  return undefined;
}

function matchesState(record: LocalSandboxRecord, states: readonly string[] | null): boolean {
  if (states === null) {
    return true;
  }
  const rawState = (record.state ?? record.status ?? "STARTED").toUpperCase();
  const state = rawState === "RUNNING" ? "STARTED" : rawState;
  return states.includes(state);
}

type LocalSandboxLookupDeadline = {
  endsAt: number;
  timeoutMs: number;
};

function localSandboxLookupDeadline(timeoutMs: number | undefined): LocalSandboxLookupDeadline {
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_LOCAL_SANDBOX_LOOKUP_TIMEOUT_MS;
  const normalizedTimeoutMs = Number.isFinite(effectiveTimeoutMs) && effectiveTimeoutMs > 0
    ? Math.max(1, Math.ceil(effectiveTimeoutMs))
    : DEFAULT_LOCAL_SANDBOX_LOOKUP_TIMEOUT_MS;
  return {
    endsAt: Date.now() + normalizedTimeoutMs,
    timeoutMs: normalizedTimeoutMs,
  };
}

async function awaitLocalSandboxLookupOperation<T>(
  operation: Promise<T>,
  deadline: LocalSandboxLookupDeadline,
  description: string,
): Promise<T> {
  const remainingMs = deadline.endsAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error(
      `Local sandbox lookup exceeded ${deadline.timeoutMs}ms while ${description}`,
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(
            `Local sandbox lookup exceeded ${deadline.timeoutMs}ms while ${description}`,
          ));
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function assertOk(response: Response, action: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const body = await response.text().catch(() => "");
  throw new Error(`Failed to ${action}: HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
}
