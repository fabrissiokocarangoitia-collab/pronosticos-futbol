"""
Descarga los partidos de ESPN, entrena el modelo y deja los datos listos para la página.

Uso:  python actualizar.py
Sale:  web/datos/modelo.json      (fuerza de cada equipo, partidos próximos, historial corto)
       web/datos/historial.json   (pronósticos guardados y qué tanto acertaron)
Guarda: datos/partidos.json       (detalle de cada partido jugado, para no volver a bajarlo)
"""
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

RAIZ = os.path.dirname(os.path.abspath(__file__))
ARCHIVO_PARTIDOS = os.path.join(RAIZ, "datos", "partidos.json")
SALIDA = os.path.join(RAIZ, "web", "datos")
API = "https://site.api.espn.com/apis/site/v2/sports/soccer"

# código ESPN, nombre, país, tipo
COMPETICIONES = [
    ("per.1", "Liga 1", "Perú", "liga"),
    ("conmebol.libertadores", "Copa Libertadores", "Sudamérica", "copa"),
    ("conmebol.sudamericana", "Copa Sudamericana", "Sudamérica", "copa"),
    ("uefa.champions", "Champions League", "Europa", "copa"),
    ("uefa.europa", "Europa League", "Europa", "copa"),
    ("eng.1", "Premier League", "Inglaterra", "liga"),
    ("esp.1", "LaLiga", "España", "liga"),
    ("ita.1", "Serie A", "Italia", "liga"),
    ("ger.1", "Bundesliga", "Alemania", "liga"),
    ("fra.1", "Ligue 1", "Francia", "liga"),
    ("por.1", "Primeira Liga", "Portugal", "liga"),
    ("ned.1", "Eredivisie", "Países Bajos", "liga"),
    ("tur.1", "Süper Lig", "Turquía", "liga"),
    ("bra.1", "Brasileirão", "Brasil", "liga"),
    ("arg.1", "Liga Profesional", "Argentina", "liga"),
    ("col.1", "Liga BetPlay", "Colombia", "liga"),
    ("chi.1", "Primera División", "Chile", "liga"),
    ("mex.1", "Liga MX", "México", "liga"),
    ("usa.1", "MLS", "Estados Unidos", "liga"),
]
TIPO = {c[0]: c[3] for c in COMPETICIONES}
TEMPORADAS = [2025, 2026]
DIAS_HISTORIA = 420       # partidos más viejos que esto no se usan
VIDA_MEDIA = 200          # un partido de hace 200 días pesa la mitad que uno de hoy
DIAS_PROXIMOS = 10
RHO = -0.10               # corrección Dixon-Coles para marcadores bajos (0-0, 1-1...)
LIMA = timezone(timedelta(hours=-5))


# ---------------------------------------------------------------- descarga

def bajar(url, intentos=3):
    for i in range(intentos):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 pronosticos-futbol"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            if i == intentos - 1:
                return None
            time.sleep(1.5 * (i + 1))


def en_paralelo(funcion, cosas, hilos=12):
    with ThreadPoolExecutor(hilos) as ex:
        return list(ex.map(funcion, cosas))


def logo_de(team):
    logos = team.get("logos") or []
    if logos:
        return logos[0].get("href")
    return team.get("logo")


def puntaje(comp):
    s = comp.get("score")
    if isinstance(s, dict):
        return int(s.get("value", 0))
    try:
        return int(s)
    except (TypeError, ValueError):
        return None


def leer_evento(ev, codigo, equipos):
    """Saca lo básico de un evento de ESPN (vale para calendario y para el marcador del día)."""
    c = ev["competitions"][0]
    lados = {x["homeAway"]: x for x in c["competitors"]}
    if "home" not in lados or "away" not in lados:
        return None
    for x in lados.values():
        t = x["team"]
        info = equipos.setdefault(t["id"], {})
        info["n"] = t.get("displayName") or info.get("n")
        info["ab"] = t.get("abbreviation") or info.get("ab")
        if logo_de(t):
            info["logo"] = logo_de(t)
    estado = c.get("status", ev.get("status", {})).get("type", {})
    return {
        "id": ev["id"],
        "f": ev["date"],
        "c": codigo,
        "h": lados["home"]["team"]["id"],
        "a": lados["away"]["team"]["id"],
        "n": 1 if c.get("neutralSite") else 0,
        "v": (c.get("venue") or {}).get("fullName"),
        "estado": estado.get("state"),
        "fin": bool(estado.get("completed")),
        "g": [puntaje(lados["home"]), puntaje(lados["away"])],
    }


def detalle(partido):
    """Baja el resumen del partido: goles por tiempo, córners, tarjetas, tiros, goleadores, quién jugó."""
    d = bajar(f"{API}/{partido['c']}/summary?event={partido['id']}")
    if not d:
        return None
    out = {}
    try:
        comp = d["header"]["competitions"][0]
        lados = {x["homeAway"]: x for x in comp["competitors"]}
        ht = []
        for lado in ("home", "away"):
            ls = lados[lado].get("linescores") or []
            ht.append(int(float(ls[0]["displayValue"])) if ls else None)
        out["m"] = ht if None not in ht else None
        stats = {}
        for t in d.get("boxscore", {}).get("teams", []):
            stats[t["team"]["id"]] = {s["name"]: s.get("displayValue") for s in t.get("statistics", [])}

        def par(nombre):
            try:
                return [int(float(stats[partido["h"]][nombre])), int(float(stats[partido["a"]][nombre]))]
            except (KeyError, TypeError, ValueError):
                return None

        out["k"] = par("wonCorners")
        out["y"] = par("yellowCards")
        out["r"] = par("redCards")
        out["s"] = par("totalShots")
        out["t"] = par("shotsOnTarget")
        goles = []
        for det in comp.get("details", []):
            if not det.get("scoringPlay") or det.get("shootout"):
                continue
            atl = (det.get("participants") or [{}])[0].get("athlete", {})
            minuto = (det.get("clock") or {}).get("displayValue", "")
            goles.append({
                "eq": det.get("team", {}).get("id"),
                "j": None if det.get("ownGoal") else atl.get("id"),
                "nom": atl.get("displayName"),
                "min": minuto,
                "pen": 1 if det.get("penaltyKick") else 0,
            })
        out["gol"] = goles
        jug = {}
        nombres = {}
        for r in d.get("rosters", []):
            tid = r["team"]["id"]
            lista = []
            for p in r.get("roster", []):
                a = p.get("athlete", {})
                if p.get("starter"):
                    lista.append([a.get("id"), 1])
                elif p.get("subbedIn"):
                    lista.append([a.get("id"), 0])
                if a.get("id"):
                    nombres[a["id"]] = a.get("displayName")
            jug[tid] = lista
        out["jug"] = jug
        out["nombres"] = nombres
        out["det"] = 1
    except Exception:
        return None
    return out


def descargar():
    hoy = datetime.now(timezone.utc)
    limite = hoy - timedelta(days=DIAS_HISTORIA)
    guardado = {"partidos": {}, "equipos": {}, "jugadores": {}}
    if os.path.exists(ARCHIVO_PARTIDOS):
        with open(ARCHIVO_PARTIDOS, encoding="utf-8") as f:
            guardado = json.load(f)
    partidos = guardado["partidos"]
    equipos = guardado["equipos"]
    jugadores = guardado["jugadores"]

    print("1/4 Lista de equipos por competición...")
    listas = en_paralelo(lambda c: (c[0], bajar(f"{API}/{c[0]}/teams?limit=100")), COMPETICIONES)
    tareas = []
    for codigo, d in listas:
        if not d:
            print(f"   ! no se pudo bajar la lista de {codigo}")
            continue
        for t in d["sports"][0]["leagues"][0]["teams"]:
            t = t["team"]
            info = equipos.setdefault(t["id"], {})
            info["n"] = t.get("displayName")
            info["ab"] = t.get("abbreviation")
            if logo_de(t):
                info["logo"] = logo_de(t)
            for temp in TEMPORADAS:
                tareas.append((codigo, t["id"], temp))

    print(f"2/4 Calendarios de cada equipo ({len(tareas)} consultas)...")
    calendarios = en_paralelo(
        lambda x: (x[0], bajar(f"{API}/{x[0]}/teams/{x[1]}/schedule?season={x[2]}")), tareas)
    for codigo, d in calendarios:
        for ev in (d or {}).get("events", []):
            p = leer_evento(ev, codigo, equipos)
            if not p or not p["fin"] or None in p["g"]:
                continue
            if datetime.fromisoformat(p["f"].replace("Z", "+00:00")) < limite:
                continue
            viejo = partidos.get(p["id"])
            if viejo and viejo.get("det"):
                continue
            p.pop("estado"), p.pop("fin")
            partidos[p["id"]] = {**(viejo or {}), **p}

    faltan = [p for p in partidos.values() if not p.get("det")]
    print(f"3/4 Detalle de {len(faltan)} partidos nuevos (puede tardar la primera vez)...")
    detalles = en_paralelo(detalle, faltan, hilos=16)
    for p, d in zip(faltan, detalles):
        if d:
            jugadores.update(d.pop("nombres"))
            p.update(d)

    # se borran los partidos que ya salieron de la ventana
    for pid in [k for k, p in partidos.items()
                if datetime.fromisoformat(p["f"].replace("Z", "+00:00")) < limite]:
        del partidos[pid]

    print("4/4 Partidos de los próximos días...")
    fechas = [(hoy.astimezone(LIMA) + timedelta(days=i)).strftime("%Y%m%d") for i in range(-1, DIAS_PROXIMOS)]
    consultas = [(c[0], f) for c in COMPETICIONES for f in fechas]
    tableros = en_paralelo(lambda x: (x[0], bajar(f"{API}/{x[0]}/scoreboard?dates={x[1]}")), consultas)
    proximos = {}
    for codigo, d in tableros:
        for ev in (d or {}).get("events", []):
            p = leer_evento(ev, codigo, equipos)
            if p and p["estado"] == "pre":
                p.pop("fin"), p.pop("estado"), p.pop("g")
                proximos[p["id"]] = p

    os.makedirs(os.path.dirname(ARCHIVO_PARTIDOS), exist_ok=True)
    with open(ARCHIVO_PARTIDOS, "w", encoding="utf-8") as f:
        json.dump(guardado, f, ensure_ascii=False, separators=(",", ":"))
    return partidos, equipos, jugadores, sorted(proximos.values(), key=lambda p: p["f"])


# ---------------------------------------------------------------- modelo

def fecha(p):
    return datetime.fromisoformat(p["f"].replace("Z", "+00:00"))


def liga_de_cada_equipo(partidos):
    """La liga local de cada equipo es la de su partido de liga más reciente."""
    ultima = {}
    for p in partidos:
        if TIPO.get(p["c"]) != "liga":
            continue
        for t in (p["h"], p["a"]):
            if t not in ultima or p["f"] > ultima[t][0]:
                ultima[t] = (p["f"], p["c"])
    ligas = {t: v[1] for t, v in ultima.items()}
    for p in partidos:  # equipos que solo vemos en copas (ej. de Bolivia o Ecuador)
        for t in (p["h"], p["a"]):
            ligas.setdefault(t, "otros:" + p["c"])
    return ligas


def ajustar(filas, sd_equipo=0.35, sd_liga=0.45, vueltas=80):
    """
    Modelo de Poisson: lo esperado del local = exp(mu + localía + ataque_local - defensa_visita).
    filas: (local, visita, competicion, liga_local, liga_visita, valor_local, valor_visita, peso, neutral)
    """
    mu = math.log(max(1e-6, sum(f[5] + f[6] for f in filas) / (2 * max(1, len(filas)))))
    h, A, D, a, d = {}, {}, {}, {}, {}
    for f in filas:
        h.setdefault(f[2], 0.25)
        for lg in (f[3], f[4]):
            A.setdefault(lg, 0.0), D.setdefault(lg, 0.0)
        for t in (f[0], f[1]):
            a.setdefault(t, 0.0), d.setdefault(t, 0.0)

    def esperados():
        out = []
        for f in filas:
            loc = 0 if f[8] else h[f[2]]
            lh = math.exp(mu + loc + A[f[3]] + a[f[0]] - D[f[4]] - d[f[1]])
            la = math.exp(mu + A[f[4]] + a[f[1]] - D[f[3]] - d[f[0]])
            out.append((lh, la))
        return out

    def paso(grupo, sd, contribuciones):
        g = {k: 0.0 for k in grupo}
        H = {k: 0.0 for k in grupo}
        for f, (lh, la) in zip(filas, esperados()):
            for clave, signo, y, lam in contribuciones(f, lh, la):
                g[clave] += f[7] * signo * (y - lam)
                H[clave] += f[7] * lam
        mayor = 0.0
        for k in grupo:
            gg = g[k] - (grupo[k] / sd ** 2 if sd else 0)
            hh = H[k] + (1 / sd ** 2 if sd else 0)
            if hh > 0:
                delta = max(-1.0, min(1.0, gg / hh))
                grupo[k] += delta
                mayor = max(mayor, abs(delta))
        return mayor

    for _ in range(vueltas):
        cambio = 0.0
        tot_y = sum(f[7] * (f[5] + f[6]) for f in filas)
        tot_l = sum(filas[i][7] * (lh + la) for i, (lh, la) in enumerate(esperados()))
        if tot_l > 0 and tot_y > 0:
            mu += math.log(tot_y / tot_l)
        cambio = max(cambio, paso(h, 1.0, lambda f, lh, la: [] if f[8] else [(f[2], 1, f[5], lh)]))
        cambio = max(cambio, paso(A, sd_liga, lambda f, lh, la: [(f[3], 1, f[5], lh), (f[4], 1, f[6], la)]))
        cambio = max(cambio, paso(D, sd_liga, lambda f, lh, la: [(f[4], -1, f[5], lh), (f[3], -1, f[6], la)]))
        cambio = max(cambio, paso(a, sd_equipo, lambda f, lh, la: [(f[0], 1, f[5], lh), (f[1], 1, f[6], la)]))
        cambio = max(cambio, paso(d, sd_equipo, lambda f, lh, la: [(f[1], -1, f[5], lh), (f[0], -1, f[6], la)]))
        if cambio < 1e-4:
            break

    resid, cuad = 0.0, 0.0
    for f, (lh, la) in zip(filas, esperados()):
        for y, lam in ((f[5], lh), (f[6], la)):
            resid += f[7] * ((y - lam) ** 2 - lam)
            cuad += f[7] * lam ** 2
    inv_r = resid / cuad if cuad else 0
    dispersion = round(1 / inv_r, 2) if inv_r > 0.002 else None  # None = Poisson puro
    return {"mu": mu, "h": h, "A": A, "D": D, "a": a, "d": d, "r": dispersion}


def filas_de(partidos, ligas, clave, hoy):
    filas = []
    for p in partidos:
        v = p.get(clave)
        if not v or None in v:
            continue
        dias = max(0.0, (hoy - fecha(p)).total_seconds() / 86400)
        filas.append((p["h"], p["a"], p["c"], ligas[p["h"]], ligas[p["a"]], v[0], v[1],
                      0.5 ** (dias / VIDA_MEDIA), p.get("n", 0)))
    return filas


def fuerza(m, equipo, liga):
    return (m["A"].get(liga, 0) + m["a"].get(equipo, 0), m["D"].get(liga, 0) + m["d"].get(equipo, 0))


def esperado(m, comp, ligas, local, visita, neutral):
    ah, dh = fuerza(m, local, ligas.get(local))
    aa, da = fuerza(m, visita, ligas.get(visita))
    loc = 0 if neutral else m["h"].get(comp, m["h"].get(ligas.get(local), 0.25))
    return math.exp(m["mu"] + loc + ah - da), math.exp(m["mu"] + aa - dh)


def poisson(lam, hasta=10):
    return [math.exp(-lam) * lam ** k / math.factorial(k) for k in range(hasta + 1)]


def matriz(lh, la):
    ph, pa = poisson(lh), poisson(la)
    M = [[ph[i] * pa[j] for j in range(11)] for i in range(11)]
    M[0][0] *= 1 - lh * la * RHO
    M[0][1] *= 1 + lh * RHO
    M[1][0] *= 1 + la * RHO
    M[1][1] *= 1 - RHO
    s = sum(map(sum, M))
    return [[x / s for x in fila] for fila in M]


def negbin_cola(media, r, umbral):
    """P(X > umbral) para conteos como córners (binomial negativa; Poisson si r es None)."""
    acum = 0.0
    for k in range(int(math.floor(umbral)) + 1):
        if r:
            lp = (math.lgamma(k + r) - math.lgamma(k + 1) - math.lgamma(r)
                  + r * math.log(r / (r + media)) + k * math.log(media / (r + media)))
        else:
            lp = -media + k * math.log(media) - math.lgamma(k + 1)
        acum += math.exp(lp)
    return 1 - acum


def mercados_clave(goles, corners, ligas, p):
    lh, la = esperado(goles, p["c"], ligas, p["h"], p["a"], p.get("n"))
    M = matriz(lh, la)
    p1 = sum(M[i][j] for i in range(11) for j in range(11) if i > j)
    px = sum(M[i][i] for i in range(11))
    out = {
        "1": p1, "X": px, "2": 1 - p1 - px,
        "o25": sum(M[i][j] for i in range(11) for j in range(11) if i + j > 2),
        "btts": sum(M[i][j] for i in range(1, 11) for j in range(1, 11)),
    }
    if corners:
        ch, ca = esperado(corners, p["c"], ligas, p["h"], p["a"], p.get("n"))
        r = corners["r"] * (ch + ca) ** 2 / (ch * ch + ca * ca) if corners["r"] else None
        out["c95"] = negbin_cola(ch + ca, r, 9.5)
    return {k: round(v, 4) for k, v in out.items()}


def entrenar(partidos, hoy):
    ligas = liga_de_cada_equipo(partidos)
    goles = ajustar(filas_de(partidos, ligas, "g", hoy))
    corners = ajustar(filas_de(partidos, ligas, "k", hoy), sd_equipo=0.25, sd_liga=0.3, vueltas=50)
    tarjetas = ajustar(filas_de(partidos, ligas, "y", hoy), sd_equipo=0.25, sd_liga=0.3, vueltas=50)
    return ligas, goles, corners, tarjetas


def evaluar(registros):
    """Resumen de aciertos: favorito 1X2, Brier y calibración por tramos."""
    hechos = [r for r in registros if r.get("res")]
    if not hechos:
        return {"n": 0}
    acierto, brier = 0, 0.0
    tramos = {}
    for r in hechos:
        hg, ag = r["res"]["g"]
        real = "1" if hg > ag else ("X" if hg == ag else "2")
        prob = r["p"]
        fav = max(("1", "X", "2"), key=lambda k: prob[k])
        acierto += fav == real
        brier += sum((prob[k] - (1 if k == real else 0)) ** 2 for k in ("1", "X", "2"))
        casos = [(prob[k], k == real) for k in ("1", "X", "2")]
        casos += [(prob["o25"], hg + ag > 2.5), (prob["btts"], hg > 0 and ag > 0)]
        if "c95" in prob and r["res"].get("k"):
            casos.append((prob["c95"], sum(r["res"]["k"]) > 9.5))
        for pr, ok in casos:
            t = min(9, int(pr * 10))
            b = tramos.setdefault(t, [0, 0, 0.0])
            b[0] += 1
            b[1] += ok
            b[2] += pr
    return {
        "n": len(hechos),
        "acierto_favorito": round(acierto / len(hechos), 3),
        "brier": round(brier / len(hechos), 3),
        "calibracion": [{"desde": t / 10, "casos": b[0], "dijo": round(b[2] / b[0], 3),
                         "paso": round(b[1] / b[0], 3)} for t, b in sorted(tramos.items())],
    }


# ---------------------------------------------------------------- jugadores

def goleadores(partidos, hoy):
    """Goles y partidos jugados (con peso por antigüedad) de cada jugador en cada equipo."""
    por_equipo = {}
    ultimos = {}
    for p in sorted(partidos, key=lambda x: x["f"]):
        if not p.get("det") or not p.get("jug"):
            continue
        w = 0.5 ** (max(0, (hoy - fecha(p)).days) / VIDA_MEDIA)
        for tid, lista in p["jug"].items():
            eq = por_equipo.setdefault(tid, {"pj": 0.0, "goles": 0.0, "jug": {}})
            eq["pj"] += w
            ultimos.setdefault(tid, []).append({j[0] for j in lista})
            for jid, titular in lista:
                j = eq["jug"].setdefault(jid, {"pj": 0.0, "gw": 0.0, "goles": 0, "partidos": 0})
                j["pj"] += w * (1 if titular else 0.35)
                j["partidos"] += 1
        for g in p.get("gol", []):
            eq = por_equipo.get(g["eq"])
            if not eq:
                continue
            eq["goles"] += w
            if g["j"] and g["j"] in eq["jug"]:
                eq["jug"][g["j"]]["gw"] += w
                eq["jug"][g["j"]]["goles"] += 1
    return por_equipo, ultimos


# ---------------------------------------------------------------- salida

def redondear(dic, n=4):
    return {k: round(v, n) for k, v in dic.items()}


def main():
    inicio = time.time()
    hoy = datetime.now(timezone.utc)
    partidos_d, equipos, jugadores, proximos = descargar()
    partidos = list(partidos_d.values())
    print(f"   {len(partidos)} partidos jugados, {len(proximos)} por jugarse.")

    print("Entrenando el modelo...")
    ligas, goles, corners, tarjetas = entrenar(partidos, hoy)

    # mitad de goles que cae en el primer tiempo, por competición
    primer_tiempo = {}
    tot1 = tot = 0
    for p in partidos:
        if p.get("m") and None not in p["m"]:
            t1, t = sum(p["m"]), sum(p["g"])
            tot1 += t1
            tot += t
            x = primer_tiempo.setdefault(p["c"], [0, 0])
            x[0] += t1
            x[1] += t
    global_1t = tot1 / tot if tot else 0.44
    frac_1t = {c: (v[0] + 40 * global_1t) / (v[1] + 40) for c, v in primer_tiempo.items()}

    por_equipo, ultimos = goleadores(partidos, hoy)
    salida_equipos = {}
    for tid, info in equipos.items():
        if tid not in ligas:
            continue
        lg = ligas[tid]
        ga, gd = fuerza(goles, tid, lg)
        ca, cd = fuerza(corners, tid, lg)
        ta, td = fuerza(tarjetas, tid, lg)
        lista = []
        eq = por_equipo.get(tid)
        if eq and eq["pj"] > 0:
            recientes = set().union(*ultimos[tid][-5:])
            prom_goles = eq["goles"] / eq["pj"]
            for jid, j in eq["jug"].items():
                if j["goles"] == 0 or j["pj"] < 1.5 or jid not in recientes:
                    continue
                lista.append({"id": jid, "n": jugadores.get(jid, "?"), "goles": j["goles"],
                              "pj": j["partidos"],
                              "tasa": round((j["gw"] / j["pj"]) / max(prom_goles, 0.3), 4)})
            lista.sort(key=lambda x: -x["tasa"] * min(1, x["pj"] / 6))
        salida_equipos[tid] = {
            "n": info.get("n"), "ab": info.get("ab"), "logo": info.get("logo"), "lg": lg,
            "g": [round(ga, 4), round(gd, 4)], "k": [round(ca, 4), round(cd, 4)],
            "y": [round(ta, 4), round(td, 4)], "jug": lista[:8],
        }

    res = []
    for p in sorted(partidos, key=lambda x: x["f"]):
        res.append([p["id"], p["f"][:16], p["c"], p["h"], p["a"], p["g"][0], p["g"][1],
                    p.get("m"), p.get("k"), p.get("y"), p.get("n", 0)])

    comps = {}
    for codigo, nombre, pais, tipo in COMPETICIONES:
        comps[codigo] = {"n": nombre, "p": pais, "t": tipo,
                         "h": round(goles["h"].get(codigo, 0.25), 4),
                         "hk": round(corners["h"].get(codigo, 0.05), 4),
                         "hy": round(tarjetas["h"].get(codigo, -0.1), 4),
                         "f1": round(frac_1t.get(codigo, global_1t), 4)}

    modelo = {
        "generado": hoy.isoformat(timespec="minutes"),
        "rho": RHO,
        "goles": {"mu": round(goles["mu"], 4), "r": goles["r"]},
        "corners": {"mu": round(corners["mu"], 4), "r": corners["r"]},
        "tarjetas": {"mu": round(tarjetas["mu"], 4), "r": tarjetas["r"]},
        "f1": round(global_1t, 4),
        "comps": comps,
        "equipos": salida_equipos,
        "proximos": [[p["id"], p["f"][:16], p["c"], p["h"], p["a"], p.get("n", 0), p.get("v")]
                     for p in proximos if p["h"] in salida_equipos and p["a"] in salida_equipos],
        "res": res,
    }
    os.makedirs(SALIDA, exist_ok=True)
    with open(os.path.join(SALIDA, "modelo.json"), "w", encoding="utf-8") as f:
        json.dump(modelo, f, ensure_ascii=False, separators=(",", ":"))

    # ---- historial: se guarda el pronóstico antes del partido y luego se compara
    ruta_hist = os.path.join(SALIDA, "historial.json")
    hist = {"guardados": {}}
    if os.path.exists(ruta_hist):
        with open(ruta_hist, encoding="utf-8") as f:
            hist = json.load(f)
    for p in proximos:
        if p["h"] in ligas and p["a"] in ligas and fecha(p) - hoy < timedelta(days=4):
            hist["guardados"][p["id"]] = {"f": p["f"], "c": p["c"], "h": p["h"], "a": p["a"],
                                          "p": mercados_clave(goles, corners, ligas, p)}
    for pid, r in hist["guardados"].items():
        if pid in partidos_d and not r.get("res"):
            r["res"] = {"g": partidos_d[pid]["g"], "k": partidos_d[pid].get("k")}
    hist["real"] = evaluar(list(hist["guardados"].values()))

    # ---- prueba con el pasado: se entrena sin los últimos 45 días y se pronostican esos días
    corte = hoy - timedelta(days=45)
    antes = [p for p in partidos if fecha(p) < corte]
    despues = [p for p in partidos if fecha(p) >= corte]
    l2, g2, c2, _ = entrenar(antes, corte)
    prueba = []
    for p in despues:
        if p["h"] in l2 and p["a"] in l2:
            prueba.append({"p": mercados_clave(g2, c2, l2, p), "res": {"g": p["g"], "k": p.get("k")}})
    hist["prueba"] = evaluar(prueba)
    hist["prueba"]["desde"] = corte.date().isoformat()
    with open(ruta_hist, "w", encoding="utf-8") as f:
        json.dump(hist, f, ensure_ascii=False, separators=(",", ":"))

    pr = hist["prueba"]
    print(f"Listo en {time.time() - inicio:.0f} s. Prueba con {pr['n']} partidos pasados: "
          f"el favorito acertó {pr.get('acierto_favorito', 0) * 100:.1f}% (Brier {pr.get('brier')}).")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
