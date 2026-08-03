# Continuar el desarrollo en otra máquina

Todo el código está en git. Solo dos cosas viven fuera del repo y hay que
copiarlas a mano (o decidir no hacerlo — ver abajo):

## 1. Qué copiar a mano

### `apps/web/.env.local` — obligatorio (secretos, nunca en git)

Variables actuales (los valores están solo en la máquina original):

```
RESEND_API_KEY=            # envío de email (Resend)
EMAIL_FROM=                # remitente de digest/alertas
RUNNER_TOKEN=              # bearer compartido Core <-> runner
ENABLE_LOCAL_SCHEDULER=1   # scheduler embebido (sweeps/digest/reap)
```

Opcionales reconocidas: `ANTHROPIC_API_KEY` (activa la vía LLM de pago; hoy
vacía a propósito — se usa la sesión de Claude Code), `DATABASE_URL` (Postgres
real en vez de PGlite), `PUBLIC_BASE_URL` (base de los deep links de email a
la ficha del lead; def. http://localhost:3000), `ALERT_MAX_GRADE` (def. B),
`DIGEST_MAX_GRADE` (def. C), `SWEEP_INTERVAL_MINUTES` (def. 180),
`LISTING_RECHECK_HOURS` (def. 36),
`DEV_USER_EMAIL`, `CRON_SECRET` (solo producción).

Un modelo por vía de LLM, todos overridable por env. El criterio es qué pasa si
la vía se equivoca, no cuánto cuesta — y los vetos y límites duros siguen en
código en las cinco, así que el modelo refina pero nunca manda:

| Variable | Def. en código | Recomendado | Por qué |
| --- | --- | --- | --- |
| `DEEPBLUE_DOSSIER_MODEL` | `claude-opus-5` | Opus 5 | Búsqueda web + salida larga; un dossier flojo estropea el veredicto de cada unidad de ese modelo durante meses |
| `DEEPBLUE_DISCOVERY_MODEL` | `claude-opus-5` | Opus 5 | Igual: investigación, y de aquí salen las búsquedas |
| `DEEPBLUE_ENRICH_MODEL` | `claude-opus-5` | Sonnet 5 | Mueve subnotas ±15, y eso mueve nota, alertas y euros ofrecidos |
| `DEEPBLUE_READS_MODEL` | `claude-opus-5` | Sonnet 5 | Volumen mínimo, pero decide exposición a reparaciones |
| `DEEPBLUE_DRAFT_MODEL` | `claude-haiku-4-5-20251001` | Haiku 4.5 | Redactar no es juzgar; lo valida `isValidDraft()` y cae a texto determinista |

### `apps/web/.data/pglite/` — muy recomendable

Es la base de datos de desarrollo entera: briefs, leads, listados, dossiers
aprobados, enrichments, findings, discoveries y el log de eventos. Si no se
copia, la nueva máquina arranca vacía y lo craftado en sesión (dossiers,
enrichments, findings) se pierde — los sweeps se pueden relanzar, eso no.

**Cómo copiarla sin corromperla (PGlite = un solo escritor):**

1. En la máquina vieja: parar el servidor web (todo el árbol de procesos,
   no solo la ventana) y comprobar que el puerto 3000 queda libre.
2. Copiar la carpeta `apps/web/.data/pglite` completa (USB/scp/zip).
3. En la nueva: pegarla en la misma ruta ANTES de arrancar `pnpm dev:web`.

No copiar `pglite-corrupt-*` (restos de un incidente antiguo) ni `node_modules`.

## 2. Puesta en marcha

```bash
git clone https://github.com/nicomencia/deepblue.git && cd deepblue
corepack enable          # pnpm via corepack
pnpm install
# (colocar .env.local y .data/pglite como arriba)
pnpm typecheck && pnpm test
pnpm dev:web             # backup de la BD + migraciones pendientes al arrancar
```

Runner (segunda terminal). Desde 2026-07-21 carga su propio entorno — busca
`apps/runner/.env.local`, luego `.env.local` (raíz) y por último
`apps/web/.env.local` (gana el primer archivo que defina cada variable; el
entorno real siempre gana sobre los archivos). `CORE_API_URL` tiene valor por
defecto `http://localhost:3000`, así que en la misma máquina basta:

```bash
pnpm dev:runner
```

En un despliegue separado (runner en otra máquina), define `CORE_API_URL` y
`RUNNER_TOKEN` en el entorno o en `apps/runner/.env.local`.

**Arranque de un clic (Windows):** `start-deepblue.bat` en la raíz hace todo
lo anterior: mata cualquier servidor viejo en el 3000 (el candado single-writer
de PGlite), abre el panel web y el runner en sus propias ventanas, espera a que
el panel responda y abre el navegador. Doble clic, o crea un acceso directo en
el escritorio. Para pararlo, cierra las dos ventanas (web y runner).

## 3. Reglas de oro de esta base de código

- **PGlite, un solo escritor**: jamás dos `pnpm dev:web` a la vez. Antes de
  arrancar, comprobar que nada escucha en el 3000. Si un arranque se mata,
  matar el árbol completo (`taskkill /T` en Windows) — el wrapper de pnpm
  deja huérfano a `next dev`. Recuperación de corrupción: renombrar el
  directorio y reseedear, nunca borrar.
- **Migraciones**: se generan con `pnpm db:generate` (drizzle-kit) y las
  aplica el servidor web al arrancar. No ejecutar `db:migrate` contra PGlite
  (segundo escritor).
- **Invariantes de diseño** (PROJECT.md manda): runner = manos, nunca cerebro;
  límites duros y vetos en código, no en prompt; los dossiers entran en uso al
  crearse (auto-aprobados desde 2026-07-14) y la revisión es a posteriori —
  desactivar uno en /dossiers lo saca de los veredictos al momento; leads
  muertos no resucitan;
  `ACTIVE_PLATFORMS = ["wallapop"]` (AS24 pausado — no reactivar sin decidirlo).
- **Higiene Wallapop**: volumen bajo, pacing con jitter, ante 403/429 parar,
  nunca reintentar más fuerte. Desde 2026-07-14 esto es código: los adapters
  lanzan PlatformBlockedError ante 403/429 (sin fallback) y el runner deja de
  arrendar jobs 45–90 min; el Core registra el evento y avisa por email.
- **Convención de commits**: un commit por feature, mensaje explicando el
  porqué; `pnpm typecheck && pnpm test` SIEMPRE después del último archivo
  tocado, no antes.

## 4. Caja de herramientas dev (NODE_ENV != production; 404 en prod)

| Endpoint | Uso |
|---|---|
| `GET /api/dev/state` | contadores rápidos (users/briefs/listings/jobs/leads) |
| `GET /api/dev/briefs` | briefs con criterios |
| `GET /api/dev/leads?limit=200` | shortlist con veredictos completos |
| `GET /api/dev/jobs?status=queued` | cola del runner |
| `GET /api/dev/listing-raw?id=…` o `?latest=wallapop` | payload raw de un listing |
| `POST /api/dev/brief-status` | cambiar estado de una búsqueda `{briefId, status}` |
| `POST /api/dev/brief-delete` | eliminar búsqueda + leads (cascada; corpus intacto) `{briefId}` |
| `GET/POST /api/dev/outreach` | conversación de un lead / `{leadId, action: draft\|approve\|reject\|fetch\|send}` |
| `GET/POST /api/dev/chat-reads` | conversaciones pendientes de interpretar / importar `{leadId, reading}` |
| `POST /api/dev/sweep` | disparar sweep de todos los briefs activos |
| `POST /api/dev/reap` | sondas de vida (reaper) |
| `POST /api/dev/reevaluate` | backfill + retire + dedup + reevaluar todo |
| `POST /api/dev/adopt` | adoptar anuncio por URL `{url, maxPriceEur?, briefId?}` |
| `POST /api/dev/finding` | registrar hallazgo `{leadId, title, status, note?}` |
| `POST /api/dev/import-dossier` | vía suscripción: importar dossier (borrador) |
| `POST /api/dev/import-enrichment` | vía suscripción: `{leadId, enrichment}` |
| `GET/POST/PATCH /api/dev/discoveries` | sesiones de descubrimiento |
| `POST /api/dev/import-discovery` | vía suscripción: `{discoveryId, report}` |
| `POST /api/dev/seed` · `/seed-dossier` | arranque desde cero |

**Modo suscripción (sin ANTHROPIC_API_KEY):** los dossiers, enrichments e
informes de descubrimiento los redacta una sesión de Claude Code y se importan
por los endpoints de arriba (misma frontera zod que la vía API). La UI indica
dónde aplica ("pide el análisis en tu sesión de Claude Code").

## 5. Estado actual y siguiente hito

Hecho y en master: motor de evaluación con benchmark ponderado por acabado/año,
dedup por REF, precio al contado, preferencia por particulares, reaper de
anuncios, digest con suelo de nota + alertas A/B sin duplicados, dossiers
(207/THP, Golf, Elise) con verificación manual de riesgos (Confirmar/Descartar
en la página del lead), tabs por búsqueda, página Actividad, descubrimiento de
modelos y adopción manual de anuncios con dossier-first. 77 tests verdes.

**Cambio 2026-07-29 (20) — nada se enseña antes de estar analizado.** Nico:
"recibir un correo de candidato nuevo con «Confianza global: B — Buen candidato:
merece escribir al vendedor ya» no es bueno; hacemos un enriquecimiento para
tener la info clave y damos info genérica". Y después: "el enriquecimiento
debería ir antes de enseñar unidades en el programa también".

Misma causa en los dos sitios: la unidad se PRESENTA antes del análisis que la
hace legible. `composeUnitLine` ya prefiere `llm.keyLine` y solo cae en la frase
de banda cuando no hay ninguno — el problema nunca fue la redacción, era el
momento. La alerta salía en el ingest, y el enriquecimiento llega después.

- **Correo**: con la vía LLM activa, la alerta de un lead shortlisted ESPERA a
  su enriquecimiento (`alertEnrichedLead` dentro de `saveEnrichment`).
  `alertedAt` sigue siendo el sello de una sola vez. Los near miss nunca se
  enriquecen (guarda de coste deliberada), así que siguen alertando en el
  ingest. Efecto lateral bueno: un lead que solo supera el umbral DESPUÉS del
  enriquecimiento ahora sí avisa; antes no avisaba nunca.
- **Panel**: la portada retiene los leads sin `enrichedAt` y los cuenta
  ("⏳ N analizándose") en vez de enseñarlos con la nota de reglas como si fuera
  el veredicto. Sin `ANTHROPIC_API_KEY` no va a llegar ningún análisis, así que
  se enseña todo.

No estrangula nada: `enrichPendingLeadsSoon` ya se dispara desde el report del
runner en cada job, así que los lotes se encadenan — 86 analizados y 15 en cola
mientras se escribía esto.

Medido en la búsqueda ancha del Golf: de 97 shortlisted solo 5 pasan el umbral
de alerta (A/B y ≥75), y de los 28 Golf solo 2. La selectividad aguanta el
ancho.

**Cambio 2026-07-29 (19) — el concesionario oficial es una tercera categoría.**
El Spider lo vende "Renault Jurado", concesionario oficial: cuenta de negocio
verificada, 5,0 de media… pero solo 2 valoraciones, así que `assessSeller` caía
en "historial limitado" y lo dejaba en 55 neutro. La reputación de Wallapop no
es la fuente de confianza aquí.

La preferencia por particulares es desconfianza de las CADENAS de compraventa,
no de la red del fabricante. Un concesionario oficial trae garantía, kilometraje
certificado, revisión multipunto y una empresa con dirección a la que reclamar,
y nada de eso depende de cuántos compradores se acordaron de dejar estrellas.
Así que: nunca cuenta como cadena, nunca lleva la penalización de
`prefer_private`, y recibe un SUELO de credibilidad de 75 — suelo, no bonus,
y solo si la nota no lo contradice (un oficial con 2,5/5 no se maquilla).

`isOfficialDealer`: el nombre del vendedor lleva la marca registrada Y el
anuncio es de esa marca. Por tokens completos, para que "Auto Seaton" no pase
por concesionario SEAT. El texto del anuncio ("concesionario oficial") NO se usa
a propósito: cualquiera lo escribe, mientras que una cuenta de negocio no puede
operar bajo el nombre de una marca sin estar en su red. Se pierden los oficiales
con nombre familiar ("Automóviles Martín") y esa asimetría es la buena:
quedarse corto es seguro, inventar una garantía no.

En vivo: sellerCredibility 55 → 70 (C → B) y el veredicto 60 → 63.

**Cambio 2026-07-29 (18) — el mismo coche con otro nombre: alias de modelo.**
Nico encontró un Renault Spider en Wallapop que la búsqueda no vio. Renault lo
homologó como "Sport Spider", pero los anuncios ponen solo "Renault Spider", y
faltando esa palabra fallaban DOS cosas: el sweep buscaba las keywords
equivocadas, y la evaluación exigía después una palabra que el vendedor nunca
escribió (`different_vehicle`).

Aquí no se puede inferir: quitar una palabra a veces SÍ es otro coche ("Golf" vs
"Golf R"), así que los alias se **declaran** por búsqueda. Campo nuevo "Otros
nombres del modelo" que añade entradas a `criteria.vehicles` — el array que el
sweep y `matchesVehicle` ya recorrían, así que no hace falta maquinaria nueva.
De paso, `updateBrief` re-añadía `vehicles.slice(1)` al guardar (escrito cuando
solo el vehículo primario tenía campos): ahora el formulario los devuelve todos
y duplicaría cada alias en cada guardado.

Y el efecto colateral que casi se escapa: `getDossier` busca por el modelo del
ANUNCIO, así que un anuncio "Spider" no encontraba el dossier "Sport Spider" y
se evaluaba con cero conocimiento — o sea, otra vez el 55 neutro ganándole a la
investigación. Nuevo `getDossierForBrief` (en `lookups.ts`): modelo del anuncio
primero, y si no, los nombres que la búsqueda conoce. Vive ahí y no en las
llamadas porque ingest, reevaluate y adopt lo buscaban cada uno por su cuenta:
parcheé ingest, y el mismo anuncio tuvo dossier al entrar y lo perdió en la
siguiente reevaluación. Los tres pasan ya por el helper.

Verificado en vivo con el anuncio real (1148355781): aparece en la lista, 1998,
60.000 €, con los 11 riesgos del dossier, confianza 50% → 65% y exposición
4.320–23.050 €.

**Cambio 2026-07-29 (17) — una letra de diferencia y el coche pagó dos
dossiers.** Nico: "¿por qué tenemos 2 dossiers de este coche?". Culpa mía: al
probar el cambio 16 creé la búsqueda como "Renault **Sport** Spider" mientras la
suya decía "Renault **Sports** Spider". Dos investigaciones pagadas del mismo
coche (17:15, 14 problemas / 17:21, 11 problemas).

La guarda del cambio 12 existía justo para esto, pero comparaba
`lower(model) = lower(model)`: para SQL "sport spider" y "sports spider" son dos
coches. Es la misma clase de fallo que el GR Yaris —identidad de un coche por
comparación exacta de cadenas— ahora en un tercer sitio.

Nuevo `sameModelName` en core, a propósito MUCHO más estricto que
`sameModelFamily`, porque esto controla gasto real y no puede fusionar dos
coches: **el número de palabras tiene que coincidir**. Eso es lo que mantiene
"Golf" separado de "Golf R", "207" de "207 RC" y "Yaris" de "GR Yaris" — una
palabra de más es justo como los fabricantes nombran otro coche. Solo dentro de
un nombre de la misma longitud se perdona la ortografía (singular/plural, sin
encoger tokens cortos: "RS" nunca pasa a "R").

Lo usan las dos guardas: la cobertura (`isGenerationCovered`) y la reserva
(`claimDossierBuild`, que ahora mira las reservas vivas de la marca en código y
deja el índice único como árbitro atómico de las carreras con nombre idéntico).

Verificado en vivo: "Sports Spider" y "Sport Spiders" se rechazan al instante y
sin gastar, mientras Yaris y GR Yaris siguen conviviendo con dossier propio.

**Cambio 2026-07-29 (16) — el precio máximo deja de ser obligatorio.** Nico: "no
quiero poner precio máximo al crear una búsqueda; busco un Renault Sport Spider
y no sé por cuánto van, quiero crear la búsqueda para ver qué hay en el
mercado". El formulario exigía el dato que la búsqueda existe para averiguar.

`HardLimits.maxPriceEur` pasa a opcional y con eso:
- **Evaluación**: sin presupuesto no hay veto `price_over_budget` — nada puede
  pasarse de un límite que no se puso. El resto de límites (km, año, modelo)
  siguen igual.
- **Sweep**: sin presupuesto NO se manda ni techo ni suelo a la plataforma.
  Cualquier cota inventada aquí respondería la pregunta antes de hacerla.
- **`budgetNote`**: sigue cuantificando la apuesta de reparaciones, pero sin
  compararla contra un techo que no existe.
- **Negociación: se apaga.** El tope ES lo único que acota una oferta o un
  "accept"; sin él no hay número seguro que poner encima de la mesa. Así que
  `agreedPriceEur` devuelve null, `chat-reads` no emite `negotiation_ready`, y
  la ficha del lead no propone oferta ni contraoferta. Preguntas y visitas
  siguen funcionando. El typechecker encontró los cinco sitios solo.

Nuevo `/api/dev/brief-create` (dev): crea una búsqueda llamando a la MISMA
server action del formulario, así lo que se prueba es el camino real (validación
+ cadena dossier/sweep). Y el PATCH de `/api/dev/briefs` acepta `name`.

Verificado en vivo: la búsqueda del Spider sin tope encola un job **sin
`priceMaxEur` ni `priceMinEur`**, mientras las demás mantienen los suyos.

**Cambio 2026-07-29 (15) — el digest ordenado por nota, con la nota a la vista y
separado por búsqueda.** Nico recibió un correo de 52 unidades: una lista plana
donde no se veía ni cuál abrir primero ni de qué búsqueda venía cada coche.

Tres cosas. (1) El orden era `verdict->>'overall'`, la LETRA: una tirada de
"C" no dice nada sobre cuál mirar antes. Ahora ordena por la nota numérica
(`coalesce((verdict->>'score')::int, 0)`). (2) La cabecera de cada unidad pasa
de `[C]` a `[C · 67]`, porque la letra agrupa cinco puntos en un cubo y a ojo no
se puede ordenar. (3) Una sección por búsqueda, con su nombre y su cuenta, y las
secciones encabezadas por la que tiene el mejor candidato — que es la que
interesa leer primero.

El tope pasa de global (`MAX_LISTED = 25`) a POR BÚSQUEDA (`MAX_PER_BRIEF = 10`):
con varias búsquedas activas, un tope global dejaba que la más prolífica se
comiera el correo entero y las demás no aparecieran. Cada sección dice cuántas
se guarda.

Y `/api/dev/digest-preview` (dev): compone el correo que se enviaría SIN
enviarlo y SIN escribir el evento `digest_run`. Los dos efectos importan — el
correo va al buzón real, y el evento es lo que mueve la ventana, así que forzar
un envío "solo para verlo" habría suprimido el digest de verdad de ese día.
`?html=1` para el cuerpo HTML, `?hours=N` para ensanchar la ventana al inspeccionar.
Verificado en vivo: 54 candidatos, 3 secciones, tope por búsqueda respetado.

**Cambio 2026-07-28 (14) — el GR Sport no es un GR Yaris, y lo que no sabemos
identificar no puede encabezar la lista.** Nico, sobre los resultados del cambio
13: "acepto el Yaris GR FWD, pero el GR Sport no debería estar, es un coche
totalmente distinto, y nunca en los primeros resultados como están los dos".

Lo primero es un patrón de toda la industria, no un caso Toyota: el fabricante
vende un acabado que toma prestado el nombre del modelo caliente porque el halo
vende. GR Sport (130 CV, delantera, pack estético) contra GR Yaris (261 CV, AWD,
homologación de rally). Igual: N Line vs i30 N, M Sport vs M3, S line vs S3, AMG
Line vs A45, R-Line vs Golf R, ST-Line vs Fiesta ST, GT Line vs GTI. De ahí
`DECOY_BADGES`: el señuelo CONSUME la palabra que tomó prestada, así que ya no
puede satisfacer al modelo del brief. Se amplía la lista, no se parchea la
llamada.

Y las palabras del modelo tienen que ir JUNTAS: la adyacencia es lo que separa
"Toyota Yaris GR" (el coche) de "Toyota Yaris 1.5 Hybrid GR Sport" (un acabado
tres palabras más allá). Pero la adyacencia sola no basta —los vendedores
escriben "Yaris GR Sport"— por eso hacen falta las dos reglas.

Lo segundo era más profundo y no era el precio. El GRMN encabezaba con 72 (B) y
el GR Sport empataba con el mejor GR Yaris real. Motivo: los GR Yaris de verdad
SÍ casan con su dossier y arrastran "6/6 riesgos del modelo sin verificar" →
`modelReliability` E 7; el GRMN y el GR Sport no casan con nada y se llevan un
55 neutro de regalo. O sea: **la ignorancia le ganaba al conocimiento**. Un
coche del que no sabemos nada puntuaba mejor que uno que hemos investigado.

Arreglo: si el campo `model` del propio anuncio nombra una insignia
ESTRICTAMENTE más larga que la que pide el brief —"YARIS GR MN" contiene "GR
Yaris" y algo más— es un `variant`: se muestra, pero con veto `model_variant` y
techo 45 (D como mucho). "Yaris GR" son las mismas dos palabras en otro orden,
que es ortografía, no otro coche: ese no se toca. El GRMN pasa de 1º con 72 a 9º
con 45; los ocho primeros son ya todos GR Yaris de 261/262 CV.

**Cambio 2026-07-28 (13) — "¿por qué 0 GR Yaris?": el orden de las palabras
mataba el coche.** La búsqueda encontró 14 anuncios y dejó vivos 0. Seis eran GR
Yaris de verdad. Tres murieron por distancia (Elche, Pontevedra, Cádiz) y eran
muertes correctas con el brief de entonces. Los otros murieron por
`different_vehicle`, y uno de ellos —31.000 €, 98.119 km, a 52 km del centro de
búsqueda, dentro de TODOS los límites— tenía que haber sido un lead.

Causa 1, `matchesVehicle`: colapsaba el texto a alfanuméricos y pedía subcadena
CONTIGUA. "GR Yaris" da `gryaris`; Wallapop lo titula "Toyota Yaris GR", que da
`yarisgr`. No contiene. Muerto. Y `version` —que ponía literalmente "1.6 261 GR
Yaris RZ 5p S/S"— ni se miraba. Lo irónico: el comentario que hay justo encima
de esa función ya prometía que un coche perdido es "invisible y, como los leads
muertos no resucitan, permanente". Eso es exactamente lo que pasó.

Ahora un modelo de varias palabras casa en CUALQUIER orden y `version` cuenta
igual que el título. El orden no es información: nadie que venda un GR Yaris
quiere decir otro coche escribiendo "Yaris GR". Pero las palabras tienen que ser
PALABRAS, no fragmentos: "gr" vive dentro de "gris", y un Yaris gris no es un GR
Yaris — de ahí `vehicleTokens`, que parte el texto crudo y normaliza cada trozo
por separado (partir después del NFD haría que la tilde de "león" separase, y
saldría `["leo","n"]`). El precio: un "Yaris 1.5 Hybrid GR Sport" ahora llega a
la shortlist. Es el trade que este módulo ya declaraba — visible y a un clic,
frente a invisible y permanente.

Causa 2, el radio por defecto: el formulario de búsquedas rellenaba Madrid y 100
km cuando lo dejabas vacío, encogiendo a una ciudad cualquier brief sin tocar. Y
Wallapop IGNORA `distance` (RECON.md): devuelve resultados de toda España de
todos modos, así que el radio solo tira coches que el sweep ya pagó por traer.
Para un mercado nacional y fino —seis GR Yaris en todo el país— un círculo
alrededor de una ciudad donde no vives es cómo un brief no encuentra nada.
Ahora vacío = toda España, la misma semántica que ya tenía descubrimiento
(`lib/search-area.ts`, compartido por los dos formularios).

NO era el precio, aunque 30.000 € parezca el sospechoso: con el margen de
negociación de 1,15 el techo real son 34.500 €, y los seis pasaban.

Los 14 leads muertos del brief se borraron por `/api/dev/lead-delete` (con
motivo, como exige la ruta) para que el sweep los volviera a juzgar: no es
resucitar —eso sigue sin existir— es quitar filas que produjo un bug.

**Cambio 2026-07-28 (12) — el botón que te cobra por lo que ya se está
haciendo.** Nico, exacto: "si el dossier se crea solo, ¿por qué el botón está
listo para investigar? Cliqué en los dos pensando que no se autocreaba". Eso no
es una carrera rara: es la interfaz vendiendo una acción que ya está en marcha,
y cobrándola.

Faltaba la guarda que de verdad ahorra dinero: `buildDossier` comprobaba si
había un build EN CURSO, pero nunca si el dossier YA EXISTÍA. Así que en cuanto
el autobuild terminaba, una página abierta de antes seguía ofreciendo
"Investigar y redactar borrador" y el clic pagaba una investigación entera para
algo que ya estaba hecho. Ahora se comprueba la cobertura ANTES de gastar y se
responde que lo borres o desactives si de verdad quieres rehacerlo.

Y la reserva pasa a la base de datos (tabla `dossier_builds`, migración 0016).
El índice único ES el cerrojo: reclamar es un insert que o entra o choca, sin
hueco entre leer y escribir. Sobrevive a los reinicios —que es justo lo que
rompió la guarda vieja, un `Set` en memoria— y la ven todos los procesos.
Reclamos más viejos de 20 min se consideran muertos y se pueden tomar. Las
páginas /dossiers y /briefs preguntan ahora a la BD, así que el botón
desaparece mientras haya investigación en curso venga de donde venga.

**Cambio 2026-07-28 (11) — dossiers duplicados: la guarda en memoria no basta.**
Dos dossiers de Toyota RAV4 (V 2019–presente) y dos de Toyota Yaris (II
2005–2011), estos últimos creados a las 16:21 y 16:22. Cada duplicado es una
investigación pagada entera.

SÍ había guarda: el `Set building` de `dossier-builder.ts` bloquea dos builds
del mismo modelo. Pero vive en memoria: cubre un proceso y nada más. Muere con
cada reinicio —y hoy el servidor se ha reiniciado ocho veces— y no ve un build
corriendo en otro sitio. Además nadie volvía a mirar la cobertura DESPUÉS de
investigar, así que un build que arrancó mientras otro terminaba insertaba
igual; `insertDossier` versiona a propósito (v1, v2…), o sea que no choca:
crea otro dossier vivo.

Ahora, terminada la investigación, se le pregunta a la BASE DE DATOS otra vez
con la misma regla de cobertura que usó `startBriefHunt` para decidir
investigar. Si otro build llegó antes, este no inserta. No salva el dinero —a
esas alturas ya se ha gastado— pero sí evita la fila duplicada, que es lo que
ensucia /dossiers y lo que luego hay que limpiar a mano.

Falta la otra mitad, y queda anotada: para no PAGAR dos veces hace falta una
reserva en base de datos antes de investigar, como la de descubrimiento
(`claimDiscoveryAnalysis`). `POST /api/dev/dossier-delete {id}` borra por la
misma acción que el botón, así que reevalúa los leads del modelo y deja el
evento `dossier_deleted`.

**Cambio 2026-07-28 (10) — 4x2 y 4x4 dejan de ser el mismo coche.** Nico:
"mezcla 4x2 y 4x4 y no promociona uno sobre otro, y no es justo". Tenía razón y
el mecanismo era aritmético, no de opinión: `comparableWeight` pondera por
acabado, combustible, cambio y año —y no por tracción—, así que un 4x4 se
tasaba contra un charco lleno de 4x2 y salía CARO, mientras un 4x2 se tasaba
contra 4x4 y salía CHOLLO. No era neutral: premiaba al barato por ser más
barato que un coche que no es.

Ahora `drivetrain` existe de punta a punta: columna en `listings` (migración
0015, aditíva), campo en `NormalizedListing` y en `BriefCriteria`, y peso propio
en el benchmark —como el combustible, no como el cambio, porque en un SUV es el
mayor escalón de precio que hay—. Solo se juzga cuando AMBOS lados lo dicen; un
anuncio que calla sigue siendo neutral.

Ningún portal lo publica como campo (RECON.md), así que se lee del texto — y
casi nunca dice "4x4", dice el nombre comercial: HTRAC, AWD-i, 4Motion,
quattro, AllGrip, xDrive. La recomendación también lo elige y la búsqueda lo
hereda, porque "un Tucson" no es una recomendación hasta que dice qué Tucson.

Medido contra el corpus real antes de darlo por bueno, y menos mal: la primera
versión metía "integral" y "total" sueltos y "garantía total"/"revisión
integral" convertían en 4x4 un RAV4 cuyo título decía 4X2; y `tracción 4`
casaba con "tracción 4x2" por el primer dígito. Del otro lado, "trasera" suelta
es "cámara trasera" en media España. Cada token tiene que ser inequívoco por sí
solo, porque se compara contra la plantilla del concesionario. Backfill de lo ya
guardado: `POST /api/dev/drivetrain-backfill` (gratis, idempotente) clasificó
39 de 201 — el resto son 207, Golf y Elise, donde no hay nada que elegir.

**Cambio 2026-07-28 (9) — "Yaris Cross" contiene "Yaris".** Al endurecer los
filtros, la categoría del XP90 dejó de dar nada y se cayó a la categoría de
familia, que contiene el Yaris Cross: `Toyota_Yaris_Cross_Hybrid_(XP210).jpg`
nombra "Yaris", no lleva año para que la puerta de época lo pare, y no es ni un
XP90 ni un Yaris. Peor que lo que venía a arreglar.

El código de generación estaba en el propio nombre. `namesAnotherGeneration()`
compara solo dentro de la MISMA familia de código: XP210 contra XP90 es otra
generación y se descarta; NCP91 o SCP90 no comparten prefijo con XP90, así que
no se juzgan —son los códigos de chasis del propio XP90 y descartarlos habría
tirado los mejores archivos que hay—.

**Cambio 2026-07-28 (8) — la señal que sí sabe de fotos: que un editor la haya
usado.** Pregunta de Nico —"¿podemos aprender algo de estas?"— y la respuesta
resultó ser que sí, tres cosas.

Primera: todas nuestras señales hablaban del COCHE (marca, modelo, generación,
carrocería, puertas) y ninguna de la FOTO. Por eso pasaron una caravana del Tour
de l'Ain, un salpicadero en un salón y un primer plano de la parrilla: los tres
nombran el coche correctamente. La señal que faltaba viaja gratis en la misma
petición, `prop=globalusage`: qué wikis USAN el archivo. Que un editor lo
pusiera en un artículo es un juicio humano sobre la foto, y es lo único aquí
que no se puede engañar con un nombre de archivo.

Segunda: se compara entre categorías, no se devuelve la primera que valga. Una
generación tiene varias y el Tucson tenía un `..._1.6_Front.jpg` en una mientras
devolvíamos un salpicadero de otra.

Tercera, y van tres veces: **una penalización que otra señal puede superar no es
una regla, es una sugerencia**. El bonus por uso en artículos (+160) se comía el
-100 de "es una trasera" y ganaba "Toyota Yaris TS Heck.JPG" — *Heck* es
"trasera" en alemán, que nuestro patrón en inglés leía como foto limpia. Ahora
la trasera resta -400, más de lo que cualquier bonus puede devolver, y el suelo
la descarta. Commons es multilingüe: el patrón cubre heck, hinten, arrière,
posteriore, trasera.

Resultado verificado mirando las imágenes, no los nombres: Yaris XP90 → un tres
cuartos frontal limpio por fin, Tucson → frontal, Mazda2 → frontal.

**Cambio 2026-07-28 (7) — una penalización blanda no protege de nada.** El
Tucson salió con una foto de la caravana del Tour de l'Ain: un Tucson forrado de
publicidad amarilla con un ciclista gigante de plástico en el techo, entre
vallas. El Yaris, un tres cuartos trasero. Y la lección es la misma que ya
habíamos aprendido con la era y habíamos olvidado aplicar aquí.

Todas las señales de nombre de archivo eran penalizaciones (-90 si no nombra el
coche, -100 si dice "rear"...), y `sort()[0]` devuelve igualmente al menos malo
aunque TODOS sean malos. Estar dentro de la categoría correcta demuestra que el
coche sale en la foto; no demuestra de qué es la foto. Ahora "el nombre nombra
el modelo" es un filtro DURO y hay un suelo de puntuación: por debajo se
devuelve nada y que lo intente la siguiente categoría o el siguiente peldaño.
Sin foto es mejor que con la foto equivocada.

Comprobado: Tucson → `2021_Hyundai_Tucson_Ultimate_T-GDi_MHEV_1.6_Front.jpg`,
Corolla Cross → `2020_Toyota_Corolla_Cross_-_Front.jpg`.

Y queda dibujada la frontera, ya no por intuición sino por medición: el nombre
del archivo dice fiablemente QUÉ coche es (marca, modelo, generación,
carrocería, puertas) y no dice NADA de cómo es la foto (ángulo, encuadre,
obstrucciones). El Yaris XP90 lo demuestra: no hay artículo de esa generación,
Wikidata no tiene entidad para "Toyota Yaris XP90", y "Toyota Yaris (XP90)"
redirige al artículo de familia cuya portada es un Yaris de 2020 que la puerta
de época rechaza —con razón—. O sea que para ese coche la categoría de Commons
es la única fuente, y sus fotos de cinco puertas son casi todas traseras sin
decirlo. Es un hueco de cobertura, no un fallo de ranking.

**Cambio 2026-07-28 (6) — un enum en la salida estructurada NO es un enum.**
Un análisis de 65 s se perdió entero y el botón volvió a estar disponible sin
que nadie supiera por qué. Causa: `bodyStyle` se añadió como `z.enum`, pero el
SDK de Anthropic lo degrada a `{"type":"string"}` y mete los valores permitidos
solo en la `description` — así que la decodificación NO lo restringe. El modelo
contestó algo razonable en castellano, zod lo rechazó en el límite de confianza
y se tiró la investigación ya pagada.

Mismo criterio que con la profundidad: un veto que cuesta más que el defecto no
va. Ahora el campo es `z.string()` y `normalizeBodyStyle()` traduce lo que
reconoce (berlina→sedan, familiar→estate, descapotable→convertible,
monovolumen→MPV, utilitario→hatchback, y frases tipo "hatchback 5 puertas") y
descarta lo que no: quedarse sin carrocería solo significa que la foto usa la
heurística anterior.

Regla general que queda anotada: en salida estructurada, un enum de zod es una
SUGERENCIA, no una restricción. Todo lo que venga del modelo se normaliza, no se
valida a muerte.

Y los fallos dejan rastro: `console.error` más un evento
`discovery_analysis_failed` con el error. Antes el único rastro era una línea
roja en el navegador que desaparecía al siguiente render, y un análisis caro
fallaba sin dejar nada que mirar.

**Cambio 2026-07-28 (5) — titular más largo, "Por qué encaja" primero, y el
límite de las heurísticas de nombre.** El titular pasa a pedirse en 3-4 frases:
es lo primero que se lee y enmarca las tarjetas, y una sola frase enumerando los
coches no aporta nada que no esté ya debajo. En la tarjeta, "Por qué encaja"
sube al primer puesto: es la única sección que responde a para qué existe la
página —cuál elijo— y leer antes "Buscar"/"Evitar" entierra la comparación.

De fotos, dos arreglos reales: el nombre del archivo tiene que nombrar el COCHE
(una foto titulada "2008 New York International Auto Show" estaba en la
categoría del Yaris, no nombraba carrocería, y por eso puntuaba como "canónica"),
y el veto por carrocería solo se aplica si existe una hermana que SÍ coincide
—el modelo llamó "MPV" a un Jazz que Commons archiva como hatchback, y vetar
sobre ese desacuerdo habría tirado la única categoría correcta—.

Y una conclusión honesta: rankear por nombre de archivo ha tocado techo. Cuatro
rondas, cada una arregla una clase de error y destapa la siguiente —sedán,
feria, expositor promocional de 3 puertas, y ahora un tres cuartos trasero que
el nombre no delata—. El coche y la carrocería ya salen bien; el ÁNGULO no es
deducible del nombre. El siguiente paso, si molesta, no es otra regex: es
preferir imágenes curadas de una en una (portada del artículo de Wikipedia,
P18 de Wikidata) antes que elegir entre 50 archivos de una categoría.

**Cambio 2026-07-28 (4) — /descubrir deja de resolver fotos que ya tiene.**
Navegar a la página tardaba 20-39 s en frío y luego parecía instantánea, que es
la firma de un trabajo caro escondido tras una caché en memoria. Nico lo acotó
solo: borró las recomendaciones y la página voló — el tiempo escalaba con el
número de recomendaciones.

`resolveModelPhotos` se llamaba con TODAS las recomendaciones en cada render,
aunque la tarjeta prefiere la URL ya guardada en el informe. O sea: se corría la
escalera entera de Wikimedia por recomendación y se tiraba la respuesta. Ahora
solo se piden las que no tienen foto, que tras la resolución al guardar son
ninguna: 2,6 s en frío (compilación de dev) y 0,05 s después. Los informes
antiguos siguen teniendo su respaldo gratis.

**Cambio 2026-07-28 (3) — la carrocería la dice el modelo, la foto la busca el
código.** El Yaris seguía saliendo SEDÁN, y ninguna heurística de nombre podía
arreglarlo: Commons archiva cada carrocería de una generación en subcategorías
hermanas —"Toyota Yaris (XP90) hatchback" Y "... sedan"— y nosotros leíamos la
categoría padre, que las mezcla. El archivo del sedán ni siquiera dice "sedan"
en el nombre. Verificado mirando la imagen, no el nombre: era un Yaris sedán de
EE.UU. con matrícula de concesionario.

Ahora la recomendación lleva `bodyStyle` en el vocabulario de Commons y el
resolutor elige la subcategoría correcta; una hermana que nombre OTRA carrocería
queda descalificada, no solo peor puntuada. Comprobado: Yaris → hatchback,
MX-5 → descapotable, sin codificar ninguno a mano.

Y el reparto de trabajo queda explícito. El modelo YA no da `imageUrl`: nueve
URLs suyas en dos días, nueve imágenes rotas —páginas de descripción que
devuelven HTML el 27, cinco 404 el 28—. No es cuestión de insistir más en el
prompt: no sabe buscar fotos, y falla de forma invisible porque el nombre de
archivo que inventa es plausible. Así que `discoveryResearchSchema` (lo que se
le pide) es el informe MENOS `imageUrl`, y el modelo aporta solo lo que él sabe
y el código no puede saber: qué generación y qué carrocería se vendió aquí.
Quitar el campo ahorra además un HEAD por recomendación, y el presupuesto de
peticiones es lo escaso en esa vía.

Los fallos ahora caducan en 30 min en vez de 24 h. Un acierto ("la foto está
en X") sigue siendo cierto todo el día; un "no hay nada" suele ser
circunstancial —un peldaño estrangulado que contesta vacío en vez de fallar— y
cachearlo un día dejó al Mazda2 sin foto cuando un proceso nuevo la encontraba
al instante.

**Cambio 2026-07-28 (2) — la foto correcta a la primera.** Dos fallos
distintos, no uno. El Yaris salía SEDÁN —carrocería que aquí casi no se vendió—
porque de la categoría de Commons se cogía el primer archivo que no fuera una
trasera, y ese orden es arbitrario. Ahora gana el nombre SIN carrocería
("Toyota Yaris II Facelift front.JPG" no la nombra porque ES el Yaris), y un
nombre que sí la explicita solo gana si esa carrocería domina la categoría —
así un MX-5 sigue saliendo descapotable sin codificar nada a mano.

El Jazz salía de la generación anterior porque Opus 5 escribió dos en un solo
campo, "GD (2006-2008) y GE (2009-2015)", y el código se quedaba con el primero
—GD, el viejo— para una búsqueda de 2006-2013. Ahora gana el que más solapa con
la ventana buscada, y el prompt pide UNA generación: dos son dos coches
distintos, con fiabilidad y precio distintos.

Y el límite de peticiones deja de degradar en silencio: un 429 se espera una vez
(honrando `Retry-After`) en vez de abandonar el peldaño y dejar que conteste uno
peor, cuya foto se guardaba como si fuera lo mejor que había. La pausa entre
recomendaciones sube a 2 s. Y `POST /api/dev/discovery-photos` acepta
`{"force":true}`: la verificación solo caza los 404, y una foto puede ser real y
aun así del coche equivocado — esas no se curan solas.

**Cambio 2026-07-28 — la foto que da el modelo se comprueba, no se cree.**
Las cinco recomendaciones de la primera tirada con Opus 5 salieron con foto rota.
No faltaban: estaban guardadas, bien formadas, con nombre de archivo de Commons
plausible —marca real, generación real, convención de nombres real— y las cinco
daban 404. El modelo las había deducido.

El agujero estaba en `withPhotos()`: solo rellenaba las recomendaciones SIN
`imageUrl`. Una URL con forma correcta pasaba `normalizeImageUrl` y se guardaba
sin preguntar nunca si existía, así que nuestro resolutor no llegaba a correr
justo en las que más falta hacía. Ahora se comprueba con un HEAD: si no
responde una imagen, se tira y se resuelve por la escalera de siempre.

Solo condena un "no" definitivo. Un 429 o un 5xx significan que Wikimedia está
saturada, no que el archivo no exista — tratarlos como invento borraría fotos
buenas precisamente durante un límite de peticiones, que es cuando la escalera
tampoco puede sustituirlas. Y `backfillDiscoveryPhotos` cuenta URLs que
CAMBIAN, no cuántas hay: cinco inventadas sustituidas por cinco reales dejan el
recuento igual, y comparar recuentos habría dicho "nada que hacer".

Aprendido a base de provocarlo: verificar cinco URLs a mano, más cinco HEAD,
más dos reintentos, más una prueba de seis casos, todo contra el mismo host en
minutos, se gana un 429 para todo lo demás. La escalera ya trataba eso como
transitorio y no lo cachea como ausencia, así que se recupera sola — pero la
lección es que comprobar tiene coste y hay que espaciarlo.

**Cambio 2026-07-28 — menos texto por recomendación, y en el sitio que decide.**
La pantalla de descubrimiento sirve para UNA cosa: elegir entre los modelos
propuestos. `whyFits` es el único campo que responde a eso, así que mantiene sus
4-5 líneas. Los otros tres son traspasos —la búsqueda hereda `versions`, el
dossier profundiza en `watchouts` unidad por unidad— y ahora van cortos: 2, 1-2
y 3 líneas, de apunte y no de explicación. Un 25% menos de bulto, quitado de
donde no ayudaba a comparar.

**Cambio 2026-07-27 — todas las vías de juicio pasan a Opus 5.** Sustituye a
Opus 4.8 al MISMO precio ($5/$25 por millón), así que no cuesta nada y ninguna
de las guardas de gasto cambia. Antes de tocar nada se probó la forma exacta que
manda la investigación —adaptive thinking + `web_search_20260318` + salida
estructurada— contra los dos modelos: aceptada sin 400 en ambos. La prosa barata
(`DRAFT_MODEL`) se queda en Haiku 4.5 a propósito; sigue todo overridable por
env, que es la vía para probar un modelo sin tocar código.

Se cambia a la vez que el arreglo de profundidad de abajo, y eso son dos
variables en la misma tirada. Es asumible porque la profundidad ya no depende
del modelo: está escrita en el prompt, y `thin` en el evento `discovery_report`
la mide venga de donde venga.

**Cambio 2026-07-27 — la profundidad de las recomendaciones deja de ser azar.**
Nico notó que los informes nuevos se leían peor que los primeros. Medido sobre
los informes guardados, tenía razón y el motivo no era el que parecía: la
calidad por línea es idéntica (~78 caracteres de media en los tres informes) y
el modelo era el mismo (`claude-opus-4-8`). Lo que cayó fue el NÚMERO de líneas
— 5+4 viñetas por recomendación → 4+4 → 3+3 en el mismo día.

Causa: nadie las había pedido nunca. Los arrays del schema no tienen cota y el
prompt describía la FORMA de cada campo pero jamás su TAMAÑO; `whyFits` —el que
más se nota, "Por qué encaja"— ni siquiera se mencionaba. Con eso, la
profundidad era capricho del modelo, y encima el prompt había engordado con diez
líneas sobre la URL de la foto: el único punto con detalle insistente era el que
menos importa al comprador.

Ahora las cifras viven en `DEPTH` (apps/web/lib/discovery.ts) y se interpolan en
el prompt, que además explica qué es cada campo y que las cifras son un mínimo,
no un techo. El bloque de la foto se queda en cinco líneas porque `withPhotos()`
ya resuelve en código lo que el modelo no encuentre.

A propósito **no** es un `.min()` en el schema, aunque la casa diga "límites
duros en código": rechazar un informe flojo en el límite de confianza tiraría
minutos de investigación web ya pagada por una cuestión de presentación — el
veto costaría más que el defecto. En su lugar, el evento `discovery_report`
guarda `thin`: cuántas recomendaciones han venido por debajo de lo pedido. Si el
modelo vuelve a acortar, se ve en los datos en vez de notarse a ojo meses
después. 210 tests verdes.

**Cambio 2026-07-27 — las fotos de las recomendaciones se resuelven AL GUARDAR.**
Cierra el límite que quedaba: las recomendaciones no tenían dónde persistir y
dependían de consultas en tiempo de render, así que aparecían y desaparecían
según el límite de peticiones de Wikimedia. Ahora se resuelven en
`saveDiscoveryReport`, que es el cuello de botella de **las dos vías**
(investigación por API e importación desde Claude Code), y la URL forma parte
del informe guardado desde el momento en que existe.

A propósito **secuencial y con pausa** de 400 ms: esto corre justo después de un
análisis que ha tardado minutos, así que unos segundos en NO tocar el límite
salen gratis — y la ráfaga era justo lo que hacía fallar las consultas. Nunca
lanza: un informe sin fotos sigue siendo un buen informe.

Para los informes ya guardados, `POST /api/dev/discovery-photos` (gratis, sin
LLM, idempotente — se salta las que ya tienen foto, y opcionalmente `{id}` para
una sola). En el informe de Nico llenó 2 de 4 en la primera pasada y la cuarta
en la segunda: reintentar recupera lo que se perdió por límite de peticiones,
que es exactamente para lo que sirve ser idempotente. Verificado reiniciando el
servidor: las 4 recomendaciones, el 207 de la búsqueda y los 2 dossiers pintan
al instante desde la base de datos, sin una sola llamada a Wikimedia.

**Cambio 2026-07-27 — una foto por coche, y guardada.** Nico vio que la búsqueda
del 207 RC y su dossier enseñaban fotos distintas del mismo coche. No era un
desacuerdo de criterio, era **suerte**: cada render dispara varias consultas a
la vez, Wikimedia limita las ráfagas anónimas, y la página que perdía la carrera
caía a otro peldaño de la escalera. Consultar en tiempo de render contra una API
limitada no puede dar una respuesta estable.

Tres arreglos, en orden de importancia:
1. **Se persiste lo resuelto en `content.imageUrl` del dossier.** La primera
   respuesta pasa a ser LA respuesta: las tres páginas leen el mismo campo
   después y la consulta no vuelve a ejecutarse. Verificado reiniciando el
   servidor (caché en memoria vacía): las dos páginas siguen enseñando
   `Peugeot_207_RC_Facelift_front_20100416.jpg` al instante y sin llamadas.
2. **El dossier manda sobre la identidad del modelo.** Una búsqueda de «207 RC»
   sin generación y el dossier «207 · 207 RC / THP (2007-2012)» son el mismo
   coche; se preguntaban cosas distintas y salían fotos distintas. Cuando hay
   dossier que cubre el coche, la consulta se hace con SU identidad.
3. **El código de generación ya no puede ser el propio modelo.** De
   «207 RC / THP (2007-2012)» se sacaba «207», así que se buscaba
   «Peugeot 207 207» y se aterrizaba en el artículo genérico. Ahora se salta los
   tokens numéricos y los que repiten el modelo → «RC». Y el peldaño del
   artículo con generación exige que el TÍTULO nombre la generación (o sea de
   tipo «second generation»): buscar «Peugeot 207 RC» devolvía tan feliz el
   artículo «Peugeot 207», cuya foto no tiene año y por tanto cruzaba la puerta
   de época. Con eso el 207 pasa de la foto genérica a la del RC de verdad.

Límite que queda: las recomendaciones sin dossier no tienen dónde persistir, así
que siguen expuestas al límite de peticiones y pueden quedarse sin foto en un
render y tenerla en el siguiente.

**Cambio 2026-07-27 — ninguna foto es mejor que la foto de otra generación.**
Nico lo cortó en seco: enseñar un Swift de 2024 en una caza de 2005-2017 «es
venderle al usuario algo que no es real». Tiene razón y es la misma regla que ya
aplicaba `normalizeImageUrl` («mejor sin foto que rota»), llevada un paso más:
**mejor sin foto que equivocada**. Una foto rota se nota; una foto guapa del
coche que no es, no — y eso es peor.

Ahora cada candidata pasa una **puerta de época** (`photoMatchesEra`) antes de
mostrarse. Los nombres de archivo de Commons llevan por convención el año del
coche (`2008-2010_Honda_Jazz_(GE)_…`, `2024_Toyota_Yaris_…`): si algún año del
nombre cae dentro de la banda de la caza (con holgura +2 por facelifts y fotos
posteriores, −1 por año-modelo adelantado) pasa; si hay años y todos quedan
fuera, se rechaza; si no hay ningún año, pasa — la ausencia de dato no es prueba
de desajuste, la misma regla que aplica el evaluador con las coordenadas que
faltan. La banda sale del sitio correcto en cada página: `criteria.yearMin/Max`
en búsquedas, `generationYearSpan(content.generation)` en dossiers y
`rec.yearMin/Max` en recomendaciones. La reserva del corpus se filtra por el
`year` real del anuncio, que es dato duro y no heurística de nombre.

Y una escalera nueva en medio: **Wikidata**. La mayoría de generaciones son
ítem propio con imagen curada (P18) aunque no tengan artículo — verificado en
vivo, «Toyota Yaris XP90» → `Q106612215` con foto de un NCP91 real de 2011. Va
entre el artículo con generación y el artículo a secas.

Tres fallos encontrados al verificarlo, ninguno visible en typecheck:
1. La puerta leía solo el último segmento de la URL, y las miniaturas de
   Wikipedia repiten el nombre un directorio más arriba (`/thumb/…/File.jpg/
   960px-File.jpg`), a veces abreviado sin el año. Ahora mira la ruta entera.
2. Filtrar por marca no basta: «Mazda Mazda2 DE» devolvía el artículo del
   **Mazda CX-3** y «Suzuki Swift MZ» el de **Suzuki la empresa**, cuya foto no
   tiene año y por tanto cruzaba la puerta tan feliz. `titleMatches` exige
   además el modelo, salvo en artículos de generación, que pueden usar el otro
   nombre de mercado («Honda Fit (second generation)» ES el Jazz GE).
3. **Envenenamiento de caché**: «falló la API» y «la API dice que no hay» se
   guardaban igual. Una ráfaga de consultas en paralelo tocó el límite de
   Wikimedia, los fallos se cachearon como ausencias 24 h, y fichas que SÍ
   tenían foto se quedaron sin ella hasta reiniciar. Ahora solo se cachea la
   respuesta definitiva; lo transitorio se reintenta en el siguiente render.

Coste inicial: menos fotos (2 de 4 en /discovery). Nico no lo aceptó — «parece
raro no encontrar foto de modelos de millones de ventas» — y tenía razón: el
problema no era que no existieran, era que yo miraba en el sitio equivocado.

**La fuente buena son las CATEGORÍAS de Commons**, una por generación:
`Category:Toyota Yaris (XP90)`, `Category:Mazda2 (DE)`,
`Category:Lotus Elise (Series 2)`, `Category:Honda Fit (2nd generation)`,
`Category:Volkswagen Golf VII`, `Category:Suzuki Swift (2004)`. El nombre no es
consistente, pero da lo que ninguna heurística de nombre de fichero daba: **la
categoría garantiza el COCHE**. Dentro de `Category:Mazda2 (DE)` no puede
aparecer una moto Honda, ni un Mazda CX-3, ni SWIFT el banco belga — que es
exactamente lo que devolvían las alternativas que probé y descarté (imágenes del
artículo, y búsqueda de ítems en Wikidata). Con el coche garantizado, a la
puerta de época solo le queda elegir la generación, que es lo que sabe hacer.

Detalles que costaron sangre, todos encontrados verificando:
- **Exigir el modelo en el nombre de la categoría, no solo la marca**:
  `Toyota Vios (XP90)` es otro coche de la misma plataforma y le ganaba al Yaris.
- **Un año en el nombre de una CATEGORÍA es el inicio de la generación**, no el
  año de un coche («Suzuki Swift (2004)» llegó hasta 2010). Solo se descarta si
  empieza después de la ventana. Y la categoría elegida ES la generación, así
  que su año de inicio ensancha la ventana al filtrar sus ficheros: un 2004
  dentro de esa categoría es el coche que busca una caza de 2006.
- **La categoría base suele estar VACÍA**: `Category:Suzuki Swift` tiene 0
  ficheros, todo cuelga de subcategorías. Tenía bonus por ser la de la familia y
  se comía uno de los intentos. Ahora puntúa lo mínimo.
- **Un fallo transitorio por categoría, no por función**: una llamada limitada
  por Wikimedia abortaba la función entera y tiraba las categorías aún sin
  probar. Por eso el Swift se quedaba sin foto teniendo 50 ficheros válidos un
  peldaño más abajo.

Resultado: **4 de 4 en /discovery y todas de su generación** — Yaris II
facelift, Jazz GE 2008-2010, Mazda2 DE de 2011, Swift MZ de 2004 (y no el de
2024). En /briefs el 207 RC pasó de una foto de anuncio con marca de agua a
`Peugeot_207_RC_Facelift_front_20100416.jpg`, que es literalmente el coche
buscado. Verificado con `naturalWidth > 0`.

**Cambio 2026-07-27 — las recomendaciones también caen a Wikipedia.** Nico creó
un perfil nuevo y solo 1 de 4 recomendaciones traía foto. No era un fallo de
normalización: tres venían **sin `imageUrl` en absoluto**. Es razonable — la
investigación tiene 12 búsquedas y las gasta en precios y fiabilidad, y el
prompt le dice explícitamente que omita el campo antes que inventarse una URL
(la que sí trajo usaba ya `Special:FilePath`, así que el cambio del prompt
funciona). El fallo era otro: **/discovery era la única de las tres listas sin
reserva**, justo la que le dio la idea al resto. Ahora usa el mismo
`resolveModelPhotos`: arte investigada primero (específica de generación) y
Wikipedia si no hay.

Y una escalera más en `fetchWikipediaPhoto`: primero con generación, luego sin
ella. La etiqueta de generación es texto libre de la investigación y puede ser
imposible de buscar — «Suzuki Swift MZ/EZ y FZ/NZ» no encontraba nada mientras
que «Suzuki Swift» acierta a la primera. Mejor la foto del modelo que ninguna.
De 1 de 4 a **4 de 4**, verificado con `naturalWidth > 0`.

**Cambio 2026-07-27 — borrado permanente de dossiers.** Antes `deleteDossier`
solo tocaba borradores (`isNull(reviewedAt)`), así que pedir el borrado de un
dossier en uso **borraba cero filas en silencio** y la página se repintaba
igual. Ahora borra cualquiera, y se hace cargo de las dos consecuencias que el
camino de borrador no tenía:

- los veredictos construidos sobre él quedan mal, así que se reevalúan los leads
  de ese modelo en el acto (igual que al desactivar). Las notas se mueven: es el
  objetivo, no un efecto secundario;
- `findUncoveredHunts` vuelve a ver el modelo como descubierto y, si queda
  alguna búsqueda activa o pausada de ese coche, **el carril de reintentos lo
  investiga solo y eso cuesta dinero**. El `confirm()` lo dice, y solo en ese
  caso: la página mira qué modelos siguen cazándose y añade el AVISO únicamente
  al dossier afectado (verificado: de los cuatro, el aviso sale solo en el
  Peugeot 207, que es el único con búsqueda viva). Para callar un dossier sin
  gastar sigue estando Desactivar.

Los `findings` por lead referencian las incidencias por título, así que quedan
huérfanos en vez de borrarse: si un dossier reconstruido nombra la misma
incidencia, las confirmaciones del usuario vuelven a aplicar solas. Queda evento
`dossier_deleted` con lo que se perdió. `ConfirmDelete` sube a `app/` (lo usan
ya dos páginas) con `label` opcional. Verificado en vivo importando un dossier
de pega, borrándolo desde la UI y leyendo el texto del confirm — nunca sobre los
dossiers reales del usuario.

**Cambio 2026-07-27 — límites opcionales en el perfil de descubrimiento.** Años
(mín/máx), km máximos, RHD, matrícula española y etiqueta DGT mínima. La idea de
Nico era enriquecer la recomendación, pero estos cinco no son gusto sino filtro,
así que hacen las dos cosas: entran en el prompt como «restricciones duras del
comprador» (una recomendación que las viola no sirve: se convierte en un brief
que hereda los mismos límites y luego mata todo lo que encuentra) y se heredan
en el brief, para no volver a escribirlos búsqueda a búsqueda.

El detalle que importa es la **intersección de años**: la recomendación trae los
años de la generación que propone y el perfil los del comprador, y ambos tienen
que cumplirse — `yearMin = max(rec, perfil)`, `yearMax = min(rec, perfil)`.
Quedarse con uno solo cazaría fuera de la generación o ignoraría lo que pidió el
usuario. Con test, junto al resto de `recommendationToBrief` (nuevo
`lib/discovery.test.ts`).

La etiqueta DGT es **orientativa, no filtro**: `BriefCriteria` no tiene campo
`ecoLabel`, así que guía la recomendación y viaja al brief como nota
(«Etiqueta DGT mínima: C») en vez de perderse por el camino. Convertirla en
filtro real pide campo nuevo + soporte en el evaluador; queda dicho, no hecho.
Los checkbox sin marcar no llegan en el FormData y se guardan como `undefined`,
nunca `false`: ausencia de dato no es una opinión del usuario.

Segunda tanda, misma sesión: ubicación, tolerancia al riesgo y tipo de vendedor
dejan de estar cableados. Van en su propio bloque del formulario y —a diferencia
de los límites de arriba— **no entran en el prompt**, porque no cambian QUÉ
modelos convienen, solo cómo caza la búsqueda que salga: qué modelo te pega no
depende de cuánto estés dispuesto a viajar ni de a quién prefieras comprarle.

El cambio con más consecuencia es el radio: **por defecto, toda España**. Y
«toda España» no es un radio muy grande, es **ningún filtro de distancia** —
`criteria.location` ausente y el evaluador se salta el check entero. Es lo
correcto porque Wallapop ignora los parámetros de distancia y devuelve
resultados de todo el país igualmente (RECON.md, verificado 2026-07-22): el
radio solo existió nunca como filtro de evaluación. El Madrid ±200 km que había
cableado estrechaba en silencio toda búsqueda nacida de un descubrimiento a un
tercio del país. Coordenadas sin radio se ignoran: un centro sin radio no filtra
nada. Riesgo y vendedor conservan sus valores de antes (`medium`,
`prefer_private`) como defaults del select, así que nada cambia salvo que el
usuario lo toque. Verificado en vivo los tres casos: por defecto sin location,
radio explícito desde Barcelona con decimales intactos, y coordenadas sueltas
descartadas.

**Cambio 2026-07-27 — foto de modelo en búsquedas y dossiers (y el schema roto
que casi se lleva por delante el descubrimiento).** Nico pidió las fotos también
en búsquedas y dossiers, «para identificarlo todo más rápido». Antes de tocar
nada comprobé el cambio anterior y estaba **roto**: había metido la reparación
de `model`/`imageUrl` como `.transform()` dentro de `modelRecommendationSchema`,
que es justo el schema que se le pasa al SDK como formato de salida estructurada
— `zodOutputFormat` lo rechaza («Transforms cannot be represented in JSON
Schema»). O sea: «Analizar con IA» reventaba ANTES de empezar, y ni el typecheck
ni los 193 tests lo veían porque solo salta en tiempo de petición. La reparación
pasa a ser `parseDiscoveryReport(raw)` (valida con el schema plano y luego
arregla), por la que pasan las dos vías, y hay test de regresión en core que
exige que `z.toJSONSchema` siga aceptando los schemas que ve el modelo. La
lección aplicada al resto: nada de `.transform()` en un schema que viaje al SDK.

Las fotos: `content.imageUrl` en el dossier (jsonb, sin migración) con la misma
regla Wikimedia que descubrimiento, pedido en el prompt y normalizado **después**
de parsear. `lib/model-photo.ts` resuelve la foto de cada modelo para toda la
página de una vez (nada de una consulta por fila: la BD de dev es single-writer)
en tres niveles: foto investigada del dossier → **imagen de cabecera del
artículo de Wikipedia** (`lib/wikipedia-photo.ts`, sin LLM, sin clave, sin
coste, caché de 24 h con negativos y timeout de 2,5 s para que ninguna página
dependa de que Wikipedia responda) → foto de anuncio del corpus como último
recurso, que es una unidad concreta y a veces con marca de agua del
concesionario encima.

Probé antes la búsqueda de archivos en Commons, que sí acierta la generación, y
la descarté por poco fiable: devolvió un **logo** para «Suzuki Swift», primeros
planos de bisagra y tapa de depósito para «Golf VII», y fotos de un Toyota Yaris
Cross para «Mazda2 DE». La cabecera de un artículo siempre es una foto decente
del coche.

En el título va solo `marca + modelo` (`splitModelAndGeneration` al pintar): la
generación y su rango de años ya salen en el subtítulo, y los dossiers
investigados antes de la separación siguen guardando `"Yaris (XP90, 2006-2011)"`
en el campo. Queda `Toyota Yaris · II (2006–2011) · v1` en vez de repetir los
años dos veces en la misma línea.

Y una confirmación que conviene dejar escrita, porque es justo el fallo que
acabamos de arreglar: **la generación no filtra anuncios en ningún sitio**.
`matchesVehicle` sólo compara marca y modelo; `enqueueSweeps` construye la
keyword como `${make} ${model}` y manda los años en `yearMin`/`yearMax`. La
generación se usa únicamente para (a) elegir el dossier que cubre la unidad,
(b) el nombre del brief y (c) afinar la búsqueda de la foto. Un anuncio no tiene
por qué decir «XP90» — casi ninguno lo dice — y no necesita decirlo. El corte
real es la banda de años, que además es límite ELÁSTICO: un 2012 en una búsqueda
2006–2011 no muere, cae en near miss (`NEAR_MISS_YEAR_SLACK`).

**Limitación conocida y aceptada**: cuando Wikipedia cubre todas las
generaciones en un solo artículo, su foto es la generación ACTUAL. Verificado en
vivo: el Golf VII y el 207 salen bien (hay artículo por generación), pero el
dossier del Yaris XP90 (2006-2011) enseña un Yaris de 2024 y el del Elise S1/S2
un Elise moderno. Por eso la foto investigada del dossier manda: es específica
de generación por construcción, y todos los dossiers nuevos la traen. Los cuatro
dossiers actuales son anteriores al campo. Verificado preguntando al DOM qué
imágenes decodifican de verdad (`naturalWidth > 0`): 6 de 6.

**Cambio 2026-07-27 — analizar un descubrimiento deja de poder pagarse dos veces
(y el informe deja de nacer inservible).** Nico clicó «Analizar con IA», recargó
la página y se encontró el botón otra vez: lo clicó de nuevo y salieron modelos
distintos. No era la UI, eran cuatro fallos encadenados y todos con factura.

1. **Sin marca de en-curso.** El spinner vivía solo en el navegador
   (`useFormStatus`); `discoveries.status` era `pending | ready | archived`, sin
   estado intermedio, así que al recargar la fila seguía `pending` y la página
   dibujaba el botón otra vez. Y recargar NO cancela nada: la petición sigue
   viva en el servidor. Dos clics = dos investigaciones completas de Opus con
   búsqueda web — la acción más cara del producto, la única sin guardia, contra
   el invariante «cost guards everywhere» del CLAUDE.md. **Pasó de verdad**: el
   descubrimiento `61c226a6` tiene dos eventos `discovery_report` del mismo
   modelo, y el segundo pisó al primero (por eso el Yaris XP130 se convirtió en
   XP90: el informe no se versiona, se sobrescribe, y el XP130 ya no existe).
   Ahora `analysis_started_at` + estado `analyzing`, tomados con un UPDATE
   condicional (`claimDiscoveryAnalysis`): dos clics simultáneos compiten por la
   misma fila y gana exactamente uno, el otro recibe «ya se está analizando».
   Se libera si el análisis falla, y `ANALYSIS_STALE_MS` (20 min) permite
   recuperar una marca huérfana por reinicio.
2. **El `model` traía la generación dentro.** La investigación devolvía
   `"Yaris (XP90, 2006-2011)"`, y ese campo NO es cosmético: es la keyword del
   sweep y la aguja del matcher. La búsqueda se lanzó con
   `keywords: "Toyota Yaris (XP90, 2006-2011)"`, que no existe en ningún
   anuncio → cero resultados, con pinta de «no se buscó nada». `startBriefHunt`,
   el dossier y la búsqueda funcionaron perfectamente; el dato de entrada
   estaba envenenado. `splitModelAndGeneration` lo parte en el trust boundary
   (vale para las dos vías, API e importación) y la generación se guarda en
   `generation` en vez de tirarse: es lo que distingue un XP90 de un XP130
   cuando los años ya no están. Va al nombre del brief y a `criteria.vehicles`.
3. **Las fotos eran páginas HTML.** `imageUrl` llegaba como
   `commons.wikimedia.org/wiki/File:X.jpg`, que sirve `text/html` — imagen rota
   en todas las fichas. `normalizeImageUrl` lo reescribe a
   `Special:FilePath/X.jpg?width=640` (el redirect estable de Wikimedia, y de
   paso miniatura: el Yaris original pesa 2,8 MB, el de 640 px 129 KB) y
   descarta lo que no sea imagen — mejor sin foto que rota. Se aplica también al
   pintar, para que los informes ya guardados se vean sin repetir minutos de
   investigación pagada.
4. El prompt pide ahora las dos cosas explícitamente, pero la reparación vive en
   el schema: pedirlo por prompt es una sugerencia, `parse, don't trust` es la
   regla.

`POST /api/dev/discovery-claim` (`{id, action: "claim"|"release"}`) existe para
verificar la carrera sin pagar dos investigaciones — `claim` dos veces devuelve
`true` y luego `false` — y para desatascar a mano una fila `analyzing` colgada.
Verificado en vivo con Playwright: carrera correcta, la página recargada ya no
ofrece el botón sino «⏳ Analizando…», el release la vuelve a dejar reclamable,
y la foto del Yaris ya se ve en el informe viejo. 193 tests verdes.

**Cambio 2026-07-27 — «Crear perfil» dice si funcionó, y no se come lo escrito.**
El botón ya tenía `SubmitButton` desde el 21-07, pero en una acción rápida (un
insert) la etiqueta «⏳ Creando…» parpadea y desaparece, y lo único que cambia
—una ficha nueva al final de un formulario de doce campos— se dibuja fuera de
pantalla. El clic se leía como muerto. Nuevo `app/action-form.tsx` (`ActionForm`,
cliente, campos como children para que sigan siendo servidor): envuelve la
server action con `useActionState`, pinta el resultado JUNTO AL BOTÓN que lo
provocó (verde `role=status` / rojo `role=alert`) y limpia el formulario al
crear — conservar los valores tras un alta es justo lo que invita al duplicado
accidental. `lib/action-result.ts` lleva el tipo (`ActionResult`, `actionOk`,
`actionError`) porque un módulo `"use server"` solo puede exportar funciones
async. `createDiscovery` deja de lanzar: un presupuesto mal tecleado («ocho
mil») devolvía el overlay de error de Next, un callejón sin salida para una
errata recuperable; ahora devuelve una línea bajo el botón y el mensaje de éxito
dice qué toca después («pulsa Analizar con IA»), que era el otro hueco: el
perfil nace `pending` y no hace nada solo.

Lo caro lo encontró la verificación en vivo, no el typecheck: **React 19 resetea
un formulario no controlado después de CUALQUIER action**, así que mi primera
versión borraba los tres textareas por una errata en el presupuesto — peor que
el problema que venía a arreglar. `ActionForm` guarda lo tecleado antes de
llamar a la acción y lo repone si la acción rechaza; los checkboxes se reponen
por pertenencia al snapshot (ausente = desmarcado de verdad, no falsy).
Verificado con Playwright contra el stack real: los 12 campos sobreviven al
rechazo (incluidos dos combustibles marcados y dos sin marcar, y el select),
el alta limpia el formulario y la ficha nueva aparece. Los perfiles de prueba
quedaron archivados.

**Cambio 2026-07-26 — borrar un lead que creó un bug, sin tocar la regla.**
Consecuencia del arreglo anterior: el `207RC` a 5.700 € seguía muerto, y adoptar
NO resucita (`adopt.ts` ve el lead muerto y devuelve `lead_dead` — correcto por
diseño). Los muertos no resucitan sigue siendo absoluto: **no hay transición
`dead → shortlisted` en ninguna parte y no se ha añadido ninguna.** Lo que se
añade es `POST /api/dev/lead-delete` (`{leadId, reason}`, reason OBLIGATORIA y
registrada en un evento `lead_deleted` colgado del usuario, porque los eventos
del lead se van con él): borra filas que produjo código roto, para que el
anuncio se adopte limpio por la vía normal. La regla se escribió para leads que
murieron por criterio, no por bug. El listing nunca se toca. Verificado: lead
borrado → readoptado → entra en la búsqueda 207 RC existente (no crea
«Seguimiento», gracias al arreglo del matcher en adopt.ts) como `shortlisted`
`origin=manual`, grado D (52): 170.000 km y exposición 2.200–6.550 € lo dejan
tercero de los cuatro 207.

**Cambio 2026-07-26 — «207RC» sin espacio no es otro coche.** Cazado mirando
los leads muertos: un `Peugeot 207RC 2008` REAL a 5.700 € estaba descartado como
`different_vehicle`, porque `matchesVehicle` hacía `includes("207 rc")` literal y
el vendedor lo escribió sin espacio. Los vendedores escriben `207RC`, `207 R.C.`,
`207-rc`, y `Leon` por `León`. Arreglo: normalizar ambos lados a alfanuméricos
puros (`normalizeVehicleText`, con `NFD` para que los acentos caigan solos).
**El intercambio es deliberado y asimétrico**: se acepta un falso positivo raro
(dos tokens fundiéndose en un tercero, «G Turbo» leído como «GT») a cambio de no
volver a tirar en silencio justo el coche que el usuario busca — un coche de más
en la lista se ve y se descarta de un clic; uno de menos es invisible y, como los
muertos no resucitan, permanente. Tests: las cuatro grafías entran, y un 207 a
secas o un 207 GT siguen fuera. **Ojo: esto NO revive los leads ya muertos** (es
la regla, no un olvido); para recuperar uno concreto, adoptarlo a mano — las
adopciones sobreviven a los filtros duros por diseño.

**Cambio 2026-07-26 — casi-candidatos: los límites se estiran por detrás.** Un
207 RC con 8% más de km del tope no es basura, es información — pero tampoco
entra en la lista, porque «shortlisted» tiene que seguir significando «cumple
tu búsqueda». Nuevo estado `near_miss` entre `evaluated` y `shortlisted`, con
banda de estiramiento (`NEAR_MISS_STRETCH = 1.15`, y ±1 año para los límites de
año, que en años no se miden en porcentajes). **La distinción que manda: límites
ELÁSTICOS (precio, km, año, radio) tienen banda; límites ABSOLUTOS (vehículo
distinto, RHD, matrícula extranjera) NO — un import a la derecha barato no es un
casi-candidato, es un no, y avisar de él vaciaría el invariante de límites duros
por dentro.** El precio ya tenía `NEGOTIATION_HEADROOM = 1.15`: la banda se
aplica ENCIMA de ese borde, no lo sustituye. Bandas como constante de fondo, sin
UI ni campo en el brief: el usuario pone números redondos, no tolerancias.

Solo interrumpe lo realmente bueno: grado A/B **y** puntuación por encima de
todo lo que ya hay en la lista de ese brief (medido ANTES del lote, para que la
barra sea lo que el usuario ya tenía). Los casi-candidatos no entran en el
digest, no piden enriquecimiento (ni fetch del runner ni LLM — cuestan dinero en
anuncios que el usuario no pidió) y NUNCA se contactan solos. Sí los repasa el
reaper (un aviso que apunta a un coche vendido es peor que ningún aviso) y sí
los re-evalúa un cambio de precio o de límites del brief: `shortlisted ↔
near_miss` se mueve en ambos sentidos, pero un lead ya contactado no retrocede
(lo impide `canTransition`). Detalle de implementación: las bandas se comparan
contra bordes absolutos redondeados, no contra ratios — `1.15 - 1` no es 0,15 en
coma flotante y un coche justo en el borde redondo se caía por la grieta (cazado
por un test). Verificado en vivo: 4 leads del 207 intactos, páginas 200,
`reevaluate` estable. 187 tests verdes. `GET /api/dev/leads` acepta ahora
`?state=` y devuelve `deadReason` — así se responde «¿por qué se cayó ése?».

**Cambio 2026-07-26 — `runner:login` era inusable: el muro de cookies.** Al
preparar el perfil de Wallapop en la segunda máquina, la ventana abría con la
página BORROSA y sin poder pulsar nada: el gate de consentimiento de OneTrust
bloquea la página entera hasta contestarlo, y `login.ts` iba directo a esperar
la cookie de sesión sin descartarlo — aunque `dismissCookieBanner()` ya existía
en `wallapop-chat.ts` y TODO envío de chat lo llamaba. Sólo el login se lo
saltaba. Segundo factor: `openWallapopProfile` fijaba `viewport` también en
modo headed, así que página y ventana real iban desacopladas (4011x1737 en el
caso visto) y el banner, anclado al borde inferior del viewport, caía fuera de
lo visible. Arreglo: `dismissCookieBanner()` exportado y llamado desde el
login, y en headed `viewport: null` + `--window-size=1366,900` (headless
conserva su tamaño explícito — no tiene ventana). Verificado en vivo: sesión
detectada y guardada en el perfil al primer intento. **Ojo: descartar el banner
pulsa «aceptar» de OneTrust** — es lo que ya hacía cada envío de chat, pero es
una decisión de privacidad; para rechazar hay que hacerlo a mano en la ventana.

**Cambio 2026-07-26 — el scheduler no puede importar `node:crypto`.** Al
levantar `dev:web` en la segunda máquina de desarrollo, TODAS las rutas daban
500: `UnhandledSchemeError: node:crypto`. Causa: el secreto de arranque que
añadió el ensayo de despliegue (2026-07-22) trajo consigo
`import crypto from "node:crypto"` en `lib/scheduler.ts`, y a ese módulo se
llega desde `instrumentation.ts`, que Next compila TAMBIÉN para el runtime
edge — donde un especificador `node:` no resuelve y rompe el build entero. El
guard `NEXT_RUNTIME !== "nodejs"` no salva: es de ejecución, y webpack empaqueta
igual. No se cazó el 22 porque el ensayo fue por la vía de producción
(`build`/`start`), nunca se volvió a arrancar `dev:web`. Arreglo: Web Crypto
desde `globalThis` (`globalThis.crypto.randomUUID()`), sin import — que es lo
que la cabecera del propio fichero ya exigía («deliberately dependency-free»,
instrumentation vive en una capa donde los server externals no aplican).
Verificado en vivo: las 6 páginas → 200 y `/api/cron/reap` → 200. **Regla: en
`lib/scheduler.ts` (y en todo lo alcanzable desde instrumentation) nada de
`node:*`.** 177 tests verdes.

**Cambio 2026-07-22 — despliegue listo antes de tener el hardware.** El
portátil Arch llega en unos días; todo lo verificable sin él quedó hecho y
ENSAYADO en producción local: scripts `build`/`start:web`/`start:runner` en el
package.json raíz, units systemd en `deploy/` (web con auto-restart, runner
bajo Xvfb para mantener los envíos headed sin pantalla, y backup diario POR
REINICIO a las 07:30 — la cadena de arranque ya hace el backup con el puerto
libre, el único momento consistente; un mecanismo, no dos), y
`docs/DEPLOY.md` (runbook Arch completo: pacman, portátil-como-servidor con
tapa cerrada y límite de carga de batería, Playwright sin install-deps,
Tailscale para el panel remoto, disciplina rolling-release). El ensayo cazó
un bug que habría matado el despliegue: en producción `isAuthorizedCron`
EXIGE CRON_SECRET y el scheduler local no lo enviaba — cada tick habría dado
401 contra sus propias rutas y deepblue jamás habría barrido. Arreglo
estructural: el scheduler se auto-emite un secreto de arranque (solo en
producción — dev sigue abierto para curls manuales; un CRON_SECRET explícito
de cloud gana). Verificado en vivo: build limpio, rutas dev → 404, las 7
lanes cron → 200 en el primer tick, runner arrendando jobs contra el web de
producción. Además: PROJECT.md recoge el «Seller ad audit» (auditar tu propio
anuncio con los ojos del comprador) como siguiente feature tras el despliegue.

**Cambio 2026-07-22 — docs/DEVELOPING.md: el playbook de features.** Guía de
cómo se construye una feature aquí sin romper lo que funciona: el modelo
mental (cerebro/manos), los 9 invariantes no negociables, la tabla de «¿dónde
va mi código?», el workflow (leer primero → diseñar contra invariantes →
core-first con tests → verificar en vivo → disciplina RECON → documentar y
commitear), el catálogo de patrones establecidos con sus ejemplares
(fire-and-forget + flag, carriles auto-curativos, carriles de scheduler,
SubmitButton, /api/dev/*, eventos), la filosofía de tests (los validadores
alrededor del LLM se testean, el LLM no) y los gotchas ganados a pulso
(agrupación es-ES, num() vs coord(), campos vacíos ≠ null). Enlazada desde
README. PROJECT.md manda si algún día discrepan.

**Cambio 2026-07-22 — el radio de búsqueda por fin es real (en código, no en
la query).** Sonda RECON: Wallapop IGNORA `distance` y `dist` (Madrid + 30 km
→ 40 resultados de toda España, 37 más allá de 45 km) — el radio que escribía
el usuario era decorativo de punta a punta (la evaluación tampoco miraba
localización). Ahora `hardFilterReason` (core) lo impone:
`outside_search_radius` si haversine(centro, anuncio) > radio + 15 km de
holgura (las coordenadas de Wallapop son centroides de municipio). Solo con
hechos: anuncio sin coordenadas pasa. `haversineKm` exportado de evaluate.
RECON.md documenta el hallazgo negativo. Efecto colateral honesto: leads
existentes fuera de radio morirán en su próxima re-evaluación.

**Cambio 2026-07-22 — editar búsquedas desde la UI.** La fricción quedó
probada al arreglar la localización del Master (hizo falta un endpoint dev).
Nuevo `brief-form.tsx` (formulario único crear/editar, campos = criteria +
hardLimits), `parseBriefForm` compartido en actions, `updateBrief` (conserva
vehículos extra; re-evalúa leads del brief — límites más estrictos matan
ahora, muerto no resucita — y relanza la cadena cero-clics por si cambió
modelo/generación), página `/briefs/[id]` prellenada y botón «Editar» en cada
tarjeta. La página de crear usa el mismo componente (~100 líneas de JSX
duplicado eliminadas).

**Cambio 2026-07-22 — carril de reintento de dossiers (auto-curación).** El
eslabón frágil de la cadena cero-clics era la investigación: si fallaba (API
caída, JSON inválido) o el servidor se reiniciaba a mitad, la cadena moría en
un evento `dossier_build_failed` sin reintento. Nuevo `/api/cron/dossiers`
(tick del scheduler, gated en API key): `retryPendingDossiers` recalcula del
estado actual qué cazas siguen sin cobertura (`findUncoveredHunts`, ahora
compartido con la página /dossiers — lógica única) y re-dispara UNA
investigación por tick (fire-and-forget; los ticks no se apilan). Guardas de
coste: enfriamiento de 60 min tras un fallo del mismo modelo y techo de 3
fallos/24 h (algo estructural se queda visible en /dossiers para el carril
manual en vez de quemar turnos de investigación). Auto-curación real: también
recoge builds perdidos por reinicio y modelos cuyo dossier se desactivó
después. Verificado en vivo: `{pending: 0}` con todo cubierto.

**Cambio 2026-07-22 — cadena cero-clics al crear una búsqueda.** Última pieza
manual eliminada: crear un brief de un modelo/generación sin cobertura exigía
ir a /dossiers y pulsar «Investigar». Nuevo `lib/brief-hunt.ts`
(`startBriefHunt`, compartido por el formulario de búsquedas y el 1-clic de
descubrimiento): al crear el brief, si la generación NO está cubierta
(chequeo generation-aware con `dossierCoversYears` + ventana de años del
criteria o de la etiqueta) → dispara `buildDossier` fire-and-forget y emite
`dossier_needed(reason: brief_created)`; al terminar, `insertDossier` ya
encadena reevaluación + barrido dirigido + enriquecimiento post-ingest. Si SÍ
está cubierta → barrido dirigido inmediato (antes la caza esperaba el tick).
Sin API key se mantiene el carril manual (la tarjeta en /dossiers).
Guardas nuevas: `buildDossier` rechaza builds concurrentes del mismo modelo
(Set en módulo — el clic manual durante una auto-investigación no paga dos
veces) e `isDossierBuilding` alimenta la UI: la tarjeta de /dossiers muestra
«⏳ Investigando…» en vez del botón, y la de /briefs añade «dossier en
investigación» mientras corre.

**Cambio 2026-07-22 — enriquecimiento inmediato tras el ingest.** Los leads
del Master llegaron a las ~23:45 con la frase genérica: el keyLine lo pone el
carril de enriquecimiento (Haiku), que solo corre en ticks del scheduler
(08–23h Madrid) — un barrido nocturno o el primero de la mañana dejaba leads
sin frase propia hasta horas después. Ahora el report del runner
(search_sweep y fetch_listing con éxito) dispara `enrichPendingLeadsSoon`:
fire-and-forget (jamás bloquea la respuesta al runner), lote acotado (6),
flag `enrichInFlight` en módulo para no pagar dos veces el mismo lead cuando
varios reports aterrizan en segundos (el select de pendientes no es atómico).
El tick regular sigue drenando lo que el lote no alcance. Los emails de
alerta instantánea siguen saliendo con la frase determinista (se componen
DURANTE el ingest, antes de enriquecer — hacerlos esperar al LLM retrasaría
el aviso; decisión consciente).

**Cambio 2026-07-21 — lat/lon vacíos apuntaban al golfo de Guinea; suelo de
precio con tope.** El primer barrido real del Master gen I volvió con 0
resultados y el payload lo delató: `location {lat:0, lon:0}`. Causa:
`Number(formData.get("lat") ?? 40.4168)` — un campo vacío es `""` (no null),
el `??` nunca salta y `Number("")` es 0. Nuevo helper `coord()` (los
coordinados no pueden pasar por `num()`, que quita puntos de miles es-ES y
haría de "40.4168" un 404168; acepta coma decimal española; vacío →
undefined → default Madrid). Segundo filtro silencioso: el suelo anti-chatarra
del sweep era 30% del presupuesto — con 20.000 € de tope para furgos de
3–5.000 €, el suelo de 6.000 € excluía el mercado honesto entero; ahora
`min(30%, 1.500 €)` (los anuncios de financiación son 329–421 €, el tope no
debilita el filtro). Además `PATCH /api/dev/briefs {id, location}` para
reparar el centro de búsqueda de un brief existente (no hay UI de edición).

**Cambio 2026-07-21 — dossier nuevo = barrido inmediato de su modelo.**
Antes, crear búsqueda + dossier dejaba la caza esperando al siguiente tick del
scheduler (~3 h). Ahora `insertDossier` — el punto único por el que pasan las
dos vías (builder API y import manual) — encola tras `reevaluateModelLeads`
un barrido dirigido: `enqueueSweeps(db, { make, model })` acepta filtro y
barre solo los briefs activos que cazan ese modelo (`sameModelFamily`, marca
insensible a mayúsculas). El dedup por brief existente evita pileup si el
scheduler acababa de pasar. El evento `dossier_created` registra `swept`.

**Cambio 2026-07-21 — la detección de dossier faltante entiende generaciones.**
Cierre del cambio anterior: al crear la búsqueda del Master gen I, /dossiers
NO la ofrecía en «Modelos en búsqueda sin dossier» — `isCovered` preguntaba
solo por marca+modelo, y el dossier gen III «cubría» el modelo. Nuevo
`dossierCoversYears` (core, testeado): una etiqueta de generación con rango
solo cubre ventanas de años que solapa; sin rango = universal. La página
/dossiers calcula la ventana de caza de cada brief (años explícitos del
criteria ganan; la etiqueta de generación rellena huecos) y el key del mapa
lleva la generación (dos briefs del mismo modelo, distinta gen = dos
tarjetas). `ensureDossierRequested` (adopción) igual: adopta una unidad de
1990 con solo dossier gen III → pide dossier. Prompt del builder endurecido:
el rango de años entre paréntesis en "generation" es OBLIGATORIO (el routing
de veredictos selecciona por ese rango) y hints como «Primera» se traducen
al formato canónico. Verificado en vivo: la búsqueda del Master aparece como
«Renault Master (Primera)» con su botón de investigar. 170 tests core.

**Cambio 2026-07-21 — búsquedas de unidades antiguas / por generación.**
Caso real: cazar un Master gen I (1980–1997) era imposible — el formulario
solo tenía «Año mínimo», el payload del sweep no llevaba `yearMax` (aunque
`BriefCriteria` y `evaluateListing` ya lo soportaban) y el adapter no enviaba
`max_year`. Ahora `yearMax` viaja entero: formulario («Año máximo») →
criteria → `searchSweepPayload.query` → Wallapop `max_year` (VERIFICADO en
vivo 2026-07-21: 9 resultados, todos 1982–1997 — RECON.md actualizado; AS24
`fregto` por paridad). Además «Generación (opcional)» en el formulario →
`vehicles[0].generations` (alimenta el dossier-first y la tarjeta). Y el
arreglo profundo: `getDossier` elegía dossier por versión más reciente,
ciego a generación — un dossier gen III (2010–presente) juzgaría una furgo
de 1990, o un dossier gen I recién creado secuestraría TODOS los veredictos
del modelo. Nuevo en core: `generationYearSpan` (parsea «I (1980–1997)» /
«III (2010–presente)» de la etiqueta de generación) y `pickDossierForYear`
(cubre el año > sin etiqueta [universal] > ninguno — un dossier de otra
generación es conocimiento de OTRO coche y jamás se aplica). `getDossier`
acepta `year` y los tres call sites (ingest, reevaluate, adopt) lo pasan.
El descubrimiento ya pasaba `yearMax` a criteria — hasta hoy moría en
silencio en el payload; ahora llega a la query. 168 tests core (5 nuevos).

**Cambio 2026-07-21 — el runner carga su propio entorno.** `loadConfig` leía
`CORE_API_URL`/`RUNNER_TOKEN` de `process.env` a secas y ningún framework los
cargaba por él: `pnpm dev:runner` en una terminal limpia moría al instante — y
la ventana del runner de `start-deepblue.bat` moría igual (el launcher abría
un panel sin manos). Ahora `config.ts` resuelve sus archivos env con
`process.loadEnvFile` (Node 22, cero dependencias): `apps/runner/.env.local` →
`.env.local` (raíz) → `apps/web/.env.local`; gana el primer archivo que define
cada variable y el entorno real siempre gana sobre archivos (semántica
verificada). `CORE_API_URL` por defecto `http://localhost:3000` (despliegue
separado = definirlo explícito); `RUNNER_TOKEN` sigue siendo obligatorio, con
error que lista dónde se buscó. Verificado: runner arranca sin inyectar nada
y arrienda jobs. Prerequisito directo del despliegue en mini PC (systemd
habría chocado con el mismo muro).

**Cambio 2026-07-21 — feedback de envío en todos los formularios de acción.**
«Investigar y redactar borrador» (minutos de investigación) y «Crear búsqueda»
no daban señal alguna al hacer clic — el patrón `useFormStatus` existía
(`AdoptSubmit`) pero nunca se generalizó. Nuevo `app/submit-button.tsx`
(`SubmitButton`, cliente): etiqueta pendiente + botón deshabilitado mientras
la server action corre (evita también el doble-submit). Aplicado a dossiers
(investigar ×2 «⏳ Investigando… (tarda unos minutos)», aprobar/descartar/
des-/reactivar), búsquedas (crear, pausar/activar, adoptar — `AdoptSubmit`
eliminado, absorbido), descubrimiento (crear perfil, analizar con IA, crear
búsqueda, archivar) y ficha del lead (aprobar y enviar / rechazar / enviar al
vendedor «⏳ Enviando a la cola…»). `ConfirmDelete` (borrado con confirm()) y
`GenerateLink` (navegación, no form) siguen siendo piezas aparte.

**Cambio 2026-07-18 — el benchmark pondera por motor y cambio.** El pool de
comparables se filtraba solo por marca+modelo+mercado, y `computeBenchmark`
ponderaba por acabado (tokens de trim ×4), año y potencia — pero IGNORABA
combustible y cambio, que son discriminadores de precio de primer orden
(feedback del usuario: trim, motor y 4x4 son clave; las búsquedas ideales son
específicas pero algún usuario busca solo por modelo). Ahora `Comparable` y
`BenchmarkTarget` llevan `fuel` y `gearbox`; el peso se multiplica por
coincidencia de combustible (match ×2, mismatch ×0.3 — un diésel apenas valora
un gasolina) y de cambio (match ×1.4, mismatch ×0.6), con `normalizeFuel`/
`normalizeGearbox` para sinónimos es/en (gasolina/petrol, gasoil, automático/
DSG/tiptronic…). Ponderación suave, no filtro duro: si un lado no declara el
dato se queda neutro (sin penalizar), y una búsqueda estrecha degrada con
gracia en vez de quedarse sin benchmark. Los sistemas de tracción con nombre
(quattro/4motion/4x4/xdrive) ya sobrevivían como tokens de trim. `lib/lookups.ts`
proyecta fuel+gearbox y los tres constructores de target (ingest, reevaluate,
adopt) los pasan. 163 tests core (3 nuevos de benchmark).

**Cambio 2026-07-18 — línea por unidad generada por IA (keyLine).** La línea
de triaje era determinista por nota, así que todos los B se leían igual. Ahora
el enriquecimiento produce `keyLine`: UNA frase única de esa unidad (máx 160
chars) con recomendación + su mayor pro y su mayor pega concretos, nombrando
lo específico (km, extra, brecha contado-financiado, golpe, propietarios).
Va en el `llmEnrichmentPayloadSchema` (opcional) → sale en el MISMO turno de
Haiku, cero llamadas extra; `applyEnrichment` la propaga en merges encadenados
(una lectura que la omite no borra la del anuncio). Nuevo `composeUnitLine`
(core): keyLine si existe, si no cae a `composeTriageLine`; los vetos siempre
mandan (una estafa nunca recibe frase amable). Lo consumen listado, ficha,
alertas, digest y email de bajada — todos migrados de `composeTriageLine` a
`composeUnitLine`. `POST /api/dev/enrich {leadId}` fuerza re-enriquecimiento
LLM inline de un lead concreto (para refrescar keyLine en dev). Validado en
vivo: 4 Golf B re-enriquecidos, 4 keyLines distintas y específicas. 160 core.

**Cambio 2026-07-18 — diffing de precio + tests de web-lib.** Los precios
cambiaban en silencio: el upsert del sweep pisaba la columna y las sondas de
vida tiraban el número. Ahora (1) la sonda `check_listing` lleva `priceEur`
(el detalle ya estaba pagado) y `applyListingCheck` lo diffea; (2) el ingest
captura el precio almacenado ANTES del upsert y diffea al reavistar;
(3) `lib/price-watch.ts` centraliza: evento `listing_price_changed` por lead
activo, reevaluación con el precio nuevo, y si es una BAJADA que deja al
lead shortlisted por encima del listón de alertas (mismo `ALERT_MAX_GRADE` +
`ALERT_MIN_SCORE` — una sola política de selectividad), email «bajada de
precio» con la línea de triaje (`composePriceDropEmail`, puro y testeado).
Además `apps/web` estrena carril de tests (vitest, `pnpm -r test` lo
incluye): `composeAlert`/`composeAlertHtml` (brief sin lista de preguntas,
con triaje) y el email de bajada. 157 tests core + 6 web.

**Cambio 2026-07-18 — triaje visible en la web, suelo de puntuación en
alertas, y retirada de leads de prueba.** (1) La frase de triaje
(`composeTriageLine`) ya no vive solo en el email: aparece bajo el título de
cada lead en el listado y en negrita en la tarjeta del veredicto de la ficha
— «¿sigo con este o espero otro?» donde de verdad se compara. (2) Con una
búsqueda ancha salen más B que atención tiene el usuario: las alertas
instantáneas exigen ahora además `score >= ALERT_MIN_SCORE` (defecto 75) —
solo interrumpe la parte alta de la banda, el resto espera al digest
diario. (3) `POST /api/dev/lead-state {leadId, state, reason}` mueve un lead
de estado respetando `canTransition` — usado para retirar el Focus de prueba
(la negociación completa fue un simulacro; el pipeline entero quedó validado
con él). Diagnóstico de la selectividad: 97 de 121 shortlisted son Golf, 23
A/B con scores 70–89 — la anchura de la búsqueda (entra Sportsvan y e-Golf)
más el benchmark por modelo (no por versión) comprimen la banda.

**Cambio 2026-07-18 — informe de visita por unidad.** Al cerrar visita, el
sistema convierte todo lo que sabe de ESA unidad en la lista de verificación
presencial. `composeVisitChecklist` (core, determinista, testeado): riesgos
abiertos con sus pasos `verifyBy` del dossier y su banda de coste; descartes
`seller_stated` como «prometido por chat — pide ver la prueba» con la cita
literal; confirmados como contexto de precio; avisos de la conversación;
papeles (con V5/aduanas si matrícula extranjera y RHD si aplica);
comprobaciones en frío; prueba dinámica; y precio (acordado por chat vía
`respondToCounterEur` o el del anuncio, exposición abierta como palanca, y el
tope duro del brief). Página imprimible con casillas en
`/leads/[id]/visita` (enlace «📋 Informe de visita» en la ficha; las
casillas no se guardan). Disparo automático: la lectura observa
`negotiation.visitAgreed` (comprador y vendedor cerrando día/hora) y al
pasar a true envía el informe en texto por email (evento `visit_agreed`,
solo en la transición — releer no reenvía). `lib/visit.ts` centraliza el
input (precio acordado decidido por código) para página y email.

**Cambio 2026-07-17 — feedback al generar, sin inventar disponibilidad, y
aviso de trato listo.** Tres correcciones de la primera sesión con el carril
LLM en vivo: (1) el botón «Generar» ahora enseña «⏳ Generando…» mientras el
servidor redacta (componente cliente `generate-link.tsx` con `useLinkStatus`
de Next). (2) Un borrador de Haiku afirmó disponibilidad del comprador
(«tengo disponibilidad el fin de semana») — el modelo NO conoce la agenda
del usuario: regla en el prompt (pedir opciones al vendedor, el comprador
confirma) + validación en código (`AVAILABILITY_CLAIMS`: días, franjas,
«disponibilidad» que no estén en el borrador base ⇒ descartado, cae al
determinista). (3) Cuando una lectura deja la negociación en territorio de
aceptar (`respondToCounterEur` → accept), el cierre es del usuario: evento
`negotiation_ready` + email «precio al alcance» con la cifra y el enlace a
la ficha para mandar la aceptación y pactar la visita — solo con números
nuevos, releer el mismo estado no reenvía.

**Cambio 2026-07-17 — presupuesto de salida holgado en lecturas.** La
primera lectura en vivo con Sonnet 5 salió truncada («Unterminated string in
JSON»): `max_tokens: 4000` se quedó corto y el JSON se cortó a medias.
Ahora 16.000 (solo se factura lo producido; el tope es protección, no
coste) y si `stop_reason === "max_tokens"` la lectura falla con error claro
en vez de parsear basura. Pipeline completo validado en vivo con la
negociación real del Focus: fetch del runner → lectura automática Sonnet
(extrajo 13.900/14.200) → `respondToCounterEur` aceptó (diferencia 300 €
bajo tope) → botón «Generar aceptación (14.200 €)» → prosa de Haiku con la
cifra exacta.

**Cambio 2026-07-17 — modelo propio para lecturas de conversación.** Las
lecturas de chat compartían `ENRICH_MODEL` con el enriquecimiento de
anuncios — imposible elegir modelos distintos por carril. Ahora
`READS_MODEL` (`DEEPBLUE_READS_MODEL` ?? Opus 4.8) gobierna las lecturas.
Guía de coste/calidad: el enriquecimiento es alto volumen y bajo riesgo
(deltas acotados, vetos en código) → candidato a Haiku
(`DEEPBLUE_ENRICH_MODEL=claude-haiku-4-5-20251001`); las lecturas son poco
volumen y mucho riesgo (sus issueUpdates mueven la exposición y por tanto
los € de las ofertas; detectan escalaciones) → mantener Opus o como mucho
Sonnet 5.

**Cambio 2026-07-17 — respuesta a contraofertas + carril LLM de prosa.** El
compositor determinista repetía la oferta ya rechazada cuando el vendedor
contraofertaba. Ahora: (1) la lectura de conversación OBSERVA la negociación
(`negotiation: { ourLastOfferEur, sellerLastOfferEur, quote }` en el schema;
el prompt instruye solo números literales del chat); (2) el código DECIDE
(`respondToCounterEur`, core, testeado): acepta si el vendedor baja a
nuestra cifra o queda a ≤300 € bajo presupuesto; si no, parte la diferencia
redondeada a centenas con tope duro en `hardLimits.maxPriceEur`; si no hay
recorrido, mantiene la oferta («stand»). Una contraoferta viva tiene
prioridad sobre preguntas y ofertas nuevas en la cascada del botón
(«✍️ Generar contraoferta/aceptación/mantener oferta (N €)»);
`composeCounterReply` es el texto determinista (aceptar sí promete visita:
el trato está hecho). (3) Carril de prosa LLM (`lib/draft-message.ts`,
modelo barato `DEEPBLUE_DRAFT_MODEL` ?? Haiku 4.5): con `?sugerir=1` y
`ANTHROPIC_API_KEY`, Haiku redacta el mensaje sobre el borrador base con
validación en código — debe contener el precio EXACTO decidido, caber en
300 chars, sin ¿¡, sin cifras en € que el código no haya decidido; cualquier
fallo cae al determinista. Sin API key es passthrough. El modelo nunca elige
números. Validado en vivo: contraoferta de Paula 14.500 → botón «Generar
contraoferta (13.900 €)» (151 tests).

**Cambio 2026-07-17 — límite de 300 caracteres del chat de Wallapop.** El
compositor del chat es un `<textarea maxlength="300">` (medido en vivo con
`apps/runner/src/probe-limit.ts`): la primera propuesta de precio (409
chars) salió CORTADA y la línea del precio nunca llegó a la vendedora.
Defensa en tres capas: (1) core exporta `CHAT_MAX_CHARS = 300` y TODOS los
compositores caben siempre — openers/seguimientos van soltando las últimas
preguntas, y la justificación de la oferta baja la escalera full → compact →
minimal → bare (la línea del precio es sagrada, lo que encoge es el porqué);
(2) web: `sendUserMessage`/`updateDraftBody` RECHAZAN mensajes largos con
error claro (nunca truncar una conversación humana) y los textarea de la
ficha llevan `maxLength` + aviso; (3) runner: tras `fill()`, si el campo
retiene menos de lo escrito, aborta ANTES de enviar («no se envía a
medias»). Tests con los datos reales del Focus que se cortaron (144 tests).

**Cambio 2026-07-17 — negociar antes de prometer la visita.** Feedback del
usuario: el cierre cálido «Con esto ya me decido y vemos cuándo puedo pasarme
a verlo» regala la palanca — anunciar la visita antes de negociar concede el
precio. Ahora: (1) cuando quedan pocas preguntas Y hay propuesta justificada
(`computeOfferEur` ≠ null), la oferta se FUSIONA en el seguimiento — el
cierre pasa a ser la justificación compacta + la cifra, y «me acerco a
verlo» solo aparece condicionado al número; (2) la fusión exige conversación
cálida (≥2 respuestas) y que el lote pregunte las ÚLTIMAS dudas — anclar
precio a mitad de interrogatorio es prematuro; (3) con negociación pendiente
los cierres cálidos que prometen visita/decisión NO se usan (caen al pool
neutro); solo se prometen cuando no hay nada que negociar. El botón:
«✍️ Generar seguimiento + propuesta de precio (N €)» cuando fusiona.
Validado en vivo con el Focus: todo respondido → propuesta autónoma de
13.200 € citando manguito degas y suspensión (140 tests).

**Cambio 2026-07-17 — polling de respuestas adaptativo + prioridad por nota.**
El sweep de respuestas ya no usa un cooldown fijo de 45 min: cada
conversación tiene su propio ritmo (`replyPollCooldownMinutes`, core puro).
Esperando al vendedor, se sondea a la mitad de su latencia mediana (suelo 10
min, techo 60) mientras la respuesta es plausible, se relaja a 90 min cuando
tarda el doble de lo habitual, y a 6 h tras un día de silencio (ahí manda el
flujo de nudges, no el polling). Cuando es NUESTRO turno: una comprobación a
los 30 min de su mensaje (pilla dobles envíos) y luego cada 3 h — no se nos
debe nada. La mediana sale de emparejar cada mensaje enviado con la PRIMERA
respuesta posterior (`medianSellerReplyMinutes`, ignora dobles textos).
Además, con el tope por sweep, los candidatos se ordenan por nota del
veredicto (mejor primero): las conversaciones A/B se mantienen frescas y las
flojas esperan turno. `sweepReplies` ya no recibe `cooldownMinutes`. Testeado
en `polling.test.ts` (136 tests).

**Cambio 2026-07-17 — propuesta de precio justificada con datos.** Cuando ya
no quedan preguntas por hacer y es nuestro turno, el botón del compositor
pasa a «✍️ Generar propuesta de precio (N €)». `computeOfferEur` (core,
determinista): parte del precio anunciado (contado si difiere), pide al
vendedor absorber la MITAD de la exposición esperada (punto medio de la
banda de reparaciones sin descartar), capa SIEMPRE al `hardLimits.maxPriceEur`
del brief (límite duro, no prompt), redondea a centenas y nunca baja del 80%
del anuncio (un lowball mata la conversación); null si no hay nada que
negociar (anuncio ya en precio). `composeOfferMessage` redacta informal:
elogio del coche, justificación con los riesgos aún sin descartar (título
corto, sin prefijo de motor ni consecuencia) y su banda de coste — o con el
presupuesto si no quedan riesgos — y la cifra sobre la mesa con variantes
seedeadas. Cascada del botón: inicial → seguimiento → propuesta → nudge.
Ejemplo real Focus: 15.000 € anuncio, 14.500 tope, exposición 2.150–4.950 →
propone 13.200 €. Testeado en `compose.test.ts` (129 tests).

**Cambio 2026-07-17 — `GET /api/dev/leads?id=<leadId>`.** El endpoint dev de
leads acepta ahora `?id=` y devuelve ese lead con su veredicto completo sea
cual sea su estado — la forma de inspeccionar un lead `contacted`/
`negotiating` en mitad de una conversación (sin id sigue listando solo
shortlisted).

**Cambio 2026-07-17 — más variedad y interés creciente en los mensajes.**
Feedback del usuario: los textos sonaban muy automáticos y el vendedor solo
recibía preguntas sin ningún feedback (riesgo de que deje de contestar). En
`compose.ts`: pools ampliados (3 saludos, 4 líneas de interés del opener, 3
variantes de disponibilidad, 5 cierres de opener, 5 nudges) y los
seguimientos ahora SIEMPRE agradecen/reaccionan antes de preguntar. Con
`sellerReplies >= 2` (nuevo campo de `FollowUpInput`, la ficha pasa el nº de
mensajes recibidos) el tono sube de temperatura: intros tipo «el coche me
está convenciendo» y cierres que apuntan a la visita («con esto ya me decido
y vemos cuándo puedo pasarme»). El enlace intro concuerda en número con las
preguntas restantes (una duda / un par de dudas). Todo sigue determinista y
seedeado (el seed incluye nº de respuestas), testeado en `compose.test.ts`.

**Cambio 2026-07-17 — un solo compositor de mensajes en la ficha del lead.**
Antes había dos flujos: «Redactar mensaje al vendedor» (creaba un borrador
pendiente de aprobación que aparecía ya escrito al recargar) y el textarea de
respuesta con un enlace «Sugerir…». Ahora hay UN compositor consistente:
siempre empieza vacío y un único botón «✍️ Generar…» lo rellena con la
sugerencia determinista según el turno (mensaje inicial si no hay
conversación, seguimiento con las preguntas sin hacer si respondió el
vendedor, recordatorio suave si llevamos ≥2 días esperando). El usuario
revisa, edita y pulsa «Enviar al vendedor» — enviar ES la aprobación
(`sendUserMessage`), también para el primer contacto. La tarjeta de borrador
pendiente de aprobación queda solo para borradores creados fuera de la página
(API dev / automatización futura con aprobación por email, `draftOutreach`
sigue existiendo para ese carril). Tras enviar se redirige a la URL limpia
para que `?sugerir=1` no rellene el compositor otra vez. El botón «Generar»
usa `scroll={false}` para no saltar al principio de la página al navegar.

**Cambio 2026-07-17 — frase de triaje en alertas y digest.**
`composeTriageLine(verdict)` (core, determinista, testeada): una frase por
anuncio que responde «¿sigo con este o espero otro?» — A/B empujan a
contactar, C condiciona a que el vendedor descarte riesgos cuando el peor
caso supera el presupuesto (cita la exposición), D/E dicen esperar, y los
vetos mandan descartar. Va tras la nota en la alerta instantánea (texto y
HTML) y como primera línea de cada candidato en el digest.

**Cambio 2026-07-17 — alertas de email sin lista de preguntas.** Las
alertas instantáneas de shortlist llevan solo el resumen del lead (título,
specs, foto, nota, exposición, enlaces) — las «preguntas clave» sobraban:
viven en la ficha, donde el flujo de mensajería ya las usa (regla del
usuario). El digest ya era así.

**Cambio 2026-07-17 — la adopción guarda foto y hechos de importación.**
`completeAdoption` no escribía `imageUrl` ni `rhd`/`foreignPlates` en el
upsert del listing (el sweep sí) — por eso un lead adoptado salía sin foto.
Corregido con el mismo patrón que ingest (foto si viene; hechos solo
rellenan huecos, coalesce). Los ya afectados se curan con el backfill de
`POST /api/dev/reevaluate`. Dossier Ford Focus III importado (5 issues con
applicability por motor/cambio: degas 1.0 EcoBoost crítico, correa húmeda,
PowerShift solo automáticos, TDCi solo diésel).

**Cambio 2026-07-17 — higiene de la cola de jobs.** Los jobs terminales
(succeeded/failed) se purgan a los 7 días en cada tick del reaper
(`pruneOldJobs`) — la cola es cola, no audit trail (eso son los `events`),
y los fallos antiguos ya diagnosticados no deben rondar Actividad para
siempre. Limpieza manual: `POST /api/dev/jobs {action:"prune", all:true}`.

**Cambio 2026-07-17 — «Adoptar un anuncio» vive en Búsquedas.** El
formulario de adopción (pegar URL de Wallapop) se muda del panel de leads a
/briefs, junto a la creación de búsquedas — adoptar un anuncio es iniciar
una caza, no consultar resultados. Los banners de feedback y el redirect de
`adoptAd` van con él.

**Cambio 2026-07-17 — regla: no pedir fotos por el chat.** El chat de
Wallapop no permite enviar fotos ni archivos, así que ninguna pregunta
compuesta debe pedirlas (regla en el prompt de `conversationPrompt`): se
piden descripciones (qué consta en el libro, qué taller, fechas) o se deja
la verificación documental para la visita. Además el `POST
/api/dev/chat-reads` ahora acepta re-lecturas de conversaciones ya
interpretadas — una lectura nueva cubre el hilo completo y REEMPLAZA la
anterior, así se corrige una interpretación sin esperar mensaje nuevo.

**Cambio 2026-07-17 — turno de conversación: esperando al vendedor.** Si el
último mensaje del hilo es nuestro, la ficha marca «⏳ Esperando respuesta
del vendedor» y NO sugiere más preguntas encima de las no contestadas
(regla del usuario). Tras ≥2 días de silencio la única sugerencia es un
recordatorio suave de una línea (`composeNudgeMessage`, sin preguntas
nuevas). Cuando el vendedor responde, vuelve la sugerencia de seguimiento
con las preguntas pendientes. El cuadro de respuesta manual queda siempre.
Además, las burbujas del hilo van coloreadas: las nuestras con tinte azul
(`--chat-out`), las del vendedor neutras (`--chat-in`), tokens con alfa
válidos en tema claro y oscuro.

**Cambio 2026-07-17 — Fase 2 etapa 3: las respuestas actualizan el lead.**
Interpretación automática de conversaciones: un LLM lee el hilo completo
contra el veredicto y produce un `conversationReading` validado
(`conversationReadingPayloadSchema`, extiende el payload de enriquecimiento)
que EL CÓDIGO aplica: issueUpdates con título exacto del riesgo y quote del
vendedor (basis `evidence_shared` vs `seller_stated`, la nota del finding lo
dice) van por el mismo camino que los botones manuales; importFacts solo
fijan valores desconocidos del listing; los factorAdjustments acotados se
re-mergen en cada re-evaluación igual que el enrichment del anuncio
(columnas `chat_reading`/`chat_read_at`, migración 0013, applyEnrichment en
cadena). `escalate` manda email cuando el vendedor pide algo que decide el
humano (pagos, documentos, salir de la plataforma). Enviar sigue con humano;
leer ya no lo necesita: todo queda eventado (`conversation_read`), citado y
reversible (Reabrir). Lanes: cron `/api/cron/chat-reads` por tick (con API
key) o sesión Claude Code vía `GET /api/dev/chat-reads` (pendientes+prompt)
y `POST` `{leadId, reading}`. Estrenado con la conversación real del Boxster.

**Cambio 2026-07-17 — tono informal en los borradores.** Feedback del
usuario tras estrenar el chat: los mensajes compuestos ahora suenan a
Wallapop — sin ¿¡, sin listas con guiones (una pregunta por línea), saludos
y cierres variados («Hola/Buenas», «Gracias!/Un saludo!/…») elegidos con
semilla determinista (mismo lead ⇒ mismo borrador, tests reproducibles).
El filtro de seguimientos normaliza ¿¡ en ambos lados para seguir
deduplicando contra mensajes enviados con el estilo formal antiguo.

**Cambio 2026-07-16 — Fase 2: seguimientos sugeridos.**
Bajo el cuadro de respuesta aparece «💡 Sugerir seguimiento» cuando quedan
preguntas del veredicto sin hacer: `composeFollowUpMessage` (core,
determinista) filtra las `openQuestions` ya enviadas comparándolas con los
outbound `sent/queued` del timeline y pre-rellena el textarea vía
`?sugerir=1` (sin JS de cliente) con hasta 3 pendientes — editable antes de
enviar, como siempre. Si no queda nada por preguntar, el enlace no aparece.

**Cambio 2026-07-16 — Fase 2: responder al vendedor (conversación).**
Con conversación abierta, la ficha del lead cambia el botón de borrador por
un cuadro «Responder al vendedor…»: el usuario escribe y «Enviar al
vendedor» encola el `send_message` directamente (`sendUserMessage`) — un
mensaje escrito a mano ES su propia aprobación, el gate de approvals queda
para los borradores generados por el sistema. Mismas garantías: un solo
outbound en vuelo por lead, at-most-once, timeline y evento
`message_queued {authored:"user"}`. Dev: `POST /api/dev/outreach {leadId,
action:"send", body}`. El botón «Redactar mensaje» (opener automático) solo
aparece cuando aún no hay conversación.

**Cambio 2026-07-16 — Fase 2 etapa 2: leer respuestas del vendedor.**
`fetch_replies` implementado de punta a punta y estrenado con una respuesta
real: el runner abre el deep link del chat (`/app/chat?itemId=…`, aterriza
directo en la conversación), extrae las burbujas (`tsl-chat-bubble`,
`ChatBubble--incoming/--outgoing`, hora en `ChatBubble__timestamp`; el DOM
no trae ids de mensaje, así que el externalId es un hash de
item+texto+hora) y el Core valida (`inboundMessageSchema`), deduplica por
externalId contra el lead con outreach enviado más reciente del listing,
guarda `messages(received)` y avisa por email con el texto del vendedor y
enlace a la ficha. Sondeo automático: `/api/cron/replies` en cada tick del
scheduler para leads en estados de conversación, cooldown de 45 min por
listing y máx. 3 jobs por barrido (cada fetch es una visita de navegador).
Dev: `POST /api/dev/outreach {leadId, action:"fetch"}`. Falta (etapa 3):
convertir respuestas en findings y redactar seguimientos.

**Cambio 2026-07-16 — Fase 2 etapa 1: mensajes al vendedor con aprobación.**
El sistema ya puede hablar con vendedores de Wallapop, con un humano en el
gatillo siempre: «Redactar mensaje al vendedor» en la ficha del lead compone
un borrador determinista (saludo + las 3 mejores `openQuestions` del
veredicto, `composeOpeningMessage` en core, sin LLM) y lo aparca en
`messages(pending_approval)` + `approvals` con token de un clic. Llega email
con el texto y enlaces Aprobar/Rechazar (`/api/approvals/[token]`); en la
ficha se puede editar el texto antes de aprobar. Aprobar encola un job
`send_message` que el runner ejecuta con Playwright sobre el perfil
persistente logueado (`pnpm runner:login`, una sola vez, la sesión queda en
`.browser-profile/` fuera del repo; ventana visible por defecto,
`CHAT_HEADLESS=1` para ocultarla). Éxito ⇒ mensaje `sent` + lead
`shortlisted→contacted`; fallo ⇒ mensaje `failed` visible en la ficha.
Envíos son at-most-once: un lease caducado de `send_message` nunca se
reintenta (el runner pudo haber enviado antes de morir) — se marca fallido
con aviso de comprobar el chat a mano. Endpoint dev: `/api/dev/outreach`
(GET conversación, POST draft/approve/reject). Falta (etapa 2):
`fetch_replies` para leer respuestas. 108 tests verdes.

Lecciones del primer envío real (falló limpio, sin mandar nada): el CTA del
anuncio es un `walla-button` y hay que clicar el HOST del web component (el
`<button>` interno del shadow DOM no dispara nada); jamás seleccionar por
`href*="/app/chat"` porque el «Buzón» de la cabecera apunta ahí y abre una
bandeja sin campo de mensaje; y el chat se abre en una PESTAÑA NUEVA
(`/app/chat?itemId=…`), así que el composer (placeholder «Empieza a
chatear») se busca en todas las páginas del contexto, no en la actual.
Primer envío real confirmado 2026-07-16 (mensaje `sent`, lead
`shortlisted→contacted`). Ajuste de copy tras estrenarlo: el opener con
preguntas ya no cierra con «¿Sigue disponible?» — las preguntas lo
presuponen y quedaba redundante; solo el opener sin preguntas lo mantiene.

**Cambio 2026-07-16 — límites de importación editables en búsquedas
existentes.** Los checkboxes de `noRhd`/`requireSpanishPlates` solo existían
al crear la búsqueda; ahora cada tarjeta en /briefs lleva dos chips-toggle
(«RHD: se acepta» ⇄ «✕ RHD: vetado»). Al cambiar un límite se re-evalúan los
leads vivos de esa búsqueda al momento (`reevaluateBriefLeads`), así los
recién vetados mueren sin esperar al siguiente sweep. Evento
`brief_limits_changed` en el audit log.

**Cambio 2026-07-15 — hechos de importación verificables + límites duros.**
Los flags dejan de ser solo texto: `listings.rhd` y `listings.foreign_plates`
(booleanos, null = desconocido, migración 0012) se rellenan desde texto
explícito en ingesta/backfill y se marcan a mano en la ficha del lead
(Sí/No/¿?) — las fotos cuentan lo que el texto calla; el valor explícito gana
siempre a la inferencia y un valor guardado nunca se machaca (COALESCE).
Nuevos límites duros por búsqueda (checkboxes al crearla): `noRhd` («no
acepto RHD a ningún precio») y `requireSpanishPlates` (hay importados que ni
se pueden homologar) — matan en código (`rhd_not_accepted` /
`foreign_plates_not_accepted`), pero NUNCA sobre la asunción de RHD sola: los
leads muertos no resucitan y la pregunta al vendedor la resuelve antes.

**Cambio 2026-07-15 — señales de importación (RHD / matrícula extranjera).**
Caso real (Boxster RHD a 11.999 € y Boxster S con «matricula inglesa» a
16.300 €): los deportivos importados de UK parecen gangas. `extractImportSignals`
en core detecta RHD y matrícula extranjera en el texto («matriculado en
España» explícito gana), y **asume RHD en coches de origen inglés que no
anuncian volante izquierdo** — los LHD con matrícula UK siempre lo anuncian;
la asunción va a `assumed` del factor y genera la pregunta del volante. El
factor precio compara sumando ~1.500 € de rematriculación y resta 20 puntos
al RHD; el veredicto abre con quién asume papeles/aduanas, y la ficha del
lead muestra chips de aviso junto al título. Resultado: el RHD explícito
C 60 → D 52 (precio E) y el S 3.4 «ganga» B 73 → C 65 — el nuevo nº 1 del
Boxster es el 2.7 manual de 2006, la config que el dossier recomienda.

**Cambio 2026-07-15 — backup automático de la BD.** `pnpm dev:web` ejecuta
`scripts/backup-db.mjs` antes de arrancar: snapshot .tgz fechado de
`apps/web/.data/pglite` (momento garantizado-consistente: nadie escribe), en
`DEEPBLUE_BACKUP_DIR` o `~/deepblue-backups`, retención 14. Con el servidor
encendido el script se niega a copiar (un solo escritor). Manual:
`pnpm backup:db`. Deliberadamente NO va a OneDrive por defecto (el de esta
máquina es corporativo); apunta `DEEPBLUE_BACKUP_DIR` a una carpeta
sincronizada PERSONAL para copias fuera de la máquina. La BD sigue fuera de
git a propósito (binaria, viva, una sola fuente de verdad).

**Cambio 2026-07-15 — Eliminar búsquedas.** «Archivar» solo cambiaba el
estado y la búsqueda seguía en la lista. Sustituido por Eliminar con
confirmación: borrado en cascada (leads + eventos/mensajes/aprobaciones de
esos leads + jobs pendientes del runner para esa búsqueda) vía
`deleteBriefCascade`. Los listings NUNCA se tocan — el corpus es conocimiento
global (benchmarks) que sobrevive a cualquier búsqueda. Evento `brief_deleted`
en el audit log. El estado `archived` sigue en el schema por compatibilidad.

**Cambio 2026-07-15 — teoría se cotiza, no se capa (PROJECT.md enmendado) +
fotos en descubrimiento.** La regla «teoría sin confirmar capa fiabilidad del
modelo en C» de PROJECT.md era anterior al scoring continuo y contradecía el
código: se enmienda el doc — la exposición esperada de reparación se descuenta
del precio y puede dar D/E sin confirmar (caso real: Boxster S 3.4 2007 con
bore scoring sin verificar ≈ el precio del coche). El lead sigue vivo (peso
0,15). Además `imageUrl` opcional en las recomendaciones de descubrimiento
(foto real hallada en la investigación, Wikimedia preferido; el prompt de la
vía API lo pide y prohíbe inventarla) — la página la muestra y el informe
MX-5/Boxster/MR2 quedó retro-alimentado con fotos verificadas.

**Cambio 2026-07-15 — descubrimiento idempotente y botones de búsqueda
arreglados.** «Crear búsqueda» no daba feedback y un doble clic creaba dos
búsquedas idénticas: ahora la acción es idempotente (una búsqueda viva con el
nombre canónico de la recomendación gana) y la recomendación aceptada muestra
«✓ Búsqueda creada» en vez del botón. Pausar/Activar/Archivar en /briefs
estaban rotos (React server actions no envía el name/value del botón que
dispara el submit — ZodError con status vacío): un form por botón con inputs
hidden, el patrón del resto de la app. Endpoint dev nuevo:
`POST /api/dev/brief-status {briefId, status}`.

**Cambio 2026-07-15 — digest en el primer tick del día.** El scheduler ya no
limita el digest a la ventana 08–10h: lo dispara en cada tick (dentro de las
horas activas) y el guard durable de una-vez-por-día de runDigest hace no-op
los repetidos. Antes, un PC apagado a esas horas se quedaba sin digest hasta
el día siguiente; ahora lo envía al arrancar. Verificado en vivo: trigger a
las 16:35 → composed 0 (el de hoy ya había salido de madrugada).

**Cambio 2026-07-15 — ingesta blindada contra datos basura.** Caso real: un
vendedor escribió «1.4» (la cilindrada) en el campo de caballos de Wallapop y
el float tumbó la columna integer — y con ella el batch entero del sweep
(report 500). Doble arreglo: `sanitizePowerCv` en core (CV entero en [20,
1500] o undefined, aplicado en adapter e ingesta) y aislamiento por item en
`ingestSearchResults` (un item podrido registra `ingest_item_failed` y el
resto del batch sigue). La ingesta de cada item vive ahora en `ingestOne`.

**Cambio 2026-07-15 — dedup por huella de cuentakilómetros + fotos en el
dashboard.** Caso real AUTOHERO: el mismo Golf publicado desde 7 cuentas de
ciudad, sin REF en el texto — indistinguible para el dedup por REF. Nueva
huella en core (`fingerprintDedupKey`, testeada): km EXACTOS + precio + marca/
modelo/versión/año identifican la unidad física; km redondos (plantillas de
concesionario) o campos ausentes nunca generan huella. Misma columna
`dedup_key` (prefijo `fp:` vs `ref:`), mismos mecanismos aguas abajo (nacer
muerto como duplicado, pase de mantenimiento — 11 duplicados eliminados en el
primer barrido, sobrevive el más antiguo). Además la lista de leads y la ficha
muestran la foto del anuncio.

**Cambio 2026-07-15 — foto del anuncio en emails.** Cada listing guarda la
primera foto del anuncio (`image_url`, migración 0011): el adapter la extrae
de búsqueda y detalle (extractFirstImageUrl en core, con tests), y el pase de
mantenimiento (/api/dev/reevaluate) la rellenó para todo lo ya almacenado
desde el `raw` guardado — cero peticiones nuevas a la plataforma. El digest y
las alertas (ahora también HTML) muestran la miniatura enlazada a la ficha.
Endpoint dev nuevo: `GET /api/dev/listing-raw?id=…|latest=wallapop` para
arqueología de payloads.

**Cambio 2026-07-14 — deep links en emails.** Alertas y digest enlazan
primero a la ficha del lead en deepblue (`PUBLIC_BASE_URL`, def. localhost) y
dejan el anuncio de la plataforma como enlace secundario — la ficha es donde
viven veredicto, hallazgos y (Fase 2) las aprobaciones de un clic.

**Cambio 2026-07-14 — cortacircuitos anti-baneo.** Un 403/429 de Wallapop
detiene el runner en seco: el adapter lanza PlatformBlockedError en cuanto ve
el status (antes el fallback de búsqueda reintentaba contra el bloqueo), el
runner se pausa 45–90 min con jitter y el Core lo audita (evento
`platform_blocked`) y envía email de aviso. Prerrequisito de Fase 2: proteger
la cuenta real antes de que existan send_message.

**Cambio 2026-07-14 — dossiers auto-aprobados.** Los dossiers entran en uso al
crearse (ambas vías: builder API e import por suscripción) y re-evalúan sus
leads al momento; la revisión pasa a ser a posteriori con botón Desactivar /
Reactivar en /dossiers (columna `disabled_at`, migración 0010). Un dossier
desactivado no alimenta veredictos, no cuenta como cobertura y el modelo vuelve
a aparecer como "sin dossier". Los borradores antiguos (pre-cambio) conservan
el botón Aprobar.

**Siguiente hito: Fase 2 (chat Wallapop).** Orden acordado: (1) salida con
aprobación — borrador determinista desde las preguntas abiertas del lead,
tabla `approvals` con token de un clic, job `send_message` con perfil
Playwright persistente y login manual del usuario; (2) entrada — `fetch_replies`
por lead contactado, respuestas en la página del lead junto a los botones de
findings; (3) solo después, asistencia LLM. Pilotar con leads adoptados
(origin=manual). Pendiente menor: diffing de precio en re-sondas de leads
manuales y sweep solo-corpus para benchmarks de modelos adoptados.
