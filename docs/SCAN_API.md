# Scan API

The `scan` contract: one call takes a document image and returns structured,
confidence-scored data, optionally delivered to a webhook. One request body and one
response envelope, shared across every surface.

The **envelope is stable** — additive changes only, never a broken field. The **engine
is a swappable parameter** behind it, so new extraction modes ship without touching any
existing caller.

---

## The one operation: `scan`

A single operation, reachable three ways, all sharing the same input body and the same
output envelope:

- **MCP tool** `scan` — agents call it natively; get the envelope back inline, or
  `accepted` + relay.
- **REST** `POST /v1/scan` — non-agent callers and the async/relay path.
- **`<DeadSimpleMicroScanner>`** — React (`@parserelay/scanner`) and Angular
  (`@parserelay/angular`) component; a thin client over `POST /v1/scan` that wraps
  capture/upload.

Because the contract is identical across all three, a caller can move between sync,
fire-and-forget, and the embedded component without changing how they build the request
or parse the result.

---

## Input

```jsonc
{
  // --- the image ---
  "image": "https://… | data:image/jpeg;base64,…",   // URL or base64 data URI. required (the first/only page)
  "pages": ["data:image/png;base64,…", "…"],          // optional. extra page images for a multi-page doc → [image, ...pages]

  // --- what you want out ---
  "schema": ["client_name", "total", "vat"],          // optional. field-list shorthand OR full JSON Schema. default = generic document
  "doc_type": "receipt",                              // optional hint: receipt | invoice | id | business_card | freeform

  // --- how to extract (the swappable part) ---
  "engine": "auto",                                   // optional. auto (default) | ocr | ocr+rescue | ocr+check | vision
  "ocr": { "backend": "auto" },                       // optional. backend select; { backend:"passthrough", text:"…" } to supply OCR'd text
  "model": null,                                      // optional. null = the default for the chosen engine
  "model_key": null,                                  // optional. bring your own provider key

  // --- preview before spending ---
  "dry_run": false,                                   // optional. true → return which fields WOULD be rescued + est. cost, spend nothing

  // --- where it goes ---
  "relay": {                                          // optional. present → fire-and-forget; result POSTed to url
    "url": "https://your-worker/hook",
    "idempotency_key": "inv_2026_04_18_xyz"
  }
}
```

### `image` (required)

A publicly fetchable URL or a base64 data URI. The only required field. The first (or
only) page.

### `pages` (optional)

Additional page images for a **multi-page document**, in order — one rendered image per
page. The total page set is `[image, ...pages]`. The caller renders each page to an
image (e.g. rasterizing a PDF client- or server-side); the service does **not** render
PDFs itself. Each page is extracted independently and the fields are **merged** — the
best value per field wins, so a field that lands cleanly on any page isn't dragged down
by blank pages, and each page's rescue reads its own image.

### `schema` (optional)

Describes the structured output you want. Two accepted forms:

- **Field-list shorthand** — `["client_name", "total", "vat"]`. A JSON array of
  field-name **strings**. What an agent or a human actually wants to type. Expanded to
  JSON Schema server-side. This is the common case.
- **Full JSON Schema** — an object with a `properties` map, e.g.
  `{ "type": "object", "properties": { "total": { "type": "number" } }, "required": ["total"] }`.
  The escape hatch for nested structures: line-items, discounts, parent/child layers.
  Use this when the document is complex enough that flat fields lose information.

A flat `{ "field": "type" }` map (e.g. `{ "merchant": "string", "total": "number" }`) is
**not** a JSON Schema and is **rejected** with `400 bad_request` — it has no
`properties`, so the server can't tell which fields you mean and won't silently fall
back to an unconstrained extraction. Use the field-list array form instead.

Omitting `schema` returns a generic document extraction. Choosing which fields to
request **is** feature selection — the caller decides what they need; the service does
not impose a fixed shape.

**The schema does triple duty** — it is not just output validation:

1. **Output validation** — the returned `fields` must validate against it. The rescue
   model runs in structured-output / forced-tool mode so it is *constrained* to return
   schema-shaped data.
2. **Confidence-gate derivation** — `minimum`/`maximum` feed the out-of-range rescue
   trigger; `enum` is the **coercion target** (a value that can't be mapped to an
   allowed enum is flagged for review, never approximated to a near-miss).
3. **Per-field prompting** — each field's `description` is fed *verbatim* into the
   rescue prompt as its extraction instruction (e.g.
   `"if the form shows a range like 20-40, return the midpoint"`). Domain knowledge
   lives in the schema, so callers don't maintain a parallel prompt file.

Before validation, the service applies deterministic normalization: locale numbers in
either convention → a number (EU `1.234,50` and US `1,234.50` both → `1234.5`), and
ranges → midpoint per the field's `description` hint.

The deterministic pass first tries a `key: value` / `key = value` match per field, then
— for recognized fields that real documents don't label (`merchant` in the header, a
`TOTAL <n>` line that isn't a `SOUS-TOTAL`, a date token) — a **positional/heuristic**
fallback places the value from document structure and tags it `field_source: "positional"`.
Fields it can neither label-match nor place structurally come back `null`: never guessed.
This is what lets `ocr`/`ocr+rescue` resolve common receipts for free instead of
escalating every field to a paid model call. Structural `array<object>` (line items) are
resolved by the rescue/structure model rather than the deterministic pass.

### `doc_type` (optional)

A hint that tunes prompting and defaults. Not required; `freeform` is assumed when
absent.

### `engine` (optional, default `auto`)

The swappable extraction axis. `auto` is what most callers use and should leave alone.

| `engine`     | what runs                                                       | when it's right                                              |
|--------------|-----------------------------------------------------------------|-------------------------------------------------------------|
| `ocr`        | OCR backend only; text + basic structure                        | clean text, cheapest path, no LLM in the loop               |
| `ocr+rescue` | OCR → deterministic parse → LLM rescues **only flagged fields** against the page image | **what `auto` uses on text-bearing docs**; deterministic-first, pay only for the hard fields |
| `ocr+check`  | OCR text → LLM structures **everything** and self-checks        | when you want the model to do the whole extraction, not just rescue |
| `vision`     | vision-LLM directly on the image                                | phone photos, poor scans, no usable text layer              |
| `auto`       | detect a text layer → `ocr+rescue` if present, else `vision`    | **default**; caller doesn't think about it                  |

`auto` reflects a deterministic-first principle: when a document already carries text,
parsing it structurally and spending a model call **only on the fields that look
uncertain** is far cheaper than running a vision model (or an LLM) over the whole image —
and *more* accurate, because unresolved fields fail visibly (flagged) rather than
plausibly (hallucinated). Vision is reserved for when there is no usable text to lean on.
The model is a **rescue** tool, not the extraction tool.

`ocr+check` (LLM structures everything) is available for callers who want it, but is not
what `auto` resolves to.

### `ocr` (optional)

Selects the OCR backend and, for `passthrough`, supplies the text directly.

| `ocr.backend` | quality | notes |
|---|---|---|
| `auto` (default) | — | escalate to `vision` only on low-confidence pages |
| `glm` | strong on docs/tables/formulas | GLM-OCR; the default backend behind `auto` |
| `mistral` | good | Mistral OCR; fallback backend |
| `vision` | best, incl. handwriting | the escalation path |
| `passthrough` | n/a | caller supplies already-OCR'd text via `ocr.text`; no OCR is run |

The rescue pass always works from the **rendered page image**, not the OCR text —
text-only rescue can't fix what OCR already destroyed — so the service retains source
page bytes and routes them to the rescue call.

### `dry_run` (optional)

`true` → the service spends **nothing**. It returns a `ScanDryRun` (see below) listing
the fields that *would* trigger a paid rescue call and why, plus an estimated cost
breakdown. This is how a caller trusts the cost number before committing to a run.

`dry_run` takes precedence over `relay`: a dry run is always returned inline (never
`202 accepted`), and nothing is posted to the webhook. Drop `dry_run` to run for real.

### `model` and `model_key` (optional)

- `model` — pin a specific model (e.g. `"claude-haiku-4-5"`). `null` uses the default
  for the chosen engine.
- `model_key` — **bring your own provider key.** Pass your own key and the model call
  runs on it: the model bill is your provider's, and `meta.tokens.provider_cost_usd`
  reports that cost instead of a credit charge.

Bring-your-own-key answers provider lock-in directly: callers who want to own their
model relationship can, without giving up the envelope, relay, or component.

### `relay` (optional)

Present → fire-and-forget. The request returns `accepted` immediately and the full
envelope is POSTed to `relay.url` once ready.

- `url` — the webhook the caller controls.
- `idempotency_key` — a retried scan with the same key never double-posts.

---

## Output — the envelope

This is the contract you never break. Additive changes only.

```jsonc
{
  "scan_id": "scn_a1b2c3",
  "status": "ok",                    // ok | partial | failed

  "fields": {                        // structured data matching the requested schema
    "client_name": "Acme GmbH",
    "total": 1284.50,
    "vat": 205.52,
    "line_items": [ /* … */ ]
  },

  "confidence": {                    // per-field 0–1. null per field in ocr-only mode (see note)
    "client_name": 0.98,
    "total": 0.91,
    "vat": 0.62
  },

  "needs_review": ["vat"],           // low-confidence / ambiguous fields. the caller decides what to do

  "field_source": {                  // per-field provenance: deterministic | model | rescued | uncertain | positional | inferred
    "client_name": "deterministic",
    "total": "deterministic",
    "vat": "rescued"
  },

  "self_check": {                    // present only when the engine includes a check pass
    "passed": false,
    "notes": ["line items sum to 1078.98, total reads 1284.50 — mismatch"]
  },

  "raw_text": "…",                   // full-text fallback. always present

  "meta": {
    "engine": "ocr+rescue",
    "model": "claude-haiku-4-5",
    "ocr_backend": "glm",
    "latency_ms": 1840,
    "tokens": { "input": 1180, "output": 95 },       // model usage (present only when a model ran)
    "ocr_usage": { "input": 6034, "output": 615 }    // OCR-backend usage (present when the backend reports tokens)
  }
}
```

### Field notes

- **`status`** — `ok` (everything extracted), `partial` (some fields missing or
  extraction degraded but usable), `failed` (no usable result; inspect `meta` and
  `raw_text`).
- **`fields`** — keyed to match the requested schema. Nested structures (line-items
  etc.) appear here when the schema asks for them.
- **`confidence`** — per-field, 0–1. The caller decides what to trust, re-prompt on, or
  auto-accept. See the confidence-in-`ocr`-mode note below.
- **`needs_review`** — the subset of fields whose confidence or ambiguity crossed the
  review threshold. A convenience derived from `confidence`. A field the pipeline can't
  resolve comes back `null` and appears here — it is **never** hallucinated to look
  complete (fail visibly, not plausibly).
- **`field_source`** — per-field provenance, complementary to `confidence`: how each
  value was obtained. `deterministic` = parsed with no model call; `model` = produced
  directly by a model (e.g. the `vision` path); `rescued` = resolved by the LLM rescue
  pass; `uncertain` = left unresolved, also in `needs_review`; `positional` = derived
  structurally (e.g. from page position) rather than OCR'd; `inferred` = model-produced
  but **not supported by `raw_text`** (a likely guess; always also in `needs_review`).
  Where `confidence` says *how sure*, `field_source` says *how obtained*. On text-bearing
  engines a model **string** with a significant token that `raw_text` doesn't support —
  neither present nor a near-match correcting a smudge — is re-labelled `model` →
  `inferred` and flagged: the never-hallucinate guard. It flags fabrication, not
  correction — a faithful OCR fix of a garbled mark (`ATL`→`AIL`) stays `model` because
  the mark is on the page; an *added* word with no anchor (`Montreal` appended to an
  address) becomes `inferred`. The value is never stripped; flagging a correct-but-rare
  value is safer than deleting it.
- **`self_check`** — present only when the engine ran a check pass (`ocr+check`, and
  `auto` when it resolves to that). `passed` is the headline; `notes` explains failures
  (e.g. line-items not summing to the stated total).
- **`raw_text`** — always present, even in `vision` mode, as a fallback the caller can
  fall back to or re-parse.
- **`meta.tokens`** — model usage behind the scan: `{ input, output }` token counts.
  Present only when a model ran. When you bring a `model_key`, it also carries
  `provider_cost_usd` — the cost on your own provider.
- **`meta.ocr_usage`** — OCR-backend usage: `{ input, output }` token counts. Present
  only when the backend reports them (e.g. `glm`; Mistral's free tier reports none).
- **`meta.byok_skipped`** — present only when a request supplied (or was paired to) a BYO
  provider key that was **not** used, so the model ran on the default key.
  `"provider_mismatch"`: the key's provider didn't match the model (e.g. an OpenAI key
  with an Anthropic model — pin a matching `model`). `"decrypt_failed"`: a stored key
  couldn't be decrypted. Absent on a normal scan.

> **Billing fields.** The hosted ParseRelay service adds credit-accounting fields to
> `meta` (`scan_credits`, `total_credits`, and `tokens.credits` / `ocr_usage.credits`)
> when a scan runs against it. A self-hosted deployment runs on your own keys and bills
> nothing, so those fields don't apply. They're additive and never change the rest of the
> envelope.

---

## The rescue gate (`ocr+rescue` / `auto`)

The heart of the deterministic-first path is the **rescue trigger** — the logic that
decides which fields are uncertain enough to be worth a paid model call. The default gate
fires on any of:

- **Parser self-flag** — a deterministic extractor couldn't parse the field cleanly.
- **Garbled glyphs** — the value contains out-of-charset characters (e.g. non-numeric
  junk in a numeric field — OCR mangling).
- **Missing required** — a field the schema marks `required` came back null.
- **Out-of-range** — the value violates a `minimum`/`maximum` bound declared in the
  schema.
- **Low fuzzy-match** — a value matched its vocabulary/`enum` below threshold.
- **Sparse row** — a structured row came back with too few of its expected columns
  filled.

Default posture: **rescue if uncertain.** Most fields on a typical form clear the gate at
no model cost; you pay only for the hard ones. Rescues for independent fields run
concurrently.

## Dry-run preview

With `dry_run: true`, the service runs OCR + the deterministic pass + the gate, then
**stops before any paid call** and returns:

```jsonc
{
  "scan_id": "scn_a1b2c3",
  "status": "dry_run",
  "would_rescue": [                  // the fields the gate flagged, and why
    { "field": "vat", "reason": "out_of_range" },
    { "field": "line_items[3].dbh", "reason": "garbled_glyphs" }
  ],
  "scan_credits": 1,                 // plumbing units a real run would bill (hosted service)
  "estimated_model_credits": 3       // rough model cost a real run would incur (hosted service)
}
```

Use `isEnvelope()` to distinguish this from a real run — it returns `false` for both
`dry_run` and `accepted`.

## Async / relay path

When `relay` is present, the immediate response is:

```jsonc
{ "scan_id": "scn_a1b2c3", "status": "accepted" }   // HTTP 202
```

The full envelope (byte-identical to the sync response above) is then POSTed to
`relay.url`. Because the payload is identical, a caller can switch between sync and
fire-and-forget without changing their parser.

The relay path is built for reliability:

- **Signed** — an HMAC signature header so the receiver can trust the payload.
- **Idempotent** — `idempotency_key` guarantees a retried scan never double-posts.
- **Retried + dead-lettered** — when delivery runs on a queue, failures retry with
  exponential backoff and persistent failures land in a dead-letter store rather than
  being silently dropped. (Without a queue configured, delivery is best-effort inline.)

---

## The component

`<DeadSimpleMicroScanner>` is a thin client over `POST /v1/scan` — capture/upload UI plus
a request, handing your app the parsed envelope:

```jsx
<DeadSimpleMicroScanner
  fields={["merchant", "total", "date"]}   // → schema shorthand
  docType="receipt"
  engine="auto"
  onResult={(envelope) => { /* { fields, confidence, needs_review, … } */ }}
  onNeedsReview={(fields) => { /* gate UI on low-confidence fields */ }}
/>
```

It carries no logic of its own — it speaks the same contract as everything else.

---

## Confidence in `ocr`-only mode

When an LLM is in the loop (`ocr+check`, `vision`), per-field confidence is honest —
derivable from the model, or from agreement between the OCR pass and the check pass. In
**`ocr`-only** mode there is no model to judge whether a value is *correct*; the OCR
backend only reports character/line recognition scores, which are not the same thing.

So `ocr`-only returns `confidence: null` per field and omits `self_check`. The absence of
confidence is itself the honest signal that the caller is in raw mode — rather than
quietly running a check pass to fabricate a confidence number, which would blur `ocr` and
`ocr+check` and mislead callers who chose `ocr` deliberately for cost.

---

## Versioning

- Envelope fields are **additive-only**. New fields may appear; existing fields keep
  their meaning and type.
- New `engine` values may be added; `auto` may change which engine it resolves to, but
  the envelope shape it returns will not change.
- Breaking changes, if ever required, ship under a new path version (`/v2/scan`) with the
  old one maintained.
