/**
 * Runtime contract for the `scan` REQUEST — the single authoritative validator.
 *
 * The REST API parses against THIS schema instead of its own hand-rolled checks,
 * so request validation has one definition.
 *
 * Lives in a dedicated `@parserelay/core/schema` entry point on purpose: it pulls
 * in `zod` at runtime, and the type-only consumers (the client + the browser
 * components) keep importing the zod-free main entry so zod never lands in their
 * bundles.
 *
 * Notes on what this deliberately does NOT do:
 * - It is not the *type* source: `ScanRequest` stays a hand-written interface in
 *   `index.ts`. A `z.infer` here would force `schema.properties` to be required
 *   (the regimentation rule), conflicting with the intentionally-loose `JsonSchema`
 *   and breaking `toFieldSpecs`. So `schema` is validated as `unknown` + refine,
 *   and the REST layer casts the validated body to `ScanRequest`.
 * - It is not the MCP tool schema. `@parserelay/mcp` keeps its own richly-described
 *   zod for the *model-facing* advertised JSON Schema; the API is the authority.
 * - The ENVELOPE (response) isn't modeled here (not duplicated; stays hand-typed).
 */
import { z } from "zod";

export const DOC_TYPES = ["receipt", "invoice", "id", "business_card", "freeform"] as const;
export const ENGINES = ["auto", "ocr", "ocr+rescue", "ocr+check", "vision"] as const;
export const OCR_BACKENDS = [
  "auto",
  "glm",
  "mistral",
  "tesseract",
  "paddle",
  "vision",
  "passthrough",
] as const;

export const RelayConfigSchema = z.object({
  url: z.string().trim().min(1),
  idempotency_key: z.string().min(1),
});

/** The canonical `scan` request schema. `schema` is validated as `unknown` + a
 *  refine (see module note) carrying the exact reject messages. */
export const ScanRequestSchema = z
  .object({
    image: z.string().trim().min(1).optional(),
    pages: z.array(z.string().trim().min(1)).max(50, "at most 50 pages per scan").optional(),
    schema: z.unknown().optional(),
    doc_type: z.enum(DOC_TYPES).optional(),
    engine: z.enum(ENGINES).optional(),
    ocr: z.unknown().optional(),
    dry_run: z.boolean().optional(),
    model: z.string().nullable().optional(),
    model_key: z.string().nullable().optional(),
    relay: RelayConfigSchema.optional(),
  })
  .superRefine((req, ctx) => {
    // `ocr`: an object; known backend; passthrough requires non-empty text.
    // Validated here (not as a typed field schema) so the messages are explicit —
    // a z.union/discriminatedUnion collapses to a generic "Invalid input", and the
    // refine also keeps the original lenient behaviour on unknown extra keys.
    const ocr =
      typeof req.ocr === "object" && req.ocr !== null && !Array.isArray(req.ocr)
        ? (req.ocr as Record<string, unknown>)
        : undefined;
    if (req.ocr !== undefined && ocr === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ocr"],
        message: "`ocr` must be an object.",
      });
    }
    if (ocr) {
      if (
        ocr.backend !== undefined &&
        !(OCR_BACKENDS as readonly string[]).includes(ocr.backend as string)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ocr", "backend"],
          message: `Unknown ocr.backend '${String(ocr.backend)}'. Expected: ${OCR_BACKENDS.join(", ")}.`,
        });
      }
      if (
        ocr.backend === "passthrough" &&
        (typeof ocr.text !== "string" || ocr.text.length === 0)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ocr", "text"],
          message: "ocr.backend=passthrough requires a non-empty ocr.text.",
        });
      }
    }

    // `image` is required unless the caller supplies pre-OCR'd passthrough text.
    const passthrough =
      ocr?.backend === "passthrough" && typeof ocr.text === "string" && ocr.text.length > 0;
    if (req.image === undefined && !passthrough) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`image` is required (or pass ocr.backend=passthrough with ocr.text).",
      });
    }

    // `schema`: a field-name string[] OR a JSON Schema with a `properties` map.
    // A flat {"field":"type"} object is rejected (it has no `properties`).
    const s = req.schema;
    if (s !== undefined) {
      if (Array.isArray(s)) {
        if (!s.every((x) => typeof x === "string")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["schema"],
            message:
              'A `schema` array must be a list of field-name strings, e.g. ["merchant","total"].',
          });
        }
      } else if (typeof s === "object" && s !== null) {
        const props = (s as Record<string, unknown>).properties;
        const hasProps = typeof props === "object" && props !== null && !Array.isArray(props);
        if (!hasProps) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["schema"],
            message:
              "`schema` object must be a JSON Schema with a `properties` map, e.g. " +
              '{"type":"object","properties":{"merchant":{"type":"string"}}}. A flat ' +
              '{"field":"type"} map is not accepted — use the field-list array ["merchant","total"] instead.',
          });
        }
      } else {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["schema"],
          message: "`schema` must be a field-list array or a JSON Schema object.",
        });
      }
    }
  });

/** Parse an untrusted body. `{ ok: true, data }` or `{ ok: false, message }` with
 *  a human-readable first-issue message (the REST layer maps this to 400). */
export function parseScanRequest(
  body: unknown,
): { ok: true; data: z.infer<typeof ScanRequestSchema> } | { ok: false; message: string } {
  const r = ScanRequestSchema.safeParse(body);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, message: r.error.issues[0]?.message ?? "invalid request" };
}
