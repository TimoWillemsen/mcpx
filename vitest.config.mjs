import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees (e.g. .claude/worktrees/*) are full copies of the repo.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
