/**
 * CGR cinéma – Scraper complet (Node.js ≥ 18)
 *
 * Étapes:
 * 1) GET /reserver/ → extrait les films (select#modresa_film ou select[name="modresa_film"]) 
 * 2) Pour chaque film → GET /reserver/ajax/?modresa_film=ID → jours disponibles (JSON)
 * 3) Pour chaque jour → GET /reserver/ajax/?modresa_film=ID&modresa_jour=YYYY-MM-DD → séances (JSON)
 * 4) Pour chaque séance → POST /reserver/ avec modresa_film, modresa_jour, modresa_seance → parse HTML → n° de salle (img sal_XX.png)
 * 5) Écrit un CSV des projections par salle
 *
 * ⚠️ À installer: npm i cheerio
 *
 * Exécution: node cgr_scraper.js
 */

import fs from "fs";
import { load as loadHTML } from "cheerio";

// =================== Config ===================
const CINEMA_SLUG = "lefrancais"; // ex: "blagnac", "lefrancais", etc.
const BASE = `https://achat.cgrcinemas.fr/${CINEMA_SLUG}`;
const RESERVER_URL = `${BASE}/reserver/`;
const AJAX_URL = `${BASE}/reserver/ajax/`;
const OUTPUT_CSV = `cgr_${CINEMA_SLUG}_programme.csv`;

// Delai entre requêtes pour rester fair-play
const DELAY_MS = 250;

// =================== Utils ===================
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CookieJar {
  constructor() {
    this.cookies = {};
  }
  setFrom(res) {
    const raw = res.headers.get("set-cookie");
    if (!raw) return;
    const arr = Array.isArray(raw) ? raw : [raw];
    for (const sc of arr) {
      // Split on ";" → first part is name=value
      const first = sc.split(";")[0];
      const eq = first.indexOf("=");
      if (eq === -1) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      // Overwrite same-name cookie
      this.cookies[name] = value;
    }
  }
  header() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  apply(headers) {
    const jar = this.header();
    if (jar) headers.set("Cookie", jar);
  }
}

async function fetchWithJar(url, { method = "GET", headers = {}, body } = {}, jar) {
  const h = new Headers({
    "User-Agent": UA,
    Accept: "*/*",
    ...headers,
  });
  if (jar) jar.apply(h);

  const res = await fetch(url, { method, headers: h, body, redirect: "follow" });
  if (jar) jar.setFrom(res);

  const ct = res.headers.get("content-type") || "";
  const isJson = ct.includes("application/json");
  const txt = await res.text();
  return { res, body: isJson ? safeJson(txt) : txt, contentType: ct };
}

function safeJson(txt) {
  try {
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (s.includes(";") || s.includes("\n") || s.includes('"')) {
    return '"' + s.replaceAll('"', '""') + '"';
  }
  return s;
}

function toCSV(rows, headers) {
  const lines = [];
  lines.push(headers.join(";"));
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(";"));
  }
  return lines.join("\n");
}

// Extraire films depuis la page HTML initiale
function parseFilmsFromHTML(html) {
  const $ = loadHTML(html);
  // Supporte id #modresa_film ET fallback sur name="modresa_film"
  const options = $("#modresa_film option, select[name=modresa_film] option");
  const films = [];
  options.each((_, el) => {
    const id = $(el).attr("value");
    const title = $(el).text().trim();
    if (id && id.trim() !== "") {
      films.push({ id: id.trim(), title });
    }
  });
  return films;
}

// Extraire n° salle depuis HTML (sal_06.png, class tag-SAL10, alt/title)
function extractSalle(html) {
    const $ = require("cheerio").load(html);

    const img = $('img[src*="/img/tags/sal_"], img[class*="tag-SAL"]').first();
    if (!img.length) return { salleNum: "", salleLabel: "" };

    // Priorité : src
    let src = img.attr("src") || "";
    let m = src.match(/sal_(\d{1,2})\.png/i);

    // Sinon : class
    if (!m) {
        const cls = img.attr("class") || "";
        m = cls.match(/tag-SAL(\d{1,2})/i);
    }

    // Sinon : alt / title
    if (!m) {
        m = (img.attr("alt") || "").match(/salle\s*(\d{1,2})/i);
    }
    if (!m) {
        m = (img.attr("title") || "").match(/salle\s*(\d{1,2})/i);
    }

    if (!m) return { salleNum: "", salleLabel: "" };

    const num = m[1].padStart(2, "0");
    return { salleNum: num, salleLabel: `Salle ${parseInt(num, 10)}` };
}

function parseSeanceKey(key) {
  // Exemple: "1756145400/VF/1240" → { ts:1756145400, version:"VF", seanceId:"1240" }
  const parts = String(key).split("/");
  const ts = Number(parts[0]);
  const version = parts[1] || "";
  const seanceId = parts[2] || "";
  return { ts, version, seanceId };
}

function parseSeanceLabel(label) {
  // Exemple: "20h10 - VF - 7.1" → { time:"20h10", version:"VF", audio:"7.1" }
  const chunks = String(label).split(" - ").map((s) => s.trim());
  const time = chunks[0] || "";
  const version = chunks[1] || "";
  const audio = chunks[2] || "";
  return { time, version, audio };
}

async function main() {
  const jar = new CookieJar();
  console.log(`→ Chargement films depuis ${RESERVER_URL}`);
  const first = await fetchWithJar(
    RESERVER_URL,
    { headers: { Referer: RESERVER_URL, Accept: "text/html" } },
    jar
  );

  const films = [parseFilmsFromHTML(first.body || "")[0]];
  if (!films.length) {
    console.error("Aucun film détecté — vérifie la page ou le sélecteur.");
    process.exit(1);
  }
  console.log(`✓ ${films.length} films détectés`);

  const results = [];

  for (const film of films) {
    await sleep(DELAY_MS);
    const urlDays = `${AJAX_URL}?modresa_film=${encodeURIComponent(film.id)}`;
    console.log(`→ Jours pour film ${film.title} (#${film.id})`);
    const rDays = await fetchWithJar(
      urlDays,
      { headers: { Referer: RESERVER_URL, Accept: "application/json" } },
      jar
    );

    const daysObj = rDays.body || {};
    const days = Object.keys(daysObj);
    if (!days.length) {
      console.log(`  (aucun jour disponible)`);
      continue;
    }

    for (const day of days) {
      await sleep(DELAY_MS);
      const urlSeances = `${AJAX_URL}?modresa_film=${encodeURIComponent(
        film.id
      )}&modresa_jour=${encodeURIComponent(day)}`;
      console.log(`  → Séances pour ${day}`);
      const rSeances = await fetchWithJar(
        urlSeances,
        { headers: { Referer: RESERVER_URL, Accept: "application/json" } },
        jar
      );

      const seancesObj = rSeances.body || {};
      const seanceKeys = Object.keys(seancesObj);
      if (!seanceKeys.length) {
        console.log("    (aucune séance)");
        continue;
      }

      for (const key of seanceKeys) {
        const label = seancesObj[key];
        const { ts, version: verFromKey, seanceId } = parseSeanceKey(key);
        const { time, version: verFromLbl, audio } = parseSeanceLabel(label);
        const version = verFromLbl || verFromKey;

        // POST final pour récupérer la page de réservation (et la salle)
        await sleep(DELAY_MS);
        const form = new URLSearchParams({
          modresa_film: film.id,
          modresa_jour: day,
          modresa_seance: seanceId,
          valid: "Continuer",
        }).toString();

        const rBook = await fetchWithJar(
          RESERVER_URL,
          {
            method: "POST",
            headers: {
              Referer: RESERVER_URL,
              "Content-Type": "application/x-www-form-urlencoded",
              Accept: "text/html",
            },
            body: form,
          },
          jar
        );

        const { salleNum, salleLabel } = extractSalle(rBook.body || "");

        results.push({
          cinema: CINEMA_SLUG,
          salle: salleNum || "",
          salle_label: salleLabel || "",
          film_id: film.id,
          film_titre: film.title,
          date: day,
          heure: time,
          version: version,
          audio: audio,
          seance_id: seanceId,
          ts,
        });
      }
    }
  }

  // Tri par salle puis date/heure
  results.sort((a, b) => {
    const s = (a.salle || "").localeCompare(b.salle || "");
    if (s !== 0) return s;
    const d = (a.date || "").localeCompare(b.date || "");
    if (d !== 0) return d;
    return (a.heure || "").localeCompare(b.heure || "");
  });

  // Écriture CSV
  const headers = [
    "cinema",
    "salle",
    "salle_label",
    "film_id",
    "film_titre",
    "date",
    "heure",
    "version",
    "audio",
    "seance_id",
    "ts",
  ];
  const csv = toCSV(results, headers);
  fs.writeFileSync(OUTPUT_CSV, csv, "utf8");
  console.log(`\n✓ CSV écrit → ${OUTPUT_CSV} (${results.length} lignes)`);
}

// Lancer
main().catch((err) => {
  console.error("Erreur:", err);
  process.exit(1);
});
