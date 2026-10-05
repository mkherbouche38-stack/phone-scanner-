import { writeFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CAT = "https://www.vinted.fr/catalog?search_text=iphone%20xr&order=newest_first&price_to=100";
const jar = new Map<string, string>();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const names = () => [...jar.keys()].join(",");
const abs = (l: string) => new URL(l, "https://www.vinted.fr").toString();
const count = (t: string) => (t.match(/\/items\/\d{6,}/g) ?? []).length;
const store = (res: Response) => {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
};
const H = (extra: Record<string, string> = {}): Record<string, string> => ({
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "fr-FR,fr;q=0.9",
  ...(jar.size ? { cookie: cookieHeader() } : {}),
  ...extra,
});

let r = await fetch(CAT, { headers: { "user-agent": UA, accept: "text/html", "accept-language": "fr-FR,fr;q=0.9" }, redirect: "manual" });
let t = await r.text();
console.log("A sans cookie :", r.status, r.headers.get("location")?.slice(0, 50) ?? "-", "| annonces:", count(t));

r = await fetch("https://www.vinted.fr/", { headers: H(), redirect: "manual" });
store(r);
await r.text();
console.log("B accueil :", r.status, "| cookies:", names());

r = await fetch(CAT, { headers: H(), redirect: "manual" });
store(r);
t = await r.text();
const loc = r.headers.get("location");
console.log("C catalogue :", r.status, loc?.slice(0, 50) ?? "-", "| annonces:", count(t));

let endpoint = "/web/api/auth/refresh";
if (loc) {
  r = await fetch(abs(loc), { headers: H(), redirect: "manual" });
  store(r);
  t = await r.text();
  writeFileSync("session.html", t);
  console.log("D page session :", r.status, "| taille:", t.length);
  const srcs = [...new Set(t.match(/https:\/\/[^"']+\/_next\/static\/chunks\/[^"']+\.js/g) ?? [])].slice(0, 25);
  const found = new Set<string>();
  for (const s of srcs) {
    try {
      const js = await (await fetch(s)).text();
      for (const m of js.matchAll(/["'`](\/[A-Za-z0-9_\-\/.]*refresh[A-Za-z0-9_\-\/.]*)["'`]/g)) found.add(m[1]);
    } catch {}
  }
  console.log("refresh dans le JS :", [...found].slice(0, 6).join(" ") || "-");
  const first = [...found].find((f) => f.includes("api"));
  if (first) endpoint = first;
}

r = await fetch(abs(endpoint), {
  method: "POST",
  headers: H({ accept: "application/json", "content-type": "application/json", origin: "https://www.vinted.fr", referer: "https://www.vinted.fr/" }),
  body: "{}",
  redirect: "manual",
});
store(r);
await r.text();
console.log("E refresh", endpoint, ":", r.status, "| cookies:", names());

r = await fetch(CAT, { headers: H() });
t = await r.text();
console.log("F final :", r.status, r.url.slice(0, 50), "| annonces:", count(t), "| taille:", t.length);
