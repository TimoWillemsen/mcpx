# Changelog

All notable changes to mcpx are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.1] - 2026-10-20

### Changed
- mcpx now lives at https://github.com/TimoWillemsen/mcpx. Installs from the old
  repository switch to it with this release's self-update.

### Fixed
- `mcpx logout` only revokes a token at the authorization server that issued it,
  only over https (http for localhost), and never follows a redirect with it.
  Before, a server whose metadata changed could make logout send the token elsewhere.
- `setup-agent` also refuses a dangling symlink in the project; before, it wrote
  through it and created the link's target outside the project.

## [0.4.0] - 2026-10-17

### Added
- The plugin also ships a Cursor manifest (`.cursor-plugin/plugin.json`, with a
  `.cursor-plugin/marketplace.json` at the repo root) and an
  [Agent Plugins](https://agent-plugins.org) manifest (`plugin.json`) for Codex,
  Copilot CLI, VS Code and Kiro.
- `setup-agent skills` installs the skill into `.agents/skills` (or `~/.agents/skills`
  with `--global`), which Codex, Cursor, Copilot, Gemini CLI, opencode, Amp, Goose,
  Windsurf and other Agent Skills tools load. `setup-agent kiro` targets Kiro.

### Changed
- Output format follows where the output goes: readable text in a terminal, JSON
  when piped or captured (scripts and agents get JSON as before). `--json` forces
  JSON, `--text` forces text, and `MCPX_OUTPUT=json|text` sets the default. Errors
  follow stderr the same way.

## [0.3.0] - 2026-10-17

### Added
- Automatic updates: at most once a day, mcpx checks for a newer release in the
  background and installs it. `mcpx update` updates right away (`--check` only
  reports); `MCPX_NO_AUTO_UPDATE=1` turns it off. `mcpx doctor` reports the status.
- README: how to turn on automatic updates for the Claude Code plugin.

### Fixed
- Installing from git with plain `npm install -g github:...` failed or left a broken
  symlink: npm runs a nested "prepare" install for git packages with a `build` script.
  The script is now called `compile`.

## [0.2.0] - 2026-10-17

### Added
- `key=value` arguments for `mcpx call`, converted using the tool's input schema
  (numbers, booleans, lists, JSON objects), with `key:=<json>` for raw JSON values and
  "did you mean" suggestions for misspelled argument names.
- `mcpx call --unwrap` prints just the result: `structuredContent`, or the text,
  parsed as JSON when it is JSON.
- `mcpx doctor` checks Node.js, the config and its permissions, referenced
  environment variables, the keychain, the audit log, and each server's connection,
  tools and login state.
- Dependabot updates with automatic merging of patch/minor updates, and automatic
  patch releases when runtime dependencies change.

### Security
- `setup-agent` no longer writes through symlinks or outside the project directory
  in project mode, so a cloned repository can't redirect it to other files.
- Text output and plain-text errors strip ANSI escape sequences and control
  characters from servers when printed to a terminal.
- The plaintext test credential store (`MCPX_TEST_CREDENTIAL_FILE`) is only allowed
  under the OS temp directory.
- GitHub Actions are pinned to commit SHAs.
- README: new threat model section; guardrails are described as protection against
  agent mistakes, not a sandbox.

## [0.1.0] - 2026-10-17

First release.

### Added
- `servers`, `tools`, `describe` and `call` for MCP servers over stdio, Streamable HTTP
  and legacy HTTP+SSE.
- JSON output by default (`--text` for humans), structured errors on stderr, exit codes
  0–4, and a hard deadline on every command (`--timeout`).
- Configuration in `servers.json` that accepts the `mcpServers` format of Claude
  Desktop, Claude Code and Cursor, with `${VAR}` expansion for secrets.
- `login` / `logout`: OAuth 2.1 with discovery, dynamic client registration or a
  pre-registered client, PKCE, automatic refresh and token revocation. Tokens are
  stored in the OS keychain and bound to the server URL they were issued for.
- Guardrails: per-server `allowedTools` and `readOnly`, and an audit log of every call
  (never arguments or results).
- `setup-agent` and `instructions` to teach coding agents (Claude Code, Cursor,
  Windsurf, Codex, opencode, Gemini CLI, Copilot and other `AGENTS.md` readers) to
  use mcpx.
- A Claude Code plugin with the mcpx skill and `/mcpx:setup`; the repository is its
  own plugin marketplace.

[Unreleased]: https://github.com/TimoWillemsen/mcpx/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/TimoWillemsen/mcpx/releases/tag/v0.4.1
