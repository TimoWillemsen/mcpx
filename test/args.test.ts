import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { coercePairs, parseCallArgs, type Pair } from "../src/args.js";
import { unwrap } from "../src/commands/call.js";

const tool = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}): Tool => ({
  name: "t",
  inputSchema: { type: "object", properties, ...extra },
});

const pairs = (...tokens: string[]): Pair[] => {
  const p = parseCallArgs(tokens);
  if (p.kind !== "pairs") throw new Error("expected pairs");
  return p.pairs;
};

describe("parseCallArgs", () => {
  it("accepts nothing, one JSON object, or key=value pairs", () => {
    expect(parseCallArgs([])).toEqual({ kind: "json", value: {} });
    expect(parseCallArgs(['{"a":1}'])).toEqual({ kind: "json", value: { a: 1 } });
    expect(parseCallArgs(["a=1", "b:=[2]"])).toEqual({
      kind: "pairs",
      pairs: [
        { key: "a", value: "1", rawJson: false },
        { key: "b", value: "[2]", rawJson: true },
      ],
    });
  });

  it("keeps everything after the first = as the value", () => {
    expect(pairs("q=a=b")[0].value).toBe("a=b");
  });

  it.each([["noequals"], ["=x"], [":=1"]])("rejects %s", (t) => {
    expect(() => parseCallArgs([t])).toThrow();
  });

  it("rejects duplicate keys and non-object JSON", () => {
    expect(() => parseCallArgs(["a=1", "a=2"])).toThrow(/more than once/);
    expect(() => parseCallArgs(["[1,2]"])).toThrow(/JSON object/);
  });
});

describe("coercePairs", () => {
  const schema = tool({
    limit: { type: "number" },
    page: { type: "integer" },
    archived: { type: "boolean" },
    assignee: { type: ["string", "null"] },
    fields: { type: "array", items: { type: "string" } },
    ids: { type: "array", items: { type: "number" } },
    filter: { type: "object" },
    name: { type: "string" },
  });

  it("converts values using the schema", () => {
    expect(
      coercePairs(
        pairs("limit=5", "page=2", "archived=yes", "fields=id, title", "ids=1,2", "filter={\"a\":1}", "name=007"),
        schema,
      ),
    ).toEqual({ limit: 5, page: 2, archived: true, fields: ["id", "title"], ids: [1, 2], filter: { a: 1 }, name: "007" });
  });

  it('keeps strings as strings, even "null" for a string|null field', () => {
    expect(coercePairs(pairs("assignee=null"), schema)).toEqual({ assignee: "null" });
  });

  it("uses := values as raw JSON", () => {
    expect(coercePairs(pairs("assignee:=null", "fields:=[]"), schema)).toEqual({ assignee: null, fields: [] });
  });

  it("explains bad values", () => {
    expect(() => coercePairs(pairs("limit=lots"), schema)).toThrow(/limit must be a number/);
    expect(() => coercePairs(pairs("page=1.5"), schema)).toThrow(/integer/);
    expect(() => coercePairs(pairs("archived=maybe"), schema)).toThrow(/true or false/);
    expect(() => coercePairs(pairs("ids=1,x"), schema)).toThrow(/number/);
  });

  it("suggests the closest argument for a typo", () => {
    expect(() => coercePairs(pairs("limt=5"), schema)).toThrow(/did you mean "limit"/);
  });

  it("allows unknown keys only when the schema allows extra properties", () => {
    expect(coercePairs(pairs("x=1"), tool({}, { additionalProperties: true }))).toEqual({ x: "1" });
    expect(coercePairs(pairs("x=1"), tool({}))).toEqual({ x: "1" }); // no properties declared at all
    expect(() => coercePairs(pairs("x=1"), tool({ a: { type: "string" } }))).toThrow(/no argument "x"/);
  });
});

describe("unwrap", () => {
  it("prefers structuredContent", () => {
    expect(unwrap({ content: [{ type: "text", text: "x" }], structuredContent: { a: 1 } })).toEqual({ a: 1 });
  });

  it("parses JSON text, otherwise returns the text", () => {
    expect(unwrap({ content: [{ type: "text", text: '{"issues":[]}' }] })).toEqual({ issues: [] });
    expect(unwrap({ content: [{ type: "text", text: "Echo: hi" }] })).toBe("Echo: hi");
    expect(unwrap({ content: [] })).toBe("");
  });

  it("returns non-text content as-is", () => {
    const content = [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }];
    expect(unwrap({ content })).toEqual(content);
  });
});
