import { defineNode, spawn } from '@agent-relay/fleet';
import { claude, codex, definePtyHarness, gemini, opencode } from '@agent-relay/harnesses';

export const chiefBrokerGrokCommand =
  '/Users/khaliqgant/.local/share/mise/installs/node/22.22.2/bin/grok';

export const chiefBrokerExpectedRuntimeCapabilities = [
  'spawn:claude',
  'spawn:codex',
  'spawn:gemini',
  'spawn:opencode',
  'spawn:grok',
  // These two capacities are owned and injected by the broker provider.
  'release',
  'relay:delivery-cursor-v1',
] as const;

export function chiefBrokerCapabilities({
  grokCommand = chiefBrokerGrokCommand,
}: { grokCommand?: string } = {}) {
  // The Grok launcher uses `#!/usr/bin/env node`; launchd does not inherit the
  // interactive mise PATH, so include the launcher's Node directory explicitly.
  const grokBinDirectory = grokCommand.slice(0, grokCommand.lastIndexOf('/'));
  const grok = definePtyHarness({
    runtime: 'pty',
    command: grokCommand,
    env: { PATH: `${grokBinDirectory}:/usr/bin:/bin:/usr/sbin:/sbin` },
  });

  return {
    'spawn:claude': spawn(claude),
    'spawn:codex': spawn(codex),
    'spawn:gemini': spawn(gemini),
    'spawn:opencode': spawn(opencode),
    'spawn:grok': spawn(grok),
  };
}

export default defineNode({
  name: 'chief-broker',
  capabilities: chiefBrokerCapabilities(),
});
