import type { BlaxelRuntimeOptions } from "../config.js";

export interface BlaxelSandboxView {
  id: string;
  state?: string;
  labels: Record<string, string>;
  createdAt?: string;
}

export interface BlaxelProcessView {
  id: string;
  status: string;
  exitCode?: number;
  output: string;
  stdout?: string;
  stderr?: string;
}

export interface BlaxelClientLike {
  create(options: {
    name: string;
    image?: string;
    memoryMb?: number;
    env?: Record<string, string>;
    labels: Record<string, string>;
    maxAge: string;
    expiresAt?: string;
    terminatedRetention?: string;
  }): Promise<BlaxelSandboxView>;
  get(id: string): Promise<BlaxelSandboxView | null>;
  list(): Promise<BlaxelSandboxView[]>;
  execute(id: string, options: {
    command: string;
    name?: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutSeconds?: number;
    waitForCompletion: boolean;
  }): Promise<BlaxelProcessView>;
  getProcess(id: string, processId: string): Promise<BlaxelProcessView>;
  getProcessLogs(id: string, processId: string): Promise<string>;
  killProcess(id: string, processId: string): Promise<void>;
  upload(id: string, destination: string, content: Buffer): Promise<void>;
  download(id: string, source: string): Promise<Buffer>;
  delete(id: string): Promise<void>;
}

export type BlaxelClientFactory = (
  options: BlaxelRuntimeOptions,
) => Promise<BlaxelClientLike> | BlaxelClientLike;

let settingsQueue: Promise<void> = Promise.resolve();

/** The only module that imports the vendor SDK. */
export async function createOfficialBlaxelClient(
  options: BlaxelRuntimeOptions,
): Promise<BlaxelClientLike> {
  const { SandboxInstance, settings } = await import("@blaxel/core");
  const configured = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = settingsQueue;
    let release!: () => void;
    settingsQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      settings.setConfig({ apiKey: options.apiKey, workspace: options.workspace });
      return await operation();
    } finally {
      release();
    }
  };

  const view = (sandbox: InstanceType<typeof SandboxInstance>): BlaxelSandboxView => ({
    id: sandbox.metadata.name,
    state: sandbox.status,
    labels: { ...(sandbox.metadata.labels ?? {}) },
    ...(sandbox.metadata.createdAt ? { createdAt: sandbox.metadata.createdAt } : {}),
  });
  const processView = (process: {
    pid: string;
    status: string;
    exitCode?: number;
    logs?: string;
    stdout?: string;
    stderr?: string;
  }): BlaxelProcessView => ({
    id: process.pid,
    status: process.status,
    ...(typeof process.exitCode === "number" ? { exitCode: process.exitCode } : {}),
    output: process.logs ?? combinedOutput(process.stdout ?? "", process.stderr ?? ""),
    ...(process.stdout !== undefined ? { stdout: process.stdout } : {}),
    ...(process.stderr !== undefined ? { stderr: process.stderr } : {}),
  });

  return {
    async create(params) {
      return await configured(async () => {
        const expirationPolicies: Array<{ action: "delete"; type: "ttl-max-age" | "date"; value: string }> = [
          { action: "delete", type: "ttl-max-age", value: params.maxAge },
        ];
        if (params.expiresAt) {
          expirationPolicies.push({ action: "delete", type: "date", value: params.expiresAt });
        }
        const sandbox = await SandboxInstance.create({
          name: params.name,
          ...(params.image ? { image: params.image } : {}),
          ...(params.memoryMb ? { memory: params.memoryMb } : {}),
          ...(params.env
            ? { envs: Object.entries(params.env).map(([name, value]) => ({ name, value })) }
            : {}),
          labels: params.labels,
          lifecycle: {
            expirationPolicies,
            ...(params.terminatedRetention
              ? { terminatedRetention: params.terminatedRetention }
              : {}),
          },
        });
        await sandbox.wait();
        return view(sandbox);
      });
    },
    async get(id) {
      return await configured(async () => {
        try {
          return view(await SandboxInstance.get(id));
        } catch (error) {
          if (isNotFound(error)) return null;
          throw error;
        }
      });
    },
    async list() {
      return await configured(async () => {
        const page = await SandboxInstance.list({ showTerminated: true, limit: 100 });
        const sandboxes: BlaxelSandboxView[] = [];
        for await (const sandbox of page) sandboxes.push(view(sandbox));
        return sandboxes;
      });
    },
    async execute(id, execOptions) {
      return await configured(async () => {
        const sandbox = await SandboxInstance.get(id);
        const response = await sandbox.process.exec({
          command: execOptions.command,
          ...(execOptions.name ? { name: execOptions.name } : {}),
          ...(execOptions.cwd ? { workingDir: execOptions.cwd } : {}),
          ...(execOptions.env ? { env: execOptions.env } : {}),
          ...(execOptions.timeoutSeconds !== undefined
            ? { timeout: execOptions.timeoutSeconds }
            : {}),
          waitForCompletion: execOptions.waitForCompletion,
        });
        return processView(response);
      });
    },
    async getProcess(id, processId) {
      return await configured(async () => processView(
        await (await SandboxInstance.get(id)).process.get(processId),
      ));
    },
    async getProcessLogs(id, processId) {
      return await configured(async () => await (
        await SandboxInstance.get(id)
      ).process.logs(processId, "all"));
    },
    async killProcess(id, processId) {
      await configured(async () => {
        await (await SandboxInstance.get(id)).process.kill(processId);
      });
    },
    async upload(id, destination, content) {
      await configured(async () => {
        await (await SandboxInstance.get(id)).fs.writeBinary(destination, content);
      });
    },
    async download(id, source) {
      return await configured(async () => {
        const blob = await (await SandboxInstance.get(id)).fs.readBinary(source);
        return Buffer.from(await blob.arrayBuffer());
      });
    },
    async delete(id) {
      await configured(async () => {
        try {
          await SandboxInstance.delete(id);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      });
    },
  };
}

function combinedOutput(stdout: string, stderr: string): string {
  if (!stdout) return stderr;
  if (!stderr) return stdout;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  return record.status === 404 || record.response?.status === 404;
}
