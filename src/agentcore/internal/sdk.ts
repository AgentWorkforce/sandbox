import type { AgentCoreCredentials } from "../config.js";

/**
 * The vendor SDK boundary.
 *
 * This is the only module in the package that imports
 * `@aws-sdk/client-bedrock-agentcore` or
 * `@aws-sdk/client-bedrock-agentcore-control`, and both imports are dynamic
 * so the dependency stays genuinely optional. Everything above this file
 * talks to the structural `*Like` interfaces below, which is what makes the
 * adapter testable without either SDK installed and pinnable to one version.
 *
 * AWS splits this surface across two services on purpose: the control plane
 * (`bedrock-agentcore-control`) manages the code interpreter *resource*
 * (create/get/delete/list), and the data plane (`bedrock-agentcore`) manages
 * *sessions* against that resource (start/get/stop/list/invoke). This
 * module keeps that split rather than flattening it, because the two planes
 * have different quotas, different endpoints, and — relevant to the
 * idle-billing question this adapter exists partly to answer — different
 * billing meters.
 */

// --- shared -----------------------------------------------------------

export type AgentCoreInterpreterStatus =
  | "CREATING"
  | "CREATE_FAILED"
  | "READY"
  | "DELETING"
  | "DELETE_FAILED"
  | "DELETED"
  | (string & {});

/** Per `GetCodeInterpreterSession`'s documented `Valid Values`. */
export type AgentCoreSessionStatus = "READY" | "TERMINATED" | (string & {});

export type AgentCoreNetworkMode = "VPC" | "SANDBOX" | "PUBLIC";

export interface AgentCoreVpcConfigParams {
  subnets: string[];
  securityGroups: string[];
  requireServiceS3Endpoint?: boolean;
}

export interface AgentCoreNetworkConfigParams {
  networkMode: AgentCoreNetworkMode;
  vpcConfig?: AgentCoreVpcConfigParams;
}

// --- control plane ------------------------------------------------------

export interface AgentCoreCreateInterpreterParams {
  name: string;
  description?: string;
  executionRoleArn?: string;
  networkConfiguration: AgentCoreNetworkConfigParams;
  tags?: Record<string, string>;
  clientToken?: string;
  abortSignal?: AbortSignal;
}

export interface AgentCoreCreateInterpreterResult {
  codeInterpreterArn: string;
  codeInterpreterId: string;
  createdAt?: Date;
  status: AgentCoreInterpreterStatus;
}

export interface AgentCoreGetInterpreterResult {
  codeInterpreterId: string;
  codeInterpreterArn?: string;
  status: AgentCoreInterpreterStatus;
  executionRoleArn?: string;
  networkConfiguration?: AgentCoreNetworkConfigParams;
  createdAt?: Date;
  lastUpdatedAt?: Date;
}

export interface AgentCoreControlApiLike {
  createCodeInterpreter(
    params: AgentCoreCreateInterpreterParams,
  ): Promise<AgentCoreCreateInterpreterResult>;
  getCodeInterpreter(params: {
    codeInterpreterId: string;
    abortSignal?: AbortSignal;
  }): Promise<AgentCoreGetInterpreterResult>;
  deleteCodeInterpreter(params: {
    codeInterpreterId: string;
    clientToken?: string;
    abortSignal?: AbortSignal;
  }): Promise<{ status: AgentCoreInterpreterStatus }>;
  listCodeInterpreters(params: {
    maxResults?: number;
    nextToken?: string;
    abortSignal?: AbortSignal;
  }): Promise<{
    items: Array<{ codeInterpreterId: string; name?: string; status?: AgentCoreInterpreterStatus }>;
    nextToken?: string;
  }>;
}

// --- data plane -----------------------------------------------------------

export interface AgentCoreStartSessionParams {
  codeInterpreterIdentifier: string;
  name?: string;
  sessionTimeoutSeconds?: number;
  clientToken?: string;
  abortSignal?: AbortSignal;
}

export interface AgentCoreStartSessionResult {
  codeInterpreterIdentifier: string;
  sessionId: string;
  createdAt?: Date;
}

export interface AgentCoreGetSessionResult {
  codeInterpreterIdentifier: string;
  sessionId: string;
  name?: string;
  status: AgentCoreSessionStatus;
  sessionTimeoutSeconds?: number;
  createdAt?: Date;
}

export interface AgentCoreInvokeContentItem {
  type: string;
  text?: string;
}

/**
 * Result of one `InvokeCodeInterpreter` call.
 *
 * `structuredContent` is populated for `executeCode`/`executeCommand`
 * (`stdout`/`stderr`/`exitCode`/`executionTime`, per the AWS Strands/
 * LangChain integration examples); other actions (`writeFiles`,
 * `listFiles`) report only `content`/`isError`.
 */
export interface AgentCoreInvokeResult {
  isError: boolean;
  content: AgentCoreInvokeContentItem[];
  structuredContent?: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    executionTime?: number;
  };
}

export interface AgentCoreInvokeParams {
  codeInterpreterIdentifier: string;
  sessionId: string;
  /** Tool/action name: `executeCommand`, `executeCode`, `writeFiles`, `listFiles`, ... */
  name: string;
  arguments: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

export interface AgentCoreDataApiLike {
  startSession(
    params: AgentCoreStartSessionParams,
  ): Promise<AgentCoreStartSessionResult>;
  getSession(params: {
    codeInterpreterIdentifier: string;
    sessionId: string;
    abortSignal?: AbortSignal;
  }): Promise<AgentCoreGetSessionResult>;
  stopSession(params: {
    codeInterpreterIdentifier: string;
    sessionId: string;
    abortSignal?: AbortSignal;
  }): Promise<void>;
  invoke(params: AgentCoreInvokeParams): Promise<AgentCoreInvokeResult>;
}

export interface AgentCoreApi {
  control: AgentCoreControlApiLike;
  data: AgentCoreDataApiLike;
}

export type AgentCoreApiFactory = () => Promise<AgentCoreApi> | AgentCoreApi;

/**
 * True when the provider reports the named resource (interpreter or
 * session) as absent.
 *
 * Delete verification needs to tell "gone" apart from "the lookup failed";
 * treating a transport error as absence is how a leaked resource gets
 * reported as cleaned up.
 */
export function isAgentCoreNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  if (name === "ResourceNotFoundException") {
    return true;
  }
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata
    ?.httpStatusCode;
  return status === 404;
}

/**
 * The official clients, bound to injected credentials and region.
 *
 * Credentials are resolved exactly once here, from the explicit
 * `AgentCoreCredentials` union — never from ambient environment variables —
 * except when the caller has explicitly opted into `{ type: "default-chain" }`,
 * in which case the AWS SDK's own resolution is exactly what was asked for.
 *
 * Each vendor result is assigned **through** the structural type above
 * rather than cast, so a signature change in the vendor SDK breaks the build
 * here, in the one file that owns the boundary, instead of surfacing later
 * as a runtime failure against a live session.
 */
export async function createOfficialAgentCoreApi(
  credentials: AgentCoreCredentials,
  region: string,
): Promise<AgentCoreApi> {
  const [{ BedrockAgentCoreControlClient, CreateCodeInterpreterCommand, GetCodeInterpreterCommand, DeleteCodeInterpreterCommand, ListCodeInterpretersCommand }, { BedrockAgentCoreClient, StartCodeInterpreterSessionCommand, GetCodeInterpreterSessionCommand, StopCodeInterpreterSessionCommand, InvokeCodeInterpreterCommand }] =
    await Promise.all([
      import("@aws-sdk/client-bedrock-agentcore-control"),
      import("@aws-sdk/client-bedrock-agentcore"),
    ]);

  const clientConfig = {
    region,
    ...(credentials.type === "static"
      ? {
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            ...(credentials.sessionToken
              ? { sessionToken: credentials.sessionToken }
              : {}),
          },
        }
      : {}),
  };
  const controlClient = new BedrockAgentCoreControlClient(clientConfig);
  const dataClient = new BedrockAgentCoreClient(clientConfig);

  const control: AgentCoreControlApiLike = {
    createCodeInterpreter: async (params) => {
      const res = await controlClient.send(
        new CreateCodeInterpreterCommand({
          name: params.name,
          ...(params.description ? { description: params.description } : {}),
          ...(params.executionRoleArn
            ? { executionRoleArn: params.executionRoleArn }
            : {}),
          networkConfiguration: params.networkConfiguration,
          ...(params.tags ? { tags: params.tags } : {}),
          ...(params.clientToken ? { clientToken: params.clientToken } : {}),
        }),
        { abortSignal: params.abortSignal },
      );
      if (!res.codeInterpreterId || !res.status) {
        throw new Error("AgentCore CreateCodeInterpreter response is missing required fields");
      }
      const checked: AgentCoreCreateInterpreterResult = {
        codeInterpreterArn: res.codeInterpreterArn ?? "",
        codeInterpreterId: res.codeInterpreterId,
        ...(res.createdAt ? { createdAt: new Date(res.createdAt) } : {}),
        status: res.status,
      };
      return checked;
    },
    getCodeInterpreter: async (params) => {
      const res = await controlClient.send(
        new GetCodeInterpreterCommand({ codeInterpreterId: params.codeInterpreterId }),
        { abortSignal: params.abortSignal },
      );
      if (!res.codeInterpreterId || !res.status) {
        throw new Error("AgentCore GetCodeInterpreter response is missing required fields");
      }
      const checked: AgentCoreGetInterpreterResult = {
        codeInterpreterId: res.codeInterpreterId,
        ...(res.codeInterpreterArn ? { codeInterpreterArn: res.codeInterpreterArn } : {}),
        status: res.status,
        ...(res.executionRoleArn ? { executionRoleArn: res.executionRoleArn } : {}),
        ...(res.networkConfiguration
          ? { networkConfiguration: res.networkConfiguration as AgentCoreNetworkConfigParams }
          : {}),
        ...(res.createdAt ? { createdAt: new Date(res.createdAt) } : {}),
        ...(res.lastUpdatedAt ? { lastUpdatedAt: new Date(res.lastUpdatedAt) } : {}),
      };
      return checked;
    },
    deleteCodeInterpreter: async (params) => {
      const res = await controlClient.send(
        new DeleteCodeInterpreterCommand({
          codeInterpreterId: params.codeInterpreterId,
          ...(params.clientToken ? { clientToken: params.clientToken } : {}),
        }),
        { abortSignal: params.abortSignal },
      );
      return { status: res.status ?? "DELETING" };
    },
    listCodeInterpreters: async (params) => {
      const res = await controlClient.send(
        new ListCodeInterpretersCommand({
          ...(params.maxResults ? { maxResults: params.maxResults } : {}),
          ...(params.nextToken ? { nextToken: params.nextToken } : {}),
        }),
        { abortSignal: params.abortSignal },
      );
      const summaries: Array<{ codeInterpreterId?: string; name?: string; status?: string }> =
        res.codeInterpreterSummaries ?? [];
      return {
        items: summaries.map((item) => ({
          codeInterpreterId: item.codeInterpreterId ?? "",
          ...(item.name ? { name: item.name } : {}),
          ...(item.status ? { status: item.status } : {}),
        })),
        ...(res.nextToken ? { nextToken: res.nextToken } : {}),
      };
    },
  };

  const data: AgentCoreDataApiLike = {
    startSession: async (params) => {
      const res = await dataClient.send(
        new StartCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: params.codeInterpreterIdentifier,
          ...(params.name ? { name: params.name } : {}),
          ...(params.sessionTimeoutSeconds
            ? { sessionTimeoutSeconds: params.sessionTimeoutSeconds }
            : {}),
          ...(params.clientToken ? { clientToken: params.clientToken } : {}),
        }),
        { abortSignal: params.abortSignal },
      );
      if (!res.sessionId || !res.codeInterpreterIdentifier) {
        throw new Error("AgentCore StartCodeInterpreterSession response is missing required fields");
      }
      const checked: AgentCoreStartSessionResult = {
        codeInterpreterIdentifier: res.codeInterpreterIdentifier,
        sessionId: res.sessionId,
        ...(res.createdAt ? { createdAt: new Date(res.createdAt) } : {}),
      };
      return checked;
    },
    getSession: async (params) => {
      const res = await dataClient.send(
        new GetCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: params.codeInterpreterIdentifier,
          sessionId: params.sessionId,
        }),
        { abortSignal: params.abortSignal },
      );
      if (!res.sessionId || !res.codeInterpreterIdentifier || !res.status) {
        throw new Error("AgentCore GetCodeInterpreterSession response is missing required fields");
      }
      const checked: AgentCoreGetSessionResult = {
        codeInterpreterIdentifier: res.codeInterpreterIdentifier,
        sessionId: res.sessionId,
        ...(res.name ? { name: res.name } : {}),
        status: res.status,
        ...(res.sessionTimeoutSeconds
          ? { sessionTimeoutSeconds: res.sessionTimeoutSeconds }
          : {}),
        ...(res.createdAt ? { createdAt: new Date(res.createdAt) } : {}),
      };
      return checked;
    },
    stopSession: async (params) => {
      await dataClient.send(
        new StopCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: params.codeInterpreterIdentifier,
          sessionId: params.sessionId,
        }),
        { abortSignal: params.abortSignal },
      );
    },
    invoke: async (params) => {
      const res = await dataClient.send(
        new InvokeCodeInterpreterCommand({
          codeInterpreterIdentifier: params.codeInterpreterIdentifier,
          sessionId: params.sessionId,
          name: params.name,
          arguments: params.arguments,
        }),
        { abortSignal: params.abortSignal },
      );
      return collectInvokeStream(res.stream);
    },
  };

  return { control, data };
}

/**
 * `InvokeCodeInterpreter` returns an AWS SDK event stream. Every event
 * observed in AWS's own examples carries a `result` field shaped like
 * `AgentCoreInvokeResult`; this drains the whole stream (so the underlying
 * HTTP/2 stream is not left half-read) and keeps the last result event,
 * which is where a multi-chunk response's final `structuredContent` lands.
 */
async function collectInvokeStream(
  stream: AsyncIterable<{ result?: AgentCoreInvokeResult }> | undefined,
): Promise<AgentCoreInvokeResult> {
  let last: AgentCoreInvokeResult | undefined;
  if (stream) {
    for await (const event of stream) {
      if (event.result) {
        last = event.result;
      }
    }
  }
  if (!last) {
    throw new Error("AgentCore InvokeCodeInterpreter returned no result event");
  }
  return last;
}
