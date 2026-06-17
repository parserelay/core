import { describe, expect, it } from "vitest";
import {
  type ScanAccepted,
  type ScanDryRun,
  type ScanEnvelope,
  type ScanStatus,
  isEnvelope,
} from "./index";

function envelope(status: ScanStatus): ScanEnvelope {
  return {
    scan_id: "scn_test",
    status,
    fields: { total: 12 },
    confidence: { total: 0.9 },
    needs_review: [],
    raw_text: "…",
    meta: {
      engine: "ocr+rescue",
      model: "claude-haiku-4-5",
      ocr_backend: "paddle",
      latency_ms: 10,
      tokens: { input: 1180, output: 95, credits: 2 },
      scan_credits: 1,
      total_credits: 3,
    },
  };
}

describe("isEnvelope", () => {
  it("returns true for ok / partial / failed", () => {
    expect(isEnvelope(envelope("ok"))).toBe(true);
    expect(isEnvelope(envelope("partial"))).toBe(true);
    expect(isEnvelope(envelope("failed"))).toBe(true);
  });

  it("returns false for the async ack", () => {
    const accepted: ScanAccepted = { scan_id: "scn_test", status: "accepted" };
    expect(isEnvelope(accepted)).toBe(false);
  });

  it("returns false for a dry-run preview", () => {
    const dry: ScanDryRun = {
      scan_id: "scn_test",
      status: "dry_run",
      would_rescue: [{ field: "vat", reason: "out_of_range" }],
      scan_credits: 1,
      ocr_credits: 0.11,
      estimated_model_credits: 3,
    };
    expect(isEnvelope(dry)).toBe(false);
  });
});
