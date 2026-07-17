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

Runner (segunda terminal; no tiene .env propio, hereda del entorno):

```bash
export CORE_API_URL=http://localhost:3000
export RUNNER_TOKEN=<el mismo que en .env.local>   # sin echo, sin pegarlo en chats
pnpm dev:runner
```

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
