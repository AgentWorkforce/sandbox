/**
 * SDK-free configuration for the AWS Bedrock AgentCore Code Interpreter adapter.
 *
 * Nothing in this module imports `@aws-sdk/client-bedrock-agentcore` or
 * `@aws-sdk/client-bedrock-agentcore-control`. Consumers can construct and
 * type-check a configuration without either optional peer dependency
 * installed.
 */

/**
 * Credentials for the AgentCore control- and data-plane APIs.
 *
 * AWS auth is not a single token, and this adapter never falls back to
 * ambient process state implicitly. A caller gets exactly one of two
 * explicit choices:
 *
 *  - `static`: long-lived IAM user keys, or STS/SSO temporary credentials
 *    (add `sessionToken` for the latter).
 *  - `default-chain`: explicit opt-in to the AWS SDK's own credential
 *    resolution (env vars, shared config file, EC2/ECS/Lambda role, SSO
 *    cache, etc). This is the standard way to run under an assumed IAM role,
 *    and it is common enough in AWS-native deployments that refusing it
 *    outright would be dogmatic — but the adapter never *defaults* to it.
 *    The caller names it, exactly like every other field here.
 */
export type AgentCoreCredentials =
  | {
      type: "static";
      accessKeyId: string;
      secretAccessKey: string;
      /** Required for STS/SSO temporary credentials; omitted for IAM user keys. */
      sessionToken?: string;
    }
  | { type: "default-chain" };

/**
 * Network mode for an owned code interpreter.
 *
 * `VPC` is the only mode reachable without an explicit, named opt-in to a
 * riskier mode. This is deliberate: public research disclosed in March 2026
 * (BeyondTrust Phantom Labs, corroborated by Unit 42 and the Cloud Security
 * Alliance) showed that AgentCore's `SANDBOX` network mode still permits
 * outbound DNS A/AAAA queries even though it blocks general internet
 * traffic, and that this residual DNS path is enough to build a full
 * covert command-and-control and data-exfiltration channel out of a
 * "sandboxed" code interpreter. AWS's own guidance in response was not a
 * platform-level fix but a documentation update recommending `VPC` mode
 * plus Route 53 Resolver DNS Firewall for customers who need real
 * isolation. This adapter encodes that recommendation as the type-level
 * default: constructing a runtime with `network` omitted, or with `mode`
 * omitted inside it, resolves to `VPC` and requires `vpc` details, because
 * there is no safe subnet/security-group default to invent. Reaching
 * `SANDBOX` (or `PUBLIC`) requires spelling out `mode` explicitly, and doing
 * so logs a warning that names the hazard.
 */
export type AgentCoreNetworkConfig =
  | { mode?: "VPC"; vpc: AgentCoreVpcConfig }
  | { mode: "SANDBOX" }
  | { mode: "PUBLIC" };

export interface AgentCoreVpcConfig {
  /** At least one subnet the code interpreter's ENIs are placed in. */
  subnetIds: readonly string[];
  /** At least one security group applied to those ENIs. */
  securityGroupIds: readonly string[];
  /**
   * Require traffic to Amazon S3 to stay on the service's VPC endpoint
   * rather than transiting the public internet. Defaults to the provider's
   * own default when omitted (not asserted here, since that default is not
   * independently verified).
   */
  requireServiceS3Endpoint?: boolean;
}

/**
 * Identifies which code interpreter *environment* a session runs against.
 *
 *  - `system`: the AWS-managed default environment (`aws.codeinterpreter.v1`).
 *    It accepts no execution role and no network configuration of its own —
 *    those are exclusively properties of a *custom* code interpreter — so
 *    this adapter's VPC-default and sandbox-mode-warning logic does not
 *    apply to it. Use it only for workloads with no S3/network requirements.
 *  - `owned`: a custom code interpreter this runtime creates (once, lazily,
 *    cached for the life of the runtime instance) and every session it
 *    starts runs against. This is the path that carries `network` and
 *    `executionRoleArn`, and the one this adapter is built around.
 */
export type AgentCoreInterpreterSource =
  | { type: "system" }
  | {
      type: "owned";
      /**
       * Deterministic name for the owned code interpreter. Fixed rather than
       * randomly suffixed so a fresh process can rediscover and reuse the
       * same environment (via `GetCodeInterpreter`) instead of creating a new
       * one on every restart — AgentCore names must be unique per account and
       * match `[a-zA-Z][a-zA-Z0-9_]{0,47}`.
       */
      name: string;
      description?: string;
      /**
       * IAM role the code interpreter assumes to reach AWS services from
       * inside a session — required for the S3 large-file path (uploads over
       * the 100 MB inline limit, up to 5 GB) documented at
       * https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-s3-integration.html.
       * The adapter does not create this role: provisioning it (trust policy
       * for `bedrock-agentcore.amazonaws.com`, `s3:GetObject`/`s3:PutObject`
       * scoped to the target bucket/prefix) is the caller's or operator's
       * responsibility, same as `namePrefix` is for other providers' identity
       * scoping.
       */
      executionRoleArn?: string;
      network: AgentCoreNetworkConfig;
      tags?: Readonly<Record<string, string>>;
    };

export interface AgentCoreRuntimeOptions {
  credentials: AgentCoreCredentials;
  region: string;
  interpreter: AgentCoreInterpreterSource;
  /**
   * Home directory sessions boot into. Required because no default is
   * correct for every language runtime the code interpreter selects.
   */
  defaultHomeDir: string;
  /**
   * Wall-clock lifetime of a session in seconds. AgentCore defaults to 900
   * (15 minutes) and caps at 28,800 (8 hours) when omitted. Set explicitly
   * per `launch()` via `LaunchOptions.createTimeoutSeconds`, which takes
   * precedence when supplied.
   */
  sessionTimeoutSeconds?: number;
  /**
   * Default environment variables inherited by every command. AgentCore has
   * no native per-command env parameter (see `runtime.ts`), so these are
   * applied by shell-prefixing each invocation.
   */
  env?: Readonly<Record<string, string>>;

  // --- deadlines -------------------------------------------------------
  // Every remote operation carries an explicit deadline, mirroring the
  // discipline in the Vercel and Modal adapters. AWS SDK v3 clients accept
  // a per-call `abortSignal` on `.send()`, so there is no need for the
  // fetch-wrapping trick those adapters use — the deadline is passed
  // straight through to each command.

  /** Fallback per-request deadline for operations without a specific one. */
  requestTimeoutMs?: number;
  /** Total deadline for creating (or discovering) the owned code interpreter. */
  createInterpreterTimeoutMs?: number;
  /** Total deadline for starting a session. */
  launchTimeoutMs?: number;
  /** Total deadline for a lookup (`GetCodeInterpreterSession`). */
  lookupTimeoutMs?: number;
  /** Default total deadline for a command when the caller supplies none. */
  execTimeoutMs?: number;
  /** Total deadline for a single file upload or download. */
  fileTimeoutMs?: number;
  /** Total deadline for stopping a session (destroy). */
  destroyTimeoutMs?: number;
}

export function isStaticCredentials(
  credentials: AgentCoreCredentials,
): credentials is Extract<AgentCoreCredentials, { type: "static" }> {
  return credentials.type === "static";
}
