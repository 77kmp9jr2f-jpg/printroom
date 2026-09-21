# Operate your print room

Printroom monitors printer APIs, optional camera streams and Spoolman inventory independently. A camera image is not evidence that telemetry is current, and an HTTP acknowledgment is not proof that a printer stopped.

## Everyday use

The Room shows job state, progress, temperatures and the age of each source. Expand More details for available job metadata. On larger fleets, use Find a printer. Focus view keeps the room and its exit control visible. The Color view groups Spoolman spools by filament and filters by material, finish and inventory status. Colors are screen references, not color calibration.

Settings applies connection changes immediately. Disable a printer to temporarily remove it from monitoring. Remove retires its stable ID while preserving history. Re-adding hardware requires a new ID. Discovery only checks the private subnet and port you choose, then offers candidates for review.

## A printer is disconnected

Check that the Printroom container can reach the printer's private IPv4 address and Moonraker port. Test connection in Settings. A protected endpoint may need an API key. The service supports direct HTTP endpoints, not HTTPS, hostname resolution, IPv6, or reverse-proxy path prefixes. Containers cannot use their own localhost address to reach a separate host.

A vendor printer may report a job independently from Moonraker. The Creality profile retains those differences instead of assuming that standby means the machine is idle. Read the warning and open the printer's own interface when the sources disagree.

## The camera is offline

First confirm that telemetry is still current. Check the camera mode and endpoint or named go2rtc stream. For LAN viewing, the relay must advertise the Docker host's reachable LAN address and mapped WebRTC port. The browser needs access to TCP or UDP 18555 in the portable stack. No public STUN service is configured.

Creality camera sources are registered in relay memory as needed. The YAML mount can remain read-only. Other sources must already have a named go2rtc stream. Camera codecs, device firmware and network topology need separate qualification. At most four visible feeds are connected per dashboard, and hidden tabs pause their feeds.

## Spoolman is unavailable

Test its connection in Settings. Use its published host port for a server on the Docker host, or the service's internal port when both containers share a network. Set Browser URL separately if people need a different address than the container uses.

Changing servers clears current physical associations and selects that endpoint's import history. Existing Spoolman data is retained. If CFSync is installed separately, its connection must match before spool-link operations resume. Replacing a database at the exact same host and port is not automatically detectable: clear and recheck associations before using a replacement database.

## Backup and recovery

Stop the companion before a file-level backup of its data volume, or use a consistent SQLite backup. Preserve the bootstrap configuration and companion token together with the volume. Saved Moonraker API keys are stored in that volume; protect the backup accordingly. Retain the previous Docker image before upgrading. Never use `docker compose down -v` during an ordinary upgrade.

Restoring the database also restores connection profiles, records and action history. Ensure restored profiles still identify the same physical machines. An unresolved action must be reviewed rather than automatically resent. Monitoring may be unavailable while the companion restarts; printer firmware continues independently.

## Scaling up

The current limit is 64 saved printers. Polling permits eight concurrent requests with per-printer scheduling. Slow or disconnected devices can still lengthen refresh time, so use source ages rather than assuming every tile is live. Start with two printers, then add a representative small group, and measure host memory, CPU and network use before adding the rest.

The 64-printer validation uses simulated devices. The hardware-qualified installation has two rooted Creality K2 Plus printers. This is not a claim of physical qualification for a 64-machine farm. Multiple tools and unusual firmware object layouts require additional testing.

## Access and control

The portable install listens only on localhost by default. Optional LAN access supports one-use browser pairing. Paired browsers can edit connections; open LAN viewers cannot manage Settings. This is a trusted local-network tool, not a multi-tenant service. It has no per-user roles, TLS termination or internet-facing authentication layer.

Printer commands and Spoolman inventory writes each require an explicit host policy. Both are disabled by default. Treat physical command qualification as a separate task on an idle, supervised machine. The initial release does not claim physical-control qualification.

## Report a useful issue

Include your printer model, firmware, Moonraker version, operating system and Docker version, plus the selected profile and observed error. Say whether the failure is telemetry, cameras, discovery or inventory. Redact API keys, tokens, printer addresses, job filenames and personal data from screenshots or logs. A minimal simulated reproduction is especially helpful.
