/**
 * Wallapop chat over the real web UI, driven through a persistent browser
 * profile that holds the user's logged-in session (created once with
 * `pnpm runner:login`). Plain HTTP covers search/detail; chat is the one
 * surface that genuinely needs the browser.
 *
 * Selectors are best-effort with fallbacks: Wallapop ships web components
 * that change names, so every step fails loudly with context instead of
 * clicking the wrong thing.
 */

/// <reference lib="dom" />
// ^ page.evaluate callbacks run in the browser; only this module needs DOM types.

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConversationRef, InboundMessage, SendResult } from "@deepblue/core";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";

const WALLAPOP_HOME = "https://es.wallapop.com";

/** Human pause: chat steps must not fire machine-fast. */
function pause(minMs: number, maxMs: number): Promise<void> {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

export async function openWallapopProfile(
  profileDir: string,
  headless: boolean,
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir, {
    headless,
    // Headed: viewport null makes the page track the real OS window. A fixed
    // viewport leaves the two out of sync, and bottom-anchored overlays (the
    // OneTrust consent gate) land off the visible edge — unclickable, with
    // the page blurred behind them (2026-07-26). Headless has no window, so
    // it keeps an explicit size.
    viewport: headless ? { width: 1366, height: 850 } : null,
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    args: [
      "--disable-blink-features=AutomationControlled",
      ...(headless ? [] : ["--window-size=1366,900"]),
    ],
  });
}

/** The session cookie outlives the UI; its presence is the login check. */
export async function hasWallapopSession(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies(WALLAPOP_HOME);
  return cookies.some((c) => /accesstoken|refreshtoken/i.test(c.name) && c.value.length > 0);
}

export async function dismissCookieBanner(page: Page): Promise<void> {
  const accept = page.locator("#onetrust-accept-btn-handler");
  if (await accept.isVisible({ timeout: 4000 }).catch(() => false)) {
    await accept.click();
    await pause(400, 900);
  }
}

/**
 * First visible locator among the candidates, or null. Checks every match of
 * each selector, not just the first: Wallapop renders invisible duplicates
 * of its CTAs (responsive variants), and DOM order puts them first.
 */
async function firstVisible(page: Page, selectors: string[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const matches = page.locator(selector);
      const count = Math.min(await matches.count().catch(() => 0), 10);
      for (let i = 0; i < count; i++) {
        const loc = matches.nth(i);
        if (await loc.isVisible().catch(() => false)) return loc;
      }
    }
    await sleep(300);
  }
  return null;
}

const COMPOSER_SELECTORS = [
  "textarea",
  '[contenteditable="true"]',
  'input[placeholder*="chatear" i]',
  'input[placeholder*="mensaje" i]',
];

/** The chat composer, wherever it appeared — Wallapop opens chat in a new tab. */
async function findComposer(
  context: BrowserContext,
  timeoutMs: number,
): Promise<{ page: Page; composer: Locator } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      for (const selector of COMPOSER_SELECTORS) {
        const matches = p.locator(selector);
        const count = Math.min(await matches.count().catch(() => 0), 10);
        for (let i = 0; i < count; i++) {
          const loc = matches.nth(i);
          if (await loc.isVisible().catch(() => false)) return { page: p, composer: loc };
        }
      }
    }
    await sleep(400);
  }
  return null;
}

/**
 * Send `body` to the seller of one listing: open the ad, hit its Chat
 * button, write in the composer, send, and verify the composer emptied.
 */
export async function sendWallapopMessage(
  profileDir: string,
  headless: boolean,
  ref: ConversationRef,
  body: string,
): Promise<SendResult> {
  if (!ref.url) throw new Error("send_message sin url del anuncio");

  const context = await openWallapopProfile(profileDir, headless);
  try {
    if (!(await hasWallapopSession(context))) {
      throw new Error(
        "no hay sesión de Wallapop en el perfil del navegador — ejecuta `pnpm runner:login` una vez",
      );
    }

    const page = await context.newPage();
    await page.goto(ref.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await dismissCookieBanner(page);
    await pause(1200, 2800); // read the ad like a person would

    // The ad's own CTA is a walla-button web component; click the HOST (its
    // handler lives there, verified 2026-07-16 — clicking the inner shadow
    // button does nothing). Never match on href: the header's "Buzón" inbox
    // link also goes to /app/chat but opens an inbox with no composer.
    const chatButton = await firstVisible(
      page,
      [
        'walla-button:has-text("Chat")',
        'button:has-text("Chat")',
        'a:has-text("Chat")',
        '[data-testid*="chat" i]',
      ],
      15_000,
    );
    if (!chatButton) {
      throw new Error(`botón de chat no encontrado en ${page.url()} (¿anuncio caído o UI cambiada?)`);
    }
    await chatButton.click();

    // The chat opens in a NEW TAB (/app/chat?itemId=…) — scan every page in
    // the context for the composer instead of assuming the current one.
    const found = await findComposer(context, 25_000);
    if (!found) {
      const loginWall = await firstVisible(
        page,
        ['button:has-text("Inicia sesión")', 'a:has-text("Inicia sesión")', '[href*="login"]'],
        1_000,
      );
      throw new Error(
        loginWall
          ? "Wallapop pide iniciar sesión — la sesión del perfil caducó; ejecuta `pnpm runner:login`"
          : `no aparece el campo de mensaje tras abrir el chat (última url: ${page.url()})`,
      );
    }
    const { page: chatPage, composer } = found;

    await composer.click();
    await pause(600, 1500);
    // fill(), never keystrokes: the draft has newlines and a typed Enter
    // would fire a half-written message at a real person. A single-line
    // <input> composer can't hold newlines, so flatten for that case.
    const isInput = (await composer.evaluate((el) => el.tagName).catch(() => "")) === "INPUT";
    const intended = isInput ? body.replace(/\s*\r?\n+\s*/g, " ") : body;
    await composer.fill(intended);
    await pause(700, 1600);

    // Wallapop's composer has maxlength=300 (measured 2026-07-17): if the
    // field holds less than we wrote, the tail was silently cut — abort
    // BEFORE sending. Half a message to a real person is worse than none.
    const held = (await composer.inputValue().catch(() => composer.innerText())).trim();
    if (held.length < intended.trim().length) {
      throw new Error(
        `el chat recortó el mensaje (${held.length}/${intended.trim().length} caracteres) — no se envía a medias; acórtalo`,
      );
    }

    const sendButton = await firstVisible(
      chatPage,
      [
        'button[type="submit"]:visible',
        '[aria-label*="enviar" i]',
        '[data-testid*="send" i]',
        'button:has-text("Enviar")',
      ],
      5_000,
    );
    if (sendButton) await sendButton.click();
    else await composer.press("Enter");

    // Sent = the composer emptied. If it still holds our text, nothing left.
    const deadline = Date.now() + 10_000;
    let emptied = false;
    while (Date.now() < deadline && !emptied) {
      await sleep(500);
      const value = await composer.inputValue().catch(() => composer.innerText());
      emptied = value.trim() === "";
    }
    if (!emptied) throw new Error("el mensaje no llegó a salir (el campo de texto no se vació)");

    await pause(1500, 3000); // linger like a person; never slam the window shut
    return { sentAt: new Date().toISOString() };
  } finally {
    await context.close();
  }
}

/** One thread bubble as scraped from the chat DOM. */
interface RawBubble {
  direction: "incoming" | "outgoing";
  text: string;
  /** "HH:MM" from the bubble; Wallapop shows no full datetime. */
  time: string;
}

/**
 * "HH:MM" → ISO, assuming today (or yesterday when the time lies in the
 * future). Honest enough for fresh replies, which is what polling catches.
 */
function timeToIso(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return new Date().toISOString();
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
  return d.toISOString();
}

/**
 * Read the seller's messages for one listing. The chat deep link
 * (/app/chat?itemId=…) lands straight in the conversation — verified
 * 2026-07-16; bubble structure: tsl-chat-bubble > .ChatBubble--incoming/
 * --outgoing > .ChatBubble__content + .ChatBubble__timestamp.
 */
export async function fetchWallapopReplies(
  profileDir: string,
  headless: boolean,
  ref: ConversationRef,
): Promise<InboundMessage[]> {
  const context = await openWallapopProfile(profileDir, headless);
  try {
    if (!(await hasWallapopSession(context))) {
      throw new Error(
        "no hay sesión de Wallapop en el perfil del navegador — ejecuta `pnpm runner:login` una vez",
      );
    }

    const page = await context.newPage();
    await page.goto(
      `https://es.wallapop.com/app/chat?itemId=${encodeURIComponent(ref.platformListingId)}`,
      { waitUntil: "domcontentloaded", timeout: 45_000 },
    );
    await dismissCookieBanner(page);

    // Bubbles or composer prove the thread rendered; neither means trouble.
    const bubbleOrComposer = await firstVisible(
      page,
      ["tsl-chat-bubble", ...COMPOSER_SELECTORS],
      25_000,
    );
    if (!bubbleOrComposer) {
      throw new Error(`el chat no cargó para el item ${ref.platformListingId} (${page.url()})`);
    }
    await pause(1500, 3000); // let the thread finish hydrating

    const bubbles: RawBubble[] = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("tsl-chat-bubble")).flatMap((b) => {
        const inner = b.querySelector(".ChatBubble");
        const content = b.querySelector(".ChatBubble__content");
        if (!inner || !content) return [];
        const cls = inner.className;
        const direction = cls.includes("ChatBubble--incoming")
          ? ("incoming" as const)
          : cls.includes("ChatBubble--outgoing")
            ? ("outgoing" as const)
            : null;
        if (!direction) return [];
        return [
          {
            direction,
            text: (content.textContent ?? "").trim(),
            time: (b.querySelector(".ChatBubble__timestamp")?.textContent ?? "").trim(),
          },
        ];
      });
    });

    return bubbles
      .filter((b) => b.direction === "incoming" && b.text)
      .map((b) => ({
        conversation: {
          platform: ref.platform,
          platformListingId: ref.platformListingId,
          platformConversationId: ref.platformConversationId,
        },
        // No DOM message ids: hash of identity fields. Same seller text at
        // the same HH:MM dedups as one — acceptable for chat reality.
        externalId: createHash("sha256")
          .update(`${ref.platformListingId}|in|${b.text}|${b.time}`)
          .digest("hex")
          .slice(0, 32),
        body: b.text,
        receivedAt: timeToIso(b.time),
      }));
  } finally {
    await context.close();
  }
}
