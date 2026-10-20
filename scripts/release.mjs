// Release helper for .github/workflows/release.yml.
//   node scripts/release.mjs check <before-sha>  -> sets output release=true|false
//   node scripts/release.mjs bump                -> patch bump, rebuild, changelog; sets output version
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const output = (key, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`${key}=${value}`);
};
const pkgAt = (rev) => {
  try {
    return JSON.parse(git("show", `${rev}:package.json`));
  } catch {
    return undefined;
  }
};

const [command, before] = process.argv.slice(2);

if (command === "check") {
  // A push of a new branch has an all-zero "before"; compare with the parent instead.
  const base = !before || /^0+$/.test(before) ? "HEAD~1" : before;
  const changedDist = git("diff", "--name-only", base, "HEAD", "--", "dist").length > 0;
  const prev = pkgAt(base);
  const next = pkgAt("HEAD");
  const changedDeps = JSON.stringify(prev?.dependencies) !== JSON.stringify(next?.dependencies);
  const versionBumpedByHand = prev?.version !== next?.version;
  console.log({ base, changedDist, changedDeps, versionBumpedByHand });
  output("release", String((changedDist || changedDeps) && !versionBumpedByHand));
} else if (command === "bump") {
  execFileSync("npm", ["version", "patch", "--no-git-tag-version"], { stdio: "inherit" });
  // Rebuilding regenerates dist/ and the plugin manifest with the new version.
  execFileSync("npm", ["run", "compile"], { stdio: "inherit" });
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));

  const date = new Date().toISOString().slice(0, 10);
  const log = readFileSync("CHANGELOG.md", "utf8");
  const entry = `## [Unreleased]\n\n## [${version}] - ${date}\n\n### Changed\n- Dependency updates. See the [release notes](https://github.com/TimoWillemsen/mcpx/releases/tag/v${version}).\n`;
  let updated = log.replace("## [Unreleased]\n", entry);
  updated = updated.replace(
    /^\[Unreleased\]: (.*)\/compare\/v[\d.]+\.\.\.HEAD$/m,
    `[Unreleased]: $1/compare/v${version}...HEAD\n[${version}]: $1/releases/tag/v${version}`,
  );
  writeFileSync("CHANGELOG.md", updated);
  output("version", version);
} else {
  console.error("usage: release.mjs check <before-sha> | bump");
  process.exit(2);
}
