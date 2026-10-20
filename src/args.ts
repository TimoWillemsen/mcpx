import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { usageError } from "./errors.js";

/**
 * Tool arguments for `mcpx call`, given either as one JSON object or as
 * `key=value` pairs that are converted using the tool's input schema:
 *
 *   mcpx call srv tool '{"limit": 5}'
 *   mcpx call srv tool limit=5 assignee=me fields=id,title
 *   mcpx call srv tool 'filter:={"state":"open"}'    # := takes a raw JSON value
 */
export type ParsedArgs =
  | { kind: "json"; value: Record<string, unknown> }
  | { kind: "pairs"; pairs: Pair[] };

export interface Pair {
  key: string;
  value: string;
  /** `key:=value`: value is JSON and is used as-is. */
  rawJson: boolean;
}

export function parseCallArgs(tokens: string[]): ParsedArgs {
  if (tokens.length === 0) return { kind: "json", value: {} };
  if (tokens.length === 1 && /^\s*[{[]/.test(tokens[0])) {
    return { kind: "json", value: parseJsonObject(tokens[0]) };
  }

  const pairs: Pair[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      throw usageError(
        `expected key=value (or one JSON object), got "${token}"; e.g. mcpx call <server> <tool> limit=5`,
      );
    }
    let key = token.slice(0, eq);
    const rawJson = key.endsWith(":");
    if (rawJson) key = key.slice(0, -1);
    if (!key) throw usageError(`missing key in "${token}"`);
    if (seen.has(key)) throw usageError(`argument "${key}" given more than once`);
    seen.add(key);
    pairs.push({ key, value: token.slice(eq + 1), rawJson });
  }
  return { kind: "pairs", pairs };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw usageError(`arguments are not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError("arguments must be a JSON object, e.g. '{\"key\": \"value\"}'");
  }
  return parsed as Record<string, unknown>;
}

interface PropSchema {
  type?: string | string[];
  items?: PropSchema;
  enum?: unknown[];
}

/** Turn key=value pairs into typed arguments using the tool's input schema. */
export function coercePairs(pairs: Pair[], tool: Tool): Record<string, unknown> {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, PropSchema>;
  const known = Object.keys(props);
  // Only accept unknown keys when the schema explicitly allows extra properties.
  const extraAllowed = Boolean((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties);

  const out: Record<string, unknown> = {};
  for (const { key, value, rawJson } of pairs) {
    const schema = props[key];
    if (!schema && known.length > 0 && !extraAllowed) {
      const hint = closest(key, known);
      throw usageError(
        `"${tool.name}" has no argument "${key}"${hint ? ` (did you mean "${hint}"?)` : ""}; arguments: ${known.join(", ")}`,
      );
    }
    if (rawJson) {
      try {
        out[key] = JSON.parse(value);
      } catch (err) {
        throw usageError(`${key}:= expects a JSON value: ${(err as Error).message}`);
      }
      continue;
    }
    out[key] = coerce(key, value, schema);
  }
  return out;
}

function types(schema: PropSchema | undefined): string[] {
  if (!schema?.type) return [];
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function coerce(key: string, value: string, schema: PropSchema | undefined): unknown {
  const t = types(schema);
  // Strings win: a field typed ["string","null"] gets the literal text (use := for JSON).
  if (t.length === 0 || t.includes("string")) return value;

  if (t.includes("integer") || t.includes("number")) {
    const n = Number(value);
    if (value.trim() === "" || !Number.isFinite(n)) {
      throw usageError(`${key} must be a number, got "${value}"`);
    }
    if (!t.includes("number") && !Number.isInteger(n)) {
      throw usageError(`${key} must be an integer, got "${value}"`);
    }
    return n;
  }
  if (t.includes("boolean")) {
    const v = value.toLowerCase();
    if (["true", "yes", "1", "on"].includes(v)) return true;
    if (["false", "no", "0", "off"].includes(v)) return false;
    throw usageError(`${key} must be true or false, got "${value}"`);
  }
  if (t.includes("array")) {
    if (value.trim().startsWith("[")) return jsonValue(key, value);
    if (value === "") return [];
    return value.split(",").map((item) => coerce(`${key}[]`, item.trim(), schema?.items));
  }
  if (t.includes("object")) return jsonValue(key, value);
  if (t.includes("null") && value === "null") return null;
  return value;
}

function jsonValue(key: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw usageError(`${key} expects JSON here: ${(err as Error).message}`);
  }
}

/** Nearest known name by edit distance, for "did you mean" hints. */
function closest(name: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = editDistance(name.toLowerCase(), c.toLowerCase());
    if (d < bestDist) [best, bestDist] = [c, d];
  }
  return bestDist <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}
