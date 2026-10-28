import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface Listing {
  id: string;
  source: "vinted" | "ebay";
  title: string;
  price: number;
  currency: string;
  url: string;
  image?: string;
  extra?: string;
}

interface Search { name: string; query: string; maxPrice?: number; exclude?: string[] }

const config = JSON.parse(readFileSync("config.json", "utf8")) as {
  intervalSeconds: number; exclude: string[]; searches: Search[];
  fast?: { enabled?: boolean; query?: string; everySeconds?: number; priceTo?: number; domains?: string[] };
};
// ⚡ Mode rapide : UNE recherche large « iphone » (plus récentes d'abord) relue toutes les quelques secondes.
// Chaque nouvelle annonce passe ensuite par les mêmes filtres et les mêmes plafonds par modèle qu'avant.
const FAST = {
  enabled: config.fast?.enabled ?? true,
  query: config.fast?.query ?? "iphone",
  everySeconds: Math.max(config.fast?.everySeconds ?? 8, 5),
  priceTo: config.fast?.priceTo ?? Math.max(...config.searches.map((x) => x.maxPrice ?? 0), 100),
  domains: (config.fast?.domains?.length ? config.fast.domains : ["www.vinted.fr"]).map((d) => d.replace(/^https?:\/\//, "").replace(/\/$/, "")),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// ---------- Plafonds par modèle (lus dans config.json) ----------
const MODEL_RE = /iphone\s*(xs\s*max|xr|xs|1[1-8])\s*(pro\s*max|pro|plus|mini|air)?/;
const modelKey = (t: string): string | null => {
  const m = t.match(MODEL_RE);
  return m ? `${m[1]} ${m[2] ?? ""}`.replace(/\s+/g, " ").trim() : null;
};
const modelCap = new Map<string, number>();
for (const s of config.searches) {
  if (!s.maxPrice) continue;
  const k = modelKey(norm(s.query));
  if (k) modelCap.set(k, s.maxPrice);
}
const UNKNOWN_MODEL_CAP = 60;
console.log(`Plafonds par modèle chargés : ${modelCap.size}`);

const SEEN_FILE = "seen.json";
const seen = new Set<string>(existsSync(SEEN_FILE) ? JSON.parse(readFileSync(SEEN_FILE, "utf8")) : []);
const saveSeen = () => writeFileSync(SEEN_FILE, JSON.stringify([...seen].slice(-8000)));
const rejected = new Set<string>();

const COLORS = { vinted: 0x09b1ba, ebay: 0xe53238 } as const;
const FLAGS: Record<string, string> = {
  FR: "🇫🇷", BE: "🇧🇪", LU: "🇱🇺", NL: "🇳🇱", DE: "🇩🇪", AT: "🇦🇹", ES: "🇪🇸", IT: "🇮🇹", PT: "🇵🇹",
  LT: "🇱🇹", SK: "🇸🇰", FI: "🇫🇮", IE: "🇮🇪", GR: "🇬🇷", HR: "🇭🇷", SI: "🇸🇮", EE: "🇪🇪", LV: "🇱🇻",
};

async function sendToDiscord(l: Listing, searchName: string, retry = 0): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error("DISCORD_WEBHOOK_URL manquant");
  const host = (() => { try { return new URL(l.url).host; } catch { return "www.vinted.fr"; } })();
  const cc = countryOf("https://" + host);
  const body = {
    username: "Phone Scanner",
    embeds: [{
      author: { name: `${FLAGS[cc] ?? "🌍"} Vinted ${cc} · ${searchName}` },
      title: l.price ? `${l.title.split(/,\s*marque\s*:/i)[0].slice(0, 200)} — ${l.price} €` : l.title,
      url: l.url,
      color: COLORS[l.source],
      fields: [
        { name: "💰 Prix", value: `**${l.price} ${l.currency === "EUR" ? "€" : l.currency}**`, inline: true },
        { name: l.price ? "📦 État" : "ℹ️ Infos", value: l.extra ?? "Non précisé", inline: !!l.price },
        { name: "🌍 Pays", value: `${FLAGS[cc] ?? ""} ${cc}`, inline: true },
        { name: "🔗 Annonce", value: `[Ouvrir sur Vinted](${l.url})`, inline: false },
      ],
      ...(l.image ? { image: { url: l.image } } : {}),
      footer: { text: "Phone Scanner · nouvelle annonce" },
      timestamp: new Date().toISOString(),
    }],
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 429 && retry < 3) {
    const j: any = await r.json().catch(() => ({}));
    await sleep(((j.retry_after ?? 2) as number) * 1000 + 200);
    return sendToDiscord(l, searchName, retry + 1);
  }
  if (!r.ok) throw new Error(`Discord HTTP ${r.status}`);
}

// ---------- Vinted (lecture de la page de recherche, plusieurs pays possibles) ----------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const VBASE = "https://www.vinted.fr";
const PHONES_CATALOG = "3661"; // catégorie Vinted « Téléphones portables »

// Une session (cookies + pause) par pays
interface VSession { base: string; jar: Map<string, string>; blockedUntil: number; strikes: number }
const sessions = new Map<string, VSession>();
const sessionFor = (host: string): VSession => {
  let v = sessions.get(host);
  if (!v) { v = { base: `https://${host}`, jar: new Map(), blockedUntil: 0, strikes: 0 }; sessions.set(host, v); }
  return v;
};
const countryOf = (base: string) => base.split(".").pop()!.toUpperCase();

function storeCookies(v: VSession, res: Response) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) v.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
}

const vHeaders = (v: VSession, extra: Record<string, string> = {}): Record<string, string> => ({
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "fr-FR,fr;q=0.9,en;q=0.7",
  "cache-control": "no-cache",
  ...(v.jar.size ? { cookie: [...v.jar].map(([k, val]) => `${k}=${val}`).join("; ") } : {}),
  ...extra,
});

async function refreshSession(v: VSession) {
  const h = await fetch(v.base + "/", { headers: vHeaders(v), redirect: "manual" });
  storeCookies(v, h);
  await h.text();
  const r = await fetch(v.base + "/web/api/auth/refresh", {
    method: "POST",
    headers: vHeaders(v, { accept: "application/json", "content-type": "application/json", origin: v.base, referer: v.base + "/" }),
    body: "{}",
    redirect: "manual",
  });
  storeCookies(v, r);
  await r.text();
  console.log(`Vinted ${countryOf(v.base)} session rafraîchie : HTTP ${r.status}`);
}

async function getCatalogHtml(v: VSession, u: URL): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(u, { headers: vHeaders(v), redirect: "manual" });
    storeCookies(v, r);
    if (r.status === 403 || r.status === 429) {
      // pause progressive : 1 min, 2 min, 5 min, puis 10 min
      v.strikes++;
      const mins = [1, 2, 5, 10][Math.min(v.strikes - 1, 3)];
      v.blockedUntil = Date.now() + mins * 60_000;
      v.jar.clear();
      throw new Error(`Vinted ${countryOf(v.base)} bloque (HTTP ${r.status}) : pause ${mins} min`);
    }
    if (r.status >= 300 && r.status < 400) {
      await refreshSession(v);
      continue;
    }
    if (!r.ok) throw new Error(`Vinted HTTP ${r.status}`);
    const html = await r.text();
    if (/<title>\s*Session refresh/i.test(html)) {
      await refreshSession(v);
      continue;
    }
    v.strikes = 0;
    return html;
  }
  throw new Error("Vinted : session non valide");
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// ---------- Lecture de la description (seulement pour les annonces qui passent les filtres) ----------
// Si la page ne répond pas, on ne bloque pas l'annonce : mieux vaut une alerte qu'une affaire ratée.
async function fetchDescription(l: Listing): Promise<string | null> {
  if (l.source !== "vinted") return null;
  try {
    const host = new URL(l.url).host;
    const v = sessionFor(host);
    if (Date.now() < v.blockedUntil) return null;
    const r = await fetch(l.url, { headers: vHeaders(v), redirect: "follow" });
    storeCookies(v, r);
    if (!r.ok) return null;
    const html = (await r.text()).replace(/\\"/g, '"').replace(/\\n/g, " ").replace(/\\u0026/g, "&");
    const parts: string[] = [];
    for (const m of html.matchAll(/"description"\s*:\s*"([^"]{0,4000})"/g)) parts.push(m[1]);
    const meta = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,2000})["']/i);
    if (meta) parts.push(meta[1]);
    const itemprop = html.match(/itemprop=["']description["'][^>]*>([\s\S]{0,4000}?)<\//i);
    if (itemprop) parts.push(itemprop[1].replace(/<[^>]+>/g, " "));
    return parts.length ? decode(parts.join(" ")) : "";
  } catch {
    return null;
  }
}

const SP = "(?:\\s|\\u00a0|\\u202f|&nbsp;|&#160;|&#8239;)*";
const PRICE_RE = new RegExp("(\\d{1,5}(?:[.,]\\d{1,2})?)" + SP + "(?:€|&euro;|&#8364;)");
const STATE_RE = /(Neuf avec étiquette|Neuf sans étiquette|Très bon état|Bon état|Satisfaisant|Neu mit Etikett|Neu ohne Etikett|Sehr gut|Gut|Zufriedenstellend|Nuevo con etiquetas|Nuevo sin etiquetas|Muy bueno|Bueno|Nuovo con cartellino|Nuovo senza cartellino|Ottime|Buone|Nieuw met prijskaartje|Nieuw zonder prijskaartje|Zeer goed|Goed|Novo com etiquetas|Muito bom|Nuevo|Nuovo|Neu|Nieuw)/i;
const IMG_RE = /https:\/\/images\d*\.vinted\.net\/[^"'\s)<>\\]+/;

function parseCatalog(html: string, base = VBASE): Listing[] {
  const out: Listing[] = [];
  const ids = new Set<string>();

  // 1) Cartes de la page (liens <a href="/items/123-titre">)
  const anchors: { id: string; slug: string; idx: number; tag: string }[] = [];
  const reA = /<a\b[^>]*?href=["'](?:https:\/\/www\.vinted\.[a-z.]+)?\/items\/(\d{6,})-([a-z0-9-]*)[^"']*["'][^>]*>/g;
  for (const m of html.matchAll(reA)) {
    if (ids.has(m[1])) continue;
    ids.add(m[1]);
    anchors.push({ id: m[1], slug: m[2], idx: m.index ?? 0, tag: m[0] });
  }
  if (anchors.length >= 3) {
    anchors.forEach((a, i) => {
      const end = Math.min(anchors[i + 1]?.idx ?? a.idx + 6000, a.idx + 6000);
      const seg = html.slice(a.idx, end);
      const p = seg.match(PRICE_RE);
      if (!p) return;
      const attr = a.tag.match(/title=["']([^"']{3,300})["']/);
      const img = seg.match(IMG_RE);
      const st = seg.match(STATE_RE);
      out.push({
        id: `vinted:${a.id}`,
        source: "vinted",
        title: attr ? decode(attr[1]) : a.slug.replace(/-/g, " "),
        price: Number(p[1].replace(",", ".")),
        currency: "EUR",
        url: `${base}/items/${a.id}-${a.slug}`,
        image: img?.[0],
        extra: st?.[1],
      });
    });
    if (out.length) return out;
  }

  // 2) Secours : données JSON de la page
  ids.clear();
  for (const m of html.matchAll(/\/items\/(\d{6,})-([a-z0-9-]*)/g)) {
    if (ids.has(m[1])) continue;
    ids.add(m[1]);
    const idx = m.index ?? 0;
    const win = html.slice(Math.max(0, idx - 1500), idx + 300).replace(/\\"/g, '"');
    const all = [...win.matchAll(/"amount"\s*:\s*"?(\d+(?:\.\d+)?)/g)];
    if (!all.length) continue;
    const t = win.match(/"title"\s*:\s*"([^"]{3,200})"/g);
    const lastTitle = t ? t[t.length - 1].replace(/^"title"\s*:\s*"/, "").replace(/"$/, "") : undefined;
    out.push({
      id: `vinted:${m[1]}`,
      source: "vinted",
      title: lastTitle ?? m[2].replace(/-/g, " "),
      price: Number(all[all.length - 1][1]),
      currency: "EUR",
      url: `${base}/items/${m[1]}-${m[2]}`,
      image: win.match(IMG_RE)?.[0],
    });
  }
  return out;
}

async function searchVinted(query: string, maxPrice?: number, host = "www.vinted.fr", page = 1, quiet = false): Promise<Listing[]> {
  const v = sessionFor(host);
  if (Date.now() < v.blockedUntil) throw new Error(`en pause (Vinted ${countryOf(v.base)} bloque), nouvel essai dans ${Math.ceil((v.blockedUntil - Date.now()) / 1000)} s`);
  const u = new URL(v.base + "/catalog");
  u.searchParams.set("search_text", query);
  u.searchParams.set("catalog[]", PHONES_CATALOG); // uniquement la catégorie téléphones
  u.searchParams.set("order", "newest_first");
  u.searchParams.set("per_page", "96");
  if (page > 1) u.searchParams.set("page", String(page));
  u.searchParams.set("time", String(Math.floor(Date.now() / 1000))); // évite les pages en cache
  if (maxPrice) u.searchParams.set("price_to", String(maxPrice));
  const html = await getCatalogHtml(v, u);
  const items = parseCatalog(html, v.base);
  if (!quiet) console.log(`🔎 ${countryOf(v.base)} ${query}${page > 1 ? ` p${page}` : ""} : ${items.length} annonces lues`);
  if (items.length === 0) {
    const k = html.indexOf("/items/");
    console.error("Aucune annonce lisible. Extrait :", html.slice(Math.max(0, k - 150), k + 450).replace(/\s+/g, " "));
  }
  return items;
}

// ---------- eBay (optionnel) ----------
const EBAY_ENABLED = Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
let token = "";
let tokenExp = 0;

async function ebayToken(): Promise<string> {
  if (token && Date.now() < tokenExp) return token;
  const auth = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64");
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${auth}` },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });
  if (!r.ok) throw new Error(`eBay token HTTP ${r.status}`);
  const j: any = await r.json();
  token = j.access_token;
  tokenExp = Date.now() + (j.expires_in - 120) * 1000;
  return token;
}

async function searchEbay(query: string, maxPrice?: number): Promise<Listing[]> {
  if (!EBAY_ENABLED) return [];
  const u = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  u.searchParams.set("q", query);
  u.searchParams.set("sort", "newlyListed");
  u.searchParams.set("limit", "30");
  const filters = ["priceCurrency:EUR"];
  if (maxPrice) filters.unshift(`price:[..${maxPrice}]`);
  u.searchParams.set("filter", filters.join(","));
  const r = await fetch(u, {
    headers: { authorization: `Bearer ${await ebayToken()}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_FR" },
  });
  if (!r.ok) throw new Error(`eBay HTTP ${r.status}`);
  const data: any = await r.json();
  return (data.itemSummaries ?? []).map((it: any): Listing => ({
    id: `ebay:${it.itemId}`,
    source: "ebay",
    title: it.title,
    price: Number(it.price?.value),
    currency: it.price?.currency ?? "EUR",
    url: it.itemWebUrl,
    image: it.image?.imageUrl,
    extra: [it.condition, it.itemLocation?.country].filter(Boolean).join(" · ") || undefined,
  }));
}

// ---------- Filtres ----------
const MIN_PRIX = 20;

// Pièces et accessoires : on regarde seulement le DÉBUT du titre (toutes langues)
const PART_START = /^(ecran|batterie|boite|boitier|vitre|dalle|lcd|oled|camera|chassis|facade|nappe
