import { installFor, render, TARGETS, type Format, type InstallResult } from "../agents.js";
import { usageError } from "../errors.js";
import { table, type CommandResult } from "../output.js";

const FORMATS: Format[] = ["markdown", "skill", "cursor", "windsurf"];

/** Print the agent instructions (always as text: the output is the document). */
export function instructionsCommand(format: string): CommandResult {
  if (!FORMATS.includes(format as Format)) {
    throw usageError(`unknown format "${format}" (known: ${FORMATS.join(", ")})`);
  }
  const text = render(format as Format);
  return { json: { format, text }, text: () => text, raw: true };
}

export interface SetupAgentOptions {
  global: boolean;
  dir?: string;
  force?: boolean;
  dryRun?: boolean;
}

/** Install the instructions for one or more agents. All targets are validated before any file is written. */
export function setupAgentCommand(agents: string[], opts: SetupAgentOptions): CommandResult {
  if (agents.length === 0) {
    const known = Object.entries(TARGETS)
      .map(([k, t]) => `  ${k.padEnd(9)} ${t.label}`)
      .join("\n");
    throw usageError(`name at least one agent:\n${known}`);
  }
  const unique = [...new Set(agents)];
  // Dry run first so an unknown agent or a conflict fails before anything is written.
  for (const a of unique) installFor(a, { ...opts, dryRun: true });
  const results: InstallResult[] = unique.map((a) => installFor(a, opts));

  return {
    json: { dryRun: Boolean(opts.dryRun), results },
    text: () =>
      table(
        results.map((r) => [
          opts.dryRun ? `would be ${r.action}` : r.action,
          r.agent,
          r.path,
        ]),
      ),
  };
}
