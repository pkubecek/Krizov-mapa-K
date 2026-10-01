"use strict";
/* ================= konfigurace ================= */
/* jen výchozí pohled, než se načte skutečná hranice kraje – data se podle něj neomezují */
const KRAJ_BOUNDS = [[50.15, 12.95], [51.06, 14.65]];
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
const MAJOR_RIVERS = /^(Labe|Ohře|Bílina|Ploučnice|Kamenice|Chomutovka|Mandava|Křinice|Liboc|Blšanka)$/;

/* Oblast dotazu: polygon hranice kraje ze ZABAGED (data/kraj.geojson) → filtr poly:"…".
   Nezávisí na tom, jak je kraj otagovaný v OSM. Záloha, kdyby soubor chyběl: oblast podle jména/ISO kódu. */
const AREA_FALLBACK = '(area["name"="Ústecký kraj"]["boundary"="administrative"];area["ISO3166-2"="CZ-42"]["boundary"="administrative"];)->.k;';
let krajPolyPromise = null;
function krajPoly() {
  krajPolyPromise ||= fetch("/data/kraj.geojson").then(r => r.ok ? r.json() : null).then(fc => {
    const g = fc?.features?.[0]?.geometry; if (!g) return null;
    const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates.reduce((a, p) => p[0].length > a.length ? p[0] : a, []);
    const step = Math.max(1, Math.ceil(ring.length / 300));          /* ~300 vrcholů stačí, přesnost ~stovky m */
    const pts = ring.filter((_, i) => i % step === 0);
    return pts.map(([lon, lat]) => lat.toFixed(5) + " " + lon.toFixed(5)).join(" ");
  }).catch(() => null);
  return krajPolyPromise;
}
const Q = {
  dams:    { body:'way["waterway"="dam"]["name"](area.k);node["waterway"="dam"]["name"](area.k);', geom:"point" },
  plants:  { body:'nwr["power"="plant"](area.k);', geom:"point" },
  subst:   { body:'nwr["power"="substation"]["voltage"~"110000|220000|400000"](area.k);', geom:"point" },
  water:   { body:'nwr["man_made"~"^(water_works|wastewater_plant)$"](area.k);', geom:"point" },
  chem:    { body:'nwr["industrial"~"^(chemical|refinery)$"](area.k);', geom:"point" },
  police:  { body:'nwr["amenity"="police"](area.k);', geom:"point" }
};

/* pomocné klasifikace */
const isHeat = t => !!(t["plant:output:hot_water"] || t["plant:output:steam"] || t["plant:output:heat"] || /tepl[áa]rn|výtopn/i.test(t.name || ""));
const mw = s => { if (!s) return 0; const m = String(s).replace(",", ".").match(/([\d.]+)\s*(kW|MW|GW)?/i); if (!m) return 0;
  const v = parseFloat(m[1]); const u = (m[2] || "MW").toUpperCase(); return u === "KW" ? v / 1000 : u === "GW" ? v * 1000 : v; };
const isElec = t => {
  if (t["plant:source"] === "solar" && mw(t["plant:output:electricity"]) < 5) return false; // malé FVE vynecháme
  return !!t["plant:output:electricity"] || !isHeat(t);
};
const isHZS = t => /hasičský záchranný sbor|\bHZS\b/i.test((t.operator || "") + " " + (t.name || ""));
const isMP = t => /městsk|obecní/i.test((t.operator || "") + " " + (t.name || "") + " " + (t["police:type"] || ""));

/* symboly */
/* piktogramy (bílé, 24×24) – kříž, štít, plamen podle běžných map */
const PICTO = {
  kriz:   '<path d="M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z"/>',
  stit:   '<path d="M12 2 20 5v6c0 5.2-3.4 9.6-8 11-4.6-1.4-8-5.8-8-11V5z"/><path fill="var(--c)" d="m12 7 1.4 2.9 3.1.4-2.3 2.2.6 3.1L12 14.1l-2.8 1.5.6-3.1-2.3-2.2 3.1-.4z"/>',
  plamen: '<path d="M13.5.7s.7 2.6.7 4.8c0 2-1.3 3.7-3.4 3.7-2 0-3.6-1.7-3.6-3.7v-.4C5.2 7.5 4 10.6 4 14a8 8 0 0 0 16 0c0-5.4-2.6-10.2-6.5-13.3M11.7 19a3.2 3.2 0 0 1-3.2-3.1c0-1.7 1-2.8 2.8-3.2 1.8-.3 3.6-1.2 4.6-2.6.4 1.3.6 2.7.6 4.1 0 2.6-2.1 4.8-4.8 4.8"/>'
};
const picto = (name, s) => `<svg viewBox="0 0 24 24" width="${Math.round(s * .78)}" height="${Math.round(s * .78)}" fill="currentColor" aria-hidden="true" style="display:block">${PICTO[name]}</svg>`;
const mkHtml = (shape, c, glyph = "", s = 20, fg = "#fff") =>
  `<span class="mk ${shape}" style="--c:${c};--s:${s}px;--fg:${fg}">${shape === "di" ? `<span>${glyph}</span>` : glyph}</span>`;

/* ================= definice vrstev ================= */
/* ---- symbologie vrstev ZABAGED (statická data v /data) ---- */
const RIVER_MAIN = /^(Labe|Ohře)$/;
const tokStyle = p => RIVER_MAIN.test(p.jmeno || "") ? { color:"#1F6FB2", weight:4.5 }
  : p.trida === "splavny" ? { color:"#1F6FB2", weight:3.2 }
  : p.trida === "obcasny" ? { color:"#4A95CE", weight:1.3, dashArray:"4 3" }
  : { color:"#2B7BB9", weight:1.8 };
const PLOCHY = {
  "přehradní nádrž":    { color:"#144E80", weight:1, fillColor:"#1F6FB2", fillOpacity:.65 },
  "rybník":             { color:"#2B7BB9", weight:.8, fillColor:"#5AA7DA", fillOpacity:.55 },
  "antropogenní jezero":{ color:"#1E7A74", weight:.8, fillColor:"#3FA7A0", fillOpacity:.55 },
  "sedimentační nádrž": { color:"#6E5530", weight:1, fillColor:"#A88B5A", fillOpacity:.6 },
  _ostatni:             { color:"#5AA7DA", weight:.6, fillColor:"#8EC5E8", fillOpacity:.5 }
};
const plochaStyle = p => PLOCHY[p.typ] || PLOCHY._ostatni;
/* silnice a železnice mají dvě vrstvy čáry (lem + výplň) – style() vrací pole */
const silniceStyle = p => {
  if (p.vetev) return p.trida === "I" ? [{ color:"#B7791F", weight:1.8 }] : [{ color:"#D84315", weight:2.2 }];
  if (p.trida === "D1") return [{ color:"#7F1414", weight:6.5 }, { color:"#E53935", weight:4 }];
  if (p.trida === "D2") return [{ color:"#7F1414", weight:5.5 }, { color:"#F06A3A", weight:3.2 }];
  return [{ color:"#8A5A00", weight:4.4 }, { color:"#F9C23C", weight:2.6 }];
};
const zelezniceStyle = p => p.elektr
  ? [{ color:"#1A1F2B", weight:4.2, lineCap:"butt" }, { color:"#FFFFFF", weight:2, dashArray:"7 7", lineCap:"butt" }]
  : [{ color:"#4B5563", weight:3.2, lineCap:"butt" }, { color:"#FFFFFF", weight:1.4, dashArray:"7 7", lineCap:"butt" }];
const rows = (...pairs) => pairs.filter(([, v]) => v !== undefined && v !== null && v !== "");

const GROUPS = [
  { title: "Administrativní hranice", layers: [
    { id:"kraj", file:"kraj.geojson", kind:"line", label:"Hranice Ústeckého kraje", on:true,
      style: () => ({ color:"#1D3C8F", weight:3, opacity:.9, fill:false }),
      popup: p => [p.nazev || "Ústecký kraj", []] }
  ]},
  { title: "Vodní toky a plochy", layers: [
    { id:"toky", file:"vodni_toky.geojson", kind:"line", label:"Vodní toky", note:"pojmenované toky, ZABAGED",
      style: tokStyle,
      legend: [ { label:"Labe, Ohře", t:{ jmeno:"Labe" } }, { label:"ostatní splavné úseky", t:{ trida:"splavny" } },
                { label:"stálý tok", t:{ trida:"stály" } }, { label:"občasný tok", t:{ trida:"obcasny" } } ],
      popup: p => [p.jmeno, rows(["Typ", p.trida === "splavny" ? "povrchový splavný" : p.trida === "obcasny" ? "občasný" : "stálý"])] },
    { id:"toky2", file:"vodni_toky_ostatni.geojson", kind:"line", label:"Ostatní vodní linie", note:"bezejmenné toky a strouhy",
      style: p => p.trida === "obcasny" ? { color:"#7FB6DD", weight:.8, dashArray:"3 3" } : { color:"#5AA7DA", weight:.9 },
      legend: [ { label:"stálé", t:{ trida:"stály" } }, { label:"občasné", t:{ trida:"obcasny" } } ],
      popup: p => ["Vodní linie", rows(["Typ", p.trida === "obcasny" ? "občasná" : "stálá"])] },
    { id:"plochy", file:"vodni_plochy.geojson", kind:"area", label:"Vodní plochy", on:false,
      style: plochaStyle,
      legend: [ { label:"přehradní nádrž", t:{ typ:"přehradní nádrž" } }, { label:"rybník", t:{ typ:"rybník" } },
                { label:"antropogenní jezero (zatopené lomy)", t:{ typ:"antropogenní jezero" } },
                { label:"sedimentační nádrž (odkaliště)", t:{ typ:"sedimentační nádrž" } }, { label:"ostatní vodní plochy", t:{} } ],
      popup: p => [p.jmeno || p.typ || "Vodní plocha", rows(["Typ", p.typ], ["Plocha", p.ha != null ? p.ha.toLocaleString("cs") + " ha" : null])] },
    { id:"dams", q:"dams", label:"Hráze a přehrady", note:"jen pojmenované (OSM)", icon: mkHtml("sq","#1F5F94","≡",16) }
  ]},
  { title: "Doprava", layers: [
    { id:"silnice", file:"silnice.geojson", kind:"line", label:"Dálnice a silnice I. třídy", on:true,
      style: silniceStyle,
      legend: [ { label:"dálnice", t:{ trida:"D1" } }, { label:"dálnice II. třídy", t:{ trida:"D2" } },
                { label:"silnice I. třídy", t:{ trida:"I" } }, { label:"větve a nájezdy dálnic", t:{ trida:"D1", vetev:1 } },
                { label:"větve silnic I. třídy", t:{ trida:"I", vetev:1 } } ],
      popup: p => [p.cislo || "Silnice", rows(["Kategorie", ({ D1:"dálnice", D2:"dálnice II. třídy", I:"silnice I. třídy" }[p.trida] || "") + (p.vetev ? " – větev" : "")])] },
    { id:"zeleznice", file:"zeleznice.geojson", kind:"line", label:"Železniční tratě",
      style: zelezniceStyle,
      legend: [ { label:"elektrizovaná", t:{ elektr:1 } }, { label:"neelektrizovaná", t:{ elektr:0 } } ],
      popup: p => ["Železniční trať", rows(["Typ", p.elektr ? "elektrizovaná" : "neelektrizovaná"])] }
  ]},
  { title: "Kritická infrastruktura", layers: [
    { id:"elek", file:"elektrarny.geojson", label:"Elektrárny nad 100 MW", note:"ZABAGED", icon: mkHtml("di","#F2C200","E",17,"#1A1F2B"),
      popup: p => [p.jmeno || "Elektrárna", rows(["Typ", p.typ], ["Výkon", p.vykon != null ? p.vykon.toLocaleString("cs") + " MW" : null])] },
    { id:"tepl", q:"plants", label:"Teplárny a výtopny", note:"OSM", filter: isHeat, icon: mkHtml("di","#D84315","T",17) },
    { id:"subst", q:"subst", label:"Rozvodny 110–400 kV", icon: mkHtml("sq","#6A3FA0","R",16) },
    { id:"vedeni", file:"vedeni.geojson", kind:"line", label:"Elektrické vedení VVN a ZVN", note:"ZABAGED",
      style: p => p.kv >= 400 ? { color:"#7F1414", weight:3.4 } : p.kv >= 220 ? { color:"#D0312D", weight:2.7 } : { color:"#E8792B", weight:2 },
      legend: [ { label:"400 kV", t:{ kv:400 } }, { label:"220 kV", t:{ kv:220 } }, { label:"110 kV", t:{ kv:110 } } ],
      popup: p => ["Elektrické vedení", rows(["Napětí", p.napeti])] },
    { id:"water", q:"water", label:"Úpravny vod a ČOV", icon: mkHtml("ci","#00838F","V",16) },
    { id:"chem", q:"chem", label:"Chemický a petrochemický průmysl", icon: mkHtml("tri","#AD1457","!",20) }
  ]},
  { title: "Složky IZS", layers: [
    { id:"hzs", file:"hasici.geojson", filter: p => p.typ !== "HZ", pkrSrc:{ path:"/pkr/zdroje-ohrozeni/provoz/provozovna/", sub:"14" }, note:"ZABAGED + PKR ÚK", label:"Hasičské stanice", icon: mkHtml("di","#C62828",picto("plamen",19),19), on:true,
      popup: p => ["Hasičská stanice " + (p.obec || ""), rows(["Typ", p.typ_p], ["Obec", p.obec], ["ID JPO", p.id_jpo])] },
    { id:"sdh", file:"hasici.geojson", filter: p => p.typ === "HZ", pkrSrc:{ path:"/pkr/zdroje-ohrozeni/provoz/provozovna/", sub:"21" }, note:"ZABAGED + PKR ÚK", label:"Hasičské zbrojnice", icon: mkHtml("di","#E57373",picto("plamen",14),14),
      popup: p => ["Hasičská zbrojnice " + (p.obec || ""), rows(["Obec", p.obec], ["ID JPO", p.id_jpo])] },
    { id:"pcr", file:"policie.geojson", pkrSrc:{ path:"/pkr/zdroje-ohrozeni/provoz/provozovna/", sub:"17" }, note:"ZABAGED + PKR ÚK", label:"Policie ČR", icon: mkHtml("di","#1D3C8F",picto("stit",19),19), on:true,
      popup: p => [p.nazev || "Policie ČR", rows(["Typ", p.typ_p])] },
    { id:"mp", q:"police", label:"Městská policie", note:"OSM", filter: isMP, icon: mkHtml("di","#5C7BD9",picto("stit",14),14) },
    { id:"hosp", file:"nemocnice.geojson", label:"Nemocnice", icon: mkHtml("di","#D32F2F",picto("kriz",19),19), on:true,
      popup: p => [p.nazev || "Nemocnice", rows(["Typ", p.typ])] },
    { id:"zzs", pkrSrc:{ path:"/pkr/zdroje-ohrozeni/provoz/provozovna/", sub:"19,18" }, label:"Záchranná služba", note:"stanoviště a střediska ZZS, PKR ÚK",
      icon: mkHtml("di","#2E7D32",picto("kriz",19),19), popup: () => ["Zdravotnická záchranná služba", []] },
    { id:"heli_lzs", file:"heliporty.geojson", filter: p => /HEMS/.test(p.typ || "") , label:"Heliporty letecké záchranné služby",
      icon: mkHtml("ci","#2E7D32","H",20),
      popup: p => [p.kod ? "Heliport " + p.kod : "Heliport", rows(["Typ", p.typ_p], ["Umístění", p.upres], ["Noční provoz", p.nocni === "A" ? "ano" : p.nocni === "N" ? "ne" : null], ["Nadm. výška", p.vyska != null ? p.vyska + " m" : null])] },
    { id:"heli", file:"heliporty.geojson", filter: p => !/HEMS/.test(p.typ || ""), label:"Ostatní heliporty",
      icon: mkHtml("ci","#fff","H",17,"#2E7D32"),
      popup: p => [p.kod ? "Heliport " + p.kod : "Heliport", rows(["Typ", p.typ_p], ["Umístění", p.upres], ["Nadm. výška", p.vyska != null ? p.vyska + " m" : null])] }
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

/* ================= Portál krizového řízení ÚK (SyPOS) ================= */
/* Body se tahají z API "?fmt=poi_layer" stejnými parametry, jaké posílá mapa portálu.
   Souřadnice jsou v S-JTSK (EPSG:5514): geom.lon = X (východ), geom.lat = Y (sever). */
const PKR = "https://pkr.kr-ustecky.cz";
const PKR_TILES = ["0_0_0","0_1_0","0_2_0","0_3_0","1_0_0","1_1_0","1_2_0","1_3_0","2_0_0","2_1_0","2_2_0","2_3_0","3_0_0","3_1_0","3_2_0","3_3_0"].join(",");
const PKR_PARAMS = "fmt=poi_layer&map=gis_izs&base_layer_index=0" +
  "&max_extent_min_x=-1005448.4319539107&max_extent_min_y=-1326543.9442316927" +
  "&max_extent_max_x=-331439.78833832964&max_extent_max_y=-833114.4082059488" +
  "&resolution=529.1677250021168&tileSizeH=256&tileSizeW=256&tiles=" + encodeURIComponent(PKR_TILES) + "&_bulk=1";
const PKR_OHR = "/pkr/zdroje-ohrozeni/situace/udalost/";
const PKR_PROV = "/pkr/zdroje-ohrozeni/provoz/provozovna/";
const PKR_PRIR = "/pkr/zdroje-ohrozeni/prirodni_zdroje/aktivum/";
const PKR_ICON_H = 24;   /* stejná výška ikony v mapě i v legendě */
const pkrIconHtml = src => `<img src="${PKR + src}" alt="" style="height:${PKR_ICON_H}px;width:auto;display:block">`;
const PKR_GROUPS = [
  { title: "PKR ÚK – ohrožení", layers: [
    { id:"pkr_pov",  path:PKR_OHR, sub:"7",         label:"Povodně", ico:"/media/icons/u/7.gif" },
    { id:"pkr_ses",  path:PKR_OHR, sub:"2,3,4,5,6", label:"Sesuvy, posuvy, odvaly, proudy", ico:"/media/icons/u/2.gif" },
    { id:"pkr_dn",   path:PKR_OHR, sub:"15",        label:"Úseky častých dopravních nehod", ico:"/media/icons/u/15.gif" },
    { id:"pkr_zhp",  path:PKR_OHR, sub:"12",        label:"Zóny havarijního plánování", ico:"/media/icons/u/12.gif" },
    { id:"pkr_mu",   path:"/pkr/zdroje-ohrozeni/jos/resenaudalost/", label:"Řešené MU/KS", note:"aktuálně řešené události", ico:"/static/situace/img/aktualni_udalost.gif" }
  ]},
  { title: "PKR ÚK – provozovny", layers: [
    { id:"pkr_prum", path:PKR_PROV, sub:"8",  label:"Průmyslové areály", ico:"/media/icons/p/8.gif" },
    { id:"pkr_cs",   path:PKR_PROV, sub:"6",  label:"Čerpací stanice", ico:"/media/icons/p/6.gif" }
  ]},
  { title: "PKR ÚK – přírodní zdroje", layers: [
    { id:"pkr_nadr", path:PKR_PRIR, sub:"131", label:"Významné vodní nádrže", ico:"/media/icons/a/131.gif" },
    { id:"pkr_opvz", path:PKR_PRIR, sub:"126", label:"Ochranná pásma vodních zdrojů", ico:"/media/icons/a/126.gif" },
    { id:"pkr_chop", path:PKR_PRIR, sub:"120", label:"CHOPAV", note:"přirozená akumulace podzemních vod", ico:"/media/icons/a/120.gif" }
  ]}
];
for (const g of PKR_GROUPS) {
  for (const d of g.layers) { d.pkr = true; d.icon = pkrIconHtml(d.ico); }
  GROUPS.push(g);
}
/* vodní toky a plochy až na konec – v panelu těsně nad rastrovými službami (WMS) */
GROUPS.push(...GROUPS.splice(GROUPS.findIndex(g => g.title === "Vodní toky a plochy"), 1));

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

map.createPane("wms").style.zIndex = 350;
map.createPane("areas").style.zIndex = 380;
map.createPane("mask").style.zIndex = 390;
map.getPane("mask").style.pointerEvents = "none";

const Home = L.Control.extend({ options:{ position:"topleft" }, onAdd() {
  const d = L.DomUtil.create("div", "leaflet-bar leaflet-control homebtn");
  d.innerHTML = '<a href="#" title="Zobrazit celý kraj" role="button" aria-label="Zobrazit celý kraj">⌂</a>';
  L.DomEvent.on(d, "click", e => { L.DomEvent.preventDefault(e); map.fitBounds(krajBounds || KRAJ_BOUNDS); });
  return d; } });
new Home().addTo(map);
let krajBounds = null, krajFitted = false;

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

async function overpass(query, onProgress = () => {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const ep of OVERPASS) {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 90000);
      onProgress(`Dotaz na ${new URL(ep).host}${attempt ? " (2. pokus)" : ""}…` + (lastErr ? `\nPředchozí chyba: ${lastErr.message}` : ""));
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
    if (attempt === 0) { onProgress(`Všechny servery Overpass selhaly, zkusím znovu za 4 s.\nPoslední chyba: ${lastErr?.message}`); await sleep(4000); }
  }
  throw lastErr || new Error("Overpass nedostupný");
}
function loadQuery(key, onQueued) {
  if (dataCache.has(key)) return dataCache.get(key);
  const def = Q[key];
  const out = def.geom === "point" ? "out tags center;" : "out geom;";
  const p = (async () => {
    /* průběh dotazu ukazujeme v tooltipu všech vrstev, které na tento dotaz čekají */
    const progress = msg => { for (const s of Object.values(state)) if (s.def.q === key && s.st.classList.contains("load")) { s.st.title = msg; s.st.textContent = " načítám"; } };
    const poly = await krajPoly();
    const body = poly ? def.body.replaceAll("(area.k)", `(poly:"${poly}")`) : def.body;
    const query = `[out:json][timeout:80];${poly ? "" : AREA_FALLBACK}(${body});${out}`;
    const json = await enqueue(() => { onQueued && onQueued(); return overpass(query, progress); });
    return buildFeatures(json.elements || [], def.geom);
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
    } else if (kind === "boundary") {
      if (el.type === "relation" && el.members) {
        const rings = joinRings(el.members.filter(m => m.type === "way" && m.role !== "inner" && m.geometry).map(m => geomLL(m.geometry)));
        if (rings.length) out.push({ t, id, lines:rings });
      }
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
/* Legenda se kreslí ze stejné funkce style() jako mapa – barva, tloušťka, čárkování i průhlednost sedí 1:1.
   Výchozí hodnoty odpovídají výchozím hodnotám L.Path v Leafletu. */
function svgShape(st, kind) {
  const color = st.color ?? "#3388ff", w = st.weight ?? 3, op = st.opacity ?? 1;
  const dash = st.dashArray ? ` stroke-dasharray="${st.dashArray}"` : "";
  const cap = st.lineCap ?? "round";
  const stroke = `stroke="${color}" stroke-width="${w}" stroke-opacity="${op}" stroke-linecap="${cap}" stroke-linejoin="round"${dash}`;
  if (kind === "area") {
    const fill = st.fill === false ? "none" : (st.fillColor ?? color), fop = st.fillOpacity ?? .2, pad = Math.max(w / 2, .5);
    return `<rect x="${pad + 1}" y="${pad + 1}" width="${26 - 2 * pad}" height="${16 - 2 * pad}" rx="1.5" fill="${fill}" fill-opacity="${fop}" ${st.stroke === false ? "" : stroke}/>`;
  }
  return `<line x1="1" y1="9" x2="27" y2="9" ${stroke}/>`;
}
function svgSwatch(st, kind) {
  const parts = (Array.isArray(st) ? st : [st]).map(s => svgShape(s, kind)).join("");
  return `<svg class="sws" width="28" height="18" viewBox="0 0 28 18" aria-hidden="true">${parts}</svg>`;
}
const LAYER_KIND = def => def.icon ? "point" : def.kind ? def.kind : Q[def.q].geom === "area" ? "area" : "line";
function swatch(def) {
  if (def.icon) return def.icon;
  const sample = def.legend ? def.legend[def.legend.length - 1].t : {};
  return svgSwatch(def.style(sample), LAYER_KIND(def));
}
function legendRows(def) {
  if (!def.legend) return "";
  return `<div class="leg">${def.legend.map(c => `<div class="leg-row"><span class="sw">${svgSwatch(def.style(c.t), LAYER_KIND(def))}</span><span>${esc(c.label)}</span></div>`).join("")}</div>`;
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
    if (def.legend) sec.insertAdjacentHTML("beforeend", legendRows(def));
    if (def.on) cb.checked = true;
  }
  host.appendChild(sec);
}
/* ================= PKR loader ================= */
proj4.defs("EPSG:5514", "+proj=krovak +lat_0=49.5 +lon_0=24.83333333333333 +alpha=30.28813972222222 +k=0.9999 +x_0=0 +y_0=0 +ellps=bessel +towgs84=589,76,480,0,0,0,0 +units=m +no_defs");
const sjtsk2ll = (x, y) => { const [lon, lat] = proj4("EPSG:5514", "EPSG:4326", [x, y]); return [lat, lon]; };

/* Odpověď API má různé obaly (bulk dlaždice, result_items/ret, markers) – projdeme ji celou
   a sebereme každý objekt, který má souřadnice v geom. */
/* vytáhne souřadnice S-JTSK z různých zápisů, které SyPOS používá */
const num = v => (v === null || v === undefined || v === "") ? NaN : parseFloat(v);
const isSjtsk = (x, y) => x < -400000 && x > -950000 && y < -900000 && y > -1300000;
function pointOf(n) {
  const g = n.geom ?? n.geometry ?? n.g;
  if (g && typeof g === "object" && !Array.isArray(g)) {
    for (const [kx, ky] of [["lon", "lat"], ["x", "y"], ["X", "Y"]]) {
      const x = num(g[kx]), y = num(g[ky]); if (isSjtsk(x, y)) return [x, y];
    }
    if (Array.isArray(g.coordinates)) { const [x, y] = g.coordinates.map(num); if (isSjtsk(x, y)) return [x, y]; }
  }
  if (Array.isArray(g) && g.length >= 2) { const x = num(g[0]), y = num(g[1]); if (isSjtsk(x, y)) return [x, y]; }
  if (typeof g === "string") {
    /* poi_layer posílá geom jako text "{lat: -965235.38, lon: -746849.01}" (není to platný JSON) */
    const lo = g.match(/\blon\b\s*["']?\s*:\s*["']?(-?[\d.]+)/i), la = g.match(/\blat\b\s*["']?\s*:\s*["']?(-?[\d.]+)/i);
    if (lo && la && isSjtsk(+lo[1], +la[1])) return [+lo[1], +la[1]];
    const m = g.match(/POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)/i); if (m && isSjtsk(+m[1], +m[2])) return [+m[1], +m[2]];
  }
  for (const [kx, ky] of [["lon", "lat"], ["x", "y"], ["X", "Y"]]) {
    const x = num(n[kx]), y = num(n[ky]); if (isSjtsk(x, y)) return [x, y];
  }
  return null;
}
/* Odpověď API má různé obaly (bulk dlaždice, result_items/ret, markers, případně JSON uložený jako text) –
   projdeme ji celou a sebereme každý objekt se souřadnicemi v S-JTSK. */
function collectPois(node, out, seen, depth = 0) {
  if (depth > 12 || node == null) return;
  if (typeof node === "string") {
    const s = node.trim();
    if ((s[0] === "{" || s[0] === "[") && s.length > 20) { try { collectPois(JSON.parse(s), out, seen, depth + 1); } catch (e) {} }
    else if (s.includes('class="cdata"') || s.includes("class='cdata'")) {
      const doc = new DOMParser().parseFromString(s, "text/html");
      doc.querySelectorAll(".cdata").forEach(c => { try { collectPois(JSON.parse(c.textContent), out, seen, depth + 1); } catch (e) {} });
    }
    return;
  }
  if (Array.isArray(node)) { for (const n of node) collectPois(n, out, seen, depth + 1); return; }
  if (typeof node !== "object") return;
  const pt = pointOf(node);
  if (pt) {
    const key = node.uuid || (node.id ?? node.pk ?? pt.join(",")) + "@" + (node.url_prefix || "");
    if (!seen.has(key)) { seen.add(key); out.push({ ...node, _xy: pt }); }
    return;
  }
  for (const k in node) collectPois(node[k], out, seen, depth + 1);
}
const pkrCache = new Map();
function loadPkr(def) {
  if (pkrCache.has(def.id)) return pkrCache.get(def.id);
  const url = PKR + def.path + "?" + PKR_PARAMS + (def.sub ? "&sublayers=" + encodeURIComponent(def.sub) : "");
  const p = (async () => {
    const r = await fetchCors(url);
    const txt = await r.text();
    let json;
    try { json = JSON.parse(txt); } catch (e) { throw new Error("Portál nevrátil JSON (" + txt.slice(0, 60).replace(/\s+/g, " ") + "…)"); }
    const items = []; collectPois(json, items, new Set());
    const feats = items.map(it => ({ it, ll: sjtsk2ll(it._xy[0], it._xy[1]) })).filter(f => isFinite(f.ll[0]) && isFinite(f.ll[1]));
    if (!feats.length) {
      /* pro ladění: začátek odpovědi do konzole a do tooltipu vrstvy */
      console.warn("[PKR " + def.label + "] 0 prvků, URL:", url, "\nodpověď:", txt.slice(0, 2000));
      (window.__pkrRaw ||= {})[def.id] = txt;
      feats.raw = txt.slice(0, 400);
    }
    return feats;
  })();
  p.catch(() => pkrCache.delete(def.id));
  pkrCache.set(def.id, p);
  return p;
}

/* HTML popupu z portálu: odstraníme skripty a handlery, relativní odkazy převedeme na absolutní */
function cleanPkrHtml(html, base) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,iframe,object,embed,form").forEach(n => n.remove());
  doc.querySelectorAll("*").forEach(el => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      else if ((a.name === "href" || a.name === "src") && a.value) {
        if (/^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
        else try { el.setAttribute(a.name, new URL(a.value, base).href); } catch (e) {}
      }
    }
    if (el.tagName === "A") { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener"); }
  });
  return doc.body.innerHTML;
}
function pkrDetailUrl(def, it) {
  return new URL(it.url_prefix && /\/\d+\/$/.test(it.url_prefix) ? it.url_prefix : (it.url_prefix || def.path) + (it.id ? it.id + "/" : ""), PKR).href;
}
async function pkrPopupHtml(def, it) {
  const base = PKR + (it.url_prefix || def.path);
  let html = it.popup;
  if (!html && it.popup_url) {
    const r = await fetchCors(new URL(it.popup_url, base).href);
    const txt = await r.text();
    try {
      const j = JSON.parse(txt);
      html = j?.result_items?.[0]?.ret?.[0]?.popup || "";
    } catch (e) { html = txt; }
  }
  const detail = pkrDetailUrl(def, it);
  return `<div class="pp pkr-pp">${html ? cleanPkrHtml(html, base) : `<h3>${esc(it.name || def.label)}</h3>`}` +
    `<p class="k">${esc(def.label)} · <a href="${esc(detail)}" target="_blank" rel="noopener">Detail v portálu</a></p></div>`;
}
const pkrIcons = new Map();
function pkrIcon(it, def) {
  const src = it.iu || def.ico;
  const iw = +it.iw || PKR_ICON_H, ih = +it.ih || PKR_ICON_H;
  const w = Math.round(PKR_ICON_H * iw / ih), key = src + "|" + w;
  if (!pkrIcons.has(key)) pkrIcons.set(key, L.icon({ iconUrl: PKR + src, iconSize:[w, PKR_ICON_H], iconAnchor:[w / 2, PKR_ICON_H / 2], popupAnchor:[0, -PKR_ICON_H / 2] }));
  return pkrIcons.get(key);
}
function buildPkrLayer(def, feats) {
  const g = L.layerGroup();
  for (const f of feats) {
    const m = L.marker(f.ll, { icon: pkrIcon(f.it, def), title: f.it.name || def.label, keyboard:false });
    m.bindPopup(`<div class="pp"><h3>${esc(f.it.name || def.label)}</h3><p class="k">Načítám detail…</p></div>`, { maxWidth: 360 });
    let loaded = false;
    m.on("popupopen", async () => {
      if (loaded) return; loaded = true;
      try { m.setPopupContent(await pkrPopupHtml(def, f.it)); }
      catch (e) { loaded = false; m.setPopupContent(`<div class="pp"><h3>${esc(f.it.name || def.label)}</h3><p class="k">Detail se nepodařilo načíst (${esc(e.message)}).</p></div>`); }
    });
    g.addLayer(m);
  }
  return { g, n: feats.length };
}

/* ================= statická data ZABAGED (/data/*.geojson) ================= */
const fileCache = new Map();
function loadFile(def) {
  if (!fileCache.has(def.file)) {
    const p = fetch("/data/" + def.file).then(r => { if (!r.ok) throw new Error("data/" + def.file + ": HTTP " + r.status); return r.json(); });
    p.catch(() => fileCache.delete(def.file));
    fileCache.set(def.file, p);
  }
  return fileCache.get(def.file);
}
function filePopup(def, p) {
  const [title, rws] = def.popup ? def.popup(p) : [def.label, []];
  return `<div class="pp"><h3>${esc(title || def.label)}</h3><p class="k">${esc(def.label)}</p>` +
    (rws.length ? `<dl>${rws.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : "") + `</div>`;
}
function buildFileLayer(def, fc) {
  const feats = (fc.features || []).filter(f => f.geometry && (!def.filter || def.filter(f.properties || {})));
  const g = L.layerGroup();
  if (def.icon) {
    icons[def.id] ||= L.divIcon({ className:"pt", html:def.icon, iconSize:[20, 20], iconAnchor:[10, 10], popupAnchor:[0, -8] });
    for (const f of feats) {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      g.addLayer(L.marker([lat, lon], { icon:icons[def.id], title:(def.popup ? def.popup(p)[0] : "") || def.label, keyboard:false })
        .bindPopup(() => filePopup(def, p)));
    }
    return { g, n: feats.length };
  }
  /* čáry/plochy: styl může být pole (lem + výplň) – kreslíme po vrstvách, aby lemy byly pod všemi výplněmi */
  const arr = s => Array.isArray(s) ? s : [s];
  const passes = Math.max(1, ...feats.map(f => arr(def.style(f.properties || {})).length));
  const fcFilt = { type:"FeatureCollection", features: feats };
  for (let i = 0; i < passes; i++) {
    const last = i === passes - 1;
    const lyr = L.geoJSON(fcFilt, {
      renderer, interactive: last,
      style: f => { const st = arr(def.style(f.properties || {}))[i]; return st ? { ...st, fill: def.kind === "area" && st.fill !== false } : { stroke:false, fill:false }; },
      onEachFeature: last ? (f, l) => l.bindPopup(() => filePopup(def, f.properties || {})) : undefined
    });
    g.addLayer(lyr);
  }
  return { g, n: feats.length };
}

/* ================= sloučené vrstvy IZS: ZABAGED + PKR ÚK ================= */
/* Body z obou zdrojů se spárují podle vzdálenosti (do MERGE_DIST m) – spárovaný objekt se kreslí jednou,
   v poloze ze ZABAGED a s názvem z portálu. Body jen z jednoho zdroje se kreslí také. */
const MERGE_DIST = 300;
const distM = (a, b) => { const kx = 111320 * Math.cos(a[0] * Math.PI / 180); return Math.hypot((a[1] - b[1]) * kx, (a[0] - b[0]) * 110540); };
async function loadMerged(def) {
  const pkrDef = { id: def.id + "__pkr", path: def.pkrSrc.path, sub: def.pkrSrc.sub, label: def.label };
  const [zab, pkr] = await Promise.allSettled([
    def.file ? loadFile(def) : Promise.resolve(null),
    loadPkr(pkrDef)
  ]);
  if (zab.status === "rejected" && pkr.status === "rejected") throw zab.reason;
  const pts = [];
  if (zab.status === "fulfilled" && zab.value) {
    for (const f of zab.value.features || []) {
      if (!f.geometry || (def.filter && !def.filter(f.properties || {}))) continue;
      const [lon, lat] = f.geometry.coordinates;
      pts.push({ ll:[lat, lon], p: f.properties || {}, it: null });
    }
  }
  const nZab = pts.length; let nPkr = 0, nPair = 0;
  if (pkr.status === "fulfilled") {
    for (const f of pkr.value) {
      nPkr++;
      let best = null, bd = MERGE_DIST;
      for (let i = 0; i < nZab; i++) { if (pts[i].it) continue; const d = distM(pts[i].ll, f.ll); if (d < bd) { bd = d; best = pts[i]; } }
      if (best) { best.it = f.it; nPair++; } else pts.push({ ll: f.ll, p: null, it: f.it });
    }
  }
  const info = [
    def.file ? `ZABAGED: ${zab.status === "fulfilled" ? nZab : "chyba – " + zab.reason?.message}` : null,
    `PKR ÚK: ${pkr.status === "fulfilled" ? nPkr : "chyba – " + pkr.reason?.message}`,
    def.file && nPair ? `spárováno: ${nPair}` : null
  ].filter(Boolean).join("\n");
  return { pts, info, pkrDef };
}
function buildMergedLayer(def, res) {
  const g = L.layerGroup();
  icons[def.id] ||= L.divIcon({ className:"pt", html:def.icon, iconSize:[20, 20], iconAnchor:[10, 10], popupAnchor:[0, -8] });
  for (const pt of res.pts) {
    const [t0, rws] = pt.p && def.popup ? def.popup(pt.p) : [null, []];
    const title = (pt.it && pt.it.name) || t0 || def.label;
    const m = L.marker(pt.ll, { icon: icons[def.id], title, keyboard:false });
    if (pt.p) {
      const link = pt.it ? ` · <a href="${esc(pkrDetailUrl(res.pkrDef, pt.it))}" target="_blank" rel="noopener">Detail v portálu</a>` : "";
      m.bindPopup(`<div class="pp"><h3>${esc(title)}</h3><p class="k">${esc(def.label)}${link}</p>` +
        (rws.length ? `<dl>${rws.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : "") +
        `<p class="k">Zdroj: ${pt.it ? "ZABAGED, PKR ÚK" : "ZABAGED"}</p></div>`);
    } else {
      /* bod jen z portálu – detail se načte z PKR */
      m.bindPopup(`<div class="pp"><h3>${esc(title)}</h3><p class="k">Načítám detail…</p></div>`, { maxWidth: 360 });
      let loaded = false;
      m.on("popupopen", async () => {
        if (loaded) return; loaded = true;
        try { m.setPopupContent(await pkrPopupHtml(res.pkrDef, pt.it)); }
        catch (e) { loaded = false; m.setPopupContent(`<div class="pp"><h3>${esc(title)}</h3><p class="k">Detail se nepodařilo načíst (${esc(e.message)}).</p></div>`); }
      });
    }
    g.addLayer(m);
  }
  return { g, n: res.pts.length };
}

async function toggleVector(id) {
  const s = state[id];
  if (!s.cb.checked) { if (s.layer) map.removeLayer(s.layer); return; }
  if (s.layer) { s.layer.addTo(map); return; }
  s.st.className = "st load"; s.st.textContent = " ve frontě";
  try {
    const feats = s.def.pkrSrc ? (s.st.textContent = " načítám", await loadMerged(s.def))
      : s.def.pkr ? (s.st.textContent = " načítám", await loadPkr(s.def))
      : s.def.file ? (s.st.textContent = " načítám", await loadFile(s.def))
      : await loadQuery(s.def.q, () => { if (s.st.classList.contains("load")) s.st.textContent = " načítám"; });
    const { g, n } = s.def.pkrSrc ? buildMergedLayer(s.def, feats) : s.def.pkr ? buildPkrLayer(s.def, feats) : s.def.file ? buildFileLayer(s.def, feats) : buildLayer(s.def, feats);
    if (s.def.pkrSrc) s.st.title = feats.info;
    if (s.def.pkr && !n && feats.raw) s.st.title = "Portál vrátil 0 bodů. Začátek odpovědi:\n" + feats.raw;
    s.layer = g; s.st.className = "st";
    if (s.def.q) s.st.title = "Načteno živě z OpenStreetMap (Overpass API)";
    /* u sloučených liniových dat ZABAGED počet prvků nic neříká – nezobrazujeme ho */
    s.st.textContent = s.def.file && s.def.kind === "line" ? "" : n.toLocaleString("cs");
    if (id === "kraj" && n) { krajBounds = g.getLayers()[0].getBounds(); if (!krajFitted) { krajFitted = true; map.fitBounds(krajBounds); } }
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
/* servery, o kterých víme, že CORS neposílají – rovnou přes proxy, bez zbytečné chyby v konzoli */
const NO_CORS_HOSTS = new Set(["pkr.kr-ustecky.cz"]);
async function fetchCors(url) {
  if (/^https?:$/.test(location.protocol) && NO_CORS_HOSTS.has(new URL(url).hostname)) {
    const r = await fetch("/api/proxy?url=" + encodeURIComponent(url));
    if (!r.ok) throw new Error("proxy HTTP " + r.status);
    return r;
  }
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
    if (name && !hasSub) {
      const lu = l.getElementsByTagName("LegendURL")[0]?.getElementsByTagName("OnlineResource")[0];
      const href = lu && (lu.getAttribute("xlink:href") || lu.getAttributeNS("http://www.w3.org/1999/xlink", "href"));
      const legend = href ? [{ src: href, label: "" }]
        : [{ src: url + (url.includes("?") ? "&" : "?") + "SERVICE=WMS&REQUEST=GetLegendGraphic&VERSION=1.1.1&FORMAT=image/png&LAYER=" + encodeURIComponent(name), label: "" }];
      out.push({ name, title: kids.find(c => c.localName === "Title")?.textContent || name, legend });
    }
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
  const out = (j.layers || []).filter(l => !l.subLayerIds || !l.subLayerIds.length).map(l => ({ name:String(l.id), title:l.name, legend:[] }));
  if (!out.length) throw new Error("Služba nevrátila žádné vrstvy");
  /* legenda ArcGIS: symboly jako base64 obrázky přímo z renderovacího stylu služby */
  try {
    const lj = await (await fetchCors(url + "/legend?f=json")).json();
    const byId = new Map((lj.layers || []).map(l => [String(l.layerId), l.legend || []]));
    for (const l of out) l.legend = (byId.get(l.name) || []).map(e => ({ src:`data:${e.contentType || "image/png"};base64,${e.imageData}`, label:e.label || "" }));
  } catch (e) { console.warn("[Legenda] " + url, e.message); }
  return out;
}
function addWms(cfg) {
  const wrap = document.createElement("div");
  const row = document.createElement("label"); row.className = "item";
  row.innerHTML = `<input type="checkbox"><span class="sw"><svg class="sws" width="28" height="18" viewBox="0 0 28 18" aria-hidden="true"><rect x="1" y="1" width="26" height="16" rx="1.5" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="2 2"/></svg></span><span class="lbl">${esc(cfg.label)}${cfg.note ? `<small>${esc(cfg.note)}</small>` : ""}</span><span class="st"></span>`;
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
    sub.innerHTML = layers.map(l => `<label><input type="checkbox" data-n="${esc(l.name)}" ${chosen.has(l.name) ? "checked" : ""}><span>${esc(l.title)}${
        (l.legend || []).length ? `<span class="wleg">${l.legend.map(e => `<span class="wleg-row"><img src="${esc(e.src)}" alt="" loading="lazy" onerror="this.parentNode.remove()">${e.label ? `<span>${esc(e.label)}</span>` : ""}</span>`).join("")}</span>` : ""
      }</span></label>`).join("") +
      `<div class="op">Průhlednost<input type="range" min="0.1" max="1" step="0.05" value="0.7" aria-label="Průhlednost vrstvy"></div>`;
    sub.querySelectorAll("input[type=checkbox]").forEach(c => c.addEventListener("change", () => {
      s.names = [...sub.querySelectorAll("input[type=checkbox]:checked")].map(x => x.dataset.n);
      if (!s.names.length) { if (s.layer) map.removeLayer(s.layer); return; }
      if (s.layer) {
        if (s.cfg.type === "arcgis") s.layer.setShow(s.names.join(",")); else s.layer.setParams({ layers: s.names.join(",") });
        if (!map.hasLayer(s.layer)) s.layer.addTo(map);
      } else mountWms(s);
    }));
    const syncLegendOpacity = v => sub.querySelectorAll(".wleg img").forEach(img => img.style.opacity = v);
    syncLegendOpacity(.7);
    sub.querySelector("input[type=range]").addEventListener("input", e => { s.layer && s.layer.setOpacity(+e.target.value); syncLegendOpacity(e.target.value); });
    /* hlavní symbol řádku = první symbol z legendy služby */
    const first = layers.flatMap(l => l.legend || [])[0];
    if (first) row.querySelector(".sw").innerHTML = `<img class="wsym" src="${esc(first.src)}" alt="" onerror="this.remove()">`;
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

/* ================= start ================= */
for (const id in state) if (state[id].cb.checked) toggleVector(id);

/* mobil */
const tg = document.getElementById("toggle");
tg.addEventListener("click", () => { const o = document.body.classList.toggle("open"); tg.setAttribute("aria-expanded", String(o)); tg.textContent = o ? "Mapa" : "Vrstvy"; });