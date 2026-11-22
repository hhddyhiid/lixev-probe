# lixev-probe

Minimal single-file probe used to measure a PaaS host's outbound IP and whether its
edge passes `wss://` WebSocket upgrades. Pure Python 3 standard library, ~0 MB RSS
beyond the interpreter, fits a 128 MB container.

Endpoints:

| path | purpose |
|---|---|
| `/` | service info + egress IP report (JSON) |
| `/ip` | egress IP report only (6 independent sources, IPv4 + IPv6) |
| `/health` | `ok` |
| `/headers` | request headers + client address (reverse proxy check) |
| `/ws` | WebSocket echo (first frame = hello + egress IPs) |

Nothing is stored; no data is collected about visitors.
