import { writeFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const home = await fetch("https://www.vinted.fr/", { headers: { "user-agent": UA, "accept-language": "fr-FR,fr;q=0.9" } });
const cookie = home.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const r = await fetch("https://www.vinted.fr/catalog?search_text=iphone%20xr&order=newest_first&price_to=100", {
  headers: {
    "user-agent": UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "fr-FR,fr;q=0.9",
    cookie,
  },
});
const html = await r.text();
console.log("statut :", r.status, "| taille :", html.length);
console.log("adresse finale :", r.url);
console.log("titre :", (html.match(/<title>([^<]*)/) ?? [])[1]);
console.log("liens /items/ :", (html.match(/\/items\/\d+/g) ?? []).length);
console.log("liens echappes :", (html.match(/items\\\/\d+/g) ?? []).length);
console.log("mot iphone :", (html.match(/iphone/gi) ?? []).length);
console.log("debut :", html.slice(0, 250).replace(/\s+/g, " "));
writeFileSync("page.html", html);
