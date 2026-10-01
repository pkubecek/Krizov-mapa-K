// Serverless proxy pro metadata mapových služeb (GetCapabilities, ArcGIS ?f=json),
// které nevracejí CORS hlavičky. Dlaždice (obrázky) se tahají přímo, ty CORS nepotřebují.
const ALLOWED_HOSTS = new Set([
  "heis.vuv.cz",
  "gis.nature.cz",
  "mapy.geology.cz",
  "ags.cuzk.gov.cz",
  "ags.cuzk.cz",
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
      headers: { "User-Agent": "krizova-mapa-ustecky-kraj (Vercel proxy)" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: "Odpověď je příliš velká" });

    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Access-Control-Allow-Origin", "*");
    // metadata služeb se mění zřídka – cachujeme na CDN Vercelu
    if (upstream.ok) res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    return res.status(upstream.status).send(buf);
  } catch (e) {
    return res.status(502).json({ error: "Služba neodpovídá: " + (e.message || e) });
  }
}
