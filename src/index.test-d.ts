import { describe, expectTypeOf, it } from "vitest";
import { isEnvelope } from "./index";
import type {
  ConfidenceMap,
  Engine,
  FieldSourceMap,
  JsonSchema,
  OcrBackend,
  OcrConfig,
  ScanAccepted,
  ScanDryRun,
  ScanEnvelope,
  ScanMeta,
  ScanResponse,
  ScanSchema,
  TokenUsage,
} from "./index";

describe("ScanSchema", () => {
  it("accepts field-list shorthand AND full JSON Schema", () => {
    expectTypeOf<string[]>().toMatchTypeOf<ScanSchema>();
    expectTypeOf<JsonSchema>().toMatchTypeOf<ScanSchema>();
    expectTypeOf<{
      type: "object";
      properties: Record<string, JsonSchema>;
    }>().toMatchTypeOf<ScanSchema>();
  });

  it("surfaces description / minimum / maximum / enum for the schema's triple duty", () => {
    expectTypeOf<JsonSchema["description"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<JsonSchema["minimum"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<JsonSchema["maximum"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<JsonSchema["enum"]>().toEqualTypeOf<unknown[] | undefined>();
  });
});

describe("ConfidenceMap", () => {
  it("allows null per field", () => {
    expectTypeOf<ConfidenceMap>().toEqualTypeOf<Record<string, number | null>>();
    expectTypeOf<null>().toMatchTypeOf<ConfidenceMap[string]>();
  });
});

describe("engine + ocr backend", () => {
  it("Engine includes ocr+rescue", () => {
    expectTypeOf<"ocr+rescue">().toMatchTypeOf<Engine>();
  });
  it("OcrBackend includes passthrough", () => {
    expectTypeOf<"passthrough">().toMatchTypeOf<OcrBackend>();
  });
});

describe("OcrConfig discriminated union", () => {
  it("passthrough requires text", () => {
    expectTypeOf<{ backend: "passthrough"; text: string }>().toMatchTypeOf<OcrConfig>();
    expectTypeOf<{ backend: "passthrough" }>().not.toMatchTypeOf<OcrConfig>();
  });
  it("text is forbidden for non-passthrough backends", () => {
    expectTypeOf<{ backend: "tesseract" }>().toMatchTypeOf<OcrConfig>();
    expectTypeOf<{ backend: "tesseract"; text: string }>().not.toMatchTypeOf<OcrConfig>();
  });
});

describe("ScanResponse", () => {
  it("is the three-way union", () => {
    expectTypeOf<ScanResponse>().toEqualTypeOf<ScanEnvelope | ScanAccepted | ScanDryRun>();
  });
});

describe("additive envelope fields", () => {
  it("field_source is optional", () => {
    expectTypeOf<ScanEnvelope["field_source"]>().toEqualTypeOf<FieldSourceMap | undefined>();
  });
  it("meta.total_credits is always present", () => {
    expectTypeOf<ScanMeta["total_credits"]>().toEqualTypeOf<number>();
  });
  it("meta.tokens is optional (present when a model ran)", () => {
    expectTypeOf<ScanMeta["tokens"]>().toEqualTypeOf<TokenUsage | undefined>();
  });
});

describe("isEnvelope", () => {
  it("narrows to the envelope in the true branch, ack/dry-run in the false branch", () => {
    const r = {} as ScanResponse;
    if (isEnvelope(r)) {
      expectTypeOf(r).toEqualTypeOf<ScanEnvelope>();
    } else {
      expectTypeOf(r).toEqualTypeOf<ScanAccepted | ScanDryRun>();
    }
  });
});
