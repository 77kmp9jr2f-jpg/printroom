# Install Printroom

Use Docker Compose v2 and Python 3 on a machine that can reach your printers. The portable stack starts with no printers, no Spoolman server, printer commands disabled and inventory writes disabled. It binds only to localhost. Use `compose.portable.yaml` for a fresh setup.

## First start

From a fresh release checkout, run the following once. Existing configuration and tokens must be retained during upgrades.

```sh
mkdir -p config secrets
chmod 700 secrets
python3 - <<'PYTHON'
from pathlib import Path
import os, secrets
config = Path('config/printers.json')
if not config.exists():
    config.write_bytes(Path('config/printers.example.json').read_bytes())
    config.chmod(0o600)
token = Path('secrets/companion_token')
if not token.exists():
    fd = os.open(token, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(secrets.token_hex(32) + '\n')
PYTHON
```

On native Linux, the container reads these files as UID/GID `1000:1000`. If your host user has another UID (including root), give that container user ownership before starting. File-backed Compose secrets keep the source file's ownership; Compose secret `uid` and `mode` options cannot fix it.

```sh
sudo chown 1000:1000 config/printers.json secrets/companion_token
sudo chmod 600 config/printers.json secrets/companion_token
```

This ownership step is unnecessary on Docker Desktop. On Linux, later edits may require `sudo`; preserve the ownership and mode. Rootless Docker or user-namespace remapping needs the corresponding mapped host UID instead of `1000` and is not yet qualified.

Now start the service:

```sh
docker compose -f compose.portable.yaml up -d --build companion
```

Open `http://localhost:7988/settings`. Add a printer manually or scan an explicit private subnet. Select **Moonraker / Klipper** first, enter the printer's IPv4 address and API port, then use **Test connection**. Add an API key if required. A successful Moonraker check does not qualify cameras or physical control actions. Save the profile and open the Room view.

Printer profiles and the Spoolman connection persist in the `companion-data` volume. The bootstrap file is imported once for those connections; it continues to control LAN binding and the two write-policy switches. Editing bootstrap printers after first startup does not replace Settings.

## Connect Spoolman

In Settings, enable **Connect to Spoolman**, enter its server address and port, test, then save. For Spoolman running on the Docker host, use `host.docker.internal` with its published port (often 7912). The portable compose file provides the host-gateway alias on Linux. For a container on the same Docker network, use service name `spoolman` and its internal port (normally 8000). Printroom does not install Spoolman or discover other Docker networks automatically.

Use **Browser URL** when the address users open differs from the service address, such as `http://192.168.10.20:7912/`. Internal service names have no automatic browser link. With `host.docker.internal` and no explicit browser URL, links use the dashboard's host name and the configured port. HTTP API v1 is supported; an authenticated reverse proxy on the API side needs a future adapter.

Changing inventory servers clears current physical associations and separates import history by endpoint. It does not change records or weights in Spoolman. CFSync is a separate optional integration and must point to the same inventory before its links are available.

## Show Creality CFS trays

CFS tray display requires a compatible printer's **Creality + Moonraker** profile. In Settings, choose that profile and set **Creality telemetry port** (normally **9999**) in addition to Moonraker. The container must reach both ports. After saving, check that the Printer and CFS source indicators become fresh, then expand **CFS** below the camera. **Test connection** checks Moonraker only.

CFSync and Spoolman are not required to display tray colors, active slots, humidity and printer-reported percentages. The optional CFSync workshop bridge is installation-specific and is not included in the portable stack. See [CFS trays and spool links](https://printroom.innoventures.cloud/cfs.html) for requirements, physical spool identity, the bridge contract and troubleshooting.

## Optional cameras

Copy `config/go2rtc.example.yaml` to `config/go2rtc.yaml` if the latter does not exist, and protect it with `chmod 600 config/go2rtc.yaml`. On native Linux also run `sudo chown 1000:1000 config/go2rtc.yaml` so the non-root relay can read it. Active camera configuration is ignored by Git because stream URLs can contain credentials. Start the optional relay:

```sh
docker compose -f compose.portable.yaml --profile cameras up -d camera companion
```

Use **Creality local WebRTC** for a compatible rooted camera endpoint. For other cameras, define a named stream in the go2rtc file, restart the relay and enter that stream name in Settings. The form accepts a stream name, not an arbitrary URL. The included relay uses no public STUN server. Validate codec and network reachability independently.

## Optional access from other LAN devices

Reserve a private IPv4 address for the host. Set `lanHost` in `config/printers.json` to that address and add the same address as `PRINT_LAN_HOST` in `.env`:

```dotenv
PRINT_LAN_HOST=192.168.10.20
PRINT_LAN_ACCESS=paired
PRINT_PUBLIC_PORT=7988
```

Then start with both files:

```sh
docker compose -f compose.portable.yaml -f compose.lan.yaml up -d companion
```

On the host's localhost dashboard, choose **Pair a device**. Enter its one-use code in the other browser. Paired LAN browsers can manage Settings. `open` LAN mode is available for trusted viewer networks but those viewers cannot change Settings. Do not expose this local HTTP control service directly to the internet.

For LAN cameras, also start the `cameras` profile and add the host's LAN address with port 18555 to `webrtc.candidates` in go2rtc. TCP and UDP 18555 must be reachable by viewers. Restart camera after changing its file. A connection check for Moonraker does not test this media path.

## Control policies, upgrades and backups

`controlsEnabled` and `inventoryWritesEnabled` in the bootstrap file remain off by default. The first permits physical commands; the second permits confirmed creation of Spoolman inventory. These switches are independent from connecting or discovering printers. Qualify your own hardware before enabling controls. No physical control actions have been tested on the original printers.

Before an upgrade, retain the prior image and make a consistent volume backup while the companion is stopped. Preserve the configuration, token and volume; never use `down -v` to upgrade. Saved API keys are in the protected volume and must be included in secure backup handling. Restarting the companion does not stop the printer firmware, but monitoring is temporarily unavailable.

To stop or inspect the portable service:

```sh
docker compose -f compose.portable.yaml ps
docker compose -f compose.portable.yaml logs --tail 30 companion
docker compose -f compose.portable.yaml stop companion
```

For LAN deployments, consistently include the LAN override for lifecycle commands. For cameras, retain the profile flag. Keep a record of those command options with the installation.
