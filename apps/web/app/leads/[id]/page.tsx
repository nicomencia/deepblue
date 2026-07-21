import {
  CHAT_MAX_CHARS,
  composeCounterReply,
  composeFollowUpMessage,
  composeNudgeMessage,
  composeOfferMessage,
  composeOpeningMessage,
  composeUnitLine,
  computeOfferEur,
  extractImportSignals,
  respondToCounterEur,
  type IssueAssessment,
  type IssueFinding,
  type VerdictFactor,
} from "@deepblue/core";
import { briefs, events, leads, listings, messages } from "@deepblue/db";
import { asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "../../../lib/db";
import { draftSellerProse } from "../../../lib/draft-message";
import { fmtDate, fmtEur, fmtKm, gradeVar } from "../../../lib/ui";
import { SubmitButton } from "../../submit-button";
import { GenerateLink } from "./generate-link";
import {
  approveSellerMessage,
  rejectSellerMessage,
  replySellerMessage,
  setImportFact,
  setIssueFinding,
} from "./actions";

export const dynamic = "force-dynamic";

const FACTOR_NAMES: Record<string, string> = {
  priceFairness: "Precio justo",
  modelReliability: "Fiabilidad del modelo",
  unitEvidence: "Evidencia de la unidad",
  sellerCredibility: "Credibilidad del vendedor",
};

const STATUS_ES: Record<string, string> = {
  unconfirmed: "Pendiente",
  confirmed: "Confirmado",
  ruled_out: "Descartado",
};
/** Status colors: pending = attention, confirmed = bad news, ruled out = good. */
const STATUS_COLOR: Record<string, string> = {
  unconfirmed: "var(--grade-c)",
  confirmed: "var(--grade-e)",
  ruled_out: "var(--grade-a)",
};
const LIKELIHOOD_ES: Record<string, string> = {
  low: "baja",
  medium: "media",
  high: "alta",
};
const MESSAGE_STATUS_ES: Record<string, string> = {
  draft: "borrador (no enviado)",
  pending_approval: "pendiente de aprobación",
  queued: "en cola de envío",
  sent: "enviado",
  received: "recibido",
  failed: "fallo al enviar",
};
/** Status colors: delivered = good, in-flight = attention, failed = bad. */
const MESSAGE_STATUS_COLOR: Record<string, string> = {
  draft: "var(--ink-muted)",
  pending_approval: "var(--grade-c)",
  queued: "var(--grade-c)",
  sent: "var(--grade-a)",
  received: "var(--grade-a)",
  failed: "var(--grade-e)",
};

export default async function LeadDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sugerir?: string }>;
}) {
  const { id } = await params;
  const { sugerir } = await searchParams;
  const db = await getDb();

  const [row] = await db
    .select({ lead: leads, listing: listings, brief: briefs })
    .from(leads)
    .innerJoin(listings, eq(leads.listingId, listings.id))
    .innerJoin(briefs, eq(leads.briefId, briefs.id))
    .where(eq(leads.id, id))
    .limit(1);
  if (!row) notFound();
  const { lead, listing, brief } = row;
  const v = lead.verdict;

  const history = await db
    .select()
    .from(events)
    .where(eq(events.leadId, lead.id))
    .orderBy(desc(events.createdAt))
    .limit(10);

  const conversation = await db
    .select()
    .from(messages)
    .where(eq(messages.leadId, lead.id))
    .orderBy(asc(messages.createdAt));
  const pendingDraft = conversation.find(
    (m) => m.direction === "outbound" && m.status === "pending_approval",
  );
  const contactable =
    ["shortlisted", "contacted", "negotiating"].includes(lead.state) &&
    listing.platform === "wallapop" &&
    lead.autonomyMode !== "paused";

  // Whose turn is it? If the last word in the thread is ours, we're waiting
  // on the seller: no new questions get suggested on top of unanswered ones —
  // after a couple of quiet days the only suggestion is a gentle nudge.
  const lastExchange = [...conversation]
    .reverse()
    .find(
      (m) =>
        (m.direction === "outbound" && m.status === "sent") ||
        (m.direction === "inbound" && m.status === "received"),
    );
  const waitingForSeller = lastExchange?.direction === "outbound";
  const quietMs = waitingForSeller
    ? Date.now() - new Date(lastExchange.sentAt ?? lastExchange.createdAt).getTime()
    : 0;
  const NUDGE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

  // Deterministic suggestion, by conversation turn: nothing exchanged yet →
  // the opening message; seller answered → the open questions not yet asked,
  // or a data-justified price proposal once everything has been asked; we're
  // waiting → a nudge (quiet ≥2 days). Always behind the same button:
  // nothing is pre-composed until the user asks for it.
  const hasExchange = lastExchange !== undefined;

  // Live negotiation: the reading OBSERVED both numbers; code decides the
  // answer. A pending counter takes precedence over questions and fresh
  // offers — the one wrong move is repeating a number they already refused.
  const negotiation = lead.chatReading?.negotiation;
  const counterInput =
    !waitingForSeller && negotiation?.ourLastOfferEur && negotiation?.sellerLastOfferEur
      ? {
          ourLastOfferEur: negotiation.ourLastOfferEur,
          sellerCounterEur: negotiation.sellerLastOfferEur,
          maxBudgetEur: brief.hardLimits.maxPriceEur,
        }
      : null;
  const counterDecision = counterInput ? respondToCounterEur(counterInput) : null;

  const askingPriceEur = listing.cashPriceEur ?? listing.priceEur;
  const offerInput =
    askingPriceEur != null
      ? {
          askingPriceEur,
          maxBudgetEur: brief.hardLimits.maxPriceEur,
          repairExposureEur: lead.verdict?.repairExposureEur,
          pendingRisks: lead.verdict?.issues
            ?.filter((i) => i.status === "unconfirmed")
            .map((i) => i.title),
        }
      : undefined;
  const offerEur = offerInput ? computeOfferEur(offerInput) : null;
  const followUp =
    hasExchange && !waitingForSeller
      ? composeFollowUpMessage({
          openQuestions: lead.verdict?.openQuestions ?? [],
          alreadyAsked: conversation
            .filter((m) => m.direction === "outbound" && (m.status === "sent" || m.status === "queued"))
            .map((m) => m.body),
          sellerReplies: conversation.filter(
            (m) => m.direction === "inbound" && m.status === "received",
          ).length,
          // A justified offer rides along: negotiate before promising a visit.
          offer: offerEur !== null ? offerInput : undefined,
        })
      : null;
  const suggestion = !hasExchange
    ? composeOpeningMessage({
        title: listing.title,
        sellerName: listing.sellerName ?? undefined,
        openQuestions: lead.verdict?.openQuestions ?? [],
      })
    : waitingForSeller
      ? quietMs >= NUDGE_AFTER_MS
        ? composeNudgeMessage(lead.id)
        : null
      : counterInput
        ? composeCounterReply({ ...counterInput, seed: lead.id })
        : (followUp ??
          (offerEur !== null && offerInput
            ? composeOfferMessage({ ...offerInput, seed: lead.id })
            : null));
  const suggestionQuestions = suggestion?.split("\n").filter((l) => l.trim().endsWith("?")).length ?? 0;
  const offerTxt = offerEur !== null ? `propuesta de precio (${offerEur.toLocaleString("es-ES")} €)` : "";
  const counterTxt = counterDecision
    ? counterDecision.action === "accept"
      ? `aceptación (${counterDecision.priceEur.toLocaleString("es-ES")} €)`
      : counterDecision.action === "counter"
        ? `contraoferta (${counterDecision.priceEur.toLocaleString("es-ES")} €)`
        : `mantener oferta (${counterDecision.priceEur.toLocaleString("es-ES")} €)`
    : "";
  const suggestLabel = !hasExchange
    ? `✍️ Generar mensaje inicial${suggestionQuestions > 0 ? ` (${suggestionQuestions} pregunta${suggestionQuestions === 1 ? "" : "s"})` : ""}`
    : waitingForSeller
      ? "✍️ Generar recordatorio suave (sin preguntas nuevas)"
      : counterDecision
        ? `✍️ Generar ${counterTxt}`
        : followUp
          ? offerEur !== null
            ? `✍️ Generar seguimiento + ${offerTxt}`
            : `✍️ Generar seguimiento (${suggestionQuestions} pregunta${suggestionQuestions === 1 ? "" : "s"} sin hacer)`
          : `✍️ Generar ${offerTxt}`;

  // The cheap-LLM prose lane: the deterministic text is both the base draft
  // and the guaranteed fallback; the number (if any) is code-decided and the
  // draft is validated to carry it verbatim. Without ANTHROPIC_API_KEY this
  // is a no-op passthrough.
  const suggestionText =
    sugerir && suggestion
      ? (
          await draftSellerProse({
            title: listing.title,
            transcript: conversation
              .filter(
                (m) =>
                  (m.direction === "outbound" && m.status === "sent") ||
                  (m.direction === "inbound" && m.status === "received"),
              )
              .map((m) => `${m.direction === "inbound" ? "VENDEDOR" : "COMPRADOR"}: ${m.body}`)
              .join("\n---\n"),
            intent: counterDecision
              ? counterDecision.action === "accept"
                ? `aceptar la contraoferta del vendedor en ${counterDecision.priceEur.toLocaleString("es-ES")} € y proponer ver el coche`
                : counterDecision.action === "counter"
                  ? `responder a la contraoferta con ${counterDecision.priceEur.toLocaleString("es-ES")} €, justificado en los riesgos pendientes, sin aceptar su cifra`
                  : `mantener con amabilidad nuestra oferta de ${counterDecision.priceEur.toLocaleString("es-ES")} €, dejando la puerta abierta`
              : !hasExchange
                ? "primer contacto: mostrar interés y hacer las preguntas del borrador base"
                : waitingForSeller
                  ? "recordatorio suave, sin preguntas nuevas"
                  : followUp
                    ? "agradecer las respuestas y hacer las preguntas del borrador base"
                    : "proponer el precio del borrador base justificado con los riesgos pendientes",
            fallback: suggestion,
            mustContainPrice: counterDecision
              ? counterDecision.priceEur.toLocaleString("es-ES")
              : !followUp && offerEur !== null
                ? offerEur.toLocaleString("es-ES")
                : undefined,
          })
        ).text
      : suggestion;

  // High-signal import warnings belong next to the title, not buried in a
  // card. Stored facts (user-verified or ingest-detected) beat text inference.
  const extracted = extractImportSignals(listing.title, listing.description ?? undefined);
  const imported = {
    rhd: listing.rhd ?? extracted.rhd,
    rhdAssumed: listing.rhd === null && extracted.rhdAssumed,
    foreignPlate: listing.foreignPlates ?? extracted.foreignPlate,
  };

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.5rem" }}>
      <p style={{ margin: "0 0 0.5rem" }}>
        <Link href="/" style={{ color: "var(--ink-muted)", fontSize: "0.85rem" }}>
          ← Leads
        </Link>
      </p>
      <h1 style={{ fontSize: "1.3rem", margin: "0 0 0.25rem" }}>{listing.title}</h1>
      {(imported.rhd || imported.foreignPlate) && (
        <p style={{ margin: "0.15rem 0 0.35rem", display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          {imported.foreignPlate && (
            <span style={importChip}>
              🇬🇧 Matrícula extranjera{listing.foreignPlates !== null ? " (verificado)" : ""} —
              rematriculación ~1.500 € (+aduanas/IVA si UK)
            </span>
          )}
          {imported.rhd && (
            <span style={importChip}>
              Volante a la derecha
              {listing.rhd !== null
                ? " (verificado)"
                : imported.rhdAssumed
                  ? " (asumido: origen inglés)"
                  : " (RHD)"}
            </span>
          )}
        </p>
      )}
      {/* Verified import facts: the photos tell what the text hides. */}
      <details open={imported.rhd || imported.foreignPlate} style={{ margin: "0.2rem 0 0.5rem" }}>
        <summary style={{ cursor: "pointer", fontSize: "0.82rem", color: "var(--ink-muted)" }}>
          Verificar importación (volante / matrícula)
        </summary>
        <div style={{ display: "flex", gap: "1.2rem", flexWrap: "wrap", margin: "0.35rem 0 0" }}>
          <ImportFactRow
            leadId={lead.id}
            field="rhd"
            label="Volante a la derecha"
            stored={listing.rhd}
          />
          <ImportFactRow
            leadId={lead.id}
            field="foreignPlates"
            label="Matrícula extranjera (sin matricular en España)"
            stored={listing.foreignPlates}
          />
        </div>
      </details>
      {listing.imageUrl && (
        <a href={listing.url} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element -- platform CDN, unknown domains */}
          <img
            src={listing.imageUrl}
            alt={listing.title}
            style={{
              maxWidth: "100%",
              width: 420,
              borderRadius: 8,
              display: "block",
              margin: "0.5rem 0",
            }}
          />
        </a>
      )}
      <p style={{ color: "var(--ink-muted)", marginTop: 0 }}>
        {listing.cashPriceEur != null && listing.cashPriceEur !== listing.priceEur
          ? `${fmtEur(listing.cashPriceEur)} al contado (anuncio: ${fmtEur(listing.priceEur)})`
          : fmtEur(listing.priceEur)}{" "}
        · {listing.year ?? "año ?"} · {fmtKm(listing.km)} ·{" "}
        {listing.fuel ?? "?"} · {listing.gearbox ?? "cambio ?"}
        {listing.powerCv ? ` · ${listing.powerCv} CV` : ""} · {listing.locationText ?? "—"}
        {" · "}
        <a href={listing.url} target="_blank" rel="noreferrer">
          ver anuncio en {listing.platform} ↗
        </a>
      </p>
      <p style={{ color: "var(--ink-muted)", fontSize: "0.85rem" }}>
        Búsqueda: {brief.name} · Estado: <strong>{lead.state}</strong>
        {lead.state === "dead" && lead.deadReason ? ` (${lead.deadReason})` : ""}
        {lead.origin === "manual" ? " · adoptado manualmente" : ""}
        {listing.sellerName
          ? ` · Vendedor: ${listing.sellerName}${listing.sellerType === "dealer" ? " (profesional)" : ""}`
          : ""}
      </p>

      {lead.origin === "manual" && lead.state !== "dead" && lead.deadReason && (
        <p
          style={{
            border: "1px solid var(--grade-c)",
            color: "var(--grade-c)",
            borderRadius: 8,
            padding: "0.5rem 0.8rem",
            fontSize: "0.85rem",
          }}
        >
          No pasaría los filtros de esta búsqueda ({lead.deadReason}) — se mantiene vivo por
          adopción manual.
        </p>
      )}

      {v ? (
        <>
          {/* Verdict summary */}
          <section style={card}>
            <div style={{ display: "flex", gap: "2rem", alignItems: "baseline", flexWrap: "wrap" }}>
              <div>
                <span style={{ fontSize: "2.2rem", fontWeight: 700, color: gradeVar(v.overall) }}>
                  {v.overall}
                </span>
                <span style={{ fontSize: "1.2rem", color: "var(--ink-muted)" }}> {v.score}/100</span>
              </div>
              <div style={{ color: "var(--ink-muted)" }}>
                {v.confidencePct}% verificado · actualizado {fmtDate(v.updatedAt)}
              </div>
            </div>
            {/* The one-phrase answer: pursue this unit or wait for the next. */}
            <p style={{ margin: "0.5rem 0 0", fontWeight: 600 }}>{composeUnitLine(v)}</p>
            {v.repairExposureEur && (
              <p style={{ marginBottom: 0 }}>
                Exposición en reparaciones sin descartar:{" "}
                <strong>
                  ~{v.repairExposureEur.min.toLocaleString("es-ES")}–
                  {v.repairExposureEur.max.toLocaleString("es-ES")} €
                </strong>
              </p>
            )}
            {v.budgetNote && <p style={{ marginBottom: 0 }}>{v.budgetNote}</p>}
          </section>

          {/* LLM read of the ad — refinement over the rule verdict */}
          {v.llm && (
            <section style={card}>
              <strong>Lectura del anuncio (IA)</strong>
              <p style={{ margin: "0.4rem 0" }}>{v.llm.summary}</p>
              {v.llm.redFlags.length > 0 && (
                <p style={{ margin: "0.35rem 0", fontSize: "0.87rem" }}>
                  <span style={{ color: "var(--grade-e)", fontWeight: 600 }}>Alertas:</span>{" "}
                  {v.llm.redFlags.join(" · ")}
                </p>
              )}
              {v.llm.greenFlags.length > 0 && (
                <p style={{ margin: "0.35rem 0", fontSize: "0.87rem" }}>
                  <span style={{ color: "var(--grade-a)", fontWeight: 600 }}>A favor:</span>{" "}
                  {v.llm.greenFlags.join(" · ")}
                </p>
              )}
              <p style={{ margin: "0.4rem 0 0", fontSize: "0.78rem", color: "var(--ink-muted)" }}>
                {v.llm.model} · {fmtDate(v.llm.at)}
              </p>
            </section>
          )}

          {/* Factors */}
          <h2 style={h2}>Factores</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "0.75rem" }}>
            {Object.entries(v.factors).map(([key, factor]) => (
              <FactorCard key={key} name={FACTOR_NAMES[key] ?? key} factor={factor} />
            ))}
          </div>

          {/* Issues */}
          {v.issues?.length > 0 && (
            <>
              <h2 style={h2}>Riesgos conocidos aplicables a esta unidad</h2>
              {v.issues.map((issue) => (
                <div key={issue.title} style={card}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "0.05rem 0.55rem",
                      marginRight: "0.5rem",
                      borderRadius: 999,
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      color: STATUS_COLOR[issue.status] ?? "var(--ink-muted)",
                      border: "1px solid currentcolor",
                      verticalAlign: "middle",
                    }}
                  >
                    {STATUS_ES[issue.status] ?? issue.status}
                  </span>
                  <strong>{issue.title}</strong>{" "}
                  <span style={{ color: "var(--ink-muted)" }}>
                    · probabilidad {LIKELIHOOD_ES[issue.likelihood] ?? issue.likelihood}
                    {issue.typicalRepairCostEur
                      ? ` · ~${issue.typicalRepairCostEur.min.toLocaleString("es-ES")}–${issue.typicalRepairCostEur.max.toLocaleString("es-ES")} €`
                      : ""}
                  </span>
                  <p style={{ margin: "0.4rem 0 0", fontSize: "0.85rem", color: "var(--ink-muted)" }}>
                    Se descarta con: {issue.verifyBy.join("; ")}
                  </p>
                  <IssueControls
                    leadId={lead.id}
                    issue={issue}
                    finding={lead.issueFindings?.find((f) => f.title === issue.title)}
                  />
                </div>
              ))}
            </>
          )}

          {/* Seller questions */}
          {v.openQuestions.length > 0 && (
            <>
              <h2 style={h2}>Preguntas para el vendedor</h2>
              <ul style={{ lineHeight: 1.7 }}>
                {v.openQuestions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </>
          )}

          {/* What would raise the grade */}
          {v.wouldRaiseGrade.length > 0 && (
            <>
              <h2 style={h2}>Qué subiría la nota</h2>
              <ul style={{ lineHeight: 1.7, fontSize: "0.9rem" }}>
                {v.wouldRaiseGrade.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <p style={{ color: "var(--ink-muted)" }}>Sin veredicto todavía.</p>
      )}

      {/* The visit report: what to verify on THIS unit, phone-friendly. */}
      {v && (
        <p style={{ margin: "1rem 0 0" }}>
          <Link
            href={`/leads/${lead.id}/visita`}
            style={{
              ...btn,
              display: "inline-block",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            📋 Informe de visita — qué comprobar en esta unidad
          </Link>
        </p>
      )}

      {/* Conversation with the seller — every send passes a human approval */}
      {(conversation.length > 0 || contactable) && (
        <>
          <h2 style={h2}>
            Conversación con el vendedor
            {waitingForSeller && (
              <span
                style={{
                  marginLeft: "0.6rem",
                  padding: "0.1rem 0.6rem",
                  borderRadius: 999,
                  border: "1px solid var(--border)",
                  color: "var(--ink-muted)",
                  fontSize: "0.75rem",
                  fontWeight: 400,
                  verticalAlign: "middle",
                }}
              >
                ⏳ Esperando respuesta del vendedor
              </span>
            )}
          </h2>
          {conversation
            .filter((m) => m.id !== pendingDraft?.id)
            .map((m) => (
              <div
                key={m.id}
                style={{
                  ...card,
                  marginLeft: m.direction === "inbound" ? 0 : "2rem",
                  marginRight: m.direction === "inbound" ? "2rem" : 0,
                  background: m.direction === "inbound" ? "var(--chat-in)" : "var(--chat-out)",
                  borderColor:
                    m.direction === "inbound" ? "var(--chat-in-border)" : "var(--chat-out-border)",
                  whiteSpace: "pre-wrap",
                  fontSize: "0.9rem",
                }}
              >
                <p style={{ margin: "0 0 0.4rem", fontSize: "0.78rem", color: "var(--ink-muted)" }}>
                  {m.direction === "inbound" ? "Vendedor" : "deepblue"} ·{" "}
                  <span style={{ color: MESSAGE_STATUS_COLOR[m.status] ?? "inherit", fontWeight: 600 }}>
                    {MESSAGE_STATUS_ES[m.status] ?? m.status}
                  </span>{" "}
                  · {fmtDate(m.sentAt ?? m.createdAt)}
                </p>
                {m.body}
              </div>
            ))}

          {pendingDraft ? (
            <div style={{ ...card, borderColor: "var(--grade-c)" }}>
              <strong style={{ fontSize: "0.9rem" }}>
                Borrador pendiente de tu aprobación — nada se envía sin ella
              </strong>
              <form action={approveSellerMessage} style={{ marginTop: "0.6rem" }}>
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="messageId" value={pendingDraft.id} />
                <textarea
                  name="body"
                  rows={8}
                  maxLength={CHAT_MAX_CHARS}
                  defaultValue={pendingDraft.body}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "0.5rem 0.7rem",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "transparent",
                    color: "inherit",
                    font: "inherit",
                    fontSize: "0.9rem",
                  }}
                />
                <SubmitButton
                  label="Aprobar y enviar"
                  pendingLabel="⏳ Enviando a la cola…"
                  style={{ ...btn, color: "var(--grade-a)", marginTop: "0.5rem" }}
                />
              </form>
              <form action={rejectSellerMessage} style={{ display: "inline" }}>
                <input type="hidden" name="leadId" value={lead.id} />
                <SubmitButton
                  label="Rechazar"
                  style={{ ...btn, color: "var(--grade-e)", marginTop: "0.5rem" }}
                />
              </form>
            </div>
          ) : (
            contactable &&
            !conversation.some((m) => m.status === "queued") && (
              // One composer for every turn. It starts empty; the button fills
              // it with the suggested message (opener / follow-up / nudge) and
              // the user edits and sends — clicking send IS the approval.
              <div style={{ marginTop: "0.5rem" }}>
                <form action={replySellerMessage}>
                  <input type="hidden" name="leadId" value={lead.id} />
                  <textarea
                    name="body"
                    rows={sugerir && suggestionText ? 8 : 4}
                    required
                    maxLength={CHAT_MAX_CHARS}
                    placeholder={hasExchange ? "Responder al vendedor…" : "Mensaje al vendedor…"}
                    defaultValue={sugerir && suggestionText ? suggestionText : undefined}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "0.5rem 0.7rem",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "transparent",
                      color: "inherit",
                      font: "inherit",
                      fontSize: "0.9rem",
                    }}
                  />
                  <p style={{ margin: "0.2rem 0 0", fontSize: "0.75rem", color: "var(--ink-muted)" }}>
                    Máx. {CHAT_MAX_CHARS} caracteres (límite del chat de Wallapop)
                  </p>
                  <SubmitButton
                    label="Enviar al vendedor"
                    pendingLabel="⏳ Enviando a la cola…"
                    style={{ ...btn, marginTop: "0.4rem" }}
                  />
                  {suggestion && !sugerir && (
                    <GenerateLink
                      href={`/leads/${lead.id}?sugerir=1`}
                      label={suggestLabel}
                      style={{
                        ...btn,
                        display: "inline-block",
                        marginLeft: "0.5rem",
                        marginTop: "0.4rem",
                        textDecoration: "none",
                        color: "var(--ink-muted)",
                        fontWeight: 400,
                      }}
                    />
                  )}
                </form>
              </div>
            )
          )}
        </>
      )}

      {/* History */}
      {history.length > 0 && (
        <>
          <h2 style={h2}>Historial</h2>
          <ul style={{ fontSize: "0.85rem", color: "var(--ink-muted)", lineHeight: 1.8 }}>
            {history.map((e) => (
              <li key={e.id}>
                {fmtDate(e.createdAt)} — {e.type}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

/** Sí / No / ¿? controls for one verified import fact on this lead's listing. */
function ImportFactRow({
  leadId,
  field,
  label,
  stored,
}: {
  leadId: string;
  field: "rhd" | "foreignPlates";
  label: string;
  stored: boolean | null;
}) {
  const options: Array<{ value: string; text: string; active: boolean }> = [
    { value: "true", text: "Sí", active: stored === true },
    { value: "false", text: "No", active: stored === false },
    { value: "unknown", text: "¿?", active: stored === null },
  ];
  return (
    // div, not span: a form may not nest inside phrasing content (hydration error).
    <div style={{ display: "flex", gap: "0.35rem", alignItems: "center", fontSize: "0.83rem" }}>
      <span style={{ color: "var(--ink-muted)" }}>{label}:</span>
      {options.map((o) => (
        <form key={o.value} action={setImportFact} style={{ display: "inline" }}>
          <input type="hidden" name="leadId" value={leadId} />
          <input type="hidden" name="field" value={field} />
          <input type="hidden" name="value" value={o.value} />
          <button
            type="submit"
            style={{
              padding: "0.1rem 0.55rem",
              borderRadius: 999,
              border: "1px solid",
              borderColor: o.active ? "var(--ink-muted)" : "var(--border)",
              background: o.active ? "var(--card)" : "transparent",
              color: "inherit",
              fontWeight: o.active ? 700 : 400,
              fontSize: "0.8rem",
              cursor: "pointer",
            }}
          >
            {o.text}
          </button>
        </form>
      ))}
    </div>
  );
}

function FactorCard({ name, factor }: { name: string; factor: VerdictFactor }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>{name}</strong>
        <span>
          <span style={{ fontWeight: 700, color: gradeVar(factor.grade) }}>{factor.grade}</span>
          <span style={{ color: "var(--ink-muted)" }}> {factor.score ?? "—"}</span>
        </span>
      </div>
      {/* thin meter, rounded data-end, status color */}
      <div style={{ background: "var(--track)", borderRadius: 4, height: 6, margin: "0.5rem 0 0.75rem" }}>
        <div
          style={{
            width: `${factor.score ?? 0}%`,
            background: gradeVar(factor.grade),
            height: 6,
            borderRadius: 4,
          }}
        />
      </div>
      <FactList label="Sabemos" items={factor.known} />
      <FactList label="Asumimos" items={factor.assumed} />
      <FactList label="Sin verificar" items={factor.unverified} />
    </div>
  );
}

/**
 * The manual seller-verification loop: record what the seller proved (or
 * admitted) and the verdict re-evaluates on the spot. Phase 2 chat will feed
 * the same action automatically.
 */
function IssueControls({
  leadId,
  issue,
  finding,
}: {
  leadId: string;
  issue: IssueAssessment;
  finding?: IssueFinding;
}) {
  return (
    <form
      action={setIssueFinding}
      style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.6rem" }}
    >
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="title" value={issue.title} />
      {issue.status === "unconfirmed" ? (
        <>
          <input
            name="note"
            placeholder="Evidencia (factura, vídeo, diagnosis…)"
            style={{
              flex: "1 1 220px",
              padding: "0.35rem 0.6rem",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "inherit",
              fontSize: "0.85rem",
            }}
          />
          <button type="submit" name="status" value="ruled_out" style={{ ...btn, color: "var(--grade-a)" }}>
            Descartar
          </button>
          <button type="submit" name="status" value="confirmed" style={{ ...btn, color: "var(--grade-e)" }}>
            Confirmar
          </button>
        </>
      ) : (
        <>
          {(finding?.note || finding?.at) && (
            <span style={{ color: "var(--ink-muted)", fontSize: "0.8rem" }}>
              {finding.note ? `Evidencia: ${finding.note}` : "Sin nota"}
              {finding.at ? ` · ${fmtDate(finding.at)}` : ""}
            </span>
          )}
          <button type="submit" name="status" value="unconfirmed" style={btn}>
            Reabrir
          </button>
        </>
      )}
    </form>
  );
}

function FactList({ label, items }: { label: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <p style={{ margin: "0.35rem 0", fontSize: "0.85rem" }}>
      <span style={{ color: "var(--ink-muted)" }}>{label}:</span>{" "}
      {items.map((i, n) => (
        <span key={i}>
          {n > 0 && " · "}
          {i}
        </span>
      ))}
    </p>
  );
}

const card: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "0.9rem 1rem",
  margin: "0.75rem 0",
};
const h2: React.CSSProperties = { fontSize: "1rem", margin: "1.5rem 0 0.5rem" };
const importChip: React.CSSProperties = {
  display: "inline-block",
  padding: "0.15rem 0.6rem",
  borderRadius: 999,
  fontSize: "0.78rem",
  fontWeight: 600,
  color: "var(--grade-d)",
  border: "1px solid currentcolor",
};
const btn: React.CSSProperties = {
  padding: "0.3rem 0.8rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  fontSize: "0.85rem",
  fontWeight: 600,
  cursor: "pointer",
};
