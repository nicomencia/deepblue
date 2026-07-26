/**
 * One-time interactive login: opens a visible browser on the runner's
 * persistent profile so the user signs into Wallapop by hand. The session
 * cookie lands in the profile dir and every future chat send reuses it —
 * credentials never touch deepblue.
 *
 * Run with: pnpm runner:login
 */

import { setTimeout as sleep } from "node:timers/promises";
import { dismissCookieBanner, hasWallapopSession, openWallapopProfile } from "./wallapop-chat.js";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  const profileDir = process.env.BROWSER_PROFILE_DIR ?? ".browser-profile";
  console.log(`opening Wallapop with persistent profile at ${profileDir} ...`);
  const context = await openWallapopProfile(profileDir, false);

  if (await hasWallapopSession(context)) {
    console.log("✅ ya hay una sesión de Wallapop guardada en este perfil — nada que hacer.");
    await context.close();
    return;
  }

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://es.wallapop.com", { waitUntil: "domcontentloaded" });
  // The consent gate blurs and blocks the whole page until it is answered, so
  // the user cannot reach the login button behind it. Same call every chat
  // send already makes — dismiss it here too, or login is unusable.
  await dismissCookieBanner(page);
  console.log("\nInicia sesión en Wallapop en la ventana abierta (Regístrate o inicia sesión).");
  console.log("Este script detecta la sesión solo y cierra el navegador al terminar.\n");

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let closedByUser = false;
  context.on("close", () => {
    closedByUser = true;
  });

  while (Date.now() < deadline && !closedByUser) {
    await sleep(3000);
    if (await hasWallapopSession(context).catch(() => false)) {
      console.log("✅ sesión de Wallapop detectada y guardada en el perfil. El runner ya puede enviar mensajes.");
      await sleep(1500);
      await context.close();
      return;
    }
  }

  if (closedByUser) {
    console.log(
      "ventana cerrada sin detectar la cookie de sesión — si llegaste a iniciar sesión, " +
        "el perfil puede valer igualmente; pruébalo con un envío.",
    );
    return;
  }
  await context.close();
  throw new Error("tiempo agotado esperando el login (10 min)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
