import { listAllTools, withSession } from "../client.js";
import { getServer, loadConfig } from "../config.js";
import { usageError } from "../errors.js";
import { checkTool, hasPolicy } from "../policy.js";
import { table } from "../output.js";
export async function toolsCommand(serverName, opts) {
    const server = getServer(loadConfig(), serverName);
    const tools = await withSession(serverName, server, opts, listAllTools);
    const listed = tools
        .map((t) => ({ tool: t, decision: checkTool(server, t) }))
        .filter((x) => opts.all || x.decision.allowed);
    const hidden = tools.length - listed.length;
    return {
        json: {
            server: serverName,
            tools: listed.map(({ tool: t, decision }) => ({
                name: t.name,
                ...(t.title && { title: t.title }),
                description: t.description ?? "",
                ...(t.annotations && { annotations: t.annotations }),
                ...(!decision.allowed && { blocked: decision.reason }),
            })),
            // Tells callers (and agents) that a policy is filtering the list.
            ...(hasPolicy(server) && { hiddenByPolicy: hidden }),
        },
        text: () => {
            const rows = listed.map(({ tool: t, decision }) => [
                t.name,
                (decision.allowed ? "" : "[blocked] ") + firstLine(t.description),
            ]);
            const note = hidden ? `\n(${hidden} tools hidden by policy; --all to show them)` : "";
            return table(rows) + note;
        },
    };
}
export async function describeCommand(serverName, toolName, opts) {
    const server = getServer(loadConfig(), serverName);
    const tools = await withSession(serverName, server, opts, listAllTools);
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
        throw usageError(`server "${serverName}" has no tool "${toolName}" (run: mcpx tools ${serverName})`);
    }
    const decision = checkTool(server, tool);
    return {
        json: {
            server: serverName,
            tool,
            ...(!decision.allowed && { blocked: decision.reason }),
        },
        text: () => formatTool(tool) + (decision.allowed ? "" : `\n\nBlocked by policy: ${decision.reason}`),
    };
}
function firstLine(s) {
    return (s ?? "").split("\n")[0].trim();
}
function formatTool(tool) {
    const lines = [tool.name];
    if (tool.description)
        lines.push("", tool.description.trim());
    const props = (tool.inputSchema.properties ?? {});
    const required = new Set(tool.inputSchema.required ?? []);
    const names = Object.keys(props);
    lines.push("", "Arguments:");
    if (names.length === 0)
        lines.push("  (none)");
    for (const name of names) {
        const p = props[name];
        const type = p.enum
            ? p.enum.map((v) => JSON.stringify(v)).join(" | ")
            : [p.type ?? "any"].flat().join(" | ");
        const req = required.has(name) ? " (required)" : "";
        lines.push(`  ${name}: ${type}${req}`);
        if (p.description)
            lines.push(`      ${p.description}`);
    }
    if (tool.annotations) {
        const flags = Object.entries(tool.annotations)
            .filter(([k]) => k !== "title")
            .map(([k, v]) => `${k}=${v}`);
        if (flags.length)
            lines.push("", `Annotations: ${flags.join(", ")}`);
    }
    return lines.join("\n");
}
