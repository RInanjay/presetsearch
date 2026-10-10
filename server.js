const http = require("node:http");

const HOST = "https://amfinder.web.id";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
const TIMEOUT_MS = 180000;
const PORT = process.env.PORT || 3000;

function parseBlock(block) {
  const ev = /(?:^|\n)event:[ \t]*(.+)/.exec(block);
  const data = /(?:^|\n)data:[ \t]?([\s\S]*)/.exec(block)?.[1];
  if (!ev) return null;
  const name = ev[1].trim();

  if (name === "result") {
    try { return JSON.parse(data); } catch { return null; }
  }
  if (name === "error") {
    let m = data ?? "unknown error";
    try { m = JSON.parse(data).message || m; } catch {}
    throw new Error(m);
  }
  return null;
}

async function findTiktok(videoUrl) {
  const endpoint = `${HOST}/api/find?${new URLSearchParams({ url: videoUrl })}&bat=NaN&chg=0`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      signal: ac.signal,
      headers: {
        accept: "text/event-stream",
        "user-agent": UA,
        referer: HOST + "/",
        origin: HOST,
        "cache-control": "no-cache",
      },
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status} dari upstream`);

    const decoder = new TextDecoder();
    let buf = "", result = null;

    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const r = parseBlock(block);
        if (r) result = r;
      }
    }
    const last = parseBlock(buf);
    if (last) result = last;

    if (!result) throw new Error("Koneksi ditutup sebelum event result");
    if (result.ok === false) throw new Error(result.error || "upstream error");
    return result;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Timeout ${TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function send(res, code, obj) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(obj, null, 2));
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/") {
    return send(res, 200, { status: true, usage: "/api/tiktok?url=<tiktok-url>" });
  }

  if (u.pathname === "/api/tiktok") {
    const url = (u.searchParams.get("url") || "").trim();
    if (!url) return send(res, 400, { status: false, error: "Parameter url wajib diisi" });
    if (!/tiktok\.com/i.test(url)) return send(res, 400, { status: false, error: "URL harus dari TikTok" });

    try {
      const result = await findTiktok(url);
      return send(res, 200, { status: true, input: url, result });
    } catch (e) {
      return send(res, 502, { status: false, input: url, result: null, error: e.message });
    }
  }

  send(res, 404, { status: false, error: "Not found" });
}).listen(PORT, "0.0.0.0", () => console.log("Running on :" + PORT));