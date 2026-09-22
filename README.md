# Printroom

<img src="site/brand/wordmark.png" alt="Printroom — Filament Loop" width="450">

**A calmer view of your workshop.** A local, self-hosted dashboard for Moonraker/Klipper printers, optional cameras and Spoolman inventory.

[Documentation & demo](https://printroom.innoventures.cloud) · [Installation](docs/installation.md) · [Compatibility](docs/compatibility.md) · [CFS setup](docs/cfs.md) · [Optional tip](https://tips.printroom.innoventures.cloud/)

## What it does

- Shows job state, progress, temperatures and the age of each telemetry source.
- Manages printer profiles and Spoolman connections in Settings, without editing source code.
- Discovers Moonraker candidates on an explicitly selected private subnet; you review each before adding.
- Displays optional Creality or named go2rtc camera feeds with a full crop and at most four visible streams per dashboard.
- Presents Spoolman inventory as a searchable color library.
- Supports up to 64 saved printer profiles, bounded polling and fleet search.

## Start locally

You need Docker Compose v2 and Python 3 for the first-time configuration step. Clone this repository, then follow the [installation guide](docs/installation.md). Use `compose.portable.yaml`; the portable package's `compose.yaml` is an identical convenience copy.

The first start has no printers or inventory connection and listens on localhost. Open **http://localhost:7988/settings**, add a Moonraker printer, test it and save. Add an existing Spoolman server when useful. Both printer commands and inventory writes are disabled by default.

No cloud account or subscription is required to run Printroom. The public website is a separate static documentation site. Its demo uses fictional devices and data and cannot connect to a printer.

## Compatibility and release status

This is the **v0.2.0-beta.1** release candidate. The Moonraker profile has automated coverage for connection settings, custom ports, API keys, discovery and larger fleets. Two rooted Creality K2 Plus printers have been used for physical telemetry, CFS and camera qualification. Physical control actions have not been qualified.

The 64-printer check is a simulation, not a hardware benchmark. Read [the matrix and limits](docs/compatibility.md) before planning a larger installation. OctoPrint, Bambu/AMS, PrusaLink/Connect, Duet, serial USB and cloud-only adapters are not implemented. Multi-tool machines, generic enclosure sensors, IPv6, HTTPS printer APIs and hostname-based printer discovery require further work.

CFSync is an optional, separately configured integration in the original installation. The public package does not redistribute that service. See [third-party notices](THIRD_PARTY_NOTICES.md).

## Data and access

Printer profiles, API keys, Spoolman connection settings, local records and action history persist in a SQLite volume. Protect its backups. Changing inventory servers separates import histories and clears current physical associations rather than carrying spool IDs into another database.

Optional LAN mode supports browser pairing. Open LAN viewers cannot change Settings. The service is intended for a trusted local network; it has no internet-facing authentication, TLS termination or per-user roles. Keep it off the public internet. Never treat a camera image or command acknowledgment as proof of current physical machine state.

## Development

Node.js 24.14 or newer is required. The production service has no npm runtime dependencies; `ws` is used only by development tests.

```sh
npm ci
npm test
npm run test:site
npm run build:site
```

The static site builds into `dist-site/`. Its demo is generated from the real web UI and a dedicated in-browser API with no network fallback. Site builds work at a domain root or a GitHub Pages project path.

The project's `gh-pages` branch serves the generated files. Preserve `site/CNAME` when publishing this site; change or remove it before publishing a fork under your own domain.

[Operations and recovery](docs/operations.md) · [Integration API](docs/integration-api.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License and support

Printroom's original source is [MIT licensed](LICENSE). Optional services retain their own licenses. If it helps your workshop, [leave an optional tip on Fourthwall](https://tips.printroom.innoventures.cloud/). Tips support maintenance and documentation; no payment is required to use the tool.
