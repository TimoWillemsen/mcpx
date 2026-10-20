---
name: setup
description: Install the mcpx CLI and configure MCP servers for it
disable-model-invocation: true
allowed-tools: Bash(node --version) Bash(npm install -g --install-links github:TimoWillemsen/mcpx) Bash(mcpx *) Read
---

Set up mcpx so you can use MCP servers through the shell. The mcpx skill from this
plugin already teaches you how to use it; this command installs the CLI and the
servers.

1. Check whether `mcpx --version` works. If it does, skip to step 3.
2. Check that `node --version` is 20 or newer (if not, tell me and stop), then install
   mcpx with `npm install -g --install-links github:TimoWillemsen/mcpx`
   and confirm that `mcpx --version` works.
3. Set up my MCP servers in ~/.config/mcpx/servers.json (it uses the same
   "mcpServers" format as Claude Desktop, Claude Code and Cursor). If I already have
   MCP servers configured, offer to copy them; otherwise ask me which servers I want.
   Never copy secret values: replace tokens and keys with ${ENV_VAR} references and
   tell me which variables to set.
4. Run `mcpx servers --text` and show me the result. If an HTTP server needs a login,
   tell me to run `mcpx login <name>` myself. Don't run it yourself.
