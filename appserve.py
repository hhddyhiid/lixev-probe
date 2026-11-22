#!/usr/bin/env python3
"""Tiny probe app for MeroDeploy (PaaS) testing.

Endpoints:
  GET /            -> service info + egress IP report (JSON)
  GET /ip          -> egress IP report only (JSON)
  GET /health      -> plain "ok"
  GET /headers     -> request headers / client ip echo (JSON)
  GET /ws  (Upgrade: websocket) -> WebSocket echo; first frame = hello + egress IPs
"""
import base64
import hashlib
import json
import os
import socket
import struct
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

START = time.time()
PORT = int(os.environ.get("PORT", "8080"))
HOSTNAME = socket.gethostname()
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

_cache = {"t": 0.0, "data": None}
_lock = threading.Lock()

SOURCES = [
    ("ipify4", "https://api.ipify.org?format=json", "ip"),
    ("ipify64", "https://api64.ipify.org?format=json", "ip"),
    ("ipinfo", "https://ipinfo.io/json", "obj"),
    ("cloudflare", "https://www.cloudflare.com/cdn-cgi/trace", "trace"),
    ("ifconfig.me", "http://ifconfig.me/ip", "raw"),
    ("ip-api", "http://ip-api.com/json/?fields=query,country,regionName,city,isp,org,as,proxy,hosting,mobile", "obj"),
]


def fetch(name, url, kind):
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "lixev-probe/1.0", "Accept": "*/*"})
        with urllib.request.urlopen(req, timeout=8) as r:
            raw = r.read(6000).decode("utf-8", "ignore").strip()
        out = {"source": name, "ms": int((time.time() - t0) * 1000)}
        if kind == "ip":
            try:
                out["ip"] = json.loads(raw).get("ip")
            except Exception:
                out["raw"] = raw[:200]
        elif kind == "raw":
            out["ip"] = raw.splitlines()[0][:80] if raw else ""
        elif kind == "trace":
            d = dict(l.split("=", 1) for l in raw.splitlines() if "=" in l)
            out["ip"] = d.get("ip")
            out["colo"] = d.get("colo")
            out["loc"] = d.get("loc")
        else:
            try:
                out.update(json.loads(raw))
            except Exception:
                out["raw"] = raw[:200]
        return out
    except Exception as e:
        return {"source": name, "error": ("%s: %s" % (type(e).__name__, e))[:160],
                "ms": int((time.time() - t0) * 1000)}


def egress(force=False):
    with _lock:
        if not force and _cache["data"] and time.time() - _cache["t"] < 45:
            return _cache["data"]
    res = {}
    threads = []
    for s in SOURCES:
        th = threading.Thread(target=lambda s=s: res.__setitem__(s[0], fetch(*s)), daemon=True)
        th.start()
        threads.append(th)
    for th in threads:
        th.join(9)
    ips = sorted({v.get("ip") for v in res.values() if v.get("ip")})
    data = {
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "egress_ips": ips,
        "sources": res,
    }
    with _lock:
        _cache["t"] = time.time()
        _cache["data"] = data
    return data


def _read_exact(f, n):
    buf = b""
    while len(buf) < n:
        chunk = f.read(n - len(buf))
        if not chunk:
            raise ConnectionError("eof")
        buf += chunk
    return buf


def ws_read(f):
    h = _read_exact(f, 2)
    b0, b1 = h[0], h[1]
    op = b0 & 0x0F
    masked = (b1 >> 7) & 1
    ln = b1 & 0x7F
    if ln == 126:
        ln = struct.unpack("!H", _read_exact(f, 2))[0]
    elif ln == 127:
        ln = struct.unpack("!Q", _read_exact(f, 8))[0]
    mask = _read_exact(f, 4) if masked else b"\x00\x00\x00\x00"
    data = _read_exact(f, ln) if ln else b""
    if masked:
        data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
    return op, data


def ws_send(f, op, data):
    if isinstance(data, str):
        data = data.encode()
    head = bytes([0x80 | op])
    n = len(data)
    if n < 126:
        head += bytes([n])
    elif n < 65536:
        head += bytes([126]) + struct.pack("!H", n)
    else:
        head += bytes([127]) + struct.pack("!Q", n)
    f.write(head + data)
    f.flush()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "lixev-probe/1.0"

    def log_message(self, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False, indent=1).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _plain(self, text, code=200):
        body = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        upgrade = (self.headers.get("Upgrade") or "").lower()
        if path == "/ws" and "websocket" in upgrade:
            return self.ws()
        if path == "/health":
            return self._plain("ok")
        if path == "/headers":
            return self._json({
                "client": self.client_address[0],
                "headers": dict(self.headers.items()),
            })
        if path in ("/", "/ip"):
            eg = egress(force=(path == "/ip" and "force=1" in self.path))
            if path == "/ip":
                return self._json(eg)
            return self._json({
                "ok": True,
                "app": "lixev-probe/1.0",
                "hostname": HOSTNAME,
                "port_env": PORT,
                "python": os.sys.version.split()[0],
                "uptime_s": int(time.time() - START),
                "now_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "client": self.client_address[0],
                "x_forwarded_for": self.headers.get("X-Forwarded-For"),
                "egress_ips": eg["egress_ips"],
                "egress": eg,
                "routes": ["/", "/ip", "/ip?force=1", "/health", "/headers", "/ws (WebSocket echo)"],
            })
        if path == "/big":
            return self._plain("x" * 2000)
        return self._json({"error": "not found", "path": path}, 404)

    def ws(self):
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key:
            return self._json({"error": "missing Sec-WebSocket-Key"}, 400)
        acc = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", acc)
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True
        r, w = self.rfile, self.wfile
        try:
            ws_send(w, 1, json.dumps({
                "ws": "connected",
                "server": HOSTNAME,
                "now_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "egress_ips": egress()["egress_ips"],
            }))
            while True:
                op, data = ws_read(r)
                if op == 8:  # close
                    ws_send(w, 8, data[:2])
                    break
                if op == 9:  # ping
                    ws_send(w, 10, data)
                    continue
                if op == 10:  # pong
                    continue
                ws_send(w, op if op in (1, 2) else 1, data)
        except Exception:
            pass
        finally:
            self.close_connection = True


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    srv = Server(("0.0.0.0", PORT), Handler)
    print("lixev-probe listening on 0.0.0.0:%d host=%s" % (PORT, HOSTNAME), flush=True)
    srv.serve_forever()
