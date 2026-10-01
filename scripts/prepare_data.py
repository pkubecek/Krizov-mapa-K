"""Příprava dat ZABAGED pro webovou mapu.
Vstup: GeoJSON exporty (WGS84) ve složce zdroje/, výstup: zjednodušené GeoJSON do data/.
Spuštění: python scripts/prepare_data.py <slozka_se_zdroji>
"""
import json, sys, os, glob, collections
from shapely.geometry import shape, mapping
from shapely.ops import linemerge, unary_union

SRC = sys.argv[1] if len(sys.argv) > 1 else "zdroje"
OUT = os.path.join(os.path.dirname(__file__), "..", "data")
PREC = 5            # ~1 m
SIMPL_LINE = 0.00004  # ~3–4 m
SIMPL_AREA = 0.00003

def src(name):
    m = [f for f in glob.glob(os.path.join(SRC, "*.geojson")) if name.lower() in os.path.basename(f).lower()]
    if not m: raise SystemExit("Chybí soubor " + name)
    return json.load(open(m[0], encoding="utf-8"))["features"]

def clean(v):
    if v in (None, "None", ""): return None
    return v.strip() if isinstance(v, str) else v

def rnd(o):
    if isinstance(o, float): return round(o, PREC)
    if isinstance(o, (list, tuple)): return [rnd(x) for x in o]
    return o

def feat(geom, props):
    g = mapping(geom); g["coordinates"] = rnd(g["coordinates"])
    return {"type": "Feature", "properties": {k: v for k, v in props.items() if v is not None}, "geometry": g}

def write(name, feats):
    path = os.path.join(OUT, name)
    json.dump({"type": "FeatureCollection", "features": feats}, open(path, "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    print(f"{name:28s} {len(feats):6d} prvků  {os.path.getsize(path)/1e6:6.2f} MB")

def merge(geoms):
    u = unary_union(geoms)
    return linemerge(u) if u.geom_type == "MultiLineString" else u

def points(name, out, fields):
    fs = []
    for f in src(name):
        p = f["properties"]
        fs.append(feat(shape(f["geometry"]), {k: clean(p.get(src_k)) for k, src_k in fields.items()}))
    write(out, fs)

# --- hranice kraje
k = src("UsteckyKraj")[0]
write("kraj.geojson", [feat(shape(k["geometry"]).simplify(0.00005, preserve_topology=True), {"nazev": clean(k["properties"].get("nazev"))})])

# --- vodní toky: bez podzemních úseků, spojené podle jména a třídy
groups = collections.defaultdict(list)
for f in src("VodniTok"):
    p = f["properties"]
    if p.get("typtoku_p") == "podzemní": continue
    jm = clean(p.get("jmeno"))
    tr = "splavny" if p.get("typtoku_p") == "povrchový splavný" else ("stály" if p.get("vydattok_p") == "stálý" else "obcasny")
    groups[(jm, tr, None)].append(shape(f["geometry"]))
named, other = [], []
for (jm, tr, _), geoms in groups.items():
    merged = merge(geoms) if jm else unary_union(geoms)
    merged = merged.simplify(SIMPL_LINE, preserve_topology=False)
    (named if jm else other).append(feat(merged, {"jmeno": jm, "trida": tr}))
write("vodni_toky.geojson", named)
write("vodni_toky_ostatni.geojson", other)

# --- vodní plochy
fs = []
for f in src("VodniPlocha"):
    p = f["properties"]
    g = shape(f["geometry"]).simplify(SIMPL_AREA, preserve_topology=True)
    if g.is_empty: continue
    fs.append(feat(g, {"jmeno": clean(p.get("jmeno")), "typ": clean(p.get("typ_vp_p")),
                       "ha": round(float(p.get("Shape_Area") or 0) / 10000, 2)}))
write("vodni_plochy.geojson", fs)

# --- železnice: sloučené podle elektrizace
groups = collections.defaultdict(list)
for f in src("ZeleznicniTrat"):
    p = f["properties"]
    groups[p.get("typtrati_p") == "elektrizovaná trať/vlečka"].append(shape(f["geometry"]))
write("zeleznice.geojson", [feat(merge(g).simplify(SIMPL_LINE), {"elektr": int(e)}) for e, g in groups.items()])

# --- silnice: sloučené podle čísla a třídy
groups = collections.defaultdict(list)
for f in src("SilniceDalnice"):
    p = f["properties"]
    t = p.get("typsil_p") or ""
    trida = "D1" if t.startswith("dálnice I.") else "D2" if t.startswith("dálnice II.") else "I"
    vetev = int("větev" in t or "paprsek" in t)
    groups[(clean(p.get("silnice")), trida, vetev)].append(shape(f["geometry"]))
write("silnice.geojson", [feat(merge(g).simplify(SIMPL_LINE), {"cislo": c, "trida": t, "vetev": v})
                          for (c, t, v), g in groups.items()])

# --- bodové vrstvy
points("Elektrarna", "elektrarny.geojson", {"jmeno": "jmeno", "typ": "podtypel_p", "vykon": "vykon"})
points("Hasicska", "hasici.geojson", {"typ": "typjpo_k", "typ_p": "typjpo_p", "obec": "nazevobce", "id_jpo": "id_jpo"})
points("Nemocnice", "nemocnice.geojson", {"nazev": "nazev", "typ": "drzar_p"})
points("Policejni", "policie.geojson", {"nazev": "nazev_ps", "typ": "typps_k", "typ_p": "typps_p"})
points("Heliport", "heliporty.geojson", {"kod": "kod", "nazev": "nazev", "typ": "typhel_k", "typ_p": "typhel_p",
                                          "upres": "upreshel", "nocni": "nocni", "vyska": "nadm_vyska"})
