/**
 * CGR cinéma – Scraper complet (Node.js ≥ 18)
 *
 * Récupère :
 * - Tous les films du cinéma
 * - Les jours disponibles pour chaque film
 * - Les séances de chaque jour
 * - La salle de projection pour chaque séance
 * - L'URL de réservation de la séance
 *
 * Exporte le tout dans un CSV : salle → film → date → heure → réservation
 */

import fs from "fs";
import {load as loadHTML} from "cheerio";
import fetch from "node-fetch";

// =================== Config ===================
const CINEMA_SLUG = process.env.CINEMA_SLUG || "lefrancais"; // ex: "villenave", "lefrancais"
const BASE = `https://achat.cgrcinemas.fr/${CINEMA_SLUG}`;
const RESERVER_URL = `${BASE}/reserver/`;
const AJAX_URL = `${BASE}/reserver/ajax/`;
const OUTPUT_CSV = `cgr_${CINEMA_SLUG}_programme.csv`;
const DELAY_MS = 250; // délai entre requêtes pour rester fair-play

const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// Cookie jar simple
export class CookieJar {
    constructor() {
        this.cookies = {};
    }

    setFrom(res) {
        const raw = res.headers.get("set-cookie");
        if (!raw) return;
        const arr = Array.isArray(raw) ? raw : [raw];
        for (const sc of arr) {
            const first = sc.split(";")[0];
            const eq = first.indexOf("=");
            if (eq === -1) continue;
            const name = first.slice(0, eq).trim();
            const value = first.slice(eq + 1).trim();
            this.cookies[name] = value;
        }
    }

    apply(headers) {
        const jar = Object.entries(this.cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
        if (jar) headers.set("Cookie", jar);
    }
}

export async function fetchWithJar(
    url,
    {method = "GET", headers = {}, body} = {},
    jar
) {
    const h = new Headers({"User-Agent": UA, Accept: "*/*", ...headers});
    if (jar) jar.apply(h);
    const res = await fetch(url, {method, headers: h, body, redirect: "follow"});
    if (jar) jar.setFrom(res);
    const ct = res.headers.get("content-type") || "";
    const isJson = ct.includes("application/json");
    const txt = await res.text();
    return {res, body: isJson ? JSON.parse(txt) : txt, contentType: ct};
}

// =================== CSV Export ===================
function toCsvRow(values) {
    return values.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
}

function saveCSV(filename, rows) {
    if (!rows || rows.length === 0) return;
    const headers = Object.keys(rows[0]);
    const lines = [toCsvRow(headers)];
    for (const row of rows) {
        lines.push(toCsvRow(headers.map(h => row[h])));
    }
    fs.writeFileSync(filename, lines.join("\n"), "utf8");
}

// =================== Extraction ===================
function parseFilmsFromHTML(html) {
    const $ = loadHTML(html);
    const options = $("#modresa_film option, select[name=modresa_film] option");
    const films = [];
    options.each((_, el) => {
        const id = $(el).attr("value");
        const title = $(el).text().trim();
        if (id && id.trim() !== "") films.push({id: id.trim(), title});
    });
    return films;
}

function extractSalle(html) {
    const $ = loadHTML(html);
    const img = $('img[src*="/img/tags/sal_"], img[class*="tag-SAL"], img[class="tag tag-ICEBYCGR"]').first();
    if (!img.length) return {salleNum: "", salleLabel: ""};

    const src = img.attr("src") || "";
    const cls = img.attr("class") || "";
    const alt = img.attr("alt") || "";
    const title = img.attr("title") || "";

    // 1️⃣ Vérifie salle numérique classique (sal_XX.png)
    let m = src.match(/sal_(\d{1,2})\.png/i);
    if (!m) m = cls.match(/tag-SAL(\d{1,2})/i);
    if (!m) m = alt.match(/salle\s*(\d{1,2})/i);
    if (!m) m = title.match(/salle\s*(\d{1,2})/i);
    if (m) {
        const num = m[1].padStart(2, "0");
        return {salleNum: num, salleLabel: `Salle ${parseInt(num, 10)}`};
    }

    // 2️⃣ Vérifie salle ICE
    if (cls === "tag tag-ICEBYCGR") {
        return {salleNum: "ICE", salleLabel: "Salle ICE"};
    }

    // 3️⃣ Si aucune salle détectée
    return {salleNum: "", salleLabel: ""};
}

function extractReservationUrl(html) {
    const $ = loadHTML(html);
    const form = $("#ffselplace").first();
    return form ? form.attr("action") || "" : "";
}

function parseSeanceKey(key) {
    const parts = String(key).split("/");
    return {ts: Number(parts[0]), version: parts[1] || "", seanceId: parts[2] || ""};
}

function parseSeanceLabel(label) {
    const chunks = String(label).split(" - ").map((s) => s.trim());
    return {time: chunks[0] || "", version: chunks[1] || "", audio: chunks[2] || ""};
}

// =================== Main ===================
async function main() {
    const jar = new CookieJar();
    console.log(`→ Loading films from ${RESERVER_URL}`);
    const first = await fetchWithJar(
        RESERVER_URL,
        {headers: {Referer: RESERVER_URL, Accept: "text/html"}},
        jar
    );
    const films = [parseFilmsFromHTML(first.body || "")[1]];
    if (!films.length) {
        console.error("No films found");
        process.exit(1);
    }
    console.log(`✓ Found ${films.length} films\n`);

    const results = [];

    for (const film of films) {
        console.log(`🎬 Film: ${film.title} (${film.id})`);
        await sleep(DELAY_MS);

        const urlDays = `${AJAX_URL}?modresa_film=${encodeURIComponent(film.id)}`;
        const rDays = await fetchWithJar(
            urlDays,
            {headers: {Referer: RESERVER_URL, Accept: "application/json"}},
            jar
        );
        const daysObj = rDays.body || {};
        const days = Object.keys(daysObj);
        console.log(`   → ${days.length} jour(s) trouvé(s)`);
        if (!days.length) continue;

        for (const day of days) {
            console.log(`   📅 Jour: ${day}`);
            await sleep(DELAY_MS);

            const urlSeances = `${AJAX_URL}?modresa_film=${encodeURIComponent(film.id)}&modresa_jour=${encodeURIComponent(day)}`;
            const rSeances = await fetchWithJar(
                urlSeances,
                {headers: {Referer: RESERVER_URL, Accept: "application/json"}},
                jar
            );
            const seancesObj = rSeances.body || {};
            const seanceKeys = Object.keys(seancesObj);
            console.log(`      → ${seanceKeys.length} séance(s) trouvée(s)`);
            if (!seanceKeys.length) continue;

            for (const key of seanceKeys) {
                const label = seancesObj[key];
                const {ts, version: verFromKey, seanceId} = parseSeanceKey(key);
                const {time, version: verFromLbl, audio} = parseSeanceLabel(label);
                const version = verFromLbl || verFromKey;

                console.log(`      ⏰ Séance: ${time} (${version}, ${audio || "VO/FR"})`);

                await sleep(DELAY_MS);
                const form = new URLSearchParams({
                    modresa_film: film.id,
                    modresa_jour: day,
                    modresa_seance: key,
                }).toString();
                const rBook = await fetchWithJar(
                    RESERVER_URL,
                    {
                        method: "POST",
                        headers: {Referer: RESERVER_URL, "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html"},
                        body: form,
                    },
                    jar
                );

                const {salleNum, salleLabel} = extractSalle(rBook.body || "");
                const reservationUrl = extractReservationUrl(rBook.body || "");
                console.log(`         🎟️ Salle: ${salleLabel || "??"} | Réservation: ${reservationUrl ? "OK" : "❌"}`);

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
                    reservation_url: reservationUrl,
                });
            }
        }
        console.log("");
    }

    results.sort(
        (a, b) => (a.salle || "").localeCompare(b.salle || "") ||
            (a.date || "").localeCompare(b.date || "") ||
            (a.heure || "").localeCompare(b.heure || "")
    );

    saveCSV(OUTPUT_CSV, results);
    console.log(`\n✓ CSV written → ${OUTPUT_CSV} (${results.length} lines)`);
}

main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
});
