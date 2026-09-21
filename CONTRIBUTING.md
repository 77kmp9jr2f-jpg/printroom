# Contributing to Printroom

Start with a focused issue or pull request describing the observed problem and your proposed change. For compatibility reports include printer model, firmware, Moonraker version, host architecture, Docker version and the failing capability. Redact tokens, API keys, private addresses, personal data and real job filenames.

Use Node.js 24.14 or newer. Run `npm ci`, `npm test` and `npm run test:site`. Test physical printer actions only on your own supervised, idle hardware with explicit operator authorization. Automated tests should use isolated HTTP/WebSocket simulators and fictional fixtures.

Maintain the distinction between API support, automated coverage and physical qualification. Do not imply that a model is supported only because it shares a brand. Preserve idempotency, stale-state handling, endpoint identity checks and the separation of camera health from telemetry.

Source files use standard ES modules and browser APIs. Keep runtime dependencies small and changes focused. Rebuild the documentation/demo with `npm run build:site` when their source changes. The public demo must never contact a printer, camera relay, local service or inventory server.

By submitting a contribution, you agree to license that contribution under the repository's MIT license. Third-party material must retain its own required notices.
