"use strict";
/* ================= konfigurace ================= */
/* jen výchozí pohled, než se načte skutečná hranice kraje – data se podle něj neomezují */
const KRAJ_BOUNDS = [[50.15, 12.95], [51.06, 14.65]];
const AREA = 'area["ISO3166-2"="CZ-42"]["admin_level"="6"]->.k;';
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
const MAJOR_RIVERS = /^(Labe|Ohře|Bílina|Ploučnice|Kamenice|Chomutovka|Mandava|Křinice|Liboc|Blšanka)$/;

const Q = {
  rivers:  { body:'way["waterway"="river"](area.k);', geom:"line" },
  canals:  { body:'way["waterway"="canal"](area.k);', geom:"line" },
  res:     { body:'way["water"="reservoir"](area.k);relation["water"="reservoir"](area.k);way["landuse"="reservoir"](area.k);relation["landuse"="reservoir"](area.k);', geom:"area" },
  dams:    { body:'way["waterway"="dam"]["name"](area.k);node["waterway"="dam"]["name"](area.k);', geom:"point" },
  prot:    { body:'relation["boundary"~"^(protected_area|national_park)$"]["protect_class"!~"^9"](area.k);way["boundary"="protected_area"]["protect_class"!~"^9"](area.k);relation["leisure"="nature_reserve"](area.k);way["leisure"="nature_reserve"](area.k);', geom:"area" },
  plants:  { body:'nwr["power"="plant"](area.k);', geom:"point" },
  subst:   { body:'nwr["power"="substation"]["voltage"~"110000|220000|400000"](area.k);', geom:"point" },
  vvn:     { body:'way["power"="line"]["voltage"~"110000|220000|400000"](area.k);', geom:"line" },
  vn:      { body:'way["power"~"^(line|minor_line)$"]["voltage"~"^(6000|10000|22000|35000)(;|$)"](area.k);', geom:"line" },
  water:   { body:'nwr["man_made"~"^(water_works|wastewater_plant)$"](area.k);', geom:"point" },
  chem:    { body:'nwr["industrial"~"^(chemical|refinery)$"](area.k);', geom:"point" },
  fire:    { body:'nwr["amenity"="fire_station"](area.k);', geom:"point" },
  police:  { body:'nwr["amenity"="police"](area.k);', geom:"point" },
  hosp:    { body:'nwr["amenity"="hospital"](area.k);', geom:"point" },
  zzs:     { body:'nwr["emergency"="ambulance_station"](area.k);', geom:"point" }
};

/* pomocné klasifikace */
const vmax = t => Math.max(0, ...String(t.voltage || "").split(";").map(v => parseInt(v, 10) || 0));
const isHeat = t => !!(t["plant:output:hot_water"] || t["plant:output:steam"] || t["plant:output:heat"] || /tepl[áa]rn|výtopn/i.test(t.name || ""));
const mw = s => { if (!s) return 0; const m = String(s).replace(",", ".").match(/([\d.]+)\s*(kW|MW|GW)?/i); if (!m) return 0;
  const v = parseFloat(m[1]); const u = (m[2] || "MW").toUpperCase(); return u === "KW" ? v / 1000 : u === "GW" ? v * 1000 : v; };
const isElec = t => {
  if (t["plant:source"] === "solar" && mw(t["plant:output:electricity"]) < 5) return false; // malé FVE vynecháme
  return !!t["plant:output:electricity"] || !isHeat(t);
};
const isHZS = t => /hasičský záchranný sbor|\bHZS\b/i.test((t.operator || "") + " " + (t.name || ""));
const isMP = t => /městsk|obecní/i.test((t.operator || "") + " " + (t.name || "") + " " + (t["police:type"] || ""));
function protCat(t) {
  const s = [t.protection_title, t.name, t.designation, t["protection_title:cs"]].filter(Boolean).join(" ").toLowerCase();
  if (/národní park|national park/.test(s) || t.boundary === "national_park" || t.protect_class === "2") return "np";
  if (/chráněná krajinná|\bchko\b/.test(s)) return "chko";
  if (/přírodní park/.test(s)) return "prp";
  if (/rezervace|památka|reserve/.test(s) || t.leisure === "nature_reserve" || /^(1a|1b|1|3|4)$/.test(t.protect_class || "")) return "rez";
  return null;
}

/* symboly */
const mkHtml = (shape, c, glyph = "", s = 20, fg = "#fff") =>
  `<span class="mk ${shape}" style="--c:${c};--s:${s}px;--fg:${fg}">${shape === "di" ? `<span>${glyph}</span>` : glyph}</span>`;

/* ================= definice vrstev ================= */
const GROUPS = [
  { title: "Vodní toky a nádrže", layers: [
    { id:"rivers", q:"rivers", label:"Řeky", note:"Labe a Ohře zvýrazněné", sw:{line:"#2B7BB9"},
      style: t => ({ color:"#2B7BB9", weight: /^(Labe|Ohře)$/.test(t.name||"") ? 5 : MAJOR_RIVERS.test(t.name||"") ? 3 : 1.6, opacity:.9 }) },
    { id:"canals", q:"canals", label:"Kanály", sw:{line:"#2B7BB9", dash:true},
      style: () => ({ color:"#2B7BB9", weight:2.2, dashArray:"5 4" }) },
    { id:"res", q:"res", label:"Vodní nádrže", note:"plocha nad 5 ha", sw:{area:"#5AA7DA", c:"#1F5F94"},
      filter: (t, f) => f.ha >= 5, style: () => ({ color:"#1F5F94", weight:1.2, fillColor:"#5AA7DA", fillOpacity:.6 }) },
    { id:"dams", q:"dams", label:"Hráze a přehrady", note:"jen pojmenované", icon: mkHtml("sq","#1F5F94","≡",16) }
  ]},
  { title: "Chráněná území", layers: [
    { id:"np", q:"prot", label:"Národní park", filter: t => protCat(t) === "np", sw:{area:"rgba(46,125,50,.25)", c:"#1B5E20"},
      style: () => ({ color:"#1B5E20", weight:2.2, fillColor:"#2E7D32", fillOpacity:.18 }) },
    { id:"chko", q:"prot", label:"CHKO", filter: t => protCat(t) === "chko", sw:{area:"rgba(124,179,66,.25)", c:"#558B2F"},
      style: () => ({ color:"#558B2F", weight:1.8, dashArray:"7 4", fillColor:"#7CB342", fillOpacity:.14 }) },
    { id:"prp", q:"prot", label:"Přírodní parky", filter: t => protCat(t) === "prp", sw:{area:"rgba(192,202,51,.25)", c:"#9E9D24"},
      style: () => ({ color:"#8C8A1E", weight:1.5, dashArray:"2 5", fillColor:"#C0CA33", fillOpacity:.12 }) },
    { id:"rez", q:"prot", label:"Rezervace a památky", note:"NPR, PR, NPP, PP", filter: t => protCat(t) === "rez", sw:{area:"rgba(0,137,123,.4)", c:"#00695C"},
      style: () => ({ color:"#00695C", weight:1.2, fillColor:"#00897B", fillOpacity:.38 }) }
  ]},
  { title: "Kritická infrastruktura", layers: [
    { id:"elek", q:"plants", label:"Elektrárny", note:"bez FVE pod 5 MW", filter: isElec, icon: mkHtml("di","#F2C200","E",17,"#1A1F2B") },
    { id:"tepl", q:"plants", label:"Teplárny a výtopny", filter: isHeat, icon: mkHtml("di","#D84315","T",17) },
    { id:"subst", q:"subst", label:"Rozvodny 110–400 kV", icon: mkHtml("sq","#6A3FA0","R",16) },
    { id:"vvn", q:"vvn", label:"Vedení VVN a ZVN", note:"400 / 220 / 110 kV", sw:{line:"#D0312D"},
      style: t => { const v = vmax(t); return v >= 400000 ? { color:"#7F1414", weight:3.4 } : v >= 220000 ? { color:"#D0312D", weight:2.7 } : { color:"#E8792B", weight:2 }; } },
    { id:"vn", q:"vn", label:"Vedení VN 6–35 kV", note:"větší objem dat", sw:{line:"#7A6F9B"},
      style: () => ({ color:"#7A6F9B", weight:1, opacity:.75 }) },
    { id:"water", q:"water", label:"Úpravny vod a ČOV", icon: mkHtml("ci","#00838F","V",16) },
    { id:"chem", q:"chem", label:"Chemický a petrochemický průmysl", icon: mkHtml("tri","#AD1457","!",20) }
  ]},
  { title: "Složky IZS", layers: [
    { id:"hzs", q:"fire", label:"Stanice HZS", filter: isHZS, icon: mkHtml("sq","#C62828","H",20), on:true },
    { id:"sdh", q:"fire", label:"Hasičské zbrojnice SDH", filter: t => !isHZS(t), icon: mkHtml("ci","#E57373","",11) },
    { id:"pcr", q:"police", label:"Policie ČR", filter: t => !isMP(t), icon: mkHtml("sq","#1D3C8F","P",20), on:true },
    { id:"mp", q:"police", label:"Městská policie", filter: isMP, icon: mkHtml("ci","#5C7BD9","M",15) },
    { id:"hosp", q:"hosp", label:"Nemocnice", icon: mkHtml("sq","#fff","+",20,"#C62828"), on:true },
    { id:"zzs", q:"zzs", label:"Výjezdová stanoviště ZZS", icon: mkHtml("sq","#2E7D32","+",17) }
  ]}
];

const WMS = [
  { id:"zaplavy", label:"Záplavová území", note:"VÚV TGM – Q5, Q20, Q100, Q500, aktivní zóny",
    url:"https://heis.vuv.cz/data/webmap/wms.dll", pick:/q100|aktivn/i, on:true },
  { id:"aopk", label:"Chráněná území (AOPK)", note:"oficiální hranice ZCHÚ",
    url:"https://gis.nature.cz/arcgis/services/UzemniOchrana/ChranUzemi/MapServer/WMSServer", pick:/velkopl|maloplo|přírodní park/i },
  { id:"sesuvy", label:"Svahové nestability (ČGS)", note:"sesuvy, proudy, řícení – registr ČGS", type:"arcgis",
    url:"https://mapy.geology.cz/arcgis/rest/services/Geohazardy/svahove_deformace/MapServer", pick:/./ },
  { id:"poddol", label:"Poddolovaná území (ČGS)", type:"arcgis",
    url:"https://mapy.geology.cz/arcgis/rest/services/Dulni_Dila/poddolovana_uzemi/MapServer", pick:/./ }
];

/* ================= mapa ================= */
const map = L.map("map", { preferCanvas:true, zoomControl:true }).fitBounds(KRAJ_BOUNDS);
const renderer = L.canvas({ padding:.5, tolerance:4 });
const BASES = {
  osm:  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom:19, referrerPolicy:"strict-origin-when-cross-origin",
          attribution:'© přispěvatelé OpenStreetMap' }),
  orto: L.tileLayer.wms("https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer", {
    layers:"0", format:"image/jpeg", transparent:false, version:"1.3.0", tileSize:512, maxZoom:20, attribution:"Ortofoto © ČÚZK" })
};
/* OSM servery (tile.openstreetmap.org) odmítají požadavky bez hlavičky Referer (HTTP 403),
   což nastává hlavně při otevření souboru přes file://. Pak přepneme na dlaždice CARTO Voyager
   (stejná data OSM, jiný styl, bez požadavku na Referer). */
const OSM_FALLBACK = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  { maxZoom:19, subdomains:"abcd", attribution:'© přispěvatelé OpenStreetMap, © CARTO' });
function useOsmFallback(reason) {
  if (BASES.osm === OSM_FALLBACK) return;
  console.warn("[Podklad] OSM dlaždice nedostupné (" + reason + "), přepínám na CARTO Voyager.");
  const wasActive = map.hasLayer(BASES.osm);
  if (wasActive) map.removeLayer(BASES.osm);
  BASES.osm = OSM_FALLBACK;
  if (wasActive) { base = OSM_FALLBACK.addTo(map); base.bringToBack(); }
}
if (location.protocol === "file:") BASES.osm = OSM_FALLBACK;
else {
  let ok = 0, bad = 0;
  BASES.osm.on("tileload", () => ok++);
  BASES.osm.on("tileerror", () => { if (++bad >= 4 && ok === 0) useOsmFallback("HTTP 403 / blokováno"); });
}
let base = BASES.osm.addTo(map);
document.querySelectorAll(".base button").forEach(b => b.addEventListener("click", () => {
  map.removeLayer(base); base = BASES[b.dataset.base].addTo(map); base.bringToBack();
  document.querySelectorAll(".base button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
}));

/* Rastrové služby (WMS/ArcGIS) se ořezávají CSS clip-path podle polygonu hranice kraje.
   Do načtení hranice je pane skrytý, aby se nic neukázalo mimo kraj. */
const wmsPane = map.createPane("wms");
wmsPane.style.zIndex = 350;
wmsPane.style.visibility = "hidden";
let clipRings = null;
function clipPath(toPt) {
  return 'path(evenodd, "' + clipRings.map(r => r.map((ll, i) => {
    const p = toPt(ll); return (i ? "L" : "M") + p.x.toFixed(1) + " " + p.y.toFixed(1);
  }).join("") + "Z").join("") + '")';
}
function updateClip(e) {
  if (!clipRings) return;
  const toPt = e && e.zoom != null
    ? ll => map._latLngToNewLayerPoint(L.latLng(ll), e.zoom, e.center)
    : ll => map.latLngToLayerPoint(ll);
  wmsPane.style.clipPath = clipPath(toPt);
}
map.on("zoomanim", updateClip);
map.on("zoomend viewreset resize", () => updateClip());
map.createPane("areas").style.zIndex = 380;
map.createPane("mask").style.zIndex = 390;
map.getPane("mask").style.pointerEvents = "none";

const Home = L.Control.extend({ options:{ position:"topleft" }, onAdd() {
  const d = L.DomUtil.create("div", "leaflet-bar leaflet-control homebtn");
  d.innerHTML = '<a href="#" title="Zobrazit celý kraj" role="button" aria-label="Zobrazit celý kraj">⌂</a>';
  L.DomEvent.on(d, "click", e => { L.DomEvent.preventDefault(e); map.fitBounds(krajBounds || KRAJ_BOUNDS); });
  return d; } });
new Home().addTo(map);
let krajBounds = null;

/* ================= Overpass ================= */
/* fronta se 2 souběžnými dotazy (overpass-api.de dává 2 sloty na IP) */
const MAX_PARALLEL = 2; let running = 0; const waiting = [];
function enqueue(fn) {
  return new Promise((res, rej) => {
    waiting.push({ fn, res, rej }); pump();
  });
}
function pump() {
  while (running < MAX_PARALLEL && waiting.length) {
    const { fn, res, rej } = waiting.shift(); running++;
    Promise.resolve().then(fn).then(res, rej).finally(() => { running--; pump(); });
  }
}
const dataCache = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const ep of OVERPASS) {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 120000);
      try {
        const r = await fetch(ep, { method:"POST", body:"data=" + encodeURIComponent(query),
          headers:{ "Content-Type":"application/x-www-form-urlencoded" }, signal:ctl.signal });
        if (!r.ok) {
          const txt = (await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
          throw new Error(`${new URL(ep).host}: HTTP ${r.status}${txt ? " – " + txt : ""}`);
        }
        const json = await r.json();
        /* Overpass při timeoutu/přetížení vrací 200 s prázdnými daty a poznámkou "remark" */
        if (json.remark && /error|timed out|out of memory/i.test(json.remark))
          throw new Error(`${new URL(ep).host}: ${json.remark}`);
        return json;
      } catch (e) {
        lastErr = e.name === "AbortError" ? new Error(`${new URL(ep).host}: vypršel čas`) : e;
        console.warn("[Overpass]", lastErr.message);
      } finally { clearTimeout(tm); }
    }
    await sleep(4000);
  }
  throw lastErr || new Error("Overpass nedostupný");
}
function loadQuery(key, onQueued) {
  if (dataCache.has(key)) return dataCache.get(key);
  const def = Q[key];
  const out = def.geom === "point" ? "out tags center;" : "out geom;";
  const p = (async () => {
    const ck = "kmuk3:" + key;
    try { const c = sessionStorage.getItem(ck); if (c) return JSON.parse(c); } catch (e) {}
    const json = await enqueue(() => { onQueued && onQueued(); return overpass(`[out:json][timeout:110];${AREA}(${def.body});${out}`); });
    let feats = buildFeatures(json.elements || [], def.geom);
    const K = await krajReady;
    if (K) feats = clipFeatures(feats, K, def.geom);
    /* prázdný výsledek necachujeme – může jít o výpadek */
    if (feats.length) try { sessionStorage.setItem(ck, JSON.stringify(feats)); } catch (e) {}
    return feats;
  })();
  p.catch(() => dataCache.delete(key));
  dataCache.set(key, p);
  return p;
}

/* Overpass JSON -> jednoduché prvky {t, id, kind, ll | lines | rings, ha} */
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
function joinRings(segs) {
  const pool = segs.filter(s => s.length > 1).map(s => s.slice()); const rings = [];
  while (pool.length) {
    let ring = pool.shift(), changed = true;
    while (!same(ring[0], ring[ring.length - 1]) && changed) {
      changed = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i], end = ring[ring.length - 1];
        if (same(s[0], end)) ring = ring.concat(s.slice(1));
        else if (same(s[s.length - 1], end)) ring = ring.concat(s.slice(0, -1).reverse());
        else if (same(s[s.length - 1], ring[0])) ring = s.slice(0, -1).concat(ring);
        else if (same(s[0], ring[0])) ring = s.slice(1).reverse().concat(ring);
        else continue;
        pool.splice(i, 1); changed = true; break;
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}
function ringHa(r) {
  if (r.length < 3) return 0;
  const lat0 = r[0][0] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110540; let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][1] * kx) * (r[i][0] * ky) - (r[i][1] * kx) * (r[j][0] * ky);
  return Math.abs(a / 2) / 10000;
}
const geomLL = g => (g || []).filter(Boolean).map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6)]);
function buildFeatures(els, kind) {
  const out = [];
  for (const el of els) {
    const t = el.tags || {}; const id = el.type + "/" + el.id;
    if (kind === "point") {
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat != null) out.push({ t, id, ll:[lat, lon] });
    } else if (kind === "line") {
      if (el.type === "way" && el.geometry) out.push({ t, id, lines:[geomLL(el.geometry)] });
    } else {
      let outer = [], inner = [];
      if (el.type === "way" && el.geometry) { const g = geomLL(el.geometry); if (g.length >= 4 && same(g[0], g[g.length - 1])) outer = [g]; }
      else if (el.type === "relation" && el.members) {
        const o = [], i = [];
        for (const m of el.members) if (m.type === "way" && m.geometry) (m.role === "inner" ? i : o).push(geomLL(m.geometry));
        outer = joinRings(o); inner = joinRings(i);
      }
      if (outer.length) {
        const ha = outer.reduce((s, r) => s + ringHa(r), 0) - inner.reduce((s, r) => s + ringHa(r), 0);
        out.push({ t, id, rings:[...outer, ...inner], outer, inner, ha });
      }
    }
  }
  return out;
}

/* ================= ořez na území kraje ================= */
const ll2c = r => r.map(p => [p[1], p[0]]);
const c2ll = r => r.map(p => [p[1], p[0]]);
const closeRing = r => same(r[0], r[r.length - 1]) ? r : r.concat([r[0]]);

/* rychlý test "bod v kraji" přes rastrovou masku (~25 m/px), přesné výpočty dělá turf jen na hranici */
function buildRaster(rings) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const r of rings) for (const [la, lo] of r) { minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la); minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); }
  const W = 4000, H = Math.round(W * (maxLat - minLat) / ((maxLon - minLon) * Math.cos((minLat + maxLat) / 2 * Math.PI / 180)));
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently:true });
  const X = lo => (lo - minLon) / (maxLon - minLon) * W, Y = la => (maxLat - la) / (maxLat - minLat) * H;
  ctx.beginPath();
  for (const r of rings) { ctx.moveTo(X(r[0][1]), Y(r[0][0])); for (const p of r) ctx.lineTo(X(p[1]), Y(p[0])); ctx.closePath(); }
  ctx.fill("evenodd");
  const a = ctx.getImageData(0, 0, W, H).data;
  return (la, lo) => { const x = Math.floor(X(lo)), y = Math.floor(Y(la));
    return x >= 0 && y >= 0 && x < W && y < H && a[(y * W + x) * 4 + 3] > 127; };
}
function clipFeatures(feats, K, kind) {
  const out = [];
  for (const f of feats) {
    try {
      if (kind === "point") { if (K.inside(f.ll[0], f.ll[1])) out.push(f); continue; }
      if (kind === "line") {
        const pieces = [];
        for (const ln of f.lines) {
          const flags = ln.map(p => K.inside(p[0], p[1]));
          if (flags.every(Boolean)) { pieces.push(ln); continue; }
          if (!flags.some(Boolean)) continue;
          const ls = turf.lineString(ll2c(ln));
          const parts = turf.lineSplit(ls, K.line).features;
          for (const part of (parts.length ? parts : [ls])) {
            const mid = turf.along(part, turf.length(part) / 2);
            if (turf.booleanPointInPolygon(mid, K.poly)) pieces.push(c2ll(part.geometry.coordinates));
          }
        }
        if (pieces.length) out.push({ ...f, lines:pieces });
        continue;
      }
      /* plochy */
      const all = f.rings.flat();
      const ins = all.map(p => K.inside(p[0], p[1]));
      if (ins.every(Boolean)) { out.push(f); continue; }
      if (!ins.some(Boolean) && !f.outer.some(r => turf.booleanPointInPolygon(turf.point(ll2c([K.center])[0]), turf.polygon([ll2c(closeRing(r))])))) continue;
      let g = turf.multiPolygon(f.outer.map(r => [ll2c(closeRing(r))]));
      for (const r of f.inner) { if (!g) break; g = turf.difference(g, turf.polygon([ll2c(closeRing(r))])); }
      const x = g && turf.intersect(g, K.poly);
      if (!x) continue;
      const polys = x.geometry.type === "Polygon" ? [x.geometry.coordinates] : x.geometry.coordinates;
      out.push({ ...f, rings: polys.flat().map(c2ll), ha: turf.area(x) / 10000 });
    } catch (e) {
      /* nevalidní geometrie z OSM – ponecháme, jen pokud leží v kraji */
      const p = f.ll || (f.lines || f.rings)[0][0];
      if (K.inside(p[0], p[1])) out.push(f);
    }
  }
  return out;
}

/* ================= popupy ================= */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const SRC = { coal:"uhlí", lignite:"hnědé uhlí", gas:"zemní plyn", hydro:"voda", solar:"slunce", biomass:"biomasa", biogas:"bioplyn",
  wind:"vítr", waste:"odpad", oil:"ropa", nuclear:"jádro", battery:"baterie", diesel:"nafta" };
function popup(def, f) {
  const t = f.t, rows = [];
  const add = (k, v) => { if (v) rows.push(`<dt>${k}</dt><dd>${esc(v)}</dd>`); };
  add("Provozovatel", t.operator);
  if (t.voltage) add("Napětí", String(t.voltage).split(";").map(v => (parseInt(v, 10) / 1000) + " kV").join(", "));
  if (t["plant:source"]) add("Zdroj", t["plant:source"].split(";").map(s => SRC[s] || s).join(", "));
  add("Elektrický výkon", t["plant:output:electricity"]);
  add("Tepelný výkon", t["plant:output:hot_water"] || t["plant:output:steam"] || t["plant:output:heat"]);
  add("Ochrana", t.protection_title);
  if (f.ha) add("Plocha", f.ha >= 100 ? (f.ha / 100).toLocaleString("cs", { maximumFractionDigits:1 }) + " km²" : f.ha.toLocaleString("cs", { maximumFractionDigits:1 }) + " ha");
  add("Adresa", [[t["addr:street"] || t["addr:place"], t["addr:housenumber"] || t["addr:conscriptionnumber"]].filter(Boolean).join(" "), t["addr:city"]].filter(Boolean).join(", "));
  add("Telefon", t.phone || t["contact:phone"]);
  const web = t.website || t["contact:website"];
  return `<div class="pp"><h3>${esc(t.name || def.label)}</h3><p class="k">${esc(def.label)}</p>${rows.length ? `<dl>${rows.join("")}</dl>` : ""}` +
    (web ? `<a href="${esc(web)}" target="_blank" rel="noopener">Web</a> · ` : "") +
    `<a href="https://www.openstreetmap.org/${f.id}" target="_blank" rel="noopener">Objekt v OSM</a></div>`;
}

/* ================= vektorové vrstvy ================= */
const host = document.getElementById("layers");
const icons = {};
function swatch(def) {
  if (def.icon) return def.icon;
  if (def.sw.line) return `<span class="sw-line${def.sw.dash ? " sw-dash" : ""}" style="--c:${def.sw.line}"></span>`;
  return `<span class="sw-area" style="--f:${def.sw.area};--c:${def.sw.c}"></span>`;
}
function buildLayer(def, feats) {
  const g = L.layerGroup(); let n = 0;
  for (const f of feats) {
    if (def.filter && !def.filter(f.t, f)) continue;
    n++;
    let lyr;
    if (f.ll) {
      icons[def.id] ||= L.divIcon({ className:"pt", html:def.icon, iconSize:[20, 20], iconAnchor:[10, 10], popupAnchor:[0, -8] });
      lyr = L.marker(f.ll, { icon:icons[def.id], title:f.t.name || def.label, keyboard:false });
    } else if (f.lines) lyr = L.polyline(f.lines, { ...def.style(f.t), renderer });
    else lyr = L.polygon(f.rings, { ...def.style(f.t), renderer, pane:"areas" });
    lyr.bindPopup(() => popup(def, f));
    g.addLayer(lyr);
  }
  return { g, n };
}
const state = {};
for (const grp of GROUPS) {
  const sec = document.createElement("section"); sec.className = "group";
  sec.innerHTML = `<h2>${grp.title}</h2>`;
  for (const def of grp.layers) {
    const row = document.createElement("label"); row.className = "item";
    row.innerHTML = `<input type="checkbox"><span class="sw">${swatch(def)}</span><span class="lbl">${def.label}${def.note ? `<small>${def.note}</small>` : ""}</span><span class="st"></span>`;
    const cb = row.querySelector("input"), st = row.querySelector(".st");
    state[def.id] = { def, cb, st, layer:null };
    cb.addEventListener("change", () => toggleVector(def.id));
    st.addEventListener("click", e => { if (st.classList.contains("err")) { e.preventDefault(); cb.checked = true; toggleVector(def.id); } });
    sec.appendChild(row);
    if (def.on) cb.checked = true;
  }
  host.appendChild(sec);
}
async function toggleVector(id) {
  const s = state[id];
  if (!s.cb.checked) { if (s.layer) map.removeLayer(s.layer); return; }
  if (s.layer) { s.layer.addTo(map); return; }
  s.st.className = "st load"; s.st.textContent = " ve frontě";
  try {
    const feats = await loadQuery(s.def.q, () => { if (s.st.classList.contains("load")) s.st.textContent = " načítám"; });
    const { g, n } = buildLayer(s.def, feats);
    s.layer = g; s.st.className = "st"; s.st.textContent = n.toLocaleString("cs");
    if (s.cb.checked) g.addTo(map);
  } catch (e) {
    console.error("[" + s.def.label + "]", e);
    s.st.className = "st err"; s.st.textContent = "Chyba – znovu"; s.st.title = String(e.message || e); s.cb.checked = false;
  }
}

/* ================= WMS ================= */
const wsec = document.createElement("section"); wsec.className = "group";
wsec.innerHTML = `<h2>Rastrové služby (WMS)</h2>`;
host.appendChild(wsec);
const wmsState = {};

/* GetCapabilities / ArcGIS JSON: nejdřív přímo, při CORS nebo chybě přes serverless proxy na Vercelu */
async function fetchCors(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r;
  } catch (e) {
    if (!/^https?:$/.test(location.protocol)) throw e;
    const r = await fetch("/api/proxy?url=" + encodeURIComponent(url));
    if (!r.ok) throw new Error("proxy HTTP " + r.status + " (" + e.message + ")");
    return r;
  }
}
async function capabilities(url) {
  const sep = url.includes("?") ? "&" : "?";
  const r = await fetchCors(url + sep + "SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0");
  if (!r.ok) throw new Error("HTTP " + r.status);
  const doc = new DOMParser().parseFromString(await r.text(), "text/xml");
  const out = [];
  for (const l of doc.getElementsByTagName("Layer")) {
    const kids = [...l.children];
    const name = kids.find(c => c.localName === "Name")?.textContent;
    const hasSub = kids.some(c => c.localName === "Layer");
    if (name && !hasSub) out.push({ name, title: kids.find(c => c.localName === "Title")?.textContent || name });
  }
  if (!out.length) throw new Error("Služba nevrátila žádné vrstvy");
  return out;
}
/* ArcGIS REST MapServer: dlaždice přes /export (obrázky nepotřebují CORS) */
const ArcTile = L.TileLayer.extend({
  initialize(url, opts) { this._svc = url; this._show = opts.show || ""; L.TileLayer.prototype.initialize.call(this, "", opts); },
  setShow(ids) { this._show = ids; this.redraw(); },
  getTileUrl(c) {
    const b = this._tileCoordsToNwSe(c), ts = this.getTileSize();
    const nw = L.CRS.EPSG3857.project(b[0]), se = L.CRS.EPSG3857.project(b[1]);
    const q = new URLSearchParams({ bbox:[nw.x, se.y, se.x, nw.y].join(","), bboxSR:"3857", imageSR:"3857",
      size:ts.x + "," + ts.y, dpi:"96", format:"png32", transparent:"true", f:"image" });
    if (this._show) q.set("layers", "show:" + this._show);
    return this._svc + "/export?" + q.toString();
  }
});
async function arcLayers(url) {
  const r = await fetchCors(url + "?f=json");
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "chyba služby");
  const out = (j.layers || []).filter(l => !l.subLayerIds || !l.subLayerIds.length).map(l => ({ name:String(l.id), title:l.name }));
  if (!out.length) throw new Error("Služba nevrátila žádné vrstvy");
  return out;
}
function addWms(cfg) {
  const wrap = document.createElement("div");
  const row = document.createElement("label"); row.className = "item";
  row.innerHTML = `<input type="checkbox"><span class="sw"><span class="sw-area" style="--f:repeating-linear-gradient(45deg,#5AA7DA55 0 3px,transparent 3px 6px);--c:#1F5F94"></span></span><span class="lbl">${esc(cfg.label)}${cfg.note ? `<small>${esc(cfg.note)}</small>` : ""}</span><span class="st"></span>`;
  const sub = document.createElement("div"); sub.className = "sub"; sub.hidden = true;
  wrap.append(row, sub); wsec.appendChild(wrap);
  const cb = row.querySelector("input"), st = row.querySelector(".st");
  const s = wmsState[cfg.id] = { cfg, cb, st, sub, layer:null, names:[] };

  cb.addEventListener("change", async () => {
    if (!cb.checked) { if (s.layer) map.removeLayer(s.layer); sub.hidden = true; return; }
    sub.hidden = false;
    if (s.layer) { s.layer.addTo(map); return; }
    st.className = "st load"; st.textContent = "";
    let layers;
    try { layers = cfg.type === "arcgis" ? await arcLayers(cfg.url) : await capabilities(cfg.url); }
    catch (e) {
      if (cfg.type === "arcgis") {
        /* bez seznamu vrstev zobrazíme výchozí viditelnost služby */
        s.names = [];
        sub.innerHTML = `<p class="note">Seznam podvrstev nejde načíst, zobrazuji výchozí vrstvy služby.</p><div class="op">Průhlednost<input type="range" min="0.1" max="1" step="0.05" value="0.7" aria-label="Průhlednost vrstvy"></div>`;
        sub.querySelector("input[type=range]").addEventListener("input", ev => s.layer && s.layer.setOpacity(+ev.target.value));
        st.className = "st"; st.textContent = "výchozí";
        mountWms(s);
        return;
      }
      st.className = "st err"; st.textContent = "Nedostupné";
      sub.innerHTML = `<p class="note">Seznam vrstev nejde načíst (${esc(e.message || "CORS / síť")}). Ověřte službu: <a href="${esc(cfg.url)}?SERVICE=WMS&REQUEST=GetCapabilities" target="_blank" rel="noopener">GetCapabilities</a>. Název vrstvy můžete zadat ručně:</p>
        <div class="op"><input type="text" placeholder="např. 0,1" style="flex:1;padding:4px 6px;border:1px solid var(--line);border-radius:3px;background:transparent;color:var(--ink)"><button style="font:600 12px var(--ui);padding:4px 8px;border:0;border-radius:3px;background:var(--blue);color:#fff;cursor:pointer">Zobrazit</button></div>`;
      const inp = sub.querySelector("input"), btn = sub.querySelector("button");
      btn.addEventListener("click", () => { const v = inp.value.trim(); if (!v) return; s.names = v.split(",").map(x => x.trim()); mountWms(s); st.className = "st"; st.textContent = "ručně"; });
      return;
    }
    const pre = layers.filter(l => cfg.pick && (cfg.pick.test(l.title) || cfg.pick.test(l.name)));
    const chosen = new Set((pre.length ? pre : layers.slice(0, 1)).slice(0, 12).map(l => l.name));
    s.names = layers.filter(l => chosen.has(l.name)).map(l => l.name);
    sub.innerHTML = layers.map((l, i) => `<label><input type="checkbox" data-n="${esc(l.name)}" ${chosen.has(l.name) ? "checked" : ""}><span>${esc(l.title)}</span></label>`).join("") +
      `<div class="op">Průhlednost<input type="range" min="0.1" max="1" step="0.05" value="0.7" aria-label="Průhlednost vrstvy"></div>`;
    sub.querySelectorAll("input[type=checkbox]").forEach(c => c.addEventListener("change", () => {
      s.names = [...sub.querySelectorAll("input[type=checkbox]:checked")].map(x => x.dataset.n);
      if (!s.names.length) { if (s.layer) map.removeLayer(s.layer); return; }
      if (s.layer) {
        if (s.cfg.type === "arcgis") s.layer.setShow(s.names.join(",")); else s.layer.setParams({ layers: s.names.join(",") });
        if (!map.hasLayer(s.layer)) s.layer.addTo(map);
      } else mountWms(s);
    }));
    sub.querySelector("input[type=range]").addEventListener("input", e => s.layer && s.layer.setOpacity(+e.target.value));
    st.className = "st"; st.textContent = layers.length + " vrstev";
    if (s.names.length) mountWms(s);
  });
  if (cfg.on) { cb.checked = true; cb.dispatchEvent(new Event("change")); }
}
function mountWms(s) {
  if (s.layer) map.removeLayer(s.layer);
  const common = { opacity:+(s.sub.querySelector("input[type=range]")?.value || .7), pane:"wms", tileSize:512, maxZoom:20, attribution: s.cfg.label };
  s.layer = s.cfg.type === "arcgis"
    ? new ArcTile(s.cfg.url, { ...common, show: s.names.join(",") })
    : L.tileLayer.wms(s.cfg.url, { ...common, layers: s.names.join(","), format:"image/png", transparent:true, version:"1.1.1" });
  let errs = 0;
  s.layer.on("tileerror", ev => { if (++errs === 3) { console.warn("[" + s.cfg.label + "] dlaždice selhávají:", ev.tile && ev.tile.src); s.st.className = "st err"; s.st.textContent = "Chyba dlaždic"; } });
  s.layer.on("tileload", () => { if (errs) { errs = 0; s.st.className = "st"; s.st.textContent = s.st.textContent === "Chyba dlaždic" ? "" : s.st.textContent; } });
  if (s.cb.checked) s.layer.addTo(map);
}
WMS.forEach(addWms);

/* vlastní WMS */
const custom = document.createElement("div"); custom.className = "custom";
custom.innerHTML = `<label class="lbl" style="font:500 13px var(--ui);color:var(--muted)" for="cw">Přidat vlastní WMS službu</label>
  <input id="cw" type="url" placeholder="https://…/MapServer/WMSServer"><button type="button">Přidat službu</button>`;
wsec.appendChild(custom);
let cwN = 0;
custom.querySelector("button").addEventListener("click", () => {
  const url = custom.querySelector("input").value.trim().replace(/\?.*$/, "");
  if (!/^https:\/\//.test(url)) { custom.querySelector("input").focus(); return; }
  const id = "custom" + (++cwN);
  let label; try { label = new URL(url).hostname; } catch (e) { label = url; }
  addWms({ id, label, note:url.replace(/^https:\/\/[^/]+/, ""), url, pick:/./, on:true });
  wsec.appendChild(custom); custom.querySelector("input").value = "";
});

/* ================= hranice kraje + maska ================= */
const krajReady = (async () => {
  try {
    const json = await enqueue(() => overpass('[out:json][timeout:110];relation["ISO3166-2"="CZ-42"]["admin_level"="6"];out geom;'));
    const rel = (json.elements || [])[0]; if (!rel) { wmsPane.style.visibility = ""; return null; }
    const rings = joinRings(rel.members.filter(m => m.type === "way" && m.role !== "inner").map(m => geomLL(m.geometry))).map(closeRing);
    if (!rings.length) { wmsPane.style.visibility = ""; return null; }
    const world = [[85, -180], [85, 180], [-85, 180], [-85, -180]];
    /* okolí kraje jen jemně ztlumíme – podklad zůstává vidět, data jsou ořezaná */
    L.polygon([world, ...rings], { stroke:false, fillColor:"#1A1F2B", fillOpacity:.18, interactive:false, renderer }).addTo(map);
    const outline = L.polyline(rings, { color:"#1D3C8F", weight:2.5, interactive:false, renderer }).addTo(map);
    krajBounds = outline.getBounds();
    map.fitBounds(krajBounds);
    /* ořez rastrů: zjednodušená hranice (~20 m), aby clip-path nebyl zbytečně dlouhý */
    try {
      const simp = turf.simplify(turf.multiPolygon(rings.map(r => [ll2c(r)])), { tolerance:0.0002, highQuality:false });
      clipRings = simp.geometry.coordinates.map(poly => c2ll(poly[0]));
    } catch (e) { clipRings = rings; }
    updateClip();
    wmsPane.style.visibility = "";
    const poly = turf.multiPolygon(rings.map(r => [ll2c(r)]));
    const c = krajBounds.getCenter();
    return { poly, line: turf.multiLineString(rings.map(ll2c)), inside: buildRaster(rings), center:[c.lat, c.lng] };
  } catch (e) { console.warn("Hranici kraje nelze načíst, data nebudou ořezaná:", e); wmsPane.style.visibility = ""; return null; }
})();
krajReady.then(() => { for (const id in state) if (state[id].cb.checked) toggleVector(id); });

/* mobil */
const tg = document.getElementById("toggle");
tg.addEventListener("click", () => { const o = document.body.classList.toggle("open"); tg.setAttribute("aria-expanded", String(o)); tg.textContent = o ? "Mapa" : "Vrstvy"; });