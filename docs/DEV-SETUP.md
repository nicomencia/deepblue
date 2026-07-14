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
pnpm dev:web             # aplica migraciones pendientes al arrancar
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
