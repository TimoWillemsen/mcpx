#!/usr/bin/env node
import { Command, CommanderError, Option } from "commander";
import type { SessionOptions } from "./client.js";
import { instructionsCommand, setupAgentCommand } from "./commands/agent.js";
import { loginCommand, logoutCommand } from "./commands/auth.js";
import { callCommand } from "./commands/call.js";
import { doctorCommand } from "./commands/doctor.js";
import { serversCommand } from "./commands/servers.js";
import { describeCommand, toolsCommand } from "./commands/tools.js";
import { ExitCode, usageError } from "./errors.js";
import { outputFormat, printError, printResult, type CommandResult } from "./output.js";
import { backgroundUpdate, maybeScheduleAutoUpdate, update } from "./update.js";
import { VERSION } from "./version.js";

interface GlobalOptions {
  text?: boolean;
  json?: boolean;
  timeout: string;
  verbose?: boolean;
}

const program = new Command()
  .name("mcpx")
  .description("CLI client for MCP servers")
  .version(VERSION)
  .addOption(
    new Option("--text", "human-readable output (default on a terminal)").conflicts("json"),
  )
  .addOption(new Option("--json", "JSON output (default when piped; or set MCPX_OUTPUT)"))
  .addOption(
    new Option("--timeout <ms>", "overall timeout per command")
      .env("MCPX_TIMEOUT")
      .default("30000"),
  )
  .addOption(new Option("-v, --verbose", "show server stderr"))
  .exitOverride()
  .configureOutput({
    // Commander's own usage errors go to stderr; we decide the exit code.
    writeErr: (s) => process.stderr.write(s),
  });

function globals(): GlobalOptions {
  return program.opts<GlobalOptions>();
}

function sessionOptions(): SessionOptions {
  const g = globals();
  const timeoutMs = Number(g.timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw usageError(`--timeout must be a positive number of ms, got "${g.timeout}"`);
  }
  return { timeoutMs, verbose: g.verbose };
}

/** Wraps a command so its result is printed and its exit code recorded. */
function action<A extends unknown[]>(
  fn: (...args: A) => CommandResult | Promise<CommandResult>,
) {
  return async (...args: A) => {
    outputFormat(globals(), false); // reject an invalid MCPX_OUTPUT before doing anything
    const result = await fn(...args);
    printResult(result, globals());
    process.exitCode = result.exitCode ?? ExitCode.OK;
  };
}

program
  .command("servers")
  .description("list configured servers")
  .action(action(() => serversCommand()));

program
  .command("tools")
  .description("list tools a server exposes (tools blocked by policy are hidden)")
  .argument("<server>")
  .option("--all", "also list tools blocked by allowedTools/readOnly, marked as blocked")
  .action(
    action((server: string, o: { all?: boolean }) =>
      toolsCommand(server, { ...sessionOptions(), all: o.all }),
    ),
  );

program
  .command("describe")
  .description("show a tool's description and input schema")
  .argument("<server>")
  .argument("<tool>")
  .action(
    action((server: string, tool: string) =>
      describeCommand(server, tool, sessionOptions()),
    ),
  );

program
  .command("call")
  .description("call a tool with key=value arguments or one JSON object")
  .argument("<server>")
  .argument("<tool>")
  .argument(
    "[args...]",
    "key=value pairs, converted using the tool's schema (key:=<json> for a raw JSON value), or one JSON object",
  )
  .option("--unwrap", "print the payload: structuredContent, or the text (parsed as JSON if it is JSON)")
  .action(
    action((server: string, tool: string, args: string[], o: { unwrap?: boolean }) =>
      callCommand(server, tool, args, { ...sessionOptions(), unwrap: o.unwrap }),
    ),
  );

program
  .command("login")
  .description("log in to an HTTP server with OAuth (opens a browser)")
  .argument("<server>")
  .option("--no-browser", "print the authorization URL instead of opening a browser")
  .option("--wait <seconds>", "how long to wait for you to approve", "300")
  .action(
    action((server: string, o: { browser: boolean; wait: string }) => {
      const waitSeconds = Number(o.wait);
      if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
        throw usageError(`--wait must be a positive number of seconds, got "${o.wait}"`);
      }
      return loginCommand(server, {
        browser: o.browser,
        waitMs: waitSeconds * 1000,
        session: sessionOptions(),
      });
    }),
  );

program
  .command("logout")
  .description("remove stored credentials for a server and revoke them")
  .argument("<server>")
  .action(action((server: string) => logoutCommand(server)));

program
  .command("doctor")
  .description("check the setup: Node, config, keychain, audit log, and each server's connection and login")
  .argument("[server]", "only check this server")
  .option("--offline", "don't connect to servers")
  .action(
    action((server: string | undefined, o: { offline?: boolean }) =>
      doctorCommand({ ...sessionOptions(), server, offline: o.offline }),
    ),
  );

program
  .command("update")
  .description("install the latest mcpx release (mcpx also does this automatically once a day)")
  .option("--check", "only check whether a newer release exists")
  .action(
    action(async (o: { check?: boolean }) => {
      const r = await update({ checkOnly: o.check });
      return {
        json: r,
        text: () =>
          r.updated
            ? `Updated mcpx ${r.current} -> ${r.latest}.`
            : r.skipped
              ? `mcpx ${r.latest} is available, but not installed: ${r.skipped}.`
              : r.updateAvailable
                ? `mcpx ${r.latest} is available (you have ${r.current}); run: mcpx update`
                : `mcpx ${r.current} is up to date.`,
      };
    }),
  );

// Started detached by maybeScheduleAutoUpdate; not for direct use.
program
  .command("__auto-update", { hidden: true })
  .action(async () => {
    await backgroundUpdate();
  });

program
  .command("instructions")
  .description("print instructions that teach a coding agent to use mcpx (markdown)")
  .option("--format <format>", "markdown, skill (Claude Code), cursor or windsurf", "markdown")
  .action(action((o: { format: string }) => instructionsCommand(o.format)));

program
  .command("setup-agent")
  .description(
    "install the mcpx instructions for coding agents: skills (shared .agents/skills), claude, cursor, windsurf, codex, opencode, gemini, copilot, kiro, agents",
  )
  .argument("<agents...>", "one or more agents")
  .option("-g, --global", "install for the user (all projects) instead of the current project")
  .option("--dir <path>", "project directory (default: current directory)")
  .option("--force", "overwrite an existing file that mcpx didn't create")
  .option("--dry-run", "show what would change without writing")
  .action(
    action(
      (
        agents: string[],
        o: { global?: boolean; dir?: string; force?: boolean; dryRun?: boolean },
      ) =>
        setupAgentCommand(agents, {
          global: Boolean(o.global),
          dir: o.dir,
          force: o.force,
          dryRun: o.dryRun,
        }),
    ),
  );

async function main(): Promise<number> {
  const sub = process.argv[2];
  if (sub !== "__auto-update" && sub !== "update") maybeScheduleAutoUpdate();
  try {
    await program.parseAsync(process.argv);
    return Number(process.exitCode ?? ExitCode.OK);
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help and --version are "errors" with exit code 0.
      return err.exitCode === 0 ? ExitCode.OK : ExitCode.USAGE;
    }
    return printError(err, globals());
  }
}

// Exit explicitly so a lingering child process or socket can never keep us alive.
main().then((code) => process.exit(code));
