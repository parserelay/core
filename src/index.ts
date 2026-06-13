/**
 * Scan API — request/response contract.
 *
 * Source of truth for the `scan` operation across all three surfaces
 * (MCP tool, REST `POST /v1/scan`, and the <DeadSimpleMicroScanner> component).
 *
 * Design rule: the ENVELOPE (ScanEnvelope) is stable and additive-only.
 * The ENGINE is a swappable parameter behind it — new modes ship without
 * breaking existing callers.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** A publicly fetchable URL or a base64 data URI (e.g. `data:image/jpeg;base64,…`). */
export type ImageInput = string;

/** Hint that tunes prompting and defaults. `freeform` is assumed when absent. */
export type DocType = "receipt" | "invoice" | "id" | "business_card" | "freeform";

/**
 * The swappable extraction axis.
 * - `auto`       detect a text layer → `ocr+rescue` if present, else `vision`. Default.
 * - `ocr`        OCR backend only; text + basic structure. Cheapest, no LLM.
 * - `ocr+rescue` deterministic parse first, LLM rescues ONLY flagged fields against the
 *                page image. Cheapest accurate path; what `auto` prefers on text-bearing docs.
 * - `ocr+check`  OCR text → LLM structures *everything* and self-checks. Still available;
 *                no longer the `auto` default (see `ocr+rescue`).
 * - `vision`     vision-LLM directly on the image. For photos / poor scans / no text layer.
 */
export type Engine = "auto" | "ocr" | "ocr+rescue" | "ocr+check" | "vision";

/**
 * OCR backend, selectable per request.
 * - `auto`        default; prefers GLM-OCR, escalating to `vision` on low-confidence pages.
 * - `glm`         GLM-OCR (0.9B) via Z.AI; the preferred backend powering `auto`.
 * - `mistral`     Mistral OCR; fallback backend.
 * - `tesseract`   free server OCR; good enough to feed deterministic extractors.
 * - `paddle`      stronger on dense tables / grid-heavy forms.
 * - `vision`      LLM-as-OCR (best, incl. handwriting); the escalation path.
 * - `passthrough` caller supplies already-OCR'd `text`; no OCR is run.
 */
export type OcrBackend =
  | "auto"
  | "glm"
  | "mistral"
  | "tesseract"
  | "paddle"
  | "vision"
  | "passthrough";

/**
 * OCR backend selection. A discriminated union so `text` is *required* exactly
 * when `backend` is `passthrough`, and forbidden otherwise — the type closes the
 * "passthrough without text" silent-failure path at compile time.
 */
export type OcrConfig =
  | {
      /** Which OCR backend to run. Default `auto`. */
      backend?: Exclude<OcrBackend, "passthrough">;
      text?: never;
    }
  | {
      backend: "passthrough";
      /** Pre-OCR'd text supplied by the caller; no OCR is run. */
      text: string;
    };

/**
 * What you want out.
 * - Field-list shorthand: `["client_name", "total", "vat"]` — expanded to JSON Schema server-side.
 * - Full JSON Schema: the escape hatch for nested line-items, discounts, parent/child layers.
 * Omit entirely for generic document extraction.
 */
export type ScanSchema = string[] | JsonSchema;

/**
 * Minimal JSON Schema shape — intentionally loose; full Schema is accepted as the escape hatch.
 *
 * The schema does triple duty: output validation,
 * confidence-gate derivation (`minimum`/`maximum`/`enum`), and per-field prompting
 * (`description` is fed verbatim into the rescue call as the extraction instruction).
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  /** Fed verbatim into the rescue prompt as the per-field extraction instruction. */
  description?: string;
  /** Lower bound; also feeds the out-of-range rescue trigger. */
  minimum?: number;
  /** Upper bound; also feeds the out-of-range rescue trigger. */
  maximum?: number;
  /** Allowed values: the coercion target. Unmappable values are flagged, never approximated. */
  enum?: unknown[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Relay (fire-and-forget)
// ---------------------------------------------------------------------------

export interface RelayConfig {
  /** Webhook the worker controls. The full envelope is POSTed here, HMAC-signed. */
  url: string;
  /** A retried scan with the same key never double-posts. */
  idempotency_key: string;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface ScanRequest {
  /** URL or base64 data URI. Required. The first (or only) page. */
  image: ImageInput;

  /**
   * Additional page images for a multi-page document, in order — the caller
   * supplies one rendered image per page (e.g. a PDF rasterized client/server-side;
   * the Worker doesn't render PDFs). Total pages = `[image, ...pages]`. Each page is
   * extracted independently and the fields are merged (the best value per field wins),
   * so each page's rescue reads its own image. Billed one plumbing credit per page.
   */
  pages?: ImageInput[];

  /** Field-list shorthand OR full JSON Schema. Default = generic document. */
  schema?: ScanSchema;

  /** Optional document-type hint. */
  doc_type?: DocType;

  /** Extraction mode. Default `auto`. */
  engine?: Engine;

  /** OCR backend selection + optional pre-OCR'd `text` (passthrough). Default backend `auto`. */
  ocr?: OcrConfig;

  /**
   * Preview-only. When `true`, the service does NOT spend money: it returns a
   * `ScanDryRun` listing the fields that *would* trigger a paid rescue call (and why)
   * plus the estimated credits. How an operator trusts the cost before committing.
   * Takes precedence over `relay`: a dry run is returned inline only; nothing is posted.
   */
  dry_run?: boolean;

  /** Pin a specific model (e.g. "claude-haiku-4-5"). `null`/omit = our default for the engine. */
  model?: string | null;

  /**
   * Bring your own provider key → we charge plumbing only (your `scan_credits`),
   * never your model tokens. The model bill is on your provider; the envelope's
   * `meta.tokens.provider_cost_usd` estimates it, and `meta.total_credits` is
   * then just the plumbing.
   */
  model_key?: string | null;

  /** Present → fire-and-forget; result is POSTed to `relay.url` instead of / in addition to returning inline. */
  relay?: RelayConfig;
}

// ---------------------------------------------------------------------------
// Response envelope (STABLE — additive changes only)
// ---------------------------------------------------------------------------

/**
 * Overall outcome.
 * - `ok`       everything extracted.
 * - `partial`  some fields missing or extraction degraded but usable.
 * - `failed`   no usable result; inspect `meta` and `raw_text`.
 */
export type ScanStatus = "ok" | "partial" | "failed";

/** Status returned immediately on the async path before the envelope is delivered. */
export type ScanAcceptedStatus = "accepted";

/** Status returned for a preview-only request (`dry_run: true`). */
export type ScanDryRunStatus = "dry_run";

/**
 * Provenance of a field's value — *how* it was obtained, complementary to the
 * numeric `confidence`.
 * - `deterministic` parsed without a model call (the cheap path).
 * - `model`         produced directly by a model (the `vision` path, or `ocr+check`
 *                   structuring the whole document) — no prior deterministic pass.
 * - `rescued`       resolved by the LLM rescue pass after being flagged.
 * - `uncertain`     left unresolved / below bar — appears in `needs_review`.
 * - `positional`    derived structurally (e.g. from page index), not OCR'd.
 * - `inferred`      model-produced but NOT supported by `raw_text` — a likely
 *                   guess (e.g. a synthesized default or an appended detail).
 *                   Trust `deterministic`/`rescued`/`model` as grounded; treat
 *                   `inferred` with caution. Always also in `needs_review`.
 */
export type FieldSource =
  | "deterministic"
  | "model"
  | "rescued"
  | "uncertain"
  | "positional"
  | "inferred";

/** Per-field provenance map (keys match `fields`). */
export type FieldSourceMap = Record<string, FieldSource>;

/**
 * Model usage behind a scan — token counts plus its cost. Present only when a
 * model ran. Exactly one of `credits` / `provider_cost_usd` is set: `credits`
 * when the model ran on our keys (billed to your balance, may be fractional),
 * `provider_cost_usd` when you brought a `model_key` (the bill is on your key).
 */
export interface TokenUsage {
  input: number;
  output: number;
  /** Our key: credits charged for this model usage (decimal; may be 0). */
  credits?: number;
  /** BYO: cost on YOUR provider key, USD at sticker. */
  provider_cost_usd?: number;
}

/**
 * OCR-backend usage behind a scan — token counts plus the credits charged for
 * them. Present only when the backend reports tokens (e.g. GLM-OCR; Mistral's
 * free tier reports none). Separate from {@link TokenUsage}, which is the model
 * pass. The OCR backend ALWAYS runs on our key — the caller's `model_key` is the
 * *model* provider's key, never the OCR backend's — so OCR cost is always billed
 * as `credits` (folded into `total_credits`), even when the model itself runs on
 * a BYO key. Hence there is no `provider_cost_usd` here.
 */
export interface OcrUsage {
  input: number;
  output: number;
  /** Credits charged for OCR usage, included in `total_credits`. `0` on a failed scan. */
  credits?: number;
}

/**
 * Per-field confidence, 0–1.
 *
 * Honest when an LLM is in the loop (`ocr+check`, `vision`). In `ocr`-only mode
 * there is no model to judge correctness, so each value is `null` — the absence
 * of confidence is itself the signal that the caller is in raw mode.
 */
export type ConfidenceMap = Record<string, number | null>;

/** Present only when the engine ran a check pass (`ocr+check`, or `auto` resolving to it). */
export interface SelfCheck {
  /** Headline result of the self-check. */
  passed: boolean;
  /** Human-readable explanations of any failures (e.g. line-items not summing to total). */
  notes: string[];
}

export interface ScanMeta {
  engine: Engine;
  /** The model actually used, if any (null in `ocr`-only mode). */
  model: string | null;
  /** The OCR backend used, if any (e.g. "paddle", "docling"; null in pure `vision` mode). */
  ocr_backend: string | null;
  latency_ms: number;
  /** Model usage (counts + cost). Absent on a fully-deterministic run. */
  tokens?: TokenUsage;
  /**
   * OCR-backend usage (counts + credits). Present only when the backend reports
   * tokens (e.g. GLM-OCR). Separate from `tokens` (the model pass).
   */
  ocr_usage?: OcrUsage;
  /**
   * Billable operations = the plumbing credits charged (1 credit per scan/page).
   * `0` on a `failed` scan (a failed scan never burns a credit); the page count
   * for a multi-page PDF.
   */
  scan_credits: number;
  /**
   * Total credits deducted from your balance = `scan_credits` (plumbing) +
   * `tokens.credits` (model, on our keys) + `ocr_usage.credits` (OCR backend,
   * always on our keys) — the headline charge. On BYO the model is on your key
   * (its cost is `tokens.provider_cost_usd`, not credits), so this equals
   * `scan_credits` + `ocr_usage.credits` — the OCR backend still bills credits.
   */
  total_credits: number;
  /**
   * Present only when the API key was paired to a BYO provider key that we did
   * NOT use for this scan, so the model ran on our keys (you were charged model
   * credits). `provider_mismatch`: the paired key's provider didn't match the
   * model. `decrypt_failed`: the stored key couldn't be decrypted. Absent on a
   * normal scan (BYO used, or no pairing, or no model ran).
   */
  byok_skipped?: "provider_mismatch" | "decrypt_failed";
  /** Optional free-text note (e.g. why confidence is null, why status is partial). */
  note?: string;
}

/**
 * The envelope. Returned inline on the sync path, and POSTed (byte-identical)
 * to `relay.url` on the async path.
 *
 * `fields` is typed generically so callers can narrow it to their own schema:
 *   const r = await scan<{ merchant: string; total: number }>(req)
 */
export interface ScanEnvelope<Fields = Record<string, unknown>> {
  scan_id: string;
  status: ScanStatus;

  /** Structured data matching the requested schema. */
  fields: Fields;

  /** Per-field confidence 0–1 (null per field in `ocr`-only mode). */
  confidence: ConfidenceMap;

  /** Subset of fields whose confidence/ambiguity crossed the review threshold. */
  needs_review: string[];

  /** Per-field provenance (deterministic / model / rescued / uncertain / positional / inferred). Complements `confidence`. */
  field_source?: FieldSourceMap;

  /** Present only when a check pass ran. */
  self_check?: SelfCheck;

  /** Full-text fallback. Always present. */
  raw_text: string;

  meta: ScanMeta;
}

/** Immediate response on the async path (when `relay` is present). HTTP 202. */
export interface ScanAccepted {
  scan_id: string;
  status: ScanAcceptedStatus;
}

/** A single field the dry-run predicts would trigger a paid rescue, with the reason. */
export interface DryRunFlag {
  field: string;
  /** Which trigger fired (e.g. "missing_required", "out_of_range", "garbled_glyphs"). */
  reason: string;
}

/**
 * Preview-only response (returned when `request.dry_run` is `true`). No money spent.
 * Lists the fields that *would* be rescued and the estimated cost if run for real.
 */
export interface ScanDryRun {
  scan_id: string;
  status: ScanDryRunStatus;
  /** Fields that would trigger a paid rescue call, and why. */
  would_rescue: DryRunFlag[];
  /** Plumbing credits this scan would bill (1 per page; 0 if it would fail). */
  scan_credits: number;
  /** Estimated model credits if run for real on our keys (token→credit map). */
  estimated_model_credits?: number;
}

/** What the sync call returns; what the async call eventually delivers to the webhook. */
export type ScanResponse<Fields = Record<string, unknown>> =
  | ScanEnvelope<Fields>
  | ScanAccepted
  | ScanDryRun;

/**
 * Type guard: did the call return the full envelope, or one of the non-envelope
 * responses (`accepted` ack / `dry_run` preview)?
 */
export function isEnvelope<F>(r: ScanResponse<F>): r is ScanEnvelope<F> {
  return r.status === "ok" || r.status === "partial" || r.status === "failed";
}

// ---------------------------------------------------------------------------
// <DeadSimpleMicroScanner> component props
// ---------------------------------------------------------------------------

/**
 * Props for the drop-in capture component, shared by `@parserelay/scanner` (React)
 * and `@parserelay/angular`. The common case is the `fields` shorthand; pass a full
 * `schema` (JSON Schema) for typed / nested extraction (e.g. `line_items`). Other
 * advanced request fields (`ocr` backend select, `dry_run`) stay off the component
 * by design — reach for the REST or MCP path when you need them.
 */
export interface DeadSimpleMicroScannerProps<Fields = Record<string, unknown>> {
  /** Field-list shorthand passed through as the request `schema`. */
  fields?: string[];
  /** Full JSON Schema (or field-list). Takes precedence over `fields` — use for typed/nested extraction. */
  schema?: ScanSchema;
  docType?: DocType;
  engine?: Engine;
  /** Pin a specific model (omit for the server default). */
  model?: string;
  /** Bring-your-own provider key → billed for plumbing only. */
  modelKey?: string;
  /** Fired with the parsed envelope once a scan completes. */
  onResult?: (envelope: ScanEnvelope<Fields>) => void;
  /** Convenience callback fired with the low-confidence field names, to gate UI. */
  onNeedsReview?: (fields: string[]) => void;
  /** Fired on a failed scan. */
  onError?: (error: Error) => void;
}
