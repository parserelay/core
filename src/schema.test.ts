import { describe, expect, it } from "vitest";
import { parseScanRequest } from "./schema";

describe("parseScanRequest", () => {
  it("accepts a field-list array schema", () => {
    const r = parseScanRequest({ image: "data:,", schema: ["merchant", "total"] });
    expect(r.ok).toBe(true);
  });

  it("accepts a JSON Schema object with a properties map (keeping extra keywords)", () => {
    const r = parseScanRequest({
      image: "data:,",
      schema: {
        type: "object",
        properties: { total: { type: "number" } },
        required: ["total"],
        additionalProperties: false,
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok && !Array.isArray(r.data.schema)) {
      expect((r.data.schema as Record<string, unknown>).additionalProperties).toBe(false);
    }
  });

  it("rejects a flat {field:type} schema object (no properties)", () => {
    const r = parseScanRequest({
      image: "data:,",
      schema: { merchant: "string", total: "number" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a schema array that isn't all strings", () => {
    const r = parseScanRequest({ image: "data:,", schema: ["merchant", { total: "number" }] });
    expect(r.ok).toBe(false);
  });

  it("requires image unless passthrough text is supplied", () => {
    expect(parseScanRequest({ schema: ["total"] }).ok).toBe(false);
    const r = parseScanRequest({
      ocr: { backend: "passthrough", text: "Total: 18.50" },
      schema: ["total"],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects passthrough without text — with an explicit message", () => {
    const r = parseScanRequest({ ocr: { backend: "passthrough" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("passthrough requires a non-empty ocr.text");
  });

  it("rejects an unknown ocr backend — with an explicit message", () => {
    const r = parseScanRequest({ image: "data:,", ocr: { backend: "tesseractt" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Unknown ocr.backend");
  });

  it("accepts unknown extra keys on ocr (lenient, as before)", () => {
    const r = parseScanRequest({ image: "data:,", ocr: { backend: "auto", extra: "ignored" } });
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown engine", () => {
    expect(parseScanRequest({ image: "data:,", engine: "magic" }).ok).toBe(false);
  });
});
