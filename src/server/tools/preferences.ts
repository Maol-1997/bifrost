import type { ProviderDefinition, ToolDefinition } from '../providers/types.js';

/**
 * Whether a given user currently has a given tool.
 *
 * Two independent authorities decide, and keeping them apart is the point: the
 * deployment sets a ceiling of what is possible here at all, and the user picks
 * what they want inside it. A tool the deployment forbids is not a tool the user
 * can switch back on.
 */

export type ToolAvailability = {
  isEnabled: boolean;
  /** Off because of `WRITE_TOOL_ALLOWLIST`, not because the user turned it off. */
  isBlockedByServer: boolean;
};

/**
 * The user's own choice, defaulting by what the tool does.
 *
 * Having no stored row means different things on purpose. Reading is the reason
 * you connected an app, so it starts on. Writing acts in your name and is the
 * thing you would regret not having been asked about, so it starts off and you
 * turn it on deliberately. Encoding the default here rather than seeding rows
 * means a new user and a user who never touched the screen behave identically.
 */
export function isToolPreferred(tool: ToolDefinition, preferences: ReadonlyMap<string, boolean>): boolean {
  return preferences.get(tool.name) ?? tool.mutability === 'read';
}

/**
 * Whether the deployment permits this tool at all.
 *
 * An empty allowlist means no ceiling. That is a deliberate reversal: it used to
 * mean "deny every write", which combined with advertising them anyway produced
 * tools that an agent could see and never successfully call. Per-user control is
 * the replacement, and `server.ts` warns at startup when no ceiling is set.
 */
export function isWithinDeploymentCeiling(tool: ToolDefinition, allowlist: ReadonlySet<string>): boolean {
  if (tool.mutability === 'read') return true;
  return allowlist.size === 0 || allowlist.has(tool.name);
}

export function toolAvailability(
  tool: ToolDefinition,
  preferences: ReadonlyMap<string, boolean>,
  allowlist: ReadonlySet<string>,
): ToolAvailability {
  const isBlockedByServer = !isWithinDeploymentCeiling(tool, allowlist);
  return { isEnabled: !isBlockedByServer && isToolPreferred(tool, preferences), isBlockedByServer };
}

/**
 * The names `visibleTools` has to drop. Computed over the whole registry rather
 * than per provider so that there is exactly one answer to "is this tool on",
 * shared by the MCP handler and the screen that draws the switches.
 */
export function disabledToolNames(
  providers: readonly ProviderDefinition[],
  preferences: ReadonlyMap<string, boolean>,
  allowlist: ReadonlySet<string>,
): ReadonlySet<string> {
  const disabled = new Set<string>();
  for (const provider of providers) {
    for (const tool of provider.tools) {
      if (!toolAvailability(tool, preferences, allowlist).isEnabled) disabled.add(tool.name);
    }
  }
  return disabled;
}

/** Every tool name the server actually serves, so a preference cannot name one that does not exist. */
export function knownToolNames(providers: readonly ProviderDefinition[]): ReadonlySet<string> {
  return new Set(providers.flatMap((provider) => provider.tools.map((tool) => tool.name)));
}
