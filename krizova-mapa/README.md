# Krizová mapa Ústeckého kraje

Statická webová mapa (Leaflet) se serverless proxy pro metadata mapových služeb.

## Struktura

```
index.html      stránka
styles.css      vzhled
app.js          logika mapy (vrstvy, Overpass, WMS/ArcGIS, ořez na kraj)
api/proxy.js    Vercel funkce – obchází chybějící CORS u GetCapabilities / ArcGIS ?f=json
vercel.json     konfigurace (hlavičky, limit funkce)
```

Žádný build krok není potřeba – Vercel nasadí statické soubory a funkci v `api/`.

## Nasazení

**Přes GitHub:** pushni repozitář, na vercel.com → Add New → Project → Import.
Framework Preset: *Other*, Build Command a Output Directory nech prázdné.

**Přes CLI:**

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # produkce
```

## Lokální vývoj

```bash
vercel dev      # http://localhost:3000, včetně /api/proxy
```

Bez Vercel CLI stačí `python -m http.server`, jen nepoběží proxy
(služby bez CORS pak ukážou „Nedostupné“).

## Zdroje dat

- Vektorová data: OpenStreetMap přes Overpass API (živě, ořez na CZ-42)
- Ortofoto: ČÚZK (WMS)
- Záplavová území: VÚV TGM (WMS)
- Chráněná území: AOPK ČR (WMS)
- Svahové nestability, poddolovaná území: ČGS (ArcGIS REST)

Proxy povoluje jen hosty v `ALLOWED_HOSTS` v `api/proxy.js` – při přidání nové služby je potřeba ji tam doplnit.
