import type { Daytona } from '@daytonaio/sdk';

/**
 * Sandbox DTO fields Daytona's wire response carries that the vendored
 * `@daytonaio/sdk` `Sandbox` class does not copy onto itself. Both fields
 * exist on the low-level `@daytona/api-client` DTOs (confirmed present since
 * 0.190.0 for sandboxClass and 0.205.0 for warmPoolId), but sdk-typescript's
 * `processSandboxDto()` never assigns them to the public `Sandbox`/list
 * wrapper, even at daytona/clients HEAD as of 2026-08-21. Tracked upstream —
 * see docs/daytona.md. Retire this module once that lands and the vendored
 * SDK version picks it up.
 */
export interface DaytonaWireSupplement {
  /** Sandbox class/tier, e.g. "container" or "linux-vm". */
  sandboxClass?: string;
  /** Id of the warm pool this sandbox is an unclaimed member of. Unset outside a warm pool. */
  warmPoolId?: string;
}

interface RawSandboxApiClient {
  sandboxApi: {
    getSandbox: (sandboxIdOrName: string) => Promise<{
      data: { sandboxClass?: string; warmPoolId?: string };
    }>;
  };
}

/**
 * Fetches the two Sandbox DTO fields the SDK's `Sandbox` class drops, via
 * the same low-level `sandboxApi` reach the adapter already uses for
 * detached create (runtime.ts's `createDetachedWithOptions`). Issues one
 * extra GET — callers that need this on every lookup should batch or cache.
 */
export async function fetchDaytonaWireSupplement(
  daytona: Daytona,
  sandboxId: string,
): Promise<DaytonaWireSupplement> {
  const client = daytona as unknown as RawSandboxApiClient;
  const response = await client.sandboxApi.getSandbox(sandboxId);
  const { sandboxClass, warmPoolId } = response.data;
  return {
    ...(sandboxClass ? { sandboxClass } : {}),
    ...(warmPoolId ? { warmPoolId } : {}),
  };
}
