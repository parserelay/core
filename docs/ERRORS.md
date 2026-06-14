# Errors

Every non-2xx response from the scan API returns a JSON body with this stable shape:

```jsonc
{
  "error": {
    "code": "bad_request",                 // stable machine-readable code (see table)
    "message": "`image` is required.",      // human-readable, safe to log
    "details": { /* optional, code-specific */ }
  }
}
```

`@parserelay/client` parses this into `ParseRelayError` — `err.status` (HTTP status),
`err.code` (the `code` above), `err.message` (the `message`), and `err.body` (the raw
parsed body). Callers should branch on `err.code`, never on `err.message`.

## Codes

| `code` | HTTP | Meaning | Retry? |
|---|---|---|---|
| `bad_request` | 400 | Malformed request: bad JSON, missing `image`, unknown `engine`/`ocr.backend`, invalid `relay`. `details` may name the field. | No — fix the request. |
| `unauthorized` | 401 | Missing/malformed `Authorization` header, or an invalid API key. | No. |
| `payment_required` | 402 | No balance left (hosted service only). | After topping up. |
| `not_found` | 404 | Unknown route. | No. |
| `rate_limited` | 429 | Too many requests. Honor the `Retry-After` header. | Yes, after backoff. |
| `engine_error` | 502 | An upstream extraction provider (OCR/vision/LLM) failed. | Yes, with backoff. |
| `internal` | 500 | Unexpected server error. | Yes, with backoff. |

## Semantics

- **A failed scan is never billed.** Metering only counts a scan whose envelope status
  is not `failed`.
- **`dry_run` never errors for cost reasons** — it spends nothing, so it cannot return
  `payment_required`.
- **Rate limiting** uses standard `429` + `Retry-After` (seconds). Treat the header as
  authoritative for backoff.
- The error body is the same across all surfaces (REST, MCP). The relay path reports
  delivery failures out of band (dead-letter), not via this body.
