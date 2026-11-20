// Fixture server for the e2e suite. Serves test/fixtures/pages/ on two origins:
//   - 4100 (origin A): the fixture pages.
//   - 4101 (origin B): the same files with no CORS headers, for cross-origin stylesheets, images and frames.
// `?delay=ms` delays any response (slow-css). `heavy.html` is generated: 5,000 rules and 2,000 elements.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PAGES = fileURLToPath(new URL("./pages/", import.meta.url));
export const PORT_A = 4100;
export const PORT_B = 4101;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".mp4": "video/mp4",
};

/** Deterministic light page with 5,000 rules over 2,000 elements (time-to-themed criterion). */
export function heavyHtml() {
  const rules = [];
  for (let i = 0; i < 5000; i++) {
    const n = i % 2000;
    const l = 88 + (i % 12);
    switch (i % 5) {
      case 0: rules.push(`.c${n}{background-color:hsl(${(i * 37) % 360} 30% ${l}%);color:#2${i % 10}2}`); break;
      case 1: rules.push(`.c${n}>span{color:rgb(${40 + (i % 30)},${40 + (i % 20)},${50 + (i % 40)});border-bottom:1px solid #e${i % 10}e${i % 10}e${i % 10}}`); break;
      case 2: rules.push(`.c${n}:hover{background:#f${i % 10}f${i % 10}f${i % 10};box-shadow:0 1px 2px rgba(0,0,0,.${1 + (i % 8)})}`); break;
      case 3: rules.push(`#e${n}{outline-color:#${(0xd0d0d0 + i).toString(16).slice(-6)}}`); break;
      default: rules.push(`.c${n}.k${i % 7}{border-color:#ccc;background-image:linear-gradient(#fff,#f${i % 10}f${i % 10}f${i % 10})}`);
    }
  }
  const els = [];
  for (let n = 0; n < 2000; n++) els.push(`<div id="e${n}" class="c${n} k${n % 7}"><span>Item ${n}</span> text ${n}</div>`);
  return (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Heavy</title>" +
    `<style>html,body{margin:0;background:#fff;color:#222;font:14px/1.4 system-ui,sans-serif}${rules.join("")}</style>` +
    `</head><body>${els.join("")}</body></html>`
  );
}

function handler(origin) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const delay = Math.min(Number(url.searchParams.get("delay")) || 0, 30_000);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    // Origin A sends no CORS headers either: its resources are only ever read same-origin. Origin B is the cross-origin
    // case, so it must not send them (images there are never pixel-readable, corsOk false).
    const headers = { "cache-control": "no-store", "x-fixture-origin": origin };
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      // A malformed escape (URIError) is the client's error, not a crash of the fixture server.
      res.writeHead(400, { ...headers, "content-type": "text/plain" }).end("bad request");
      return;
    }
    if (path === "/") path = "/index.html";
    if (path === "/heavy.html") {
      res.writeHead(200, { ...headers, "content-type": TYPES[".html"] });
      res.end(heavyHtml());
      return;
    }
    const file = normalize(join(PAGES, path));
    if (!file.startsWith(PAGES.endsWith(sep) ? PAGES : PAGES + sep)) {
      res.writeHead(403, headers).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { ...headers, "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { ...headers, "content-type": "text/plain" }).end("not found");
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // B first: Playwright's webServer waits for A, so A listening implies both are up.
  createServer(handler("B")).listen(PORT_B, () => {
    console.log(`fixtures B on http://localhost:${PORT_B}`);
    createServer(handler("A")).listen(PORT_A, () => console.log(`fixtures A on http://localhost:${PORT_A}`));
  });
}
