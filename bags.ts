// 👜 Luxe Scanner — articles de luxe à bas prix sur Vinted (marque vérifiée), alertes Discord
// Tourne à côté du Phone Scanner (même Termux), avec son propre salon Discord.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Une recherche = une marque. On ne garde QUE les annonces où le vendeur a choisi
// cette marque dans le champ « Marque » de Vinted (les faux sont presque toujours sans marque).
interface Search {
  name: string; query: string; brand: string[]; maxPrice: number; minPrice?: number;
}
interface Config {
  intervalSeconds: number; minPrice: number; searches: Search[];
  titleExclude: string[]; fakeWords: string[]; trustWords: string[];
}
interface Listing {
  id: string; title: string; brand?: string; price: number; url: string; image?: string; state?: string;
}
interface Check { ok: boolean; score: number; reasons: string[]; description: string }

const config = JSON.parse(readFileSync("bags.json", "utf8")) as Config;
const WEBHOOK = (process.env.DISCORD_WEBHOOK_BAGS ?? process.env.DISCORD_WEBHOOK_URL ?? "").trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’`]/g, "'").toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// mot entier (évite que « tag » bloque « vintage »)
const hasWord = (text: string, w: string) =>
  new RegExp(`(^|[^a-z0-9])${esc(norm(w))}([^a-z0-9]|$)`).test(text);
// début de mot (« inspir » attrape « inspiré », « inspiration »)
const hasStem = (text: string, w: string) => new RegExp(`(^|[^a-z0-9])${esc(norm(w))}`).test(text);

// ---------- Mémoire ----------
const SEEN_FILE = "seen-bags.json";
const seen = new Set<string>(existsSync(SEEN_FILE) ? JSON.parse(readFileSync(SEEN_FILE, "utf8")) : []);
const saveSeen = () => writeFileSync(SEEN_FILE, JSON.stringify([...seen].slice(-5000)));

// ---------- Vinted (même méthode que le Phone Scanner) ----------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const VBASE = "https://www.vinted.fr";
const jar = new Map<string, string>();
let blockedUntil = 0;

const storeCookies = (res: Response) => {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
};
const vHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "fr-FR,fr;q=0.9",
  ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
  ...extra,
});

async function refreshSession() {
  const h = await fetch(VBASE + "/", { headers: vHeaders(), redirect: "manual" });
  storeCookies(h); await h.text();
  const r = await fetch(VBASE + "/web/api/auth/refresh", {
    method: "POST",
    headers: vHeaders({ accept: "application/json", "content-type": "application/json", origin: VBASE, referer: VBASE + "/" }),
    body: "{}", redirect: "manual",
  });
  storeCookies(r); await r.text();
}

async function getHtml(u: URL | string): Promise<string> {
  if (Date.now() < blockedUntil) throw new Error("en pause (Vinted bloque)");
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(u, { headers: vHeaders(), redirect: "manual" });
    storeCookies(r);
    if (r.status === 403 || r.status === 429) {
      blockedUntil = Date.now() + 5 * 60_000;
      throw new Error(`Vinted bloque (HTTP ${r.status})`);
    }
    if (r.status >= 300 && r.status < 400) { await refreshSession(); continue; }
    if (!r.ok) throw new Error(`Vinted HTTP ${r.status}`);
    const html = await r.text();
    if (/<title>\s*Session refresh/i.test(html)) { await refreshSession(); continue; }
    return html;
  }
  throw new Error("Vinted : session non valide");
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, " ").replace(/\\"/g, '"');

const SP = "(?:\\s|\\u00a0|\\u202f|&nbsp;|&#160;|&#8239;)*";
const PRICE_RE = new RegExp("(\\d{1,3}(?:[ .\\u00a0\\u202f]?\\d{3})*(?:[.,]\\d{1,2})?)" + SP + "(?:€|&euro;|&#8364;)");
const STATE_RE = /(Neuf avec étiquette|Neuf sans étiquette|Très bon état|Bon état|Satisfaisant)/i;
const IMG_RE = /https:\/\/images\d*\.vinted\.net\/[^"'\s)<>\\]+/;
const toNumber = (s: string) => Number(s.replace(/[ .  ](?=\d{3}\b)/g, "").replace(",", "."));

export function parseCatalog(html: string): Listing[] {
  const out: Listing[] = [];
  const ids = new Set<string>();
  const anchors: { id: string; slug: string; idx: number; tag: string }[] = [];
  const reA = /<a\b[^>]*?href=["'](?:https:\/\/www\.vinted\.fr)?\/items\/(\d{6,})-([a-z0-9-]*)[^"']*["'][^>]*>/g;
  for (const m of html.matchAll(reA)) {
    if (ids.has(m[1])) continue;
    ids.add(m[1]);
    anchors.push({ id: m[1], slug: m[2], idx: m.index ?? 0, tag: m[0] });
  }
  anchors.forEach((a, i) => {
    const seg = html.slice(a.idx, Math.min(anchors[i + 1]?.idx ?? a.idx + 6000, a.idx + 6000));
    const p = seg.match(PRICE_RE);
    if (!p) return;
    const attr = a.tag.match(/title=["']([^"']{3,400})["']/);
    const full = attr ? decode(attr[1]) : a.slug.replace(/-/g, " ");
    const brand = full.match(/,\s*marque\s*:\s*([^,]+)/i)?.[1]?.trim();
    out.push({
      id: `vinted:${a.id}`,
      title: full.split(/,\s*marque\s*:/i)[0].trim(),
      brand,
      price: toNumber(p[1]),
      url: `${VBASE}/items/${a.id}-${a.slug}`,
      image: seg.match(IMG_RE)?.[0],
      state: seg.match(STATE_RE)?.[1],
    });
  });
  return out;
}

async function searchVinted(s: Search): Promise<Listing[]> {
  const u = new URL(VBASE + "/catalog");
  u.searchParams.set("search_text", s.query);
  u.searchParams.set("order", "newest_first");
  u.searchParams.set("price_from", String(s.minPrice ?? config.minPrice));
  u.searchParams.set("price_to", String(s.maxPrice));
  const items = parseCatalog(await getHtml(u));
  const withBrand = items.filter((i) => i.brand).length;
  console.log(`🔎 ${s.query} : ${items.length} annonces lues (${withBrand} avec marque)`);
  if (items.length >= 10 && withBrand === 0) console.error("⚠️ aucune marque lue sur la page : préviens Claude, le format Vinted a changé");
  return items;
}

// Description de l'annonce (lue seulement pour les annonces qui passent les filtres)
async function fetchDescription(url: string): Promise<string> {
  try {
    const html = await getHtml(url);
    const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)
      ?? html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
    const js = html.match(/"description"\s*:\s*"((?:[^"\\]|\\.){10,4000})"/);
    return decode([og?.[1], js?.[1]].filter(Boolean).join(" ")).slice(0, 4000);
  } catch (e) {
    console.error("description :", (e as Error).message);
    return "";
  }
}

// ---------- Filtres titre + marque ----------
const minOf = (s: Search, c: Config) => s.minPrice ?? c.minPrice;

export function titleRefusal(l: Listing, s: Search, c: Config = config): string | null {
  const t = norm(l.title);
  const b = norm(l.brand ?? "");
  if (!b) return "aucune marque renseignée = faux probable";
  if (!s.brand.some((w) => b === norm(w) || hasWord(b, w))) return `marque « ${l.brand} » ≠ ${s.name}`;
  const fake = c.fakeWords.find((w) => hasStem(t, w) || t.includes(norm(w)));
  if (fake) return `🚨 signe de copie « ${fake} »`;
  const ex = c.titleExclude.find((w) => hasWord(t, w));
  if (ex) return `accessoire « ${ex} »`;
  if (l.price < minOf(s, c)) return `prix trop bas (${l.price}€)`;
  if (l.price > s.maxPrice) return `trop cher (${l.price}€ > ${s.maxPrice}€)`;
  return null;
}

// ---------- Analyse d'authenticité de l'annonce ----------
export function analyse(l: Listing, s: Search, description: string, c: Config = config): Check {
  // « copie de facture » est une preuve, pas un signe de copie
  const d = norm(description).replace(/copie (de (la )?)?facture/g, "facture");
  const reasons: string[] = [`✅ marque Vinted : ${l.brand}`];
  let score = 55;

  const fakes = [...new Set(c.fakeWords.map(norm).filter((w) => d.includes(w)))];
  if (fakes.length) return { ok: false, score: 0, reasons: [`🚨 copie : « ${fakes.join(" », « ")} »`], description };

  const notAuth = /(non|pas|jamais) (encore )?authentifi/.test(d);
  if (notAuth) { score -= 10; reasons.push("⚠️ jamais authentifié"); }
  const dt = d.replace(/(non|pas|jamais) (encore )?authentifi\w*/g, "");
  const trust = [...new Set(c.trustWords.map(norm).filter((w) => dt.includes(w)))];
  if (trust.length) {
    score += Math.min(trust.length * 12, 36);
    reasons.push(`✅ ${trust.slice(0, 4).join(", ")}`);
  } else {
    reasons.push("⚪ aucune preuve citée (facture, date code, puce…)");
  }

  // Très bas prix : peut être LA bonne affaire (vendeur pressé) ou un faux → on prévient, on ne bloque pas
  if (l.price <= s.maxPrice * 0.25) { score -= 5; reasons.push("💥 prix très bas : grosse affaire possible, vérifie bien"); }

  if (!description) { score -= 10; reasons.push("⚪ description non lue"); }
  else if (description.length < 40) { score -= 10; reasons.push("⚠️ description très courte"); }

  if (/neuf avec etiquette/.test(norm(l.state ?? ""))) { score -= 10; reasons.push("⚠️ « neuf avec étiquette » : les maisons de luxe n'en mettent pas"); }
  if (/(chine|china|aliexpress|dhgate|taobao)/.test(d)) { score -= 30; reasons.push("🚨 provenance Chine citée"); }

  score = Math.max(0, Math.min(100, score));
  return { ok: score >= 35, score, reasons, description };
}

// ---------- Discord ----------
async function sendToDiscord(payload: object, retry = 0): Promise<void> {
  if (!WEBHOOK) throw new Error("DISCORD_WEBHOOK_BAGS manquant");
  const r = await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (r.status === 429 && retry < 3) {
    const j: any = await r.json().catch(() => ({}));
    await sleep(((j.retry_after ?? 2) as number) * 1000 + 200);
    return sendToDiscord(payload, retry + 1);
  }
  if (!r.ok) throw new Error(`Discord HTTP ${r.status}`);
}

const CHECKLIST = [
  "Compare le prix aux ventes du même modèle (Vinted « vendus », Vestiaire)",
  "Demande les photos : étiquette intérieure, n° de série / date code, coutures",
  "Logo et gravures nets, zips et métal lourds, cuir qui sent le cuir",
  "Profil vendeur : évaluations, autres articles de luxe crédibles",
  "Paiement uniquement via Vinted, jamais en direct",
].map((x) => `• ${x}`).join("\n");

function embed(l: Listing, s: Search, c: Check) {
  const color = c.score >= 70 ? 0x2ecc71 : c.score >= 50 ? 0xf1c40f : 0xe67e22;
  const badge = c.score >= 70 ? "🟢 Bons signaux" : c.score >= 50 ? "🟡 À vérifier" : "🟠 Prudence";
  return {
    username: "Luxe Scanner",
    embeds: [{
      title: l.title.slice(0, 250),
      url: l.url,
      color,
      fields: [
        { name: "💰 Prix", value: `**${l.price} €**`, inline: true },
        { name: "🏷️ Marque", value: l.brand ?? "?", inline: true },
        { name: "🎯 Plafond", value: `${s.maxPrice} €`, inline: true },
        { name: `🔍 Annonce : ${badge} (${c.score}/100)`, value: c.reasons.join("\n").slice(0, 1000), inline: false },
        ...(l.state ? [{ name: "✨ État", value: l.state, inline: true }] : []),
        { name: "🔎 Recherche", value: s.name, inline: true },
        { name: "🧾 Avant d'acheter", value: CHECKLIST, inline: false },
      ],
      ...(l.image ? { image: { url: l.image } } : {}),
      footer: { text: "Analyse de l'annonce uniquement — l'authenticité se confirme sur le sac." },
      timestamp: new Date().toISOString(),
    }],
  };
}

// ---------- Boucle ----------
async function cycle(silent: boolean) {
  for (const s of config.searches) {
    try {
      const items = (await searchVinted(s)).reverse();
      for (const l of items) {
        if (seen.has(l.id)) continue;
        seen.add(l.id);
        if (silent) continue;
        const why = titleRefusal(l, s);
        if (why) { console.log(`🚫 ${why} | ${l.price}€ | ${l.title.slice(0, 70)}`); continue; }
        await sleep(2500);
        const c = analyse(l, s, await fetchDescription(l.url));
        if (!c.ok) { console.log(`🚫 ${c.reasons[0]} | ${l.price}€ | ${l.title.slice(0, 70)}`); continue; }
        await sendToDiscord(embed(l, s, c));
        console.log(`➡️ ${c.score}/100 | ${l.price}€ | ${l.title}`);
        await sleep(1200);
      }
    } catch (e) {
      console.error(`"${s.query}" :`, (e as Error).message);
    }
    await sleep(4000);
  }
  saveSeen();
}

if (process.argv[1]?.endsWith("bags.ts")) {
  console.log("👜 Luxe Scanner démarré");
  try {
    await sendToDiscord({ username: "Luxe Scanner", content: `✅ **Luxe Scanner en ligne** — ${config.searches.length} marques surveillées sur Vinted (marque vérifiée uniquement).` });
  } catch (e) { console.error("Discord :", (e as Error).message); }
  await cycle(true);
  console.log("✅ Premier tour terminé : les nouvelles annonces arrivent sur Discord");
  while (true) {
    await sleep(Math.max(config.intervalSeconds, 30) * 1000);
    await cycle(false);
  }
}
