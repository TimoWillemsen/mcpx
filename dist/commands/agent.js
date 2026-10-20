import { installFor, render, TARGETS } from "../agents.js";
import { usageError } from "../errors.js";
import { table } from "../output.js";
const FORMATS = ["markdown", "skill", "cursor", "windsurf"];
/** Print the agent instructions (always as text: the output is the document). */
export function instructionsCommand(format) {
    if (!FORMATS.includes(format)) {
        throw usageError(`unknown format "${format}" (known: ${FORMATS.join(", ")})`);
    }
    const text = render(format);
    return { json: { format, text }, text: () => text, raw: true };
}
/** Install the instructions for one or more agents. All targets are validated before any file is written. */
export function setupAgentCommand(agents, opts) {
    if (agents.length === 0) {
        const known = Object.entries(TARGETS)
            .map(([k, t]) => `  ${k.padEnd(9)} ${t.label}`)
            .join("\n");
        throw usageError(`name at least one agent:\n${known}`);
    }
    const unique = [...new Set(agents)];
    // Dry run first so an unknown agent or a conflict fails before anything is written.
    for (const a of unique)
        installFor(a, { ...opts, dryRun: true });
    const results = unique.map((a) => installFor(a, opts));
    return {
        json: { dryRun: Boolean(opts.dryRun), results },
        text: () => table(results.map((r) => [
            opts.dryRun ? `would be ${r.action}` : r.action,
            r.agent,
            r.path,
        ])),
    };
}
