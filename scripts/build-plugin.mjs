// Generates the plugin's files that derive from the CLI, so they can't drift: the
// usage skill (from `mcpx instructions --format skill`) and the manifests for each
// plugin format, all carrying package.json's version.
//
// plugins/mcpx is one plugin in three manifest formats:
//   .claude-plugin/plugin.json  Claude Code (also read by Copilot CLI and VS Code)
//   .cursor-plugin/plugin.json  Cursor
//   plugin.json                 Agent Plugins standard (Codex, Copilot, VS Code, Kiro, Cursor)
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { render } from "../dist/agents.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const root = new URL("../plugins/mcpx/", import.meta.url);

const notInstalled = `
### If mcpx is not installed
If the \`mcpx\` command is not found, ask the user to run \`/mcpx:setup\`, which installs
it and configures their servers.
`;
writeFileSync(new URL("skills/mcpx/SKILL.md", root), render("skill") + notInstalled);

const description =
  "Use any MCP server from your coding agent through the mcpx CLI: a skill that teaches the agent to discover, describe and call MCP tools, and a setup command that installs mcpx.";
const common = {
  name: "mcpx",
  version: pkg.version,
  description,
  author: { name: pkg.author },
  homepage: pkg.homepage.replace(/#readme$/, ""),
  repository: pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""),
  license: pkg.license,
  keywords: ["mcp", "model-context-protocol", "cli", "tools"],
};

const write = (path, value) => {
  const url = new URL(path, root);
  mkdirSync(new URL(".", url), { recursive: true });
  writeFileSync(url, JSON.stringify(value, null, 2) + "\n");
};

write(".claude-plugin/plugin.json", common);
mkdirSync(new URL("assets/", root), { recursive: true });
copyFileSync(new URL("../assets/logo.svg", import.meta.url), new URL("assets/logo.svg", root));
write(".cursor-plugin/plugin.json", { ...common, logo: "assets/logo.svg" });
// Agent Plugins 1.0 (agent-plugins.org): only the core fields, since some loaders
// validate strictly.
write("plugin.json", {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: common.name,
  version: common.version,
  description,
});

// Cursor reads its marketplace from .cursor-plugin/marketplace.json at the repo root.
mkdirSync(new URL("../.cursor-plugin/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../.cursor-plugin/marketplace.json", import.meta.url),
  JSON.stringify(
    {
      name: "mcpx",
      owner: { name: pkg.author },
      plugins: [{ name: "mcpx", source: "plugins/mcpx", description }],
    },
    null,
    2,
  ) + "\n",
);
