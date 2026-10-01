export const config = { maxDuration: 30 };

// Serverless proxy pro metadata mapových služeb (GetCapabilities, ArcGIS ?f=json),
// které nevracejí CORS hlavičky. Dlaždice (obrázky) se tahají přímo, ty CORS nepotřebují.
const ALLOWED_HOSTS = new Set([
  "heis.vuv.cz",
  "gis.nature.cz",
  "mapy.geology.cz",
  "ags.cuzk.gov.cz",
  "ags.cuzk.cz",
  "pkr.kr-ustecky.cz",
]);
const MAX_BYTES = 5 * 1024 * 1024;

export default async function handler(req, res) {
  let target;
  try {
    target = new URL(String(req.query.url || ""));
  } catch {
    return res.status(400).json({ error: "Chybí nebo je neplatný parametr url" });
  }
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    return res.status(403).json({ error: `Host ${target.hostname} není povolený` });
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent": "krizova-mapa-ustecky-kraj (Vercel proxy)",
        // SyPOS (PKR) vrací data jen pro AJAX požadavky, jinak přesměruje na HTML stránku
        ...(target.hostname === "pkr.kr-ustecky.cz" ? { "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/javascript, */*" } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());

    // diagnostika: /api/proxy?debug=1&url=... vrátí, co přesně server odpověděl
    if (req.query.debug) {
      return res.status(200).json({
        requested: target.href,
        status: upstream.status,
        redirected: upstream.redirected,
        finalUrl: upstream.url,
        contentType: upstream.headers.get("content-type"),
        bytes: buf.length,
        region: process.env.VERCEL_REGION || null,
        bodyStart: buf.subarray(0, 1500).toString("utf8"),
      });
    }
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: "Odpověď je příliš velká" });

    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Access-Control-Allow-Origin", "*");
    // metadata služeb se mění zřídka – cachujeme na CDN Vercelu
    // PKR obsahuje i aktuální události – krátká cache; metadata ostatních služeb na den
    const ttl = target.hostname === "pkr.kr-ustecky.cz" ? "s-maxage=300, stale-while-revalidate=600" : "s-maxage=86400, stale-while-revalidate=604800";
    if (upstream.ok) res.setHeader("Cache-Control", "public, " + ttl);
    return res.status(upstream.status).send(buf);
  } catch (e) {
    return res.status(502).json({ error: "Služba neodpovídá: " + (e.message || e), cause: String(e.cause?.code || e.cause?.message || ""), region: process.env.VERCEL_REGION || null });
  }
}