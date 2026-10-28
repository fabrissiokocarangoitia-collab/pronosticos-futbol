# La Previa de Fabrissio (pronosticos-futbol)

Proyecto **personal** del usuario (no es de un cliente): página web de análisis y pronósticos de fútbol
con la probabilidad de cada resultado. Para uso propio, sobre todo desde el celular.
**Este repositorio es público** (para usar GitHub Pages gratis): no escribir aquí datos personales del
usuario. Esos van en `claude-general`, que es privado.

Link de la página: https://la-previa.github.io
Repositorio: `la-previa/la-previa.github.io` (organización `la-previa`, del usuario, para que el link no
muestre su nombre). La carpeta local sigue siendo `C:\Proyectos\pronosticos-futbol`; en otro equipo:
`gh repo clone la-previa/la-previa.github.io C:\Proyectos\pronosticos-futbol`.

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
- Combinadas (`#/combinadas`, funciones `opcionesPartido`, `sugerir`, `paginaCombinadas` en `app.js`): una
  opción por partido (como la combinada normal de la casa; dos opciones del mismo partido no se juntan) y
  solo partidos que aún no empiezan. Probabilidad total = producto (partidos distintos). Tres sugeridas por
  día y cantidad de selecciones (70–88%, 55–72%, 40–56% por opción; sin equipos con menos de 8 partidos) y
  "Arma la tuya", que se guarda en el navegador (localStorage `combinada`). Cada partido tiene "Agregar a mi
  combinada". Las cuotas son justas del modelo, no las de la casa.
- Competiciones: lista `COMPETICIONES` al inicio de `actualizar.py` (códigos de ESPN). Para sumar una liga,
  agregar su código ahí (ej. `eng.2`, `ecu.1`, `bol.1`, `uru.1`).

## Probar en la PC
```
python actualizar.py
python -m http.server 8000 --directory web
```
y abrir http://localhost:8000 (la primera descarga tarda varios minutos; las siguientes, poco).

## Publicación
- Link: https://la-previa.github.io (público, se puede compartir).
- `.github/workflows/actualizar.yml` corre `actualizar.py` 4 veces al día (0, 6, 12 y 18 h de Lima) y publica
  `web/` en GitHub Pages (Pages en modo "GitHub Actions"). También se puede lanzar a mano:
  `gh workflow run actualizar.yml` o desde la pestaña Actions del repo. En GitHub tarda ~2 min.
- `datos/partidos.json` vive en el caché de Actions (clave `partidos-<run>`). Si el caché se borra, la
  siguiente corrida baja todo de nuevo (en GitHub son ~90 s; en la PC, ~18 min).
- El bot hace commits de `web/datos/historial.json`: hacer `git pull` antes de trabajar.
- Al cambiar `estilos.css` o `app.js`, subir el número `?v=` en `web/index.html` para que los celulares
  no usen la versión vieja guardada.

## Diseño
Ver `PRODUCT.md`. Estadio de noche: fondo #0b0f0d, un solo color ámbar #f2b544 para lo más probable,
Barlow + Barlow Condensed. Sin emojis ni adornos.

## Pendientes / ideas
- Mostrar alineaciones confirmadas y lesionados (ESPN los trae cerca del partido).
- Comparar con las cuotas reales de la casa para marcar "valor".
- Análisis escrito con Claude (API de pago), si el usuario lo quiere más adelante.
- Selecciones (Eliminatorias, Copa América).
- Liga 2 de Perú: ESPN no la cubre desde 2011. Buscar otra fuente si el usuario la quiere.
- GitHub avisa que las acciones usan Node 20 (obsoleto) y que `ubuntu-latest` pasa a Ubuntu 26: por
  ahora funciona; si algún día falla, subir las versiones de las acciones en el workflow.

## Historial
- 28-oct-2026 (PC): creado el proyecto. El usuario eligió: estilo oscuro de estadio, análisis escrito
  automático (gratis, sin IA de pago), mercados de las casas de apuestas peruanas y publicarlo en internet.
  Nombre: "La Previa de Fabrissio". Repo hecho público para GitHub Pages; antes se limpió el historial para
  que no quede ningún dato personal. Prueba del modelo con 819 partidos pasados: el favorito acertó ~50%
  y las probabilidades salen bien calibradas (ver la página "Precisión").
- 28-oct-2026 (PC): el link con el usuario de GitHub mostraba su nombre completo. Se creó la organización
  `la-previa` y se movió el repo a `la-previa/la-previa.github.io` → link https://la-previa.github.io.
  El nombre de la página se queda "La Previa de Fabrissio" (decisión del usuario).
- 28-oct-2026 (PC): nueva sección "Combinadas" (sugeridas + armar la propia, con probabilidad total).
  Idea para después: "Crea tu apuesta" (varias opciones del mismo partido) calculando la probabilidad conjunta
  con la matriz de marcadores.
