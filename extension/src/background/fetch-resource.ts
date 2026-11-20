// Fetch proxy for page-referenced resources: cross-origin stylesheets the engine must
// rewrite and images it must analyze. The only network requests Duskling makes, and only for URLs the page itself references.
//
// - credentials: "omit" and cache: "force-cache" (Fetch standard RequestInit; MDN fetch() options).
// - http(s) only, at most MAX_BYTES (Content-Length and a streamed byte count), TIMEOUT_MS via AbortController.
// - Local-network targets (loopback, private, link-local, .local, IPv6 ULA) are refused unless both the requesting tab
//   and the requesting frame are themselves in the same class, so a public page can't use the extension's host permissions to read a LAN device.
// - Redirects are followed by hand (redirect: "manual", at most MAX_REDIRECTS), re-validating every hop before it is
//   requested. Per the Fetch standard, manual mode in a page context yields an "opaqueredirect" filtered response with
//   no readable status or Location (MDN Response.type); that case fails closed, as does any hop that isn't allowed.
// - Only text/css is returned as text and only image/* as a blob.
//
// Residual risk: WebExtensions can't resolve DNS, so the class check sees host names only. A public name that resolves
// (or rebinds) to a private address can still be fetched. The type checks limit what comes back to a CSS file or to
// image bytes; the engine only classifies those bytes and never puts image pixels into the page unless corsOk is true.
// Accepted residual risk: cross-origin CSS has no CORS gate. Its rewritten selectors and colors go into
// a <style> the page can read, so a page could learn the contents of a stylesheet it links but can't read itself (only
// what the user's network can fetch without cookies). Gating it on corsOk would leave CDN sheets without ACAO unthemed.
import type { FetchResult, RuntimeMessage } from "../shared/messages";

export const MAX_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;

export type HostClass = "loopback" | "private" | "link-local" | "local" | "ula";

export interface FetchSender {
  /** URL of the tab that sent the request (the top-level page). */
  tabUrl?: string;
  /** URL of the frame that sent the request; its origin is compared with Access-Control-Allow-Origin. */
  frameUrl?: string;
}

type FetchMessage = Extract<RuntimeMessage, { type: "fetchResource" }>;
type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

function ipv4Class(a: number, b: number): HostClass | null {
  if (a === 127 || a === 0) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  // RFC 6598 shared address space (carrier-grade NAT): not public either.
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 169 && b === 254) return "link-local";
  return null;
}

/**
 * Local-network class of a URL hostname as produced by the WHATWG URL parser (IPv4 already canonical dotted-decimal,
 * IPv6 bracketed and compressed lowercase, IPv4-mapped IPv6 as `::ffff:hhhh:hhhh`). `null` means public.
 */
export function hostClass(hostname: string): HostClass | null {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
  if (h.endsWith(".local")) return "local";
  // RFC 8375 home.arpa; ".internal" (ICANN reserved for private use, 2024); ".lan" is a common router default.
  if (/(^|\.)(home\.arpa|internal|lan)$/.test(h)) return "private";
  // A single-label name (http://router/) resolves only through a local search domain or hosts file.
  if (h !== "" && !h.includes(".") && !h.includes(":") && !/^\d+$/.test(h)) return "private";
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) return ipv4Class(Number(v4[1]), Number(v4[2]));
  if (!h.includes(":")) return null;
  if (h === "::1" || h === "::") return "loopback";
  // Embedded IPv4: IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96 (::a.b.c.d) and NAT64 64:ff9b::/96 (RFC 6052).
  // The URL parser serializes the IPv4 part as two hex pieces, or one when the high piece is zero.
  const embedded = /^(?:::ffff:|::|64:ff9b::)(?:([0-9a-f]{1,4}):)?[0-9a-f]{1,4}$/.exec(h);
  if (embedded) {
    const hi = parseInt(embedded[1] ?? "0", 16);
    return ipv4Class(hi >> 8, hi & 0xff);
  }
  const first = parseInt(h.split(":")[0] || "0", 16);
  if ((first & 0xffc0) === 0xfe80) return "link-local";
  if ((first & 0xffc0) === 0xfec0) return "private"; // deprecated site-local fec0::/10 (RFC 3879)
  if ((first & 0xfe00) === 0xfc00) return "ula";
  return null;
}

function parseUrl(u: string | undefined): URL | null {
  if (!u) return null;
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

interface SenderClasses { tab: HostClass | null | undefined; frame: HostClass | null | undefined }

/** A local-network target needs both the tab and the frame in its class; an unknown sender URL never matches. */
function allowedTarget(url: URL, sender: SenderClasses): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const c = hostClass(url.hostname);
  return c === null || (c === sender.tab && c === sender.frame);
}

async function readCapped(res: Response): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export async function handleFetchResource(msg: FetchMessage, sender: FetchSender = {}, fetchImpl: FetchImpl = (u, i) => fetch(u, i)): Promise<FetchResult> {
  const target = parseUrl(msg.url);
  const classOf = (u: string | undefined) => {
    const p = parseUrl(u);
    return p ? hostClass(p.hostname) : undefined;
  };
  const tabClass: SenderClasses = { tab: classOf(sender.tabUrl), frame: classOf(sender.frameUrl) };
  if (!target || !allowedTarget(target, tabClass)) return { ok: false };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let url = target;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const r = await fetchImpl(url.href, { credentials: "omit", cache: "force-cache", redirect: "manual", signal: ctrl.signal });
      if (r.type === "opaqueredirect") return { ok: false };
      if (r.status >= 300 && r.status < 400) {
        void r.body?.cancel().catch(() => {});
        const next = parseUrl(r.headers.get("location") ? new URL(r.headers.get("location") as string, url).href : undefined);
        if (!next || !allowedTarget(next, tabClass)) return { ok: false };
        url = next;
        continue;
      }
      res = r;
      break;
    }
    if (!res || !res.ok) {
      void res?.body?.cancel().catch(() => {});
      return { ok: false };
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const typeOk = msg.as === "text" ? type === "text/css" : type.startsWith("image/") && MIME.test(type);
    if (!typeOk) {
      void res.body?.cancel().catch(() => {});
      return { ok: false };
    }
    const bytes = await readCapped(res);
    if (!bytes) return { ok: false };
    if (msg.as === "text") return { ok: true, text: new TextDecoder().decode(bytes) };

    const acao = res.headers.get("access-control-allow-origin")?.trim();
    const pageOrigin = parseUrl(sender.frameUrl ?? sender.tabUrl)?.origin;
    const corsOk = acao === "*" || (acao !== undefined && pageOrigin !== undefined && acao === pageOrigin);
    return { ok: true, dataUrl: `data:${type};base64,${base64(bytes)}`, corsOk };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
