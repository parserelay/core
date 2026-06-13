# @parserelay/core

The shared **scan** request/response contract for [ParseRelay](https://parserelay.app) — the single source of truth used by the MCP tool, the REST endpoint, and the `<DeadSimpleMicroScanner>` component.

```ts
import type { ScanRequest, ScanEnvelope, Engine } from "@parserelay/core";
import { isEnvelope } from "@parserelay/core";
```

Design rule: the **envelope (`ScanEnvelope`) is stable and additive-only**. The **engine is a swappable parameter** behind it — new extraction modes ship without breaking existing callers.

See the full spec at [`docs/SCAN_API.md`](../../docs/SCAN_API.md).
