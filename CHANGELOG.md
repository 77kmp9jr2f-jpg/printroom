# Changelog

## 0.2.0-beta.1 — release candidate

Printer profiles and Spoolman connections can now be managed in Settings. Moonraker discovery scans one explicitly selected private subnet and port, presents verified or authentication-required candidates, and requires review before adding a printer. Empty installations no longer depend on hard-coded devices.

The generic Moonraker profile avoids Creality-specific telemetry assumptions. Up to 64 saved profiles, bounded concurrent polling, fleet search and a four-visible-camera limit prepare the dashboard for larger rooms. The camera crop fills its frame across layout sizes, and the pinned relay receives dynamic camera registrations in memory.

Connection changes apply immediately with revision checks, API-key redaction, retired printer IDs and protection against stale inventory associations. Metadata and preview requests run through the authenticated backend.

Portable Docker Compose, MIT licensing, compatibility and operations guides, a static documentation site, an isolated simulated demo and a Printroom support page prepare the project for an initial public beta.

Hardware qualification remains two rooted Creality K2 Plus printers for telemetry, CFS observation and camera viewing. Larger fleets are simulated; physical control actions remain unqualified.
