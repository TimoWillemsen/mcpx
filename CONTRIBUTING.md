# Contributing to mcpx

Thanks for helping out. mcpx is a small, generic CLI, and the bar for changes is that
it stays small, predictable and safe to hand to an agent.

## Ground rules

- **Vendor-neutral.** No code, names or defaults for a specific MCP server or company.
  If a server needs special handling, find the general version of the fix.
- **Never break automation.** JSON on stdout, errors as one JSON line on stderr, the
  documented exit codes (0 ok, 1 tool error, 2 auth, 3 config/usage, 4 blocked by
  policy), and no command may hang or prompt (except `login`).
- **Secrets never leak.** Tokens only in the OS keychain; never in files, logs, output,
  error messages or the audit log. The audit log never contains arguments or results.

## Development

```sh
npm install
npm test               # builds, then runs the vitest suite
npm run dev -- tools <server>
```

The tests run the built CLI as a subprocess against local fixture servers (a stdio
reference server, a bearer-auth HTTP server and a fake OAuth authorization server),
so exit codes and output are real. They never call remote services or touch your real
keychain. Add tests for any new exit code or JSON output shape.

## Before you open a pull request

1. `npm test` passes.
2. `npm run check:dist` passes. `dist/` and the generated plugin files under
   `plugins/` are committed (so installing from git needs no build), so commit the
   output of `npm run compile` with your change.
3. If you changed the agent instructions or plugin, run
   `claude plugin validate .` and `claude plugin validate ./plugins/mcpx`.
4. Update `CHANGELOG.md` under "Unreleased", and the README if behaviour changed.

Keep pull requests focused: one change per PR is easier to review and to revert.

## Dependencies and releases

Dependabot opens grouped update PRs every Monday. Patch and minor updates merge
automatically once CI passes; major updates wait for review. When a merge changes the
runtime `dependencies` or `dist/`, the release workflow bumps the patch version,
rebuilds, updates this changelog, and publishes a GitHub release. For a feature
release, bump the version yourself (`npm version minor --no-git-tag-version`, then
`npm run compile`) and write the changelog entry; the workflow skips commits that
already change the version. It doesn't create releases for those, so tag and release
them by hand.

## Reporting security issues

Please don't open an issue for a vulnerability. See [SECURITY.md](SECURITY.md).
