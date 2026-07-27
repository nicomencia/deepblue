/**
 * What a server action tells the user when it finishes.
 *
 * `SubmitButton` covers "something is happening" (pending label, disabled).
 * This covers what a pending label cannot: "it worked, here is what changed"
 * and "it did not work, here is why" — without throwing, because a thrown
 * server action lands on Next's error overlay, which is a dead end for a
 * recoverable mistake like typing "ocho mil" in a number field.
 *
 * Lives outside the "use server" module on purpose: those may only export
 * async functions.
 */
export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string }
  | null;

export const actionOk = (message: string): ActionResult => ({ ok: true, message });
export const actionError = (error: string): ActionResult => ({ ok: false, error });
