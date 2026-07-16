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

import { setTimeout as sleep } from "node:timers/promises";
import type { ConversationRef, SendResult } from "@deepblue/core";
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
    viewport: { width: 1366, height: 850 },
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

/** The session cookie outlives the UI; its presence is the login check. */
export async function hasWallapopSession(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies(WALLAPOP_HOME);
  return cookies.some((c) => /accesstoken|refreshtoken/i.test(c.name) && c.value.length > 0);
}

async function dismissCookieBanner(page: Page): Promise<void> {
  const accept = page.locator("#onetrust-accept-btn-handler");
  if (await accept.isVisible({ timeout: 4000 }).catch(() => false)) {
    await accept.click();
    await pause(400, 900);
  }
}

/** First visible locator among the candidates, or null. */
async function firstVisible(page: Page, selectors: string[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const loc = page.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await sleep(300);
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

    const chatButton = await firstVisible(
      page,
      [
        'a[href*="/app/chat"]',
        'button:has-text("Chat")',
        'a:has-text("Chat")',
        '[data-testid*="chat" i]',
        'walla-button[text="Chat" i]',
      ],
      15_000,
    );
    if (!chatButton) {
      throw new Error(`botón de chat no encontrado en ${page.url()} (¿anuncio caído o UI cambiada?)`);
    }
    await chatButton.click();

    // A login wall here means the session died: fail with the fix, not a timeout.
    const composer = await firstVisible(
      page,
      ["textarea", '[contenteditable="true"]', 'input[placeholder*="mensaje" i]'],
      20_000,
    );
    if (!composer) {
      const loginWall = await firstVisible(
        page,
        ['button:has-text("Inicia sesión")', 'a:has-text("Inicia sesión")', '[href*="login"]'],
        1_000,
      );
      throw new Error(
        loginWall
          ? "Wallapop pide iniciar sesión — la sesión del perfil caducó; ejecuta `pnpm runner:login`"
          : `no aparece el campo de mensaje en ${page.url()}`,
      );
    }

    await composer.click();
    await pause(600, 1500);
    // fill(), never keystrokes: the draft has newlines and a typed Enter
    // would fire a half-written message at a real person.
    await composer.fill(body);
    await pause(700, 1600);

    const sendButton = await firstVisible(
      page,
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
