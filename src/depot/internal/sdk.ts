import type { DepotRuntimeOptions } from "../config.js";

export interface DepotSandboxView {
  id: string;
  status?: string;
  name?: string;
  env: Record<string, string>;
  createdAt?: string;
}

export interface DepotCommandResult {
  commandId: string;
  output: string;
  exitCode: number;
}

export interface DepotClientLike {
  create(options: {
    name: string;
    env: Record<string, string>;
    imageRef?: string;
    resources?: { vcpus?: number; memoryMb?: number; diskGb?: number };
    timeoutMinutes?: number;
  }): Promise<DepotSandboxView>;
  get(id: string): Promise<DepotSandboxView | null>;
  execute(id: string, command: string, options?: {
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<DepotCommandResult>;
  upload(id: string, destination: string, content: Buffer): Promise<void>;
  download(id: string, source: string): Promise<Buffer>;
  kill(id: string): Promise<DepotSandboxView>;
}

export type DepotClientFactory = (
  options: DepotRuntimeOptions,
) => Promise<DepotClientLike> | DepotClientLike;

/** The only module that imports the vendor SDK. */
export async function createOfficialDepotClient(
  options: DepotRuntimeOptions,
): Promise<DepotClientLike> {
  const { createClient, Sandbox } = await import("@depot/sandbox");
  const client = createClient({
    token: options.token,
    ...(options.orgId ? { orgID: options.orgId } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });

  const view = (sandbox: Awaited<ReturnType<typeof Sandbox.get>>): DepotSandboxView => ({
    id: sandbox.sandboxId,
    status: sandbox.status,
    name: sandbox.name,
    env: { ...sandbox.env },
    ...(sandbox.createdAt ? { createdAt: sandbox.createdAt.toISOString() } : {}),
  });

  return {
    async create(params) {
      const sandbox = await Sandbox.create(client, {
        name: params.name,
        env: params.env,
        ...(params.imageRef ? { runtime: { imageRef: params.imageRef } } : {}),
        ...(params.resources ? { resources: params.resources } : {}),
        ...(params.timeoutMinutes ? { timeoutMinutes: params.timeoutMinutes } : {}),
      });
      return view(sandbox);
    },
    async get(id) {
      try {
        return view(await Sandbox.get(client, id));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async execute(id, command, execOptions = {}) {
      const sandbox = await Sandbox.get(client, id);
      const execution = await sandbox.runCommand({
        cmd: "/bin/sh",
        args: ["-lc", command],
        ...(execOptions.cwd ? { cwd: execOptions.cwd } : {}),
        ...(execOptions.env ? { env: execOptions.env } : {}),
      });
      const output = await execution.output("both");
      if (typeof execution.exitCode !== "number") {
        throw new Error(`Depot command "${execution.cmdId}" completed without an exit code`);
      }
      return { commandId: execution.cmdId, output, exitCode: execution.exitCode };
    },
    async upload(id, destination, content) {
      await (await Sandbox.get(client, id)).fs().writeFile(destination, content, {
        recursive: true,
      });
    },
    async download(id, source) {
      const content = await (await Sandbox.get(client, id)).fs().readFile(source);
      return Buffer.isBuffer(content) ? content : Buffer.from(content);
    },
    async kill(id) {
      const sandbox = await Sandbox.get(client, id);
      if (!isTerminal(sandbox.status)) {
        await sandbox.kill({ signal: "SIGKILL" });
      }
      return view(sandbox);
    },
  };
}

function isTerminal(status: string | undefined): boolean {
  return status === "finished" || status === "cancelled" || status === "failed";
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; rawCode?: unknown; status?: unknown };
  return record.code === 5 || record.rawCode === 5 || record.status === 404;
}
