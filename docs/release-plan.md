# Printroom release and launch plan

Prepared 21 September 2026. The intended first public release is **v0.2.0-beta.1**, aimed at self-hosters with one to a few dozen Moonraker/Klipper printers and an optional Spoolman inventory. A 64-profile software limit is not a hardware capacity promise. The release date remains gated by verification, not the calendar.

## Release shape

The release includes a Docker Compose installation that starts empty, persistent printer and Spoolman Settings, reviewed discovery, a compatibility matrix, setup and recovery guides, and a simulated browser demo. Monitoring is the default. Optional physical commands remain off until operators qualify their own setup. No cloud account or subscription is required to run the application.

Public documentation and the demo belong at `printroom.innoventures.cloud`, hosted on GitHub Pages. The site must work as static files, including under a GitHub project path. The demo uses fabricated printer, job and material records, has no backend integration token and must make no requests to LAN devices. It must label itself as a demo and provide a reset control. A separate Printroom-themed Fourthwall support page is linked from Settings and the site; tipping remains optional.

The existing private repository contains installation-specific history. Before source becomes public, audit the candidate source and history for credentials, private artifacts, actual device addresses and unsupported claims. Prefer a clean public release snapshot if preserving the historical private repository is useful. The user selected the MIT license on 21 September 2026; it is included as LICENSE. Include required third-party notices, including the independently pinned optional integrations.

## Qualification before a beta tag

The tested artifact must be the artifact published. Required evidence covers a fresh empty-volume start, add/edit/disable/remove and discovery, API-key redaction, Spoolman testing and restart persistence, inventory switching without cross-server associations, paired and open-LAN permissions, reachable Settings after Focus view, mobile layout, camera cropping and bounded camera activation, 64-profile simulation, and absence of live network calls in the public demo.

Run the full suite on the pinned container runtime and validate the compose files. Verify local upgrade from the existing data volume with no printer commands, unchanged control policy and retained action/history data. Publish exact known limits rather than imply support for OctoPrint, Bambu, PrusaLink or multi-tool systems that lack adapters. Record ARM64 evidence and whether AMD64 has actually been exercised.

Public delivery evidence includes a successful GitHub Pages deployment, HTTPS at the custom subdomain, internal link checks, a usable 320px view, working demo interactions, and the support page leading into native Fourthwall checkout without submitting a payment.

## Proposed rollout

**Preparation, 21–23 September:** finish implementation and local qualification, create documentation/demo/support pages, audit release contents and prepare installation notes. Dates are planning targets.

**Small beta, after the release gates pass:** publish the beta tag and an installation-focused announcement. Seek reports from a generic Klipper printer, two Moonraker instances on one host, a separate Spoolman host, an AMD64 machine and a larger fleet. Participation is voluntary; do not imply these configurations are already tested.

**Stabilization:** triage compatibility reports by API, firmware and host architecture. Patch data-integrity and connection issues before expanding adapters. Promote a stable release only after external installation evidence and rollback guidance are satisfactory.

## Positioning and marketing package

Core message: **“A clear view of your printer room. Local by default.”**

Suggested short description: “Printroom brings Moonraker printer status, cameras and Spoolman materials into one local dashboard. Discover printers, manage connections in Settings, and see what is fresh, disconnected or still uncertain.”

Suggested launch post:

> I built Printroom for the point where one printer becomes a room. It is a self-hosted dashboard for Moonraker/Klipper, with optional cameras and a Spoolman color library. The beta adds printer discovery and editable connection settings so another workshop can set it up without changing source code.
>
> Monitoring is the default. The demo uses simulated data, and the compatibility page is explicit about tested hardware and missing adapters. If you try it on a different Klipper setup or a larger fleet, a report with firmware, API version, host architecture and observed behavior would help.
>
> Start with the demo and installation guide at printroom.innoventures.cloud. Optional tips support maintenance through the linked Fourthwall page.

Prepare one desktop image of the simulated room, one mobile Settings image, a 20–30 second demo walkthrough, and a compatibility graphic distinguishing API support from physical qualification. Do not use private printer filenames or unreviewed real camera footage in marketing assets.

Potential channels, subject to current community rules: the project's GitHub release and README, the owner's existing maker channels, and relevant Klipper/self-hosting communities that allow project introductions. Review each community's current self-promotion rules before posting. No outreach, social post or message is authorized merely by this plan; the user can review the finished copy and choose destinations.

Measure installation success, actionable compatibility reports, setup failures and repeat use before vanity traffic. Do not add tracking by default. Use GitHub issue reports and voluntary feedback initially. Tips are support, not payment for promised future features or a support SLA.
