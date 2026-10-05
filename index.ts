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
let cookie = "";
let cookieAt = 0;
let blockedUntil = 0;

const pageHeaders = (): Record<string, string> => ({
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
  ...(cookie ? { cookie } : {}),
});

async function refreshCookie() {
  cookie = "";
  const r = await fetch(VBASE + "/", { headers: pageHeaders() });
  const set = r.headers.getSetCookie();
  cookie = set.map((c) => c.split(";")[0]).join("; ");
  cookieAt = Date.now();
  console.log(`Vinted accueil : HTTP ${r.status}, ${set.length} cookies`);
}

const SP = "(?:\\s|\\u00a0|\\u202f|&nbsp;|&#160;|&#8239;)*";
const PRICE_RE = new RegExp("(\\d{1,5}(?:[.,]\\d{1,2})?)" + SP + "(?:€|&euro;|&#8364;)");
const STATE_RE = /(Neuf avec étiquette|Neuf sans étiquette|Très bon état|Bon état|Satisfaisant)/i;

function parseCatalog(html: string): Listing[] {
  const found: { id: string; slug: string; idx: number }[] = [];
  const ids = new Set<string>();
  for (const m of html.matchAll(/\/items\/(\d{6,})-([a-z0-9-]*)/g)) {
    if (ids.has(m[1])) continue;
    ids.add(m[1]);
    found.push({ id: m[1], slug: m[2], idx: m.index ?? 0 });
  }
  const out: Listing[] = [];
  found.forEach((f, i) => {
    const end = Math.min(found[i + 1]?.idx ?? f.idx + 5000, f.idx + 5000);
    const seg = html.slice(f.idx, end);
    const jsonPrice = seg.match(/"amount"\s*:\s*"?(\d+(?:\.\d+)?)/);
    const htmlPrice = seg.match(PRICE_RE);
    const raw = jsonPrice?.[1] ?? htmlPrice?.[1];
    if (!raw) return;
    const jsonTitle = seg.match(/"title"\s*:\s*"([^"]{3,200})"/);
    const img = seg.match(/https:\/\/images\d*\.vinted\.net\/[^"'\s)<>\\]+/);
    const state = seg.match(STATE_RE);
    out.push({
      id: `vinted:${f.id}`,
      source: "vinted",
      title: jsonTitle?.[1] ?? f.slug.replace(/-/g, " "),
      price: Number(raw.replace(",", ".")),
      currency: "EUR",
      url: `${VBASE}/items/${f.id}-${f.slug}`,
      image: img?.[0],
      extra: state?.[1],
    });
  });
  return out;
}

async function searchVinted(query: string, maxPrice?: number): Promise<Listing[]> {
  if (Date.now() < blockedUntil) throw new Error("en pause (Vinted bloque), nouvel essai plus tard");
  if (!cookie || Date.now() - cookieAt > 20 * 60_000) await refreshCookie();
  const u = new URL(VBASE + "/catalog");
  u.searchParams.set("search_text", query);
  u.searchParams.set("order", "newest_first");
  if (maxPrice) u.searchParams.set("price_to", String(maxPrice));
  const r = await fetch(u, { headers: { ...pageHeaders(), referer: VBASE + "/" } });
  if (!r.ok) {
    if (r.status === 403 || r.status === 429) {
      blockedUntil = Date.now() + 5 * 60_000;
      console.error(`Vinted bloque (HTTP ${r.status})`);
    }
    throw new Error(`Vinted HTTP ${r.status}`);
  }
  const items = parseCatalog(await r.text());
  console.log(`🔎 ${query} : ${items.length} annonces lues`);
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
