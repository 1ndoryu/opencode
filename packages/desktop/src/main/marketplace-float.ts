// OP-33 F3c: floating in-page prototype. Main never clicks inside Facebook:
// the injected program only READS chat headers/messages and draws its own
// compact shadow-DOM panel above each open conversation (Generar button + up
// to 3 draft options, click-to-copy via navigator.clipboard). Draft brains
// stay in main (motor + catalog); the page only queues a want + renders what
// main pushes back. The chat header anchor comes from the live DOM
// (div[aria-label="Conversación con el título {buyer} · {listing}"]); if the
// header detaches, its panel is removed on the next scan.

export const FLOAT_VERSION = 1

export const FLOAT_HEADER_PREFIXES = ["Conversación con el título ", "Conversation titled "] as const

export type MpFloatStrings = { go: string; copied: string }

export type MpFloatWindow = {
  key: string
  buyer: string
  listing: string
  price: string
  excerpt: string
}

export type MpFloatSync = {
  v: number
  windows: MpFloatWindow[]
  want: MpFloatWindow | null
  error?: string
}

// "Aracelis · Casa en venta en Riberas del Caroní" -> { buyer, listing }.
// Returns undefined when the aria-label is not a conversation header.
export function parseFloatHeader(ariaLabel: string): { buyer: string; listing: string } | undefined {
  const prefix = FLOAT_HEADER_PREFIXES.find((p) => ariaLabel.slice(0, p.length) === p)
  if (!prefix) return undefined
  const title = ariaLabel.slice(prefix.length).trim()
  if (!title) return undefined
  const sep = title.indexOf(" · ")
  if (sep < 0) return { buyer: title, listing: "" }
  return { buyer: title.slice(0, sep).trim(), listing: title.slice(sep + 3).trim() }
}

export function floatKeyFor(buyer: string, listing: string): string {
  return `${buyer}|${listing}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
}

export function excerptFor(text: string): string {
  return text.slice(-1200)
}

// Page program body: runs with `s` = MpFloatStrings in scope. Plain string
// (no backticks/${ inside) so executeJavaScript can wrap it. Returns MpFloatSync.
export const FLOAT_SCRIPT = `
var V = 1;
var w = window;
w.__mpStrings = s;
if (w.__mpFloatV === V && w.__mpScan) {
  try { return w.__mpScan(); }
  catch (e) { return { v: V, windows: [], want: w.__mpWant || null, error: String(e).slice(0, 200) }; }
}
w.__mpFloatV = V;
var PREFIXES = ["Conversación con el título ", "Conversation titled "];
var panels = {};
w.__mpWant = null;
var timer = null;
function mpAttr(el, n) { try { return el.getAttribute(n) || ""; } catch (e) { return ""; } }
function mpTitle(a) {
  for (var i = 0; i < PREFIXES.length; i++) { if (a.slice(0, PREFIXES[i].length) === PREFIXES[i]) return a.slice(PREFIXES[i].length); }
  return "";
}
function mpSplit(t) {
  var i = t.indexOf(" · ");
  if (i < 0) return { buyer: t, listing: "" };
  return { buyer: t.slice(0, i), listing: t.slice(i + 3) };
}
function mpKey(buyer, listing) {
  return (buyer + "|" + listing).toLowerCase().replace(/\\s+/g, " ").trim().slice(0, 120);
}
function mpFind() {
  var all = document.querySelectorAll("div[aria-label]");
  var out = [];
  for (var i = 0; i < all.length; i++) { if (mpTitle(mpAttr(all[i], "aria-label"))) out.push(all[i]); }
  return out;
}
function mpRoot(header) {
  var el = header, n = 0;
  while (el && el.parentElement && n < 14) {
    el = el.parentElement; n++;
    var r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
    if (r && r.width >= 280 && r.width <= 430 && r.height > 320) return el;
  }
  return header.parentElement;
}
function mpText(root) { try { return root.innerText || ""; } catch (e) { return ""; } }
function mpPrice(text) {
  var m = text.match(/(VEF|USD|US\\$|\\$)\\s?[\\d][\\d.,]*/);
  return m ? m[0].slice(0, 24) : "";
}
function mpPlace(host, anchor) {
  var r = null;
  try { r = anchor.getBoundingClientRect(); } catch (e) { return; }
  if (!r || r.width === 0) return;
  var pw = 280;
  var left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.right - pw));
  var top = r.top - host.offsetHeight - 8;
  if (top < 8) top = r.bottom + 8;
  host.style.left = left + "px";
  host.style.top = Math.max(8, top) + "px";
}
function mpPanel(key) {
  var p = panels[key];
  if (p && p.host.isConnected) return p;
  if (p) { try { p.host.remove(); } catch (e) {} delete panels[key]; }
  var host = document.createElement("div");
  host.setAttribute("data-mp-float", key);
  host.style.cssText = "position:fixed;left:8px;top:8px;width:280px;z-index:2147483647;";
  var sh = host.attachShadow({ mode: "open" });
  sh.innerHTML = "<style>"
    + ".mp{font:12px/1.45 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:#18181b;color:#fafafa;border:1px solid #52525b;border-radius:10px;padding:8px 10px;box-shadow:0 8px 24px rgba(0,0,0,.45)}"
    + ".mp-t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:6px}"
    + ".mp-go{background:#fafafa;color:#18181b;border:0;border-radius:6px;padding:4px 10px;font-weight:600;cursor:pointer}"
    + ".mp-go:disabled{opacity:.6;cursor:default}"
    + ".mp-o{display:block;width:100%;text-align:left;background:#27272a;color:#fafafa;border:1px solid #52525b;border-radius:6px;padding:5px 8px;margin-top:5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
    + "</style>"
    + '<div class="mp"><div class="mp-t"></div><button class="mp-go" type="button"></button><div class="mp-opts"></div></div>';
  var mount = document.body || document.documentElement;
  mount.appendChild(host);
  p = { host: host, title: sh.querySelector(".mp-t"), go: sh.querySelector(".mp-go"), opts: sh.querySelector(".mp-opts") };
  panels[key] = p;
  return p;
}
function mpLoading(key) { return !!(w.__mpWant && w.__mpWant.key === key); }
function mpGoLabel() { return (w.__mpStrings && w.__mpStrings.go) || "Generar"; }
function mpRender(key, info, anchor) {
  var p = mpPanel(key);
  p.title.textContent = info.buyer + (info.listing ? " · " + info.listing : "");
  if (!p.goBound) {
    p.goBound = true;
    p.go.addEventListener("click", function () {
      w.__mpWant = info;
      p.go.disabled = true;
      p.go.textContent = "…";
    });
  }
  if (mpLoading(key)) { p.go.disabled = true; p.go.textContent = "…"; }
  else { p.go.disabled = false; p.go.textContent = mpGoLabel(); }
  mpPlace(p.host, anchor);
}
function mpScan() {
  var wins = [];
  var seen = {};
  var headers = mpFind();
  for (var i = 0; i < headers.length; i++) {
    var h = headers[i];
    var t = mpSplit(mpTitle(mpAttr(h, "aria-label")));
    if (!t.buyer) continue;
    var root = mpRoot(h);
    if (!root) continue;
    var full = mpText(root);
    if (!full) continue;
    var hasComposer = false;
    try { hasComposer = !!root.querySelector('div[contenteditable="true"]'); } catch (e) { hasComposer = false; }
    if (!hasComposer) continue;
    var key = mpKey(t.buyer, t.listing);
    seen[key] = true;
    var info = { key: key, buyer: t.buyer.slice(0, 80), listing: t.listing.slice(0, 120), price: mpPrice(full), excerpt: full.slice(-1200) };
    wins.push(info);
    try { mpRender(key, info, h); } catch (e) {}
  }
  for (var k in panels) {
    if (!seen[k]) { try { panels[k].host.remove(); } catch (e) {} delete panels[k]; }
  }
  return { v: V, windows: wins, want: w.__mpWant || null };
}
w.__mpScan = mpScan;
w.__mpPushDrafts = function (key, drafts) {
  var p = panels[key];
  if (!p || !p.host.isConnected) return false;
  if (w.__mpWant && w.__mpWant.key === key) w.__mpWant = null;
  p.opts.innerHTML = "";
  var list = Array.isArray(drafts) ? drafts.slice(0, 3) : [];
  for (var i = 0; i < list.length; i++) {
    (function (d) {
      var b = document.createElement("button");
      b.className = "mp-o";
      b.type = "button";
      var short = (d.text || "").slice(0, 110);
      b.textContent = short;
      b.title = d.text || "";
      b.addEventListener("click", function () {
        var done = function () {
          b.textContent = (w.__mpStrings && w.__mpStrings.copied) || "¡Copiado!";
          setTimeout(function () { b.textContent = short; }, 1200);
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(d.text || "").then(done, done);
          else done();
        } catch (e) { done(); }
      });
      p.opts.appendChild(b);
    })(list[i]);
  }
  return true;
};
function mpReposition() {
  var headers = mpFind();
  for (var i = 0; i < headers.length; i++) {
    var t = mpSplit(mpTitle(mpAttr(headers[i], "aria-label")));
    var key = mpKey(t.buyer, t.listing);
    if (panels[key]) { try { mpPlace(panels[key].host, headers[i]); } catch (e) {} }
  }
}
if (w.__mpObserver) { try { w.__mpObserver.disconnect(); } catch (e) {} }
w.__mpObserver = new MutationObserver(function () {
  if (timer) return;
  timer = setTimeout(function () { timer = null; try { mpScan(); } catch (e) {} }, 400);
});
try { w.__mpObserver.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
window.addEventListener("scroll", function () { mpReposition(); }, true);
window.addEventListener("resize", function () { mpReposition(); });
return mpScan();
`

export function floatInvokeScript(strings: MpFloatStrings): string {
  return `(function(s){${FLOAT_SCRIPT}})(${JSON.stringify(strings)})`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isFloatWindow(value: unknown): value is MpFloatWindow {
  if (!isRecord(value)) return false
  return (
    typeof value.key === "string" &&
    typeof value.buyer === "string" &&
    typeof value.listing === "string" &&
    typeof value.price === "string" &&
    typeof value.excerpt === "string"
  )
}

export function parseFloatSync(raw: unknown): MpFloatSync | null {
  if (!isRecord(raw) || raw.v !== FLOAT_VERSION || !Array.isArray(raw.windows)) return null
  if (!raw.windows.every(isFloatWindow)) return null
  const want = raw.want === null || raw.want === undefined ? null : isFloatWindow(raw.want) ? raw.want : null
  if (raw.want !== null && raw.want !== undefined && want === null) return null
  return { v: FLOAT_VERSION, windows: raw.windows as MpFloatWindow[], want }
}

export function floatDraftsFor(borradores: Array<{ intencion: string; texto: string }>): Array<{ id: string; text: string }> {
  return borradores.slice(0, 3).map((b) => ({ id: b.intencion, text: b.texto }))
}
