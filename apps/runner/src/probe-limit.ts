/**
 * One-off diagnostic: open a chat thread and measure (a) the composer's
 * declared maxlength, (b) the full text of our OUTGOING bubbles as Wallapop
 * actually shows them — to find where a long message was cut.
 * Usage: pnpm --filter @deepblue/runner exec tsx src/probe-limit.ts <itemId>
 */

/// <reference lib="dom" />

import { hasWallapopSession, openWallapopProfile } from "./wallapop-chat.js";

const itemId = process.argv[2];
if (!itemId) throw new Error("uso: tsx src/probe-limit.ts <itemId>");

const context = await openWallapopProfile(
  process.env.BROWSER_PROFILE_DIR ?? ".browser-profile",
  process.env.CHAT_HEADLESS === "1",
);
try {
  if (!(await hasWallapopSession(context))) throw new Error("sin sesión — pnpm runner:login");
  const page = await context.newPage();
  await page.goto(`https://es.wallapop.com/app/chat?itemId=${encodeURIComponent(itemId)}`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.waitForSelector("tsl-chat-bubble, textarea, [contenteditable='true']", {
    timeout: 25_000,
  });
  await new Promise((r) => setTimeout(r, 2500));

  const info = await page.evaluate(() => {
    const composer = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      "textarea, input[placeholder*='mensaje' i], input[placeholder*='chatear' i]",
    );
    const editable = document.querySelector("[contenteditable='true']");
    const outgoing = Array.from(document.querySelectorAll("tsl-chat-bubble"))
      .filter((b) => b.querySelector(".ChatBubble")?.className.includes("ChatBubble--outgoing"))
      .map((b) => (b.querySelector(".ChatBubble__content")?.textContent ?? "").trim());
    return {
      composerTag: composer?.tagName ?? (editable ? "CONTENTEDITABLE" : null),
      maxLength: composer?.maxLength ?? null,
      outgoingLengths: outgoing.map((t) => t.length),
      lastOutgoing: outgoing.at(-1) ?? null,
    };
  });
  console.log(JSON.stringify(info, null, 2));
} finally {
  await context.close();
}
