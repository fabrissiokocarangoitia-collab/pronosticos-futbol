# La Previa de Fabrissio (pronosticos-futbol)

Proyecto **personal** del usuario (no es de un cliente): página web de análisis y pronósticos de fútbol
con la probabilidad de cada resultado. Para uso propio, sobre todo desde el celular.
**Este repositorio es público** (para usar GitHub Pages gratis): no escribir aquí datos personales del
usuario. Esos van en `claude-general`, que es privado.

Link de la página: https://fabrissiokocarangoitia-collab.github.io/pronosticos-futbol/

## Cómo funciona
- `actualizar.py` (solo Python estándar, sin instalar nada): baja de la API pública de ESPN
  (`site.api.espn.com`, sin clave) los partidos del último año (~420 días) de 20 competiciones, el
  detalle de cada uno (goles por tiempo, córners, amarillas, goleadores, quién jugó) y los partidos de los
  próximos 10 días. Entrena un Poisson con ataque/defensa por equipo + nivel por liga + localía por
  competición (peso por antigüedad, vida media 200 días), igual para córners y tarjetas (binomial negativa).
  - Guarda el detalle en `datos/partidos.json` (no va a git; en GitHub Actions vive en el caché).
  - Escribe `web/datos/modelo.json` (no va a git) y `web/datos/historial.json` (sí va a git: pronósticos
    guardados antes de cada partido + prueba con los últimos 45 días).
- `web/app.js`: toda la matemática de mercados corre en el navegador con la fuerza de cada equipo, así el
  buscador y "Calcular" sirven para cualquier cruce aunque no esté programado.
- Mercados: 1X2, doble oportunidad, empate no válido, hándicap europeo, gana sin recibir, total de goles,
  ambos anotan, goles por equipo, goles exactos, valla invicta, descanso, goles por tiempo, tiempo con más
  goles, descanso/final, córners (total, por equipo, quién más), amarillas, goleador y marcador exacto.
  Cada uno con "cuota justa" (1 ÷ probabilidad). El análisis escrito es automático (sin IA de pago).
- Competiciones: lista `COMPETICIONES` al inicio de `actualizar.py` (códigos de ESPN). Para sumar una liga,
  agregar su código ahí (ej. `eng.2`, `ecu.1`, `bol.1`, `uru.1`).

## Probar en la PC
```
python actualizar.py
python -m http.server 8000 --directory web
```
y abrir http://localhost:8000 (la primera descarga tarda varios minutos; las siguientes, poco).

## Publicación
`.github/workflows/actualizar.yml` corre `actualizar.py` 4 veces al día (0, 6, 12 y 18 h de Lima) y publica
`web/` en GitHub Pages.

## Diseño
Ver `PRODUCT.md`. Estadio de noche: fondo #0b0f0d, un solo color ámbar #f2b544 para lo más probable,
Barlow + Barlow Condensed. Sin emojis ni adornos.

## Pendientes / ideas
- Mostrar alineaciones confirmadas y lesionados (ESPN los trae cerca del partido).
- Comparar con las cuotas reales de la casa para marcar "valor".
- Análisis escrito con Claude (API de pago), si el usuario lo quiere más adelante.
- Selecciones (Eliminatorias, Copa América).
- Liga 2 de Perú: ESPN no la cubre desde 2011. Buscar otra fuente si el usuario la quiere.
