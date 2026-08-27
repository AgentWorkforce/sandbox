import { Buffer } from "node:buffer";

import type { KernelRuntimeOptions } from "../config.js";

export interface KernelBrowserView {
  id: string;
  name?: string;
  state: "active" | "deleted";
  tags: Record<string, string>;
  createdAt: string;
  timeoutSeconds: number;
}

export interface KernelExecView {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export interface KernelClientLike {
  create(options: {
    name: string;
    tags: Record<string, string>;
    timeoutSeconds: number;
  }): Promise<KernelBrowserView>;
  get(id: string): Promise<KernelBrowserView | null>;
  list(tags: Record<string, string>, pageSize?: number): Promise<KernelBrowserView[]>;
  execute(id: string, options: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutSeconds?: number;
  }): Promise<KernelExecView>;
  upload(id: string, destination: string, content: Buffer): Promise<void>;
  download(id: string, source: string): Promise<Buffer>;
  delete(id: string): Promise<void>;
}

export type KernelClientFactory = (
  options: KernelRuntimeOptions,
) => Promise<KernelClientLike> | KernelClientLike;

/** The only module that imports the vendor SDK. */
export async function createOfficialKernelClient(
  options: KernelRuntimeOptions,
): Promise<KernelClientLike> {
  const { Kernel } = await import("@onkernel/sdk");
  const sdk = new Kernel({
    apiKey: options.apiKey,
    ...(options.projectId ? { projectID: options.projectId } : {}),
    ...(options.project ? { project: options.project } : {}),
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.requestTimeoutMs ? { timeout: options.requestTimeoutMs } : {}),
  });

  const view = (browser: {
    session_id: string;
    name?: string;
    tags?: Record<string, string>;
    created_at: string;
    deleted_at?: string;
    timeout_seconds: number;
  }): KernelBrowserView => ({
    id: browser.session_id,
    ...(browser.name ? { name: browser.name } : {}),
    state: browser.deleted_at ? "deleted" : "active",
    tags: { ...(browser.tags ?? {}) },
    createdAt: browser.created_at,
    timeoutSeconds: browser.timeout_seconds,
  });

  return {
    async create(params) {
      return view(await sdk.browsers.create({
        name: params.name,
        tags: params.tags,
        timeout_seconds: params.timeoutSeconds,
      }));
    },
    async get(id) {
      try {
        return view(await sdk.browsers.retrieve(id));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async list(tags, pageSize) {
      const browsers: KernelBrowserView[] = [];
      const page = sdk.browsers.list({
        status: "active",
        tags,
        ...(pageSize ? { limit: pageSize } : {}),
      });
      for await (const browser of page) browsers.push(view(browser));
      return browsers;
    },
    async execute(id, execOptions) {
      const result = await sdk.browsers.process.exec(id, {
        command: execOptions.command,
        ...(execOptions.args ? { args: execOptions.args } : {}),
        ...(execOptions.cwd ? { cwd: execOptions.cwd } : {}),
        ...(execOptions.env ? { env: execOptions.env } : {}),
        ...(execOptions.timeoutSeconds !== undefined
          ? { timeout_sec: execOptions.timeoutSeconds }
          : {}),
      });
      return {
        stdout: decodeBase64(result.stdout_b64),
        stderr: decodeBase64(result.stderr_b64),
        ...(typeof result.exit_code === "number" ? { exitCode: result.exit_code } : {}),
      };
    },
    async upload(id, destination, content) {
      await sdk.browsers.fs.writeFile(id, content, { path: destination });
    },
    async download(id, source) {
      const response = await sdk.browsers.fs.readFile(id, { path: source });
      return Buffer.from(await response.arrayBuffer());
    },
    async delete(id) {
      try {
        await sdk.browsers.deleteByID(id);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  };
}

function decodeBase64(value: string | undefined): string {
  return value ? Buffer.from(value, "base64").toString("utf8") : "";
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "status" in error && (error as { status?: unknown }).status === 404;
}
