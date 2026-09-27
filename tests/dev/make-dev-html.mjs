// YEREL GELİŞTİRME: index.html'den index.dev.html üretir (git'e GİTMEZ, .gitignore'da).
// Tek fark: CSP connect-src'ye emülatör adresleri eklenir. Canlı index.html'e dokunulmaz.
// Kullanım: node tests/dev/make-dev-html.mjs  →  http://localhost:8000/index.dev.html?emu
import { readFileSync, writeFileSync } from "node:fs";
const root = new URL("../../", import.meta.url);
const src = readFileSync(new URL("index.html", root), "utf8");
const out = src.replace(/connect-src 'self'/, "connect-src 'self' http://127.0.0.1:9099 http://127.0.0.1:8080");
if (out === src) throw new Error("CSP connect-src bulunamadı — index.html değişmiş olabilir");
writeFileSync(new URL("index.dev.html", root), "<!-- OTOMATİK ÜRETİLDİ (tests/dev/make-dev-html.mjs) — YALNIZ YEREL TEST -->\n" + out);
console.log("index.dev.html üretildi (emülatör izinli CSP).");
