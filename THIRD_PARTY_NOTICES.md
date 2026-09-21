# Third-party components

Printroom's original source is MIT licensed; see LICENSE. Separate services and dependencies retain their own licenses.

| Component | Use | License / source |
| --- | --- | --- |
| Node.js 24.14.0 | Container runtime | Node.js license and bundled notices: https://github.com/nodejs/node/blob/v24.14.0/LICENSE |
| Alpine Linux container base | Runtime operating system | Individual package licenses; base image metadata is retained upstream |
| ws 8.21.3 | Development WebSocket simulator tests only | MIT: https://github.com/websockets/ws/blob/8.21.3/LICENSE |
| go2rtc 1.9.14 | Optional separate camera relay image | MIT, copyright Alexey Khit: https://github.com/AlexxIT/go2rtc/blob/v1.9.14/LICENSE |
| Spoolman | Optional existing external inventory service | Distributed separately: https://github.com/Donkie/Spoolman |
| Google Fonts | Optional font stylesheets in the local dashboard | IBM Plex Mono, Instrument Sans and Instrument Serif use the SIL Open Font License; fonts are requested from Google and are not bundled in the public static demo |

The public package does not bundle CFSync or its upstream source. The original installation uses a separately configured, pinned integration. No license file was found at upstream commit 22d00b9c9fc2ed1faac6e8441e8c700030803bc2 during release preparation; redistribution of that bundle awaits clarification. Printroom's integration client can remain present without redistributing the separate service.

The public demo illustration and site assets were created for Printroom. Its records are fictional. No private camera footage or installation data is included.
