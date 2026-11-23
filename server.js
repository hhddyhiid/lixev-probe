// VLESS + WebSocket server (zero dependency) + Komari agent supervisor — MeroDeploy (Nepal) edition.
// Secrets (VLESS uuid, komari token) come from env: VLESS_UUID, KA_TOKEN.
// MeroDeploy terminates TLS at its edge and forwards plain HTTP/WS to PORT (default 8080).
const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
const http = require("http"), crypto = require("crypto"), net = require("net"), dgram = require("dgram");
const fs = require("fs"), cp = require("child_process");
const UID = (process.env.VLESS_UUID || "").trim();
if (!UID) { console.error("VLESS_UUID env var is required"); process.exit(1); }
const PORT = parseInt(process.env.PORT || "8080", 10);
const PATH = "/ws";
const KA_EP = "https://map.amerb.com";
const KA_TOKEN = (process.env.KA_TOKEN || "").trim();
const KA_VER = "1.6.20";
const KA_URLS = [
  "https://github.com/komari-monitor/komari-agent/releases/download/" + KA_VER + "/komari-agent-linux-amd64",
  "https://ghfast.top/https://github.com/komari-monitor/komari-agent/releases/download/" + KA_VER + "/komari-agent-linux-amd64",
  "https://gh-proxy.com/https://github.com/komari-monitor/komari-agent/releases/download/" + KA_VER + "/komari-agent-linux-amd64"
];
const UB = (() => {
  const h = UID.replace(/-/g, ""), b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
  return b;
})();
let E = "";
(async () => {
  try { E = await (await fetch("https://api.ipify.org")).text(); console.log("EGRESS " + E); } catch (e) { console.log("EGRESS_FAIL " + e.message); }
})();

// ---------- Komari agent supervision ----------
const ka = { pid: 0, restarts: 0, log: [], state: "boot" };
function klog(s) {
  ka.state = s;
  ka.log.push(new Date().toISOString().slice(11, 19) + " " + s);
  if (ka.log.length > 40) ka.log.shift();
  console.log("KA " + s);
}
async function dlAgent() {
  for (const u of KA_URLS) {
    try {
      const r = await fetch(u, { redirect: "follow", headers: { "user-agent": "curl/8.5.0" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length < 3e6) throw new Error("too small " + b.length);
      if (b.slice(0, 4).toString("hex") !== "7f454c46") throw new Error("not ELF");
      fs.writeFileSync("/tmp/ka", b);
      fs.chmodSync("/tmp/ka", 0o755);
      klog("DOWNLOADED " + b.length + "B");
      return true;
    } catch (e) { klog("DL_FAIL " + e.message); }
  }
  return false;
}
async function runAgent() {
  if (fs.existsSync("/tmp/ka") && fs.statSync("/tmp/ka").size > 3e6) {
    klog("BINARY_CACHED");
  } else if (!(await dlAgent())) { klog("NO_BINARY"); return setTimeout(runAgent, 60000); }
  const p = cp.spawn("/tmp/ka", [
    "--endpoint", KA_EP, "--token", KA_TOKEN, "-i", "3",
    "--info-report-interval", "5", "--disable-auto-update", "--prefer-ip-version", "4"
  ], { stdio: ["ignore", "pipe", "pipe"] });
  ka.pid = p.pid;
  klog("SPAWNED pid=" + p.pid);
  p.stdout.on("data", d => klog("out " + d.toString().replace(/\s+$/, "").slice(0, 300)));
  p.stderr.on("data", d => klog("err " + d.toString().replace(/\s+$/, "").slice(0, 300)));
  p.on("exit", (c, s) => { ka.pid = 0; ka.restarts++; klog("EXIT " + c + " " + s); setTimeout(runAgent, 10000); });
}
if (!KA_TOKEN) { klog("NO_TOKEN_SKIP_AGENT"); } else { setTimeout(runAgent, 1500); }

// ---------- WebSocket / VLESS ----------
function fr(p, op) {
  const n = p.length, o = op || 2;
  let h;
  if (n < 126) { h = Buffer.alloc(2); h[0] = 128 | o; h[1] = n; }
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 128 | o; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 128 | o; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
  return Buffer.concat([h, p]);
}
const srv = http.createServer((q, r) => {
  const p = (q.url || "").split("?")[0];
  if (p === "/ka") {
    r.setHeader("content-type", "application/json");
    r.end(JSON.stringify(ka));
    return;
  }
  if (p === "/health") {
    r.setHeader("content-type", "text/plain");
    r.end("ok");
    return;
  }
  r.setHeader("content-type", "text/plain");
  r.end(E || "ok");
});
srv.on("upgrade", (q, sk) => {
  if ((q.url || "").split("?")[0] !== PATH) {
    sk.write("HTTP/1.1 404 Not Found" + CR + LF + "Content-Length: 0" + CR + LF + CR + LF);
    sk.destroy();
    return;
  }
  const acc = crypto.createHash("sha1")
    .update((q.headers["sec-websocket-key"] || "") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  sk.write("HTTP/1.1 101 Switching Protocols" + CR + LF + "Upgrade: websocket" + CR + LF +
           "Connection: Upgrade" + CR + LF + "Sec-WebSocket-Accept: " + acc + CR + LF + CR + LF);
  sk.setNoDelay(true);
  let b = Buffer.alloc(0), w = Buffer.alloc(0), tcp = null, udp = null, dst = null, ready = false;
  const ka2 = setInterval(() => { if (!sk.destroyed) { try { sk.write(fr(Buffer.alloc(0), 9)); } catch (e) {} } }, 25000);
  function bye() { clearInterval(ka2); if (tcp) tcp.destroy(); if (udp) { try { udp.close(); } catch (e) {} } }
  sk.on("close", bye); sk.on("error", bye);
  function bad() { console.log("BADHDR"); sk.destroy(); }
  function feed(p) {
    if (ready) {
      if (tcp) { tcp.write(p); return; }
      b = Buffer.concat([b, p]);
      while (b.length >= 2) {
        const L = b.readUInt16BE(0);
        if (b.length < 2 + L) return;
        udp.send(b.slice(2, 2 + L), dst.port, dst.host);
        b = b.slice(2 + L);
      }
      return;
    }
    b = Buffer.concat([b, p]);
    if (b.length < 18) return;
    if (b[0] !== 0 || !b.slice(1, 17).equals(UB)) { bad(); return; }
    const o0 = 18 + b[17];
    if (b.length < o0 + 4) return;
    const cmd = b[o0], port = b.readUInt16BE(o0 + 1), at = b[o0 + 3];
    let o1 = o0 + 4, host;
    if (at === 1) { if (b.length < o1 + 4) return; host = [...b.slice(o1, o1 + 4)].join("."); o1 += 4; }
    else if (at === 2) { if (b.length < o1 + 1) return; const L = b[o1]; if (b.length < o1 + 1 + L) return; host = b.slice(o1 + 1, o1 + 1 + L).toString(); o1 += 1 + L; }
    else if (at === 3) { if (b.length < o1 + 16) return; const g = []; for (let i = 0; i < 8; i++) g.push(b.readUInt16BE(o1 + i * 2).toString(16)); host = g.join(":"); o1 += 16; }
    else { bad(); return; }
    const rest = b.slice(o1); b = Buffer.alloc(0); ready = true;
    if (cmd === 1) {
      tcp = net.connect({ host: host, port: port });
      tcp.on("connect", () => { console.log("UP " + host + ":" + port); sk.write(fr(Buffer.from([0, 0]))); if (rest.length) tcp.write(rest); });
      tcp.on("data", d => { if (!sk.destroyed) sk.write(fr(d)); });
      tcp.on("error", e => { console.log("TCPERR " + host + " " + e.message); sk.destroy(); });
      tcp.on("close", () => { if (!sk.destroyed) { try { sk.write(fr(Buffer.alloc(0), 8)); } catch (e) {} sk.destroy(); } });
    } else if (cmd === 2) {
      dst = { host: host, port: port }; udp = dgram.createSocket(at === 3 ? "udp6" : "udp4");
      udp.on("message", m => { const L = Buffer.alloc(2); L.writeUInt16BE(m.length, 0); if (!sk.destroyed) sk.write(fr(Buffer.concat([L, m]))); });
      udp.on("error", () => {});
      sk.write(fr(Buffer.from([0, 0])));
      // datagrams that arrived in the same frame as the header must be flushed now
      if (rest.length) { b = rest; feed(Buffer.alloc(0)); }
    } else bad();
  }
  sk.on("data", d => {
    w = Buffer.concat([w, d]);
    for (;;) {
      if (w.length < 2) return;
      const o = w[0] & 15, m = (w[1] & 128) !== 0; let L = w[1] & 127, q0 = 2;
      if (L === 126) { if (w.length < 4) return; L = w.readUInt16BE(2); q0 = 4; }
      else if (L === 127) { if (w.length < 10) return; L = Number(w.readBigUInt64BE(2)); q0 = 10; }
      let k = null;
      if (m) { if (w.length < q0 + 4) return; k = w.slice(q0, q0 + 4); q0 += 4; }
      if (w.length < q0 + L) return;
      const p = Buffer.from(w.slice(q0, q0 + L));
      if (k) for (let i = 0; i < p.length; i++) p[i] ^= k[i % 4];
      w = w.slice(q0 + L);
      if (o === 8) { sk.destroy(); return; }
      if (o === 9) { if (!sk.destroyed) sk.write(fr(p, 10)); continue; }
      if (o === 10) continue;
      feed(p);
      if (sk.destroyed) return;
    }
  });
});
srv.listen(PORT, () => console.log("LISTEN " + PORT + " UUID " + UID));
