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
`DEEPBLUE_DOSSIER_MODEL` / `DEEPBLUE_ENRICH_MODEL` / `DEEPBLUE_DISCOVERY_MODEL`
(def. claude-opus-4-8), `DEV_USER_EMAIL`, `CRON_SECRET` (solo producción).

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
