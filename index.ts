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
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const SEEN_FILE = "seen.json";
const wasEmpty = !existsSync(SEEN_FILE);
const seen = new Set<string>(wasEmpty ? [] : JSON.parse(readFileSync(SEEN_FILE, "utf8")));
const saveSeen = () => writeFileSync(SEEN_FILE, JSON.stringify([...seen].slice(-8000)));

const COLORS = { vinted: 0x09b1ba, ebay: 0xe53238 } as const;
async function sendToDiscord(l: Listing, searchName: string, retry = 0): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error("DISCORD_WEBHOOK_URL manquant");
  const body = {
    username: "Phone Scanner",
    embeds: [{
      title: l.title.slice(0, 250),
      url: l.url,
      color: COLORS[l.source],
      fields: [
        { name: "💰 Prix", value: `**${l.price} ${l.currency}**`, inline: true },
        { name: "🛒 Source", value: l.source.toUpperCase(), inline: true },
        { name: "🔎 Recherche", value: searchName, inline: true },
        ...(l.extra ? [{ name: "ℹ️ Infos", value: l.extra, inline: false }] : []),
      ],
      ...(l.image ? { image: { url: l.image } } : {}),
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

// ---------- Vinted (lecture de la page de recherche) ----------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const VBASE = "https://www.vinted.fr";
const jar = new Map<string, string>();
let blockedUntil = 0;

const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function storeCookies(res: Response) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
}
const vHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "fr-FR,fr;q=0.9",
  ...(jar.size ? { cookie: cookieHeader() } : {}),
  ...extra,
});

async function refreshSession() {
  const h = await fetch(VBASE + "/", { headers: vHeaders(), redirect: "manual" });
  storeCookies(h);
  await h.text();
  const r = await fetch(VBASE + "/web/api/auth/refresh", {
    method: "POST",
    headers: vHeaders({ accept: "application/json", "content-type": "application/json", origin: VBASE, referer: VBASE + "/" }),
    body: "{}",
    redirect: "manual",
  });
  storeCookies(r);
  await r.text();
  console.log(`Vinted session rafraîchie : HTTP ${r.status}`);
}

async function getCatalogHtml(u: URL): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(u, { headers: vHeaders(), redirect: "manual" });
    storeCookies(r);
    if (r.status === 403 || r.status === 429) {
      blockedUntil = Date.now() + 5 * 60_000;
      throw new Error(`Vinted bloque (HTTP ${r.status})`);
    }
    if (r.status >= 300 && r.status < 400) {
      await refreshSession();
      continue;
    }
    if (!r.ok) throw new Error(`Vinted HTTP ${r.status}`);
    const html = await r.text();
    if (/<title>\s*Session refresh/i.test(html)) {
      await refreshSession();
      continue;
    }
    return html;
  }
  throw new Error("Vinted : session non valide");
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const SP = "(?:\\s|\\u00a0|\\u202f|&nbsp;|&#160;|&#8239;)*";
const PRICE_RE = new RegExp("(\\d{1,5}(?:[.,]\\d{1,2})?)" + SP + "(?:€|&euro;|&#8364;)");
const STATE_RE = /(Neuf avec étiquette|Neuf sans étiquette|Très bon état|Bon état|Satisfaisant)/i;
const IMG_RE = /https:\/\/images\d*\.vinted\.net\/[^"'\s)<>\\]+/;

function parseCatalog(html: string): Listing[] {
  const out: Listing[] = [];
  const ids = new Set<string>();

  // 1) Cartes de la page (liens <a href="/items/123-titre">)
  const anchors: { id: string; slug: string; idx: number; tag: string }[] = [];
  const reA = /<a\b[^>]*?href=["'](?:https:\/\/www\.vinted\.fr)?\/items\/(\d{6,})-([a-z0-9-]*)[^"']*["'][^>]*>/g;
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
        url: `${VBASE}/items/${a.id}-${a.slug}`,
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
      url: `${VBASE}/items/${m[1]}-${m[2]}`,
      image: win.match(IMG_RE)?.[0],
    });
  }
  return out;
}

async function searchVinted(query: string, maxPrice?: number): Promise<Listing[]> {
  if (Date.now() < blockedUntil) throw new Error("en pause (Vinted bloque), nouvel essai plus tard");
  const u = new URL(VBASE + "/catalog");
  u.searchParams.set("search_text", query);
  u.searchParams.set("order", "newest_first");
  if (maxPrice) u.searchParams.set("price_to", String(maxPrice));
  const html = await getCatalogHtml(u);
  const items = parseCatalog(html);
  console.log(`🔎 ${query} : ${items.length} annonces lues`);
  if (items.length === 0) {
    const k = html.indexOf("/items/");
    console.error("Aucune annonce lisible. Extrait :", html.slice(Math.max(0, k - 150), k + 450).replace(/\s+/g, " "));
  }
  return items;
}

// ---------- eBay (optionnel) ----------
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
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) return [];
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

// ---------- Boucle principale ----------
const allowed = (l: Listing, s: Search) => {
  const t = norm(l.title);
  return ![...config.exclude, ...(s.exclude ?? [])].some((w) => t.includes(norm(w)));
};

async function cycle(silent: boolean) {
  for (const s of config.searches) {
    const sources = [
      { name: "vinted", run: () => searchVinted(s.query, s.maxPrice) },
      { name: "ebay", run: () => searchEbay(s.query, s.maxPrice) },
    ];
    for (const src of sources) {
      try {
        const items = (await src.run()).reverse();
        for (const l of items) {
          if (seen.has(l.id)) continue;
          seen.add(l.id);
          if (silent || !allowed(l, s)) continue;
          await sendToDiscord(l, s.name);
          console.log(`➡️ ${l.source} | ${l.price}€ | ${l.title}`);
          await sleep(1200);
        }
      } catch (e) {
        console.error(`[${src.name}] "${s.query}" :`, (e as Error).message);
      }
      await sleep(2500);
    }
  }
  saveSeen();
}

console.log("📡 Phone Scanner démarré");
try {
  await sendToDiscord(
    { id: "start", source: "vinted", title: "✅ Phone Scanner est en ligne", price: 0, currency: "EUR", url: VBASE, extra: "Les nouvelles annonces vont arriver ici." },
    "Démarrage"
  );
} catch (e) {
  console.error("Discord :", (e as Error).message);
}

await cycle(wasEmpty);
while (true) {
  await sleep(Math.max(config.intervalSeconds, 90) * 1000);
  await cycle(false);
}
