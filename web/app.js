"use strict";
/* La Previa: toda la matemática de los pronósticos corre aquí, en el navegador,
   con la fuerza de cada equipo que calcula actualizar.py. Así cualquier cruce se puede calcular al momento. */

const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");
let M = null;          // modelo.json
let H = null;          // historial.json
let porEquipo = {};    // id de equipo -> sus partidos jugados
let idxProximos = {};  // id de partido -> partido próximo

const ALIAS = {
  "u": "universitario", "la u": "universitario", "cristal": "sporting cristal", "alianza": "alianza lima",
  "madrid": "real madrid", "barca": "barcelona", "barza": "barcelona", "boca": "boca juniors", "river": "river plate",
  "city": "manchester city", "united": "manchester united", "psg": "paris saint-germain", "inter": "internazionale",
};

// ---------------------------------------------------------------- utilidades

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const pct = (p) => (p < 0.005 ? "<1%" : p > 0.995 ? ">99%" : Math.round(p * 100) + "%");
const cuota = (p) => (p < 0.01 ? "—" : (1 / p).toFixed(2));
const uno = (x) => x.toFixed(1).replace(".", ",");
const fechaUTC = (f) => new Date(f.length <= 16 ? f + ":00Z" : f);
const enLima = (f, op) => new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", ...op }).format(fechaUTC(f));
const diaLima = (f) => enLima(f, { year: "numeric", month: "2-digit", day: "2-digit" });
const hora = (f) => enLima(f, { hour: "2-digit", minute: "2-digit", hour12: false });
const leer = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

function nombreDia(f) {
  const hoy = diaLima(new Date().toISOString());
  const man = diaLima(new Date(Date.now() + 864e5).toISOString());
  const d = diaLima(f);
  const largo = enLima(f, { weekday: "long", day: "numeric", month: "long" });
  if (d === hoy) return "Hoy · " + largo.replace(",", "");
  if (d === man) return "Mañana · " + largo.replace(",", "");
  return largo.charAt(0).toUpperCase() + largo.slice(1);
}

const equipo = (id) => M.equipos[id];
const comp = (c) => M.comps[c] || { n: c.startsWith("otros:") ? "Otra liga" : c, p: "" };
function escudo(id, grande = false) {
  const e = equipo(id);
  const cls = "escudo" + (grande ? " grande" : "");
  if (!e || !e.logo) return `<span class="${cls} vacio-escudo" aria-hidden="true"></span>`;
  return `<img class="${cls}" src="${esc(e.logo)}" alt="" loading="lazy" width="${grande ? 56 : 20}" height="${grande ? 56 : 20}" onerror="this.style.visibility='hidden'">`;
}

// ---------------------------------------------------------------- el modelo

function poisson(lam, n = 10) {
  const v = [Math.exp(-lam)];
  for (let k = 1; k <= n; k++) v.push(v[k - 1] * lam / k);
  return v;
}

function lgamma(x) { // Lanczos
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function negbin(media, r, n = 30) { // conteos con más variación que Poisson (córners, tarjetas)
  if (!r) return poisson(media, n);
  const v = [];
  for (let k = 0; k <= n; k++) {
    v.push(Math.exp(lgamma(k + r) - lgamma(k + 1) - lgamma(r) + r * Math.log(r / (r + media)) + k * Math.log(media / (r + media))));
  }
  return v;
}

const rSuma = (r, m1, m2) => (r ? r * (m1 + m2) ** 2 / (m1 * m1 + m2 * m2) : null);
const sobre = (v, linea) => 1 - v.slice(0, Math.floor(linea) + 1).reduce((a, b) => a + b, 0);

function lambdas(tipo, c, h, a, neutral) {
  const [clave, claveLocal, base] = { goles: ["g", "h", 0.25], corners: ["k", "hk", 0.05], tarjetas: ["y", "hy", -0.1] }[tipo];
  const eh = equipo(h), ea = equipo(a), p = M[tipo];
  const cc = M.comps[c] || M.comps[eh.lg];
  const loc = neutral ? 0 : (cc ? cc[claveLocal] : base);
  return [Math.exp(p.mu + loc + eh[clave][0] - ea[clave][1]), Math.exp(p.mu + ea[clave][0] - eh[clave][1])];
}

function matriz(lh, la, rho, n = 10) {
  const ph = poisson(lh, n), pa = poisson(la, n);
  const m = ph.map((x) => pa.map((y) => x * y));
  if (rho) {
    m[0][0] *= 1 - lh * la * rho;
    m[0][1] *= 1 + lh * rho;
    m[1][0] *= 1 + la * rho;
    m[1][1] *= 1 - rho;
  }
  const s = m.flat().reduce((a, b) => a + b, 0);
  return m.map((f) => f.map((x) => x / s));
}

function sumaSi(m, cond) {
  let s = 0;
  for (let i = 0; i < m.length; i++) for (let j = 0; j < m.length; j++) if (cond(i, j)) s += m[i][j];
  return s;
}

function comparar(v1, v2) { // P(X>Y), P(X=Y), P(X<Y)
  let gana = 0, igual = 0;
  v1.forEach((p, i) => v2.forEach((q, j) => { if (i > j) gana += p * q; else if (i === j) igual += p * q; }));
  return [gana, igual, 1 - gana - igual];
}

/** Calcula todos los mercados de un partido. */
function pronostico(c, h, a, neutral) {
  const [lh, la] = lambdas("goles", c, h, a, neutral);
  const m = matriz(lh, la, M.rho);
  const p1 = sumaSi(m, (i, j) => i > j), px = sumaSi(m, (i, j) => i === j), p2 = 1 - p1 - px;
  const totales = Array(21).fill(0);
  m.forEach((f, i) => f.forEach((x, j) => { totales[i + j] += x; }));
  const golesH = m.map((f) => f.reduce((a, b) => a + b, 0));
  const golesA = m[0].map((_, j) => m.reduce((s, f) => s + f[j], 0));

  // mitades: parte de los goles que cae en el primer tiempo según la competición
  const f1 = (M.comps[c] || {}).f1 || M.f1;
  const m1 = matriz(lh * f1, la * f1, 0, 7), m2 = matriz(lh * (1 - f1), la * (1 - f1), 0, 7);
  const t1 = poisson((lh + la) * f1, 12), t2 = poisson((lh + la) * (1 - f1), 12);
  const htft = {};
  const res = (x, y) => (x > y ? "1" : x === y ? "X" : "2");
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) for (let k = 0; k < 8; k++) for (let l = 0; l < 8; l++) {
    const clave = res(i, j) + "/" + res(i + k, j + l);
    htft[clave] = (htft[clave] || 0) + m1[i][j] * m2[k][l];
  }
  const sumaHt = Object.values(htft).reduce((a, b) => a + b, 0);
  Object.keys(htft).forEach((k) => { htft[k] /= sumaHt; });

  const [ch, ca] = lambdas("corners", c, h, a, neutral);
  const rk = M.corners.r;
  const kH = negbin(ch, rk), kA = negbin(ca, rk), kT = negbin(ch + ca, rSuma(rk, ch, ca), 40);
  const [yh, ya] = lambdas("tarjetas", c, h, a, neutral);
  const ry = M.tarjetas.r;
  const yH = negbin(yh, ry, 15), yA = negbin(ya, ry, 15), yT = negbin(yh + ya, rSuma(ry, yh, ya), 25);

  const goleadores = (id, lam) => (equipo(id).jug || []).map((j) => ({ ...j, p: 1 - Math.exp(-j.tasa * lam) }))
    .sort((x, y) => y.p - x.p).slice(0, 6);

  return {
    c, h, a, neutral, lh, la, m, p1, px, p2, totales, golesH, golesA, m1, t1, t2, htft,
    ch, ca, kH, kA, kT, yh, ya, yH, yA, yT,
    btts: sumaSi(m, (i, j) => i > 0 && j > 0),
    jugH: goleadores(h, lh), jugA: goleadores(a, la),
  };
}

function marcadoresTop(P, n = 1) {
  const lista = [];
  P.m.forEach((f, i) => f.forEach((x, j) => lista.push([i, j, x])));
  return lista.sort((a, b) => b[2] - a[2]).slice(0, n);
}

// ---------------------------------------------------------------- datos de equipos

function resultadosDe(id, n = 10) {
  return (porEquipo[id] || []).slice(-n).reverse().map((r) => {
    const local = r[3] === id;
    const gf = local ? r[5] : r[6], gc = local ? r[6] : r[5];
    return { id: r[0], f: r[1], c: r[2], local, rival: local ? r[4] : r[3], gf, gc,
      k: r[8] ? (local ? r[8] : [r[8][1], r[8][0]]) : null, res: gf > gc ? "G" : gf === gc ? "E" : "P" };
  });
}

function resumenEquipo(id) {
  const ult = resultadosDe(id, 10);
  const prom = (f) => (ult.length ? ult.reduce((s, r) => s + f(r), 0) / ult.length : 0);
  const conK = ult.filter((r) => r.k);
  return {
    ult, forma: ult.slice(0, 5),
    gf: prom((r) => r.gf), gc: prom((r) => r.gc),
    kf: conK.length ? conK.reduce((s, r) => s + r.k[0], 0) / conK.length : null,
    total: (porEquipo[id] || []).length,
  };
}

function registro(lista) {
  const g = lista.filter((r) => r.res === "G").length, e = lista.filter((r) => r.res === "E").length;
  return { g, e, p: lista.length - g - e, n: lista.length };
}

function cruces(h, a) {
  return (porEquipo[h] || []).filter((r) => (r[3] === h && r[4] === a) || (r[3] === a && r[4] === h)).slice(-6).reverse();
}

function fuerzaEnLiga(id) {
  const lg = equipo(id).lg;
  const activo = (k) => { const ps = porEquipo[k]; return ps && Date.now() - fechaUTC(ps[ps.length - 1][1]) < 120 * 864e5; };
  const orden = Object.entries(M.equipos).filter(([k, e]) => e.lg === lg && (k === id || activo(k))).map(([k, e]) => [k, e.g[0] + e.g[1]]).sort((x, y) => y[1] - x[1]);
  return { puesto: orden.findIndex(([k]) => k === id) + 1, de: orden.length };
}

// ---------------------------------------------------------------- piezas de la interfaz

function cancha(P, grande = false) {
  const opciones = [["1", P.p1, equipo(P.h).n], ["X", P.px, "Empate"], ["2", P.p2, equipo(P.a).n]];
  const max = Math.max(P.p1, P.px, P.p2);
  const tramos = opciones.map(([k, p]) => `<i class="tramo ${k === "X" ? "x" : ""} ${p === max ? "top" : ""}" style="flex-grow:${p}"></i>`).join("");
  const rotulos = opciones.map(([k, p, n]) => `<span class="${p === max ? "top" : ""}">${pct(p)}${grande ? `<small>${esc(k === "X" ? "Empate" : n)} · cuota ${cuota(p)}</small>` : ""}</span>`).join("");
  return `<div class="cancha ${grande ? "grande" : ""}" role="img" aria-label="Gana ${esc(equipo(P.h).n)} ${pct(P.p1)}, empate ${pct(P.px)}, gana ${esc(equipo(P.a).n)} ${pct(P.p2)}">
    <div class="tramos">${tramos}</div><div class="rotulos">${rotulos}</div></div>`;
}

function tabla(titulo, filas, exclusivas = true) {
  const max = Math.max(...filas.map((f) => f[1]));
  const cuerpo = filas.map(([op, p, sub]) => `<tr class="${exclusivas && p === max ? "top" : ""}">
      <td class="op">${esc(op)}${sub ? `<small>${esc(sub)}</small>` : ""}<div class="prob movil"><i style="width:${(p * 100).toFixed(1)}%"></i></div></td>
      <td class="pr"><div class="prob"><i style="width:${(p * 100).toFixed(1)}%"></i></div></td>
      <td class="d">${pct(p)}</td><td class="d cuota">${cuota(p)}</td></tr>`).join("");
  return `<div class="mercado"><h3>${esc(titulo)}</h3><table class="t-op">
    <thead><tr><th>Opción</th><th><span class="oculto">Barra</span></th><th class="d">Prob.</th><th class="d">Cuota justa</th></tr></thead>
    <tbody>${cuerpo}</tbody></table></div>`;
}

function tablaLineas(titulo, dist, lineas, sufijo = "goles") {
  const cuerpo = lineas.map((l) => {
    const p = sobre(dist, l);
    return `<tr><td class="op">${uno(l)} ${sufijo}</td>
      <td class="d ${p >= 0.5 ? "luz" : ""}" style="${p >= 0.5 ? "color:var(--luz)" : ""}">${pct(p)}</td><td class="d cuota">${cuota(p)}</td>
      <td class="d" style="${p < 0.5 ? "color:var(--luz)" : ""}">${pct(1 - p)}</td><td class="d cuota">${cuota(1 - p)}</td></tr>`;
  }).join("");
  return `<div class="mercado"><h3>${esc(titulo)}</h3><table>
    <thead><tr><th>Línea</th><th class="d">Más de</th><th class="d">Cuota</th><th class="d">Menos de</th><th class="d">Cuota</th></tr></thead>
    <tbody>${cuerpo}</tbody></table></div>`;
}

function filaPartido(p) {
  const [id, f, c, h, a, n] = p;
  const P = pronostico(c, h, a, n);
  const [top] = marcadoresTop(P);
  const fav = P.p1 > P.p2 ? h : a;
  return `<a class="fila" href="#/partido/${id}">
    <span class="hora num">${hora(f)}</span>
    <span class="equipos-col">
      <span class="eq ${fav === h && P.p1 > P.px ? "fav" : ""}">${escudo(h)}<span>${esc(equipo(h).n)}</span></span>
      <span class="eq ${fav === a && P.p2 > P.px ? "fav" : ""}">${escudo(a)}<span>${esc(equipo(a).n)}</span></span>
    </span>
    ${cancha(P)}
    <span class="marcador-prob"><b>${top[0]}-${top[1]}</b>${pct(top[2])}</span>
  </a>`;
}

function listaResultados(id, n = 8) {
  const ult = resultadosDe(id, n);
  if (!ult.length) return `<p class="vacio">Todavía no hay partidos jugados de este equipo en los datos.</p>`;
  return `<div class="lista-res">${ult.map((r) => `<div class="res">
      <span class="f num">${enLima(r.f, { day: "2-digit", month: "2-digit" })}</span>
      <span class="rival">${r.local ? "vs" : "en"} <a href="#/equipo/${r.rival}">${esc(equipo(r.rival)?.n || "?")}</a> <small>· ${esc(comp(r.c).n)}</small></span>
      <span class="gl ${r.res}">${r.gf}-${r.gc}</span></div>`).join("")}</div>`;
}

const formaHtml = (forma) => `<span class="forma" aria-label="Últimos resultados: ${forma.map((r) => r.res).join(", ")}">${forma.map((r) => `<i class="${r.res}">${r.res}</i>`).join("")}</span>`;

// ---------------------------------------------------------------- análisis automático

function analisis(P) {
  const nH = equipo(P.h).n, nA = equipo(P.a).n;
  const sH = resumenEquipo(P.h), sA = resumenEquipo(P.a);
  const t = [];
  const max = Math.max(P.p1, P.px, P.p2);

  if (max < 0.42) {
    t.push(`Partido muy parejo: ${esc(nH)} ${pct(P.p1)}, empate ${pct(P.px)} y ${esc(nA)} ${pct(P.p2)}. Ningún resultado se despega.`);
  } else if (max === P.px) {
    t.push(`El resultado más probable es el <strong>empate (${pct(P.px)})</strong>, algo poco común: los dos equipos se anulan según sus números.`);
  } else {
    const fav = max === P.p1 ? nH : nA, otro = max === P.p1 ? nA : nH;
    const nivel = max > 0.65 ? "claro favorito" : max > 0.5 ? "favorito" : "ligeramente favorito";
    t.push(`${esc(fav)} es <strong>${nivel} (${pct(max)})</strong> frente a ${esc(otro)}.`);
  }
  t[0] += ` Se esperan unos <strong>${uno(P.lh + P.la)} goles</strong>: ${uno(P.lh)} de ${esc(nH)} y ${uno(P.la)} de ${esc(nA)}.`;

  const lado = (n, s, comoLocal) => {
    if (!s.ult.length) return `De ${esc(n)} casi no hay datos recientes.`;
    const r = registro(s.forma);
    const sitio = s.ult.filter((x) => x.local === comoLocal);
    const rs = registro(sitio);
    return `${esc(n)} llega con ${r.g} ${r.g === 1 ? "victoria" : "victorias"}, ${r.e} ${r.e === 1 ? "empate" : "empates"} y ${r.p} ${r.p === 1 ? "derrota" : "derrotas"} en sus últimos ${r.n}; marca ${uno(s.gf)} y recibe ${uno(s.gc)} goles por partido.` +
      (rs.n >= 3 ? ` En sus últimos ${rs.n} partidos ${comoLocal ? "de local" : "de visita"}: ${rs.g} ganados, ${rs.e} empatados y ${rs.p} perdidos.` : "");
  };
  t.push(lado(nH, sH, true) + " " + lado(nA, sA, false));

  const cr = cruces(P.h, P.a);
  if (cr.length) {
    let gH = 0, gA = 0, e = 0;
    cr.forEach((r) => {
      const golesH = r[3] === P.h ? r[5] : r[6], golesA = r[3] === P.h ? r[6] : r[5];
      if (golesH > golesA) gH++; else if (golesA > golesH) gA++; else e++;
    });
    t.push(`Últimos ${cr.length} ${cr.length === 1 ? "cruce" : "cruces"} entre ellos: ${esc(nH)} ganó ${gH}, ${esc(nA)} ganó ${gA} y hubo ${e} ${e === 1 ? "empate" : "empates"}.`);
  }

  const o25 = sobre(P.totales, 2.5);
  t.push(`Ambos anotan: ${pct(P.btts)}. Más de 2,5 goles: ${pct(o25)}. Córners esperados: <strong>${uno(P.ch + P.ca)}</strong> (${uno(P.ch)} y ${uno(P.ca)}). Tarjetas amarillas esperadas: ${uno(P.yh + P.ya)}.`);

  const top = [...P.jugH, ...P.jugA].sort((x, y) => y.p - x.p)[0];
  if (top) t.push(`Quien tiene más probabilidad de marcar es <strong>${esc(top.n)} (${pct(top.p)})</strong>, con ${top.goles} ${top.goles === 1 ? "gol" : "goles"} en ${top.pj} partidos, siempre que juegue.`);

  // opciones con más respaldo: probables pero que no sean obvias
  const candidatos = [
    ["Doble oportunidad " + nH + " o empate", P.p1 + P.px], ["Doble oportunidad " + nA + " o empate", P.p2 + P.px],
    ["Más de 1,5 goles", sobre(P.totales, 1.5)], ["Menos de 3,5 goles", 1 - sobre(P.totales, 3.5)],
    ["Ambos anotan: sí", P.btts], ["Ambos anotan: no", 1 - P.btts],
    ["Más de 7,5 córners", sobre(P.kT, 7.5)], ["Menos de 11,5 córners", 1 - sobre(P.kT, 11.5)],
    ["Gana " + nH, P.p1], ["Gana " + nA, P.p2], ["Más de 0,5 goles en el primer tiempo", sobre(P.t1, 0.5)],
  ].filter(([, p]) => p >= 0.6 && p <= 0.92).sort((x, y) => y[1] - x[1]).slice(0, 3);
  if (candidatos.length) {
    t.push(`Lo que más respalda el modelo: ${candidatos.map(([n, p]) => `${esc(n)} (${pct(p)})`).join("; ")}. Ojo: una opción al 75% igual falla 1 de cada 4 veces.`);
  }

  const avisos = [];
  [[P.h, sH], [P.a, sA]].forEach(([id, s]) => { if (s.total < 8) avisos.push(`hay pocos partidos de ${esc(equipo(id).n)} en los datos (${s.total})`); });
  if (equipo(P.h).lg !== equipo(P.a).lg) avisos.push("son de ligas distintas, y comparar ligas es menos preciso");
  return t.map((x) => `<p>${x}</p>`).join("") + (avisos.length ? `<p class="aviso">Tómalo con cuidado: ${avisos.join(" y ")}.</p>` : "");
}

// ---------------------------------------------------------------- páginas

function paginaInicio() {
  const comps = [...new Set(M.proximos.map((p) => p[2]))].sort((x, y) => Object.keys(M.comps).indexOf(x) - Object.keys(M.comps).indexOf(y));
  let filtro = leer("filtro") || "todas";
  if (filtro !== "todas" && !comps.includes(filtro)) filtro = "todas";
  const ahora = Date.now();
  const lista = M.proximos.filter((p) => (filtro === "todas" || p[2] === filtro) && fechaUTC(p[1]).getTime() > ahora - 15 * 60e3);

  const dias = {};
  lista.forEach((p) => { (dias[diaLima(p[1])] ||= []).push(p); });
  const bloques = Object.values(dias).map((ps) => {
    const porComp = {};
    ps.forEach((p) => { (porComp[p[2]] ||= []).push(p); });
    const orden = Object.keys(porComp).sort((x, y) => Object.keys(M.comps).indexOf(x) - Object.keys(M.comps).indexOf(y));
    return `<section class="dia"><h2>${esc(nombreDia(ps[0][1]))}</h2>
      ${orden.map((c) => `<div class="comp-bloque"><div class="comp-nombre"><span>${esc(comp(c).n)}</span><span>${esc(comp(c).p)}</span></div>
        ${porComp[c].map(filaPartido).join("")}</div>`).join("")}</section>`;
  }).join("");

  const chips = [["todas", "Todas"], ...comps.map((c) => [c, comp(c).n])]
    .map(([k, n]) => `<button class="chip" data-filtro="${k}" aria-pressed="${k === filtro}">${esc(n)}</button>`).join("");

  app.innerHTML = `<div class="titulo"><div><h1>Próximos partidos</h1>
      <p class="sub">${lista.length} partidos en los próximos días · datos del ${esc(enLima(M.generado, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }))}</p></div></div>
    <div class="filtros" role="toolbar" aria-label="Filtrar por competición">${chips}</div>
    ${bloques || `<p class="vacio">No hay partidos programados para este filtro en los próximos días. Prueba con "Todas" o busca un equipo arriba.</p>`}`;
  app.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => { guardar("filtro", b.dataset.filtro); paginaInicio(); }));
}

function paginaPartido(c, h, a, neutral, fecha, sede) {
  if (!equipo(h) || !equipo(a)) return paginaNoEncontrada();
  const P = pronostico(c, h, a, neutral);
  const nH = equipo(P.h).n, nA = equipo(P.a).n;
  const tops = marcadoresTop(P, 1)[0];
  const meta = fecha
    ? `${esc(comp(c).n)} · ${esc(enLima(fecha, { weekday: "long", day: "numeric", month: "long" }))}, ${hora(fecha)}${sede ? " · " + esc(sede) : ""}`
    : `Partido calculado · ${neutral ? "cancha neutral" : "de local " + esc(nH)}${M.comps[c] ? " · con la localía de " + esc(comp(c).n) : ""}`;
  const lado = (id) => `<div class="lado">${escudo(id, true)}<div><a href="#/equipo/${id}">${esc(equipo(id).n)}</a><small>${esc(comp(equipo(id).lg).n)}</small></div></div>`;

  // tablas
  const dnb = P.p1 / (P.p1 + P.p2);
  const exactos = [0, 1, 2, 3, 4].map((k) => [`${k} ${k === 1 ? "gol" : "goles"}`, P.totales[k]]).concat([["5 o más", 1 - P.totales.slice(0, 5).reduce((s, x) => s + x, 0)]]);
  const ht1 = sumaSi(P.m1, (i, j) => i > j), htx = sumaSi(P.m1, (i, j) => i === j);
  const mitades = comparar(P.t1, P.t2);
  const htftNombre = (k) => k.split("/").map((x) => (x === "1" ? nH : x === "2" ? nA : "Empate")).join(" / ");
  const htft = Object.entries(P.htft).sort((x, y) => y[1] - x[1]).map(([k, p]) => [htftNombre(k), p]);
  const masK = comparar(P.kH, P.kA);
  const masY = comparar(P.yH, P.yA);

  const secResultado = `<section class="panel" id="resultado"><h2>Resultado</h2>
    ${tabla("Resultado final (1X2)", [["Gana " + nH, P.p1], ["Empate", P.px], ["Gana " + nA, P.p2]])}
    ${tabla("Doble oportunidad", [[nH + " o empate", P.p1 + P.px, "1X"], [nA + " o empate", P.p2 + P.px, "X2"], [nH + " o " + nA, P.p1 + P.p2, "12, no hay empate"]])}
    ${tabla("Empate no válido (si empatan, se devuelve)", [[nH, dnb], [nA, 1 - dnb]])}
    ${tabla("Hándicap europeo", [[nH + " gana por 2 o más", sumaSi(P.m, (i, j) => i - j >= 2)], [nA + " gana por 2 o más", sumaSi(P.m, (i, j) => j - i >= 2)], ["Cualquiera gana por 1, o empate", sumaSi(P.m, (i, j) => Math.abs(i - j) <= 1)]])}
    ${tabla("Gana sin recibir goles", [[nH, sumaSi(P.m, (i, j) => i > 0 && j === 0)], [nA, sumaSi(P.m, (i, j) => j > 0 && i === 0)]], false)}
  </section>`;

  const secGoles = `<section class="panel" id="goles"><h2>Goles <small>esperados: ${uno(P.lh + P.la)}</small></h2>
    ${tablaLineas("Total de goles", P.totales, [0.5, 1.5, 2.5, 3.5, 4.5])}
    ${tabla("Ambos equipos anotan", [["Sí", P.btts], ["No", 1 - P.btts]])}
    <div class="pares">
      ${tablaLineas("Goles de " + nH, P.golesH, [0.5, 1.5, 2.5])}
      ${tablaLineas("Goles de " + nA, P.golesA, [0.5, 1.5, 2.5])}
    </div>
    ${tabla("Cantidad exacta de goles", exactos)}
    ${tabla("Valla invicta (no le hacen goles)", [[nH, P.golesA[0]], [nA, P.golesH[0]]], false)}
  </section>`;

  const secMitades = `<section class="panel" id="mitades"><h2>Primer y segundo tiempo</h2>
    ${tabla("Resultado al descanso", [["Gana " + nH, ht1], ["Empate", htx], ["Gana " + nA, 1 - ht1 - htx]])}
    <div class="pares">
      ${tablaLineas("Goles en el primer tiempo", P.t1, [0.5, 1.5, 2.5])}
      ${tablaLineas("Goles en el segundo tiempo", P.t2, [0.5, 1.5, 2.5])}
    </div>
    ${tabla("Tiempo con más goles", [["Primer tiempo", mitades[0]], ["Igual cantidad", mitades[1]], ["Segundo tiempo", mitades[2]]])}
    ${tabla("Descanso / Final", htft.slice(0, 9))}
  </section>`;

  const secCorners = `<section class="panel" id="corners"><h2>Córners <small>esperados: ${uno(P.ch + P.ca)}</small></h2>
    ${tablaLineas("Total de córners", P.kT, [7.5, 8.5, 9.5, 10.5, 11.5], "córners")}
    ${tabla("Quién saca más córners", [[nH, masK[0]], ["Igual", masK[1]], [nA, masK[2]]])}
    <div class="pares">
      ${tablaLineas("Córners de " + nH, P.kH, [3.5, 4.5, 5.5], "")}
      ${tablaLineas("Córners de " + nA, P.kA, [3.5, 4.5, 5.5], "")}
    </div></section>`;

  const secTarjetas = `<section class="panel" id="tarjetas"><h2>Tarjetas amarillas <small>esperadas: ${uno(P.yh + P.ya)}</small></h2>
    ${tablaLineas("Total de amarillas", P.yT, [2.5, 3.5, 4.5, 5.5, 6.5], "")}
    ${tabla("Quién recibe más amarillas", [[nH, masY[0]], ["Igual", masY[1]], [nA, masY[2]]])}
  </section>`;

  const listaGol = (n, js) => `<h3>${esc(n)}</h3>${js.length ? js.map((j) => `<div class="goleador">
      <span class="n">${esc(j.n)}</span><small>${j.goles} ${j.goles === 1 ? "gol" : "goles"} en ${j.pj} PJ</small>
      <span class="d">${pct(j.p)}</span><span class="d cuota">${cuota(j.p)}</span></div>`).join("")
    : `<p class="vacio" style="padding:8px 0">Sin datos de goleadores recientes.</p>`}`;
  const secGoleadores = `<section class="panel" id="goleadores"><h2>Goleador <small>anota en cualquier momento, si juega</small></h2>
    ${listaGol(nH, P.jugH)}<div style="height:14px"></div>${listaGol(nA, P.jugA)}</section>`;

  const maxCelda = Math.max(...P.m.slice(0, 6).flatMap((f) => f.slice(0, 6)));
  const mapa = `<section class="panel" id="marcador"><h2>Marcador exacto <small>más probable: ${tops[0]}-${tops[1]} (${pct(tops[2])})</small></h2>
    <div class="mapa" role="table" aria-label="Probabilidad de cada marcador">
      <span class="eje"></span>${[0, 1, 2, 3, 4, 5].map((j) => `<span class="eje">${j}</span>`).join("")}
      ${[0, 1, 2, 3, 4, 5].map((i) => `<span class="eje">${i}</span>` + [0, 1, 2, 3, 4, 5].map((j) => {
        const p = P.m[i][j];
        return `<span class="celda ${i === tops[0] && j === tops[1] ? "top" : ""}" title="${i}-${j}: ${pct(p)} · cuota ${cuota(p)}" style="background:rgba(242,181,68,${(p / maxCelda * 0.55).toFixed(3)})">${p >= 0.005 ? Math.round(p * 100) : ""}</span>`;
      }).join("")).join("")}
    </div>
    <div class="mapa-pie"><span>Filas: goles de ${esc(nH)}</span><span>Columnas: goles de ${esc(nA)}</span></div>
    ${tabla("Los marcadores más probables", marcadoresTop(P, 6).map(([i, j, p]) => [`${nH} ${i} - ${j} ${nA}`, p]))}
  </section>`;

  const sH = resumenEquipo(h), sA = resumenEquipo(a);
  const cr = cruces(h, a);
  const secForma = `<section class="panel" id="forma"><h2>Forma reciente</h2>
    <h3>${esc(nH)} ${formaHtml(sH.forma)}</h3>${listaResultados(h, 6)}
    <div style="height:16px"></div>
    <h3>${esc(nA)} ${formaHtml(sA.forma)}</h3>${listaResultados(a, 6)}
    ${cr.length ? `<div style="height:16px"></div><h3>Entre ellos</h3><div class="lista-res">${cr.map((r) => `<div class="res">
      <span class="f num">${enLima(r[1], { day: "2-digit", month: "2-digit", year: "2-digit" })}</span>
      <span class="rival">${esc(equipo(r[3]).n)} vs ${esc(equipo(r[4]).n)} <small>· ${esc(comp(r[2]).n)}</small></span>
      <span class="gl">${r[5]}-${r[6]}</span></div>`).join("")}</div>` : ""}
  </section>`;

  const saltos = [["resultado", "Resultado"], ["goles", "Goles"], ["mitades", "Mitades"], ["corners", "Córners"], ["tarjetas", "Tarjetas"], ["goleadores", "Goleador"], ["marcador", "Marcador"], ["forma", "Forma"]]
    .map(([k, n]) => `<button class="chip" data-ir="${k}">${n}</button>`).join("");

  app.innerHTML = `<div class="cabecera">
      <h1 class="oculto">${esc(nH)} vs ${esc(nA)}: pronóstico</h1>
      <p class="meta">${meta}</p>
      <div class="duelo">${lado(h)}<div class="vs"><b>${tops[0]}-${tops[1]}</b><small>marcador más probable</small></div>${lado(a)}</div>
      ${cancha(P, true)}
    </div>
    <nav class="saltos" aria-label="Ir a mercado">${saltos}</nav>
    <div class="rejilla">
      <div class="columna">${secResultado}${secGoles}${secMitades}${secCorners}${secTarjetas}</div>
      <div class="columna">
        <section class="panel analisis"><h2>Análisis</h2>${analisis(P)}</section>
        ${secGoleadores}${mapa}${secForma}
      </div>
    </div>`;
  app.querySelectorAll("[data-ir]").forEach((b) => b.addEventListener("click", () => {
    const destino = document.getElementById(b.dataset.ir);
    const y = destino.getBoundingClientRect().top + scrollY - $(".saltos").getBoundingClientRect().bottom - 8;
    scrollTo({ top: y, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }));
  document.title = `${nH} vs ${nA} · La Previa de Fabrissio`;
}

function paginaEquipo(id) {
  const e = equipo(id);
  if (!e) return paginaNoEncontrada();
  const s = resumenEquipo(id);
  const prox = M.proximos.filter((p) => p[3] === id || p[4] === id);
  const fz = fuerzaEnLiga(id);
  const goleadores = (e.jug || []);
  app.innerHTML = `<div class="ficha">${escudo(id, true)}<div class="datos"><h1>${esc(e.n)}</h1>
      <p class="sub" style="margin:0">${esc(comp(e.lg).n)}${comp(e.lg).p ? " · " + esc(comp(e.lg).p) : ""}</p></div></div>
    <div class="stats">
      <div><span>Fuerza en su liga</span><b>${fz.puesto}.º<small>de ${fz.de}</small></b></div>
      <div><span>Goles a favor</span><b>${uno(s.gf)}<small>por partido</small></b></div>
      <div><span>Goles en contra</span><b>${uno(s.gc)}<small>por partido</small></b></div>
      <div><span>Córners a favor</span><b>${s.kf === null ? "—" : uno(s.kf)}<small>por partido</small></b></div>
    </div>
    <div class="rejilla">
      <div class="columna">
        <section class="panel"><h2>Próximos partidos</h2>
          ${prox.length ? `<div class="comp-bloque compacta" style="margin:0 -20px -20px;border-radius:0 0 8px 8px">${prox.map(filaPartido).join("")}</div>` : `<p class="vacio">No tiene partidos en los próximos días.</p>`}
        </section>
        <section class="panel"><h2>Últimos resultados ${formaHtml(s.forma)}</h2>${listaResultados(id, 10)}</section>
      </div>
      <div class="columna">
        <section class="panel"><h2>Calcular un partido</h2>
          <p class="sub" style="margin:0 0 14px">Elige un rival y la página calcula el pronóstico al momento, aunque ese partido no esté programado.</p>
          <a class="boton" style="display:inline-grid;place-items:center" href="#/calcular/${id}">Calcular contra otro equipo</a>
        </section>
        <section class="panel"><h2>Goleadores <small>goles en el último año</small></h2>
          ${goleadores.length ? goleadores.map((j) => `<div class="goleador" style="grid-template-columns:minmax(0,1fr) auto"><span class="n">${esc(j.n)}</span><small style="display:inline">${j.goles} ${j.goles === 1 ? "gol" : "goles"} en ${j.pj} PJ</small></div>`).join("") : `<p class="vacio">Sin datos de goleadores.</p>`}
        </section>
      </div>
    </div>`;
  document.title = `${e.n} · La Previa de Fabrissio`;
}

function opcionesEquipos(sel) {
  const grupos = {};
  Object.entries(M.equipos).forEach(([id, e]) => { (grupos[e.lg] ||= []).push([id, e.n]); });
  const orden = Object.keys(grupos).sort((x, y) => {
    const ix = Object.keys(M.comps).indexOf(x), iy = Object.keys(M.comps).indexOf(y);
    return (ix < 0 ? 999 : ix) - (iy < 0 ? 999 : iy);
  });
  return `<option value="">Elige un equipo</option>` + orden.map((lg) => `<optgroup label="${esc(comp(lg).n)}${comp(lg).p ? " (" + esc(comp(lg).p) + ")" : ""}">
    ${grupos[lg].sort((x, y) => x[1].localeCompare(y[1], "es")).map(([id, n]) => `<option value="${id}" ${id === sel ? "selected" : ""}>${esc(n)}</option>`).join("")}</optgroup>`).join("");
}

function paginaCalcular(h = "", a = "") {
  app.innerHTML = `<div class="titulo"><div><h1>Calcular un partido</h1>
      <p class="sub">Cualquier cruce entre los ${Object.keys(M.equipos).length} equipos, aunque no esté programado.</p></div></div>
    <form class="form-calc" id="form-calc">
      <label class="campo"><span>Local</span><select id="c-h" required>${opcionesEquipos(h)}</select></label>
      <label class="campo"><span>Visitante</span><select id="c-a" required>${opcionesEquipos(a)}</select></label>
      <div style="display:flex;gap:12px;align-items:end;flex-wrap:wrap">
        <label class="check"><input type="checkbox" id="c-n"> Cancha neutral</label>
        <button class="boton" type="submit">Calcular</button>
      </div>
    </form>
    <p class="sub">También puedes escribir en el buscador de arriba, por ejemplo: <em>cristal vs melgar</em>.</p>`;
  $("#form-calc").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const vh = $("#c-h").value, va = $("#c-a").value;
    if (!vh || !va || vh === va) { $("#c-a").setCustomValidity(vh === va ? "Elige dos equipos distintos" : ""); $("#c-a").reportValidity(); return; }
    location.hash = `#/calc/${vh}/${va}/${$("#c-n").checked ? 1 : 0}`;
  });
  $("#c-a").addEventListener("change", (ev) => ev.target.setCustomValidity(""));
  document.title = "Calcular un partido · La Previa de Fabrissio";
}

function paginaPrecision() {
  const bloque = (titulo, r, extra) => {
    if (!r || !r.n) return `<section class="panel"><h2>${titulo}</h2><p class="vacio">${extra}</p></section>`;
    const filas = r.calibracion.filter((b) => b.casos >= 5).map((b) => `<div class="calib-fila">
        <span class="num">${Math.round(b.desde * 100)}–${Math.round(b.desde * 100 + 10)}%</span>
        <span class="pistas"><i class="real" style="width:${(b.paso * 100).toFixed(1)}%"></i><i class="dijo" style="left:${(b.dijo * 100).toFixed(1)}%"></i></span>
        <span class="num">${Math.round(b.paso * 100)}% <small style="color:var(--tinta-3)">de ${b.casos}</small></span></div>`).join("");
    return `<section class="panel"><h2>${titulo}</h2>
      <div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div><span>Partidos revisados</span><b>${r.n}</b></div>
        <div><span>Acertó al favorito</span><b>${Math.round(r.acierto_favorito * 100)}%</b></div>
        <div><span>Error (Brier)</span><b>${String(r.brier).replace(".", ",")}<small>menos es mejor</small></b></div>
      </div>
      <h3>Cuando el modelo dijo X%, ¿cuántas veces pasó?</h3>
      <div class="leyenda"><span><i></i>Lo que pasó</span><span><i class="linea"></i>Lo que dijo el modelo</span></div>
      <div class="calib">${filas}</div>
      <p class="sub" style="margin-top:14px">${extra}</p></section>`;
  };
  const pr = H && H.prueba, real = H && H.real;
  app.innerHTML = `<div class="titulo"><div><h1>¿Qué tanto acierta?</h1>
      <p class="sub">Un buen modelo no acierta siempre: acierta en la medida que dice. Si dice 60%, debería pasar unas 6 de cada 10 veces.</p></div></div>
    <div class="columna">
      ${bloque("Prueba con partidos ya jugados", pr, pr ? `Se entrenó el modelo solo con partidos anteriores al ${esc(pr.desde)} y se pronosticaron los que vinieron después, sin que el modelo los conociera. Incluye 1X2, más de 2,5 goles, ambos anotan y más de 9,5 córners.` : "")}
      ${bloque("Pronósticos guardados antes de cada partido", real, "Cada vez que se actualizan los datos, la página guarda el pronóstico de los partidos de los próximos días y, cuando se juegan, lo compara con el resultado real. Aquí aparecerán en cuanto se jueguen los primeros.")}
      <section class="panel"><h2>Cómo calcula</h2><div class="analisis">
        <p>Cada equipo tiene una fuerza de ataque y de defensa, que sale de sus partidos del último año. Los partidos recientes pesan más: uno de hace 200 días pesa la mitad.</p>
        <p>Con esas fuerzas se calculan los goles esperados de cada lado, y con la distribución de Poisson (corregida para marcadores bajos) se saca la probabilidad de cada marcador. De ahí salen todos los mercados. Córners y tarjetas usan el mismo método con sus propios datos.</p>
        <p>La <strong>cuota justa</strong> es 1 dividido entre la probabilidad. Si una casa paga menos que eso, según el modelo esa opción no conviene. Las casas siempre se quedan con un margen.</p>
      </div></section>
    </div>`;
  document.title = "Precisión · La Previa de Fabrissio";
}

function paginaNoEncontrada() {
  app.innerHTML = `<h1>No encontré eso</h1><p class="sub">Puede que el partido ya se haya jugado. <a href="#/" style="color:var(--luz)">Ver los próximos partidos</a>.</p>`;
}

// ---------------------------------------------------------------- buscador

function buscarEquipos(q, n = 8) {
  q = norm(q);
  if (!q) return [];
  const alias = ALIAS[q];
  const conProximo = new Set(M.proximos.flatMap((p) => [p[3], p[4]]));
  const puntos = [];
  for (const [id, e] of Object.entries(M.equipos)) {
    const nombre = norm(e.n);
    let s = null;
    if (alias && nombre === alias) s = -1;
    else if (nombre === q || norm(e.ab) === q) s = 0;
    else if (nombre.startsWith(q)) s = 1;
    else if (nombre.split(/[\s.-]+/).some((w) => w.startsWith(q))) s = 2;
    else if (q.length >= 3 && nombre.includes(q)) s = 3;
    if (s === null) continue;
    const peru = e.lg.startsWith("per.") ? 0 : 1;
    puntos.push([s * 4 + peru * 2 + (conProximo.has(id) ? 0 : 1), id]);
  }
  return puntos.sort((a, b) => a[0] - b[0]).slice(0, n).map((x) => x[1]);
}

function sugerencias(texto) {
  const partes = texto.split(/\s+(?:vs\.?|v|contra|x|-)\s+/i).filter(Boolean);
  const items = [];
  if (partes.length === 2) {
    const [h] = buscarEquipos(partes[0], 1), [a] = buscarEquipos(partes[1], 1);
    if (h && a && h !== a) {
      const p = M.proximos.find((x) => (x[3] === h && x[4] === a) || (x[3] === a && x[4] === h));
      if (p) items.push({ grupo: "Partido", html: `${esc(equipo(p[3]).n)} vs ${esc(equipo(p[4]).n)}<small>${esc(nombreDia(p[1]))}</small>`, href: `#/partido/${p[0]}` });
      items.push({ grupo: "Calcular", cls: "calcular", html: `Calcular ${esc(equipo(h).n)} vs ${esc(equipo(a).n)}<small>${esc(equipo(h).n)} de local</small>`, href: `#/calc/${h}/${a}/0` });
    }
  }
  const ids = buscarEquipos(partes[0] || texto, partes.length === 2 ? 4 : 7);
  ids.forEach((id) => items.push({ grupo: "Equipos", html: `${escudo(id)}${esc(equipo(id).n)}<small>${esc(comp(equipo(id).lg).n)}</small>`, href: `#/equipo/${id}` }));
  if (partes.length === 1 && ids.length) {
    M.proximos.filter((p) => ids.slice(0, 3).includes(p[3]) || ids.slice(0, 3).includes(p[4])).slice(0, 4).forEach((p) => {
      items.push({ grupo: "Próximos partidos", html: `${esc(equipo(p[3]).n)} vs ${esc(equipo(p[4]).n)}<small>${esc(nombreDia(p[1]).split(",")[0])} ${hora(p[1])}</small>`, href: `#/partido/${p[0]}` });
    });
  }
  return items;
}

function iniciarBuscador() {
  const input = $("#buscar"), caja = $("#sugerencias");
  let items = [], activo = -1;
  const cerrar = () => { caja.hidden = true; input.setAttribute("aria-expanded", "false"); activo = -1; };
  const pintar = () => {
    if (!items.length) {
      caja.innerHTML = input.value.trim() ? `<div class="grupo">No encontré ese equipo. Prueba con otra parte del nombre.</div>` : "";
      caja.hidden = !input.value.trim();
      return;
    }
    let grupo = "";
    caja.innerHTML = items.map((it, i) => {
      const cab = it.grupo !== grupo ? `<div class="grupo">${it.grupo}</div>` : "";
      grupo = it.grupo;
      return `${cab}<button type="button" class="sug ${it.cls || ""}" role="option" data-i="${i}" aria-selected="${i === activo}">${it.html}</button>`;
    }).join("");
    caja.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };
  const ir = (i) => { if (items[i]) { location.hash = items[i].href; input.value = ""; input.blur(); cerrar(); } };
  input.addEventListener("input", () => { items = sugerencias(input.value); activo = items.length ? 0 : -1; pintar(); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { activo = Math.min(items.length - 1, activo + 1); pintar(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { activo = Math.max(0, activo - 1); pintar(); ev.preventDefault(); }
    else if (ev.key === "Enter") { ir(activo); ev.preventDefault(); }
    else if (ev.key === "Escape") { cerrar(); }
  });
  caja.addEventListener("mousedown", (ev) => { const b = ev.target.closest(".sug"); if (b) { ev.preventDefault(); ir(+b.dataset.i); } });
  input.addEventListener("blur", () => setTimeout(cerrar, 120));
  input.addEventListener("focus", () => { if (input.value.trim()) { items = sugerencias(input.value); pintar(); } });
}

// ---------------------------------------------------------------- rutas

function ruta() {
  const partes = location.hash.replace(/^#\/?/, "").split("/");
  document.querySelectorAll(".enlaces a").forEach((a) => a.removeAttribute("aria-current"));
  const marcar = (r) => { const a = document.querySelector(`.enlaces a[data-ruta="${r}"]`); if (a) a.setAttribute("aria-current", "page"); };
  document.title = "La Previa de Fabrissio · pronósticos de fútbol";
  switch (partes[0]) {
    case "partido": {
      const p = idxProximos[partes[1]];
      if (!p) paginaNoEncontrada();
      else paginaPartido(p[2], p[3], p[4], p[5], p[1], p[6]);
      break;
    }
    case "calc": {
      const h = partes[1], a = partes[2];
      paginaPartido(equipo(h) ? equipo(h).lg : "", h, a, partes[3] === "1");
      marcar("calcular");
      break;
    }
    case "equipo": paginaEquipo(partes[1]); break;
    case "calcular": paginaCalcular(partes[1], partes[2]); marcar("calcular"); break;
    case "precision": paginaPrecision(); marcar("precision"); break;
    default: paginaInicio(); marcar("inicio");
  }
  scrollTo(0, 0);
  if (partes[0]) app.focus({ preventScroll: true });
}

async function iniciar() {
  try {
    const r = await fetch("datos/modelo.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    M = await r.json();
  } catch (e) {
    app.innerHTML = `<p class="error">No se pudieron cargar los datos. Revisa tu conexión y vuelve a cargar la página.</p>`;
    return;
  }
  try { H = await (await fetch("datos/historial.json", { cache: "no-cache" })).json(); } catch { H = null; }
  M.res.forEach((r) => { (porEquipo[r[3]] ||= []).push(r); (porEquipo[r[4]] ||= []).push(r); });
  M.proximos.forEach((p) => { idxProximos[p[0]] = p; });
  iniciarBuscador();
  addEventListener("hashchange", ruta);
  ruta();
}

iniciar();
