import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "../src/agents.js";

const root = resolve(__dirname, "..");
const json = (p: string) => JSON.parse(readFileSync(resolve(root, p), "utf8"));
const version = json("package.json").version;

describe("plugin packaging", () => {
  it("has the same name and version in every manifest", () => {
    for (const p of [
      "plugins/mcpx/.claude-plugin/plugin.json",
      "plugins/mcpx/.cursor-plugin/plugin.json",
      "plugins/mcpx/plugin.json",
    ]) {
      expect(json(p)).toMatchObject({ name: "mcpx", version });
    }
  });

  it("keeps the Agent Plugins manifest to the standard's fields", () => {
    expect(Object.keys(json("plugins/mcpx/plugin.json")).sort()).toEqual(["$schema", "description", "name", "version"]);
  });

  it("points both marketplaces at plugins/mcpx", () => {
    expect(json(".claude-plugin/marketplace.json").plugins[0].source).toBe("./plugins/mcpx");
    expect(json(".cursor-plugin/marketplace.json").plugins[0].source).toBe("plugins/mcpx");
  });

  it("ships the generated usage skill", () => {
    expect(readFileSync(resolve(root, "plugins/mcpx/skills/mcpx/SKILL.md"), "utf8").startsWith(render("skill"))).toBe(true);
  });
});
