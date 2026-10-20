import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareVersions, latestTag } from "../src/update.js";

const CLI = resolve(__dirname, "../dist/cli.js");
let dir: string;
let repo: string;

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

function mcpx(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    // CI=true (set by GitHub Actions) would block updates before the checks under test.
    env: { ...process.env, CI: "", MCPX_CONFIG_DIR: dir, MCPX_UPDATE_REPO: `file://${repo}`, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcpx-update-cfg-"));
  writeFileSync(join(dir, "servers.json"), "{}");
  // A release repo with tags v0.1.0, v99.0.0 and some non-release tags.
  repo = mkdtempSync(join(tmpdir(), "mcpx-update-repo-"));
  git(repo, "init", "-q");
  writeFileSync(join(repo, "README"), "x");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "x");
  for (const t of ["v0.1.0", "v99.0.0", "v100.0.0-beta", "latest"]) git(repo, "tag", t);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("version helpers", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.3.0")).toBeLessThan(0);
  });

  it("picks the highest vX.Y.Z tag and ignores others", () => {
    const out = ["a\trefs/tags/v0.2.0", "b\trefs/tags/v0.10.0", "c\trefs/tags/v1.0.0-rc1", "d\trefs/tags/nightly"].join("\n");
    expect(latestTag(out)).toBe("v0.10.0");
    expect(latestTag("")).toBeUndefined();
  });
});

describe("mcpx update", () => {
  it("--check reports a newer release without installing", () => {
    const r = mcpx(["update", "--check"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ latest: "99.0.0", updateAvailable: true, updated: false });
  });

  it("never replaces a git checkout (like this repo, used through npm link)", () => {
    const r = mcpx(["update"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.updated).toBe(false);
    expect(out.skipped).toMatch(/git checkout/);
  });

  it("records the check for doctor", () => {
    mcpx(["update", "--check"]);
    const state = JSON.parse(readFileSync(join(dir, "update-state.json"), "utf8"));
    expect(state.latest).toBe("v99.0.0");
    const doctor = JSON.parse(mcpx(["doctor", "--offline"]).stdout);
    expect(doctor.checks.find((c: { check: string }) => c.check === "updates").message).toMatch(/git checkout/);
  });

  it("exits 1 when the release repository can't be reached, without prompting", () => {
    const r = mcpx(["update", "--check"], { MCPX_UPDATE_REPO: "file:///nonexistent/mcpx.git" });
    expect(r.code).toBe(1);
  });

  it("doesn't schedule a background update from a git checkout", () => {
    const fresh = mkdtempSync(join(tmpdir(), "mcpx-update-fresh-"));
    writeFileSync(join(fresh, "servers.json"), "{}");
    mcpx(["servers"], { MCPX_CONFIG_DIR: fresh });
    expect(() => readFileSync(join(fresh, "update-state.json"))).toThrow();
    rmSync(fresh, { recursive: true, force: true });
  });
});
