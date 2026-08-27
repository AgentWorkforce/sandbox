import { basename } from "node:path";

import type { RunloopRuntimeOptions } from "../config.js";

export type RunloopDevboxState =
  | "scheduled"
  | "queued"
  | "provisioning"
  | "initializing"
  | "running"
  | "suspending"
  | "suspended"
  | "resuming"
  | "failure"
  | "shutdown"
  | string;

export interface RunloopDevboxView {
  id: string;
  status: RunloopDevboxState;
  metadata: Record<string, string>;
  create_time_ms?: number;
  name?: string | null;
}

export interface RunloopExecutionView {
  execution_id: string;
  status: "queued" | "running" | "completed" | string;
  exit_status?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  stdout_truncated?: boolean | null;
  stderr_truncated?: boolean | null;
}

export interface RunloopClientLike {
  create(options: {
    name?: string;
    environment_variables?: Record<string, string>;
    metadata: Record<string, string>;
    blueprint_id?: string;
    blueprint_name?: string;
    snapshot_id?: string;
  }): Promise<RunloopDevboxView>;
  get(id: string): Promise<RunloopDevboxView | null>;
  list(limit?: number): Promise<RunloopDevboxView[]>;
  executeAsync(id: string, command: string, shellName?: string): Promise<RunloopExecutionView>;
  getExecution(id: string, executionId: string): Promise<RunloopExecutionView>;
  killExecution(id: string, executionId: string): Promise<void>;
  upload(id: string, destination: string, content: Buffer): Promise<void>;
  download(id: string, source: string): Promise<Buffer>;
  suspend(id: string): Promise<RunloopDevboxView>;
  resume(id: string): Promise<RunloopDevboxView>;
  shutdown(id: string): Promise<void>;
}

export type RunloopClientFactory = (
  options: RunloopRuntimeOptions,
) => Promise<RunloopClientLike> | RunloopClientLike;

/** The only module that imports the vendor SDK. */
export async function createOfficialRunloopClient(
  options: RunloopRuntimeOptions,
): Promise<RunloopClientLike> {
  const { RunloopSDK, toFile } = await import("@runloop/api-client");
  const sdk = new RunloopSDK({
    bearerToken: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.requestTimeoutMs ? { timeout: options.requestTimeoutMs } : {}),
  });

  return {
    async create(params) {
      const devbox = await sdk.devbox.create(params);
      return await devbox.getInfo() as RunloopDevboxView;
    },
    async get(id) {
      try {
        return await sdk.devbox.fromId(id).getInfo() as RunloopDevboxView;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async list(limit) {
      const page = await sdk.api.devboxes.list({ include_total_count: false });
      const devboxes: RunloopDevboxView[] = [];
      for await (const devbox of page) {
        devboxes.push(devbox as RunloopDevboxView);
        if (limit !== undefined && devboxes.length >= limit) break;
      }
      return devboxes;
    },
    async executeAsync(id, command, shellName) {
      return await sdk.api.devboxes.executions.executeAsync(id, {
        command,
        ...(shellName ? { shell_name: shellName } : {}),
      }) as RunloopExecutionView;
    },
    async getExecution(id, executionId) {
      return await sdk.api.devboxes.executions.retrieve(
        id,
        executionId,
        { last_n: "1000000" },
      ) as RunloopExecutionView;
    },
    async killExecution(id, executionId) {
      await sdk.api.devboxes.executions.kill(id, executionId, {
        kill_process_group: true,
      });
    },
    async upload(id, destination, content) {
      await sdk.devbox.fromId(id).file.upload({
        path: destination,
        file: await toFile(content, basename(destination) || "upload.bin"),
      });
    },
    async download(id, source) {
      const response = await sdk.devbox.fromId(id).file.download({ path: source });
      return Buffer.from(await response.arrayBuffer());
    },
    async suspend(id) {
      const devbox = sdk.devbox.fromId(id);
      await devbox.suspend();
      return await devbox.awaitSuspended() as RunloopDevboxView;
    },
    async resume(id) {
      return await sdk.devbox.fromId(id).resume() as RunloopDevboxView;
    },
    async shutdown(id) {
      await sdk.devbox.fromId(id).shutdown();
    },
  };
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = "status" in error ? (error as { status?: unknown }).status : undefined;
  return status === 404;
}
