# mero-ne (branch) — MeroDeploy Nepal node

Branch of this repo used by the MeroDeploy service `mero-probe-ne`
(free tier, Kathmandu, `0.25 vCPU / 256 MB`). MeroDeploy terminates TLS at its edge and
forwards plain HTTP/WS to `PORT` (default `8080`).

Built from the Dockerfile in this branch: `node:24-alpine`, `apk upgrade --no-cache`, and
npm / corepack / yarn removed (the node is zero-dependency, so none of them are needed and
they were the bulk of the image's known-vulnerability report).

Secrets are **not** in the repository; they are set as MeroDeploy environment variables:

| variable | purpose |
|---|---|
| `VLESS_UUID` | the VLESS user id (required, the process exits without it) |
| `KA_TOKEN` | komari-agent token for `map.amerb.com` (optional; agent skipped when unset) |

| path | purpose |
|---|---|
| `/health` | `200 ok` |
| `/ws` | VLESS over WebSocket (any other upgrade path gets 404) |
| `/ka` | komari agent state |
| `/` | last known egress IP |

Zero dependencies: the WebSocket handshake and frames, the VLESS header and the TCP/UDP
forwarding are all in `server.js`. On boot it downloads `komari-agent` once into `/tmp` and
supervises it.
