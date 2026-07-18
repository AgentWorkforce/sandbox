/**
 * `@agent-relay/sandbox` — provider-agnostic sandbox runtimes and orchestration.
 *
 * This is the package entry point. Runtime adapters and the orchestration
 * surface land here; the scaffold intentionally exports nothing yet so the
 * build, typecheck, and test wiring can be verified on its own.
 */

/** Package name, exported so consumers can identify the module at runtime. */
export const PACKAGE_NAME = "@agent-relay/sandbox";
