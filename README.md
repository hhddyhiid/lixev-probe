# lixev-probe

VLESS-over-WebSocket node for the Lixev free tier (Uzbekistan, Tashkent, `0.1 vCPU / 128 MB`).
Lixev terminates TLS at its edge and forwards plain HTTP/WS to `PORT` (default `8080`).

Zero dependencies: the WebSocket handshake and frames, the VLESS header, and the TCP/UDP
forwarding are all in `server.js`. On boot it also downloads `komari-agent` once into `/tmp`
and supervises it for the uptime map.

| path | purpose |
|---|---|
| `/health` | `200 ok` |
| `/ws` | VLESS over WebSocket (any other upgrade path gets 404) |
| `/ka` | komari agent state and process memory (kB) |
| `/` | last known egress IP |

Nothing is stored and no visitor data is collected.
