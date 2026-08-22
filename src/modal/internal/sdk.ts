/**
 * The only module in this package that imports the Modal SDK.
 *
 * Everything the adapter uses is expressed here as a structural interface, so
 * `runtime.ts` depends on shapes rather than on the vendor package. That
 * matters more for Modal than for a REST provider: the official SDK speaks
 * **gRPC** (`nice-grpc` / `protobufjs` / `cbor-x`), so there is no HTTP layer
 * to intercept and no injectable `fetch` seam of the kind the Agent37 client
 * uses. Structural interfaces plus a factory are the only way to keep the
 * adapter's tests off the wire.
 *
 * Pinned surface: `modal@0.9.0` (modal-labs/libmodal), published 2026-07-09,
 * Apache-2.0.
 *   integrity sha512-kCXcdJkhbJorf/q/6T9Wdlg6in9JmRnCNQnV6rVBMyeqNV/iXI6BYk4IzY4cvZ6dbauNeDMjk/Q08cbxvoIaXg==
 *   gitHead  79b729fb75abdde51d1130d3a7347416a5da75b6
 *   docs     https://modal.com/docs/sdk/js/latest/Sandbox
 * The declarations below were read from that release's shipped `index.d.ts`,
 * whose tarball SHA-1 was verified against the registry's `dist.shasum`.
 *
 * The SDK is a `0.x` beta and its own README warns that breaking changes ship
 * in `0.X.0` releases, which is why the peer range is pinned narrowly.
 */

import type { ResolvedModalRuntimeOptions } from "../config.js";

/** A Modal App. Opaque: the adapter only ever passes it back to `create`. */
export interface ModalAppLike {
  readonly appId?: string;
}

/** A Modal Image. Opaque: the adapter only ever passes it back to `create`. */
export interface ModalImageLike {
  readonly imageId?: string;
}

/** A drainable output stream. Modal's `ModalReadStream` satisfies this. */
export interface ModalReadStreamLike {
  readText(): Promise<string>;
}

/**
 * A running exec.
 *
 * Note what is *absent*: there is no public way to re-resolve a
 * `ContainerProcess` from an id later. Its `execId` reattach path is marked
 * `@ignore` in the SDK and is not exported. That absence is why this adapter
 * declines to implement the port's async-exec trio — see `runtime.ts`.
 */
export interface ModalContainerProcessLike {
  readonly stdout: ModalReadStreamLike;
  readonly stderr: ModalReadStreamLike;
  wait(): Promise<number>;
}

/** The subset of Modal's `SandboxFilesystem` the adapter uses. */
export interface ModalFilesystemLike {
  writeBytes(data: Uint8Array, remotePath: string): Promise<void>;
  readBytes(remotePath: string): Promise<Uint8Array>;
  makeDirectory(remotePath: string, options?: { createParents?: boolean }): Promise<void>;
}

export interface ModalExecParams {
  workdir?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore";
}

/** The subset of Modal's `Sandbox` the adapter uses. */
export interface ModalSandboxLike {
  readonly sandboxId: string;
  readonly filesystem: ModalFilesystemLike;
  /**
   * Note the signature: Modal takes an **argv array**, not a shell string.
   * The adapter is responsible for wrapping caller commands.
   */
  exec(command: string[], params?: ModalExecParams): Promise<ModalContainerProcessLike>;
  /**
   * Terminate the sandbox. With `{ wait: true }` Modal resolves only once the
   * sandbox has actually finished and returns its exit code — the provider's
   * own verified-gone signal, which the adapter prefers over polling.
   */
  terminate(params?: { wait?: boolean }): Promise<number | void>;
  /** `null` while running; the exit code once finished. */
  poll(): Promise<number | null>;
  wait(): Promise<number>;
  setTags(tags: Record<string, string>): Promise<void>;
  getTags(): Promise<Record<string, string>>;
}

export interface ModalSandboxCreateParams {
  name?: string;
  tags?: Record<string, string>;
  env?: Record<string, string>;
  command?: string[];
  workdir?: string;
  /** Maximum sandbox lifetime. Modal terminates the sandbox once it elapses. */
  timeoutMs?: number;
  idleTimeoutMs?: number;
  cpu?: number;
  cpuLimit?: number;
  memoryMiB?: number;
  memoryLimitMiB?: number;
  cloud?: string;
  regions?: string[];
  blockNetwork?: boolean;
}

export interface ModalSandboxListParams {
  appId?: string;
  tags?: Record<string, string>;
  environment?: string;
}

export interface ModalSandboxServiceLike {
  create(
    app: ModalAppLike,
    image: ModalImageLike,
    params?: ModalSandboxCreateParams,
  ): Promise<ModalSandboxLike>;
  fromId(sandboxId: string): Promise<ModalSandboxLike>;
  /** Server-side tag filter: yields only sandboxes carrying *all* given tags. */
  list(params?: ModalSandboxListParams): AsyncIterable<ModalSandboxLike>;
}

export interface ModalClientLike {
  readonly apps: {
    fromName(
      name: string,
      params?: { environment?: string; createIfMissing?: boolean },
    ): Promise<ModalAppLike>;
  };
  readonly images: {
    fromRegistry(tag: string): ModalImageLike;
  };
  readonly sandboxes: ModalSandboxServiceLike;
  /** Closes the gRPC channel. Not optional in practice: see `runtime.ts`. */
  close(): void;
}

/** Injection seam. The adapter never constructs a vendor client directly. */
export type ModalClientFactory = (
  options: ResolvedModalRuntimeOptions,
) => Promise<ModalClientLike> | ModalClientLike;

/**
 * Construct the official client.
 *
 * Credentials are passed explicitly rather than left to the SDK's ambient
 * resolution (`~/.modal.toml`, `MODAL_TOKEN_*`). The SDK will happily fall back
 * to a developer's local profile if `tokenId`/`tokenSecret` are omitted, which
 * would make this adapter silently use whatever account the host happens to be
 * logged into. Passing both explicitly closes that path.
 */
export async function createOfficialModalClient(
  options: ResolvedModalRuntimeOptions,
): Promise<ModalClientLike> {
  const { ModalClient } = await import("modal");
  // Deliberately a *checked* assignment, not an `as unknown as` cast.
  //
  // Every declaration in this module is a hand-written mirror of a vendor type,
  // and the SDK is a 0.x beta that ships breaking changes in minor releases.
  // A blind cast would let the real surface drift away from this mirror and
  // fail at runtime, in production, against a live sandbox. Assigning through
  // the structural type instead makes any drift a build error here, which is
  // the whole reason the boundary exists.
  const client: ModalClientLike = new ModalClient({
    tokenId: options.credentials.tokenId,
    tokenSecret: options.credentials.tokenSecret,
    timeoutMs: options.requestTimeoutMs,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
  });
  return client;
}
