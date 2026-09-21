# Compatibility and fleet sizing

Reviewed 21 September 2026. Printroom connects to APIs, not brand names. “Implemented” means supported by the adapter and automated tests; it does not mean every printer model or firmware has been tested.

| Setup | Monitoring | Cameras / material system | Evidence and requirements |
| --- | --- | --- | --- |
| Klipper + Moonraker, including Mainsail and Fluidd installations | Implemented: job state, progress, nozzle and bed temperatures, source age, job facts | Optional named go2rtc stream; no generic multi-material adapter | HTTP Moonraker reachable from the Printroom container, private IPv4, custom port and optional API key. Automated qualification; additional physical setups still needed. |
| Rooted Creality K2 Plus with Moonraker | Qualified on two printers in the original installation | Creality local WebRTC, CFS slots, active color and reported percentages observed | Compatible Moonraker plus Creality WebSocket telemetry. Physical pause/resume/cancel/shutdown actions have not been qualified. |
| Other Creality printers exposing Moonraker | Conditional through the Moonraker profile | Vendor telemetry only if it implements the same Creality protocol | Start with the generic profile. Validate firmware and each capability separately. No blanket K1/K2/Ender family claim. |
| Several Moonraker instances on one host | Implemented | Configure each camera independently | Each instance uses a distinct port and stable printer ID. Discovery runs one selected port at a time. |
| Spoolman | Implemented inventory reads and optional reviewed imports | Color library and confirmed physical CFS associations | Configure server host/port in Settings. Direct HTTP API v1; private IPv4, `host.docker.internal`, `localhost`, or same-network Docker service `spoolman`. Optional separate browser URL. No automatic mass deductions. |
| CFSync workshop bridge | Optional installation-specific Creality integration | Monitor state and confirmed links | Requires the Printroom workshop adapter, matching printer/Spoolman configuration and monitor-only API contract. Not bundled in the public portable stack; ordinary upstream CFSync is not a drop-in replacement. Direct CFS display does not require it. |
| OctoPrint, including Marlin through OctoPrint | No adapter | Not implemented | A separate OctoPrint REST adapter is needed. |
| Bambu Lab / AMS | No adapter | Not implemented | Needs a firmware-qualified integration; Moonraker discovery does not find Bambu devices. |
| PrusaLink / Prusa Connect | No adapter | Not implemented | A Prusa running Klipper can instead be evaluated as a Moonraker setup. |
| Duet / RepRapFirmware, USB serial or cloud-only devices | No adapter | Not implemented | No Duet, serial or vendor-cloud connector. |

## Connection boundaries

For tray display, select **Creality + Moonraker** and configure its Creality telemetry port (normally 9999). The generic Moonraker profile does not collect CFS data. See [CFS trays and spool links](https://printroom.innoventures.cloud/cfs.html) for the complete requirements and troubleshooting.

Printer configuration currently accepts private IPv4 addresses and direct HTTP Moonraker endpoints. DNS names, IPv6, HTTPS printer APIs, reverse-proxy path prefixes, JWT refresh and password-protected camera sources are not implemented in the printer form. An API key stays in the local database and is never returned to the browser. Re-enter it when changing an endpoint; it is not forwarded to a new address automatically.

Discovery sends read-only `/server/info` requests over one explicitly selected `/24`–`/32` private subnet and port, with at most eight concurrent probes. It verifies the Moonraker response shape. An HTTP 401/403 is only an authentication candidate, not proof of a printer. Nothing is automatically added. There is no mDNS discovery or automatic VLAN traversal; routing and firewall rules must already permit access.

The app uses one primary extruder and the standard heated-bed object. Multiple toolheads, enclosure sensors on generic Klipper, unusual object naming and custom multi-material systems need further work. Missing capabilities remain unavailable rather than inheriting another printer's data.

Job metadata and bounded preview reads pass through the authenticated backend, using the configured Moonraker key. The browser does not need cross-origin permission to the printer. Preview reads are limited to the current job, a 24 KiB G-code prefix and a 256 KiB PNG/JPEG thumbnail. Unsupported or missing previews do not block telemetry.

## Fleet scale

There is a limit of 64 saved profiles. Polling permits eight concurrent printer polls and never overlaps a printer's own poll. Disabled printers are not polled. A slow or unreachable device consumes one bounded slot; failures do not cancel other devices. At 64 offline printers, a complete polling pass can take around 40 seconds with five-second timeouts. The age indicators deliberately reveal this delay.

The dashboard opens at most four visible camera connections per browser page, suspending offscreen and hidden-tab streams. Every additional browser has its own limit and increases load on go2rtc and the printers. Cameras are not a proxy for telemetry freshness. Large fleets should disable unneeded cameras and be measured on their actual host/network before increasing container resources.

Automated tests exercise empty fleets, 64-printer scheduling, custom ports, cancellation, configuration persistence, stale revisions, retargeting, credentials, inventory switching and authentication. Those tests are not a 64-printer hardware benchmark. Only two physical K2 Plus printers have been observed in the original deployment. ARM64 runtime has been exercised; AMD64 and a separate physical phone still require qualification.

## Inventory changes and history

A Spoolman connection change requires confirmation when replacing an existing connection. Physical associations are cleared with an audit event, including when the prior set was empty so stale dialogs cannot write into the new inventory. Import records and their versions are separated by server endpoint; reconnecting restores that server's import history. Records in Spoolman are never moved or deleted. A replacement database at the exact same host and port cannot be distinguished automatically; operators must recheck identities after a database restore or replacement.

Changing a printer address, profile, enabled state or removing it invalidates its current physical associations and fresh telemetry. Removed IDs remain reserved so old actions cannot silently attach to a different machine. Unresolved actions block connection changes until reviewed. CFSync retains its own records and is configured independently.

## Primary references

- [Moonraker server information API](https://moonraker.readthedocs.io/en/latest/external_api/server/) describes the identity and Klipper state used by discovery.
- [Moonraker authorization](https://moonraker.readthedocs.io/en/latest/external_api/authorization/) documents API keys and other authorization modes; Printroom currently implements the API-key path.
- [Moonraker configuration](https://moonraker.readthedocs.io/en/latest/configuration/) documents deployment features that may go beyond this adapter.
- [go2rtc API, pinned v1.9.14](https://github.com/AlexxIT/go2rtc/blob/v1.9.14/api/README.md) covers the relay used for optional cameras.
- [Spoolman installation](https://github.com/Donkie/Spoolman/wiki/Installation) and [security](https://github.com/Donkie/Spoolman/wiki/Security) describe the separate inventory service.
- [OctoPrint API](https://docs.octoprint.org/en/dev/api/general.html) and [PrusaLink](https://github.com/prusa3d/Prusa-Link) use different integrations and are not Moonraker substitutes.
