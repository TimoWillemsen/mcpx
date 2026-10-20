import { createRequire } from "node:module";

/** The package version, read from package.json so there is a single source of truth. */
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;
