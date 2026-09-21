# Security scope

Printroom is a trusted local-network tool. It is not designed for direct internet exposure or untrusted multi-tenant hosting. Printer commands and inventory writes default to disabled. Browser sessions use CSRF checks, and connection changes are limited to localhost or explicitly paired browsers.

The data volume contains saved Moonraker API keys. Protect the host, configuration, integration token and backups. A person with paired browser access can edit printer and Spoolman connections. No per-user roles are implemented.

Please do not publish credentials, private addresses, job files or camera footage in an issue. Use GitHub's private vulnerability reporting if it is enabled for the repository. Otherwise open a minimal issue requesting a private reporting channel without disclosing exploit details or secrets. Ordinary compatibility reports can be public after redaction.

A browser camera feed does not prove current telemetry or safe physical state. A software emergency command is not mains isolation or a safety-rated hardware stop. Use the machine's physical controls and documented recovery procedures when required.
