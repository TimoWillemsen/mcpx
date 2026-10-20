export function hasPolicy(server) {
    return Boolean(server.readOnly || server.allowedTools);
}
export function matchesPattern(name, pattern) {
    if (!pattern.includes("*"))
        return name === pattern;
    const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return re.test(name);
}
/** Whether the name alone is allowed (no tool metadata needed). */
export function checkName(server, toolName) {
    if (server.allowedTools && !server.allowedTools.some((p) => matchesPattern(toolName, p))) {
        return { allowed: false, reason: `"${toolName}" is not in allowedTools` };
    }
    return { allowed: true };
}
/** Full check, using the tool's annotations for readOnly. */
export function checkTool(server, tool) {
    const byName = checkName(server, tool.name);
    if (!byName.allowed)
        return byName;
    if (server.readOnly && tool.annotations?.readOnlyHint !== true) {
        const why = tool.annotations ? "is not annotated readOnlyHint: true" : "has no annotations";
        return { allowed: false, reason: `server is readOnly and "${tool.name}" ${why}` };
    }
    return { allowed: true };
}
