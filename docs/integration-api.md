# Inventory and project API

These routes accept the localhost or LAN browser session with CSRF, or the server-side integration bearer on the loopback listener only. The trusted actor is `local-browser`, `lan-browser` or `home-assistant`; callers cannot forge it. Browser-origin bearer requests are rejected. No companion token belongs in browser code or a URL. Integration POST bodies are bounded to 32 KiB. Physical printer controls and Spoolman writes have independent configuration switches; both default to disabled. The portable deployment uses localhost access by default; optional LAN mode supports browser pairing. Read-only LAN API access is also available without a cookie in open mode.

## Reviewed Spoolmark import

`schemas/spoolmark-v1.json` is the companion-owned transfer contract. The current Spoolmark app does not yet emit it. Its label review UI can supply the `label` fields; the local import UI must additionally collect a unique physical-spool reference, reviewed diameter, manufacturer/material-profile density and source, original net mass, and current remaining mass. Units are encoded in the field names: mm, g/cm³ and g. Do not infer current remaining mass from a label's original weight or a CFS percentage.

Send the handoff to `POST /api/v1/imports/preview`. This stores and returns the exact normalized vendor, filament and spool fields without writing to Spoolman. The handoff ID is bound to those reviewed fields. A second ID for the same physical-spool reference is rejected. Use a new reference only for a genuinely different physical spool. An exact matching vendor is reused; duplicate vendor names require manual disambiguation in Spoolman.

After showing the saved preview, submit `POST /api/v1/imports/<id>/commit` with `{"confirmed":true,"expectedSpoolmanVersion":1}` (replace 1 with the revision returned by the inventory you reviewed). This is available only with `inventoryWritesEnabled: true`. A create attempt is persisted **before** each external write. Its acknowledgment or unique marker is reconciled with the existing inventory. Repeating the same request returns the same spool ID. If the response was lost, a subsequent commit reads for the marker before doing anything further; it does not resend that uncertain write. A missing/duplicate marker stays `outcome_unknown` and needs manual inspection. Leave the first comment line, containing the companion marker, intact until the import completes. The service never guesses that a timeout proves a create failed.

`GET /api/v1/imports` lists the most recent 100 imports. `GET /api/v1/imports/<id>` returns one persistent import, including step state and the resulting real `spoolId`. `GET /api/v1/spools?offset=0` reads 100 Spoolman records, including archived records for reconciliation, and supplies `nextOffset`. Archived spools cannot be assigned. `GET /api/v1/integrations` reports configuration and write availability; it is not a live connectivity check.

## Physical CFS assignment

Read `GET /api/v1/assignments` for the current global assignment `version`. Then send `POST /api/v1/assignments`:

```json
{
  "id": "unique-move-id-0001",
  "printerId": "left",
  "slot": "T2C",
  "spoolId": 17,
  "confirmed": true,
  "baseVersion": 0,
  "expectedSpoolmanVersion": 1
}
```

The IDs and versions above are syntax examples, not existing inventory. Read the current spoolmanRevision from integrations and use it as expectedSpoolmanVersion. Choose a real Spoolman ID and physically confirm its position. The service reads that spool, rejects archived/missing records, and requires fresh telemetry for a connected destination slot. A physical spool can occupy only one current slot. Moving it clears its old position; replacing another spool records the displaced identity. Use `spoolId: null` to clear an association after physical confirmation. Clearing an old association is allowed even if the CFS is disconnected.

A stale `baseVersion` returns 409 so concurrent edits do not silently overwrite each other. Reusing a successful move ID returns the original event without undoing a later move. `GET /api/v1/assignments/history` returns the newest 100 historical snapshots; older events remain stored for idempotency. These records are operator-confirmed metadata. They do not command the printer, identify a spool from a shared material RFID, write Spoolman locations, or deduct filament consumption. An undetected manual physical move can invalidate an association; the dashboard must show its confirmation time and source.

## openFEA project handoff

`schemas/project-handoff-v1.json` defines the local metadata record. Send `POST /api/v1/projects` with `{"handoff":{...},"baseVersion":0}` to create one, then use the returned version for edits. Use a local SHA-256 tool on the selected model/report files, for example `shasum -a 256 '/path/to/model.stl'`. Only metadata is stored; reports and model files are not uploaded or interpreted by this API.

Store the report's **actual analyzed model hash**, not the current model hash by assumption. A model hash, material, orientation, revision, report or review-note change resets review. A later explicit review uses `confirmReview: true`, `review.status: "reviewed"`, a meaningful review note and a report referencing the current model hash. The record captures the integration actor and review time. This preserves an operator's review assertion; it does not independently validate the report or physical design.

`GET /api/v1/projects`, `/api/v1/projects/<id>` and `/api/v1/projects/<id>/history` expose the current records and recent history. History is retained in the same SQLite volume as action and assignment records. `nativeSolverVerified` is always false: the linked openFEA repository had no published interface at inspection, so this is a concrete file/metadata integration path rather than a native solver connection.

## Runtime configuration

Use Settings to configure Spoolman. The bootstrap connection is imported only on the first start. A bootstrap example is `{"host":"host.docker.internal","port":7912}` on Docker Desktop. Linux hosts may use a private LAN IPv4 address or map `host.docker.internal` with Compose `extra_hosts: ["host.docker.internal:host-gateway"]`. Public hostnames, URL strings, embedded credentials and caller-supplied destinations are rejected. Disabling the connection in Settings turns off live inventory access while retaining local project and import history.

The standalone browser provides import, assignment and project panels, exercised against an isolated simulator. Live Spoolman creation and physical slot association remain unperformed; synthetic validation records are confined to temporary test databases. Home Assistant is optional and its prepared adapter is not installed.

## Configuration-aware inventory requests

Read `GET /api/v1/integrations` to obtain `spoolmanRevision`. Every assignment, import preview and import commit in the configurable service must include `expectedSpoolmanVersion` from the inventory the operator reviewed. A missing or changed revision returns HTTP 409. Reload and review; do not blindly retry against a new server. Spool pages, current assignments and imports carry the same revision. Reject paginated reads that cross revisions. Direct inventory links use `spoolmanUrl` when present.

Printer management and Spoolman Settings routes require a host browser or paired LAN browser; integration bearer tokens and open-LAN viewers cannot change configuration. The Settings page documents current profile limits and discovery behavior.
