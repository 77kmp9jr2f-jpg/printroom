# CFS trays and spool links

Printroom displays Creality CFS tray telemetry directly from a compatible printer. CFSync is a separate optional integration for spool links and monitoring. Installing CFSync is not required to see tray colors, active slots, humidity or reported remaining percentages.

## Requirements for CFS display

The physically qualified setup is a rooted Creality K2 Plus with working Moonraker and the compatible Creality WebSocket telemetry endpoint. Two K2 Plus printers have been observed: two CFS units (eight slots) on one printer and one CFS unit (four slots) on the other. Other models and firmware need their own qualification; a generic Klipper connection does not supply Creality CFS telemetry.

| Connection | Typical port | Purpose |
| --- | --- | --- |
| Moonraker HTTP API | 7125 | Job state, motion status and temperatures; optional Moonraker API key |
| Creality WebSocket telemetry | 9999 | Printer state and `boxsInfo.materialBoxs` tray data |
| Spoolman HTTP API v1 | Host port often 7912; container port normally 8000 | Optional inventory and physical spool records |

The Printroom container must reach both printer ports over the trusted LAN. Routing and firewall rules must permit this traffic; the printer browser page opening successfully does not prove container reachability. The configured Moonraker API key applies to Moonraker. Printroom does not implement authentication for the Creality WebSocket endpoint. Keep these endpoints private.

## Configure a printer

- Open Settings from localhost or a paired browser, then add or edit the printer.
- Select **Creality + Moonraker**, enter its private IPv4 address and the correct Moonraker port/key.
- Set **Creality telemetry port** to the port exposed by that printer, normally **9999**. Save the profile.
- Open Room and allow a refresh. The **Printer** and **CFS** source indicators should become fresh. Expand **CFS** below the camera to see each unit and its four slots.

**Test connection** checks Moonraker only. A successful result does not validate the Creality endpoint or CFS. Cameras have a separate setup and can remain disabled while CFS is monitored. Printer control and inventory-write switches can remain disabled for this read-only display.

## What the slots mean

The dashboard shows connected CFS units with IDs 1–4, up to four slots per unit. Slot names such as `T1A` through `T1D` identify positions in unit 1. Colors, material names, active-slot selection, humidity and temperature come from current Creality telemetry. Missing or stale values remain identified as such.

Remaining percentages are **printer-reported estimates**. They are not measured grams, Spoolman remaining mass or proof of physical spool identity. A stored RFID/material description alone does not establish which inventory spool is loaded. Verify the physical spool before recording an association, and recheck it after moving rolls.

Spoolman is optional for CFS display. Connect it in Settings when you want the color library or physical spool associations. Without the CFSync bridge, Printroom provides its own confirmed assignment workflow. Neither ordinary tray monitoring nor an association automatically deducts inventory mass.

## Optional CFSync integration

The portable release does **not** include a ready-to-run CFSync service. The original installation uses a pinned CFSync build with a Printroom-specific workshop adapter. Redistribution of that bundle is pending upstream licensing clarification. CFS display works without it.

The current bridge is intended for installations that already maintain a compatible workshop adapter. It is not a connector to an arbitrary upstream CFSync instance. Its requirements are:

- A service reachable from the companion as `http://cfsync:8005`, with the workshop API and proxied UI expected by Printroom.
- `PRINT_CFSYNC_ENABLED=true` in the companion environment, followed by a companion restart. The portable Compose file leaves it unset.
- Matching stable printer IDs and endpoints in the adapter's independent configuration and the companion bootstrap configuration. Saved Settings profiles must still match those bootstrap endpoints for bridge inclusion.
- The same Spoolman host and port in both configurations. Changing Printroom's inventory endpoint pauses incompatible bridge links until the host configuration agrees and services are restarted.
- `/api/workshop/state` must report workshop `mode` as `monitor`, `inventoryWritesEnabled` as `false`, and `sshEnabled` as `false`. The companion rejects snapshots that do not prove this contract.

There is no Settings installer for CFSync and no supported copy-and-paste deployment recipe for its installation-specific adapter in the public package. Do not enable the bridge solely to make tray panels appear. Public users can use direct CFS monitoring and Printroom's own confirmed spool associations today. Adding a printer in Settings does not configure a separately running CFSync service.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No CFS section appears | Confirm the Creality + Moonraker profile is selected, the printer reports connected CFS units, and the telemetry port is reachable from the container. The section is hidden when no connected units are reported. |
| Moonraker is fresh but Printer/CFS is unavailable | Inspect the Creality endpoint, port, LAN route and firmware protocol. Retesting Moonraker alone will not repair vendor telemetry. |
| Colors or percentages are stale | Check source ages and the printer's own interface. Retained values are not current observations. |
| CFSync is unavailable or incompatible | Check the workshop adapter, service name/port, bootstrap printer identities and shared Spoolman connection. Direct CFS monitoring remains independent. |
| A generic Moonraker printer has no CFS | Expected: the generic adapter has no multi-material protocol. AMS, MMU and other systems need separate adapters. |

The public demo includes simulated CFS units in the same eight-left/four-right layout as the observed workshop. Its values are fictional, its previews are static, and it cannot connect to or control a printer.
