"use client";

import { useActionState, useEffect, useRef } from "react";
import type { ActionResult } from "../lib/action-result";

/** What the user had typed, so a rejected submit can hand it back. */
type Typed = Record<string, string[]>;

/**
 * Server-action form that answers "did that work?".
 *
 * `SubmitButton` already says "working…" while the action runs, but on a fast
 * action (an insert) the pending label flickers and is gone, and the thing that
 * changed — a new card appended below a tall form — renders off-screen. The
 * click reads as dead. So the outcome is stated next to the button that caused
 * it, and on success the form is cleared: fields keeping their values after a
 * successful create is what invites the accidental duplicate.
 *
 * The values are put back by hand when the action rejects the submit, because
 * React 19 resets an uncontrolled form after *any* action completes — verified
 * live 2026-07-27, a mistyped budget wiped three filled textareas. Losing a
 * long form to a typo is a worse dead end than the missing feedback this
 * component exists to fix.
 *
 * The fields stay server-rendered — they come in as children.
 */
export function ActionForm({
  action,
  children,
  style,
  resetOnSuccess = true,
}: {
  action: (prev: ActionResult, formData: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  style?: React.CSSProperties;
  resetOnSuccess?: boolean;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const typed = useRef<Typed>({});

  const [state, formAction] = useActionState(
    async (prev: ActionResult, formData: FormData): Promise<ActionResult> => {
      const snapshot: Typed = {};
      for (const [key, value] of formData.entries()) {
        if (typeof value === "string") (snapshot[key] ??= []).push(value);
      }
      typed.current = snapshot;
      return action(prev, formData);
    },
    null,
  );

  useEffect(() => {
    const form = ref.current;
    if (!form || !state) return;
    if (state.ok) {
      if (resetOnSuccess) form.reset();
      return;
    }
    // Rejected: undo React's automatic reset. Absent from the snapshot means
    // genuinely unchecked, so checkboxes are set from membership, not truthiness.
    for (const el of Array.from(form.elements)) {
      const field = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const values = typed.current[field.name];
      if (!field.name || !values) {
        if (field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio")) {
          field.checked = false;
        }
        continue;
      }
      if (field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio")) {
        field.checked = values.includes(field.value);
      } else if (values[0] !== undefined) {
        field.value = values[0];
      }
    }
  }, [state, resetOnSuccess]);

  return (
    <form ref={ref} action={formAction} style={style}>
      {children}
      {state && (
        <p
          // Errors interrupt, confirmations don't: a screen reader should not
          // lose what it is reading to be told something worked.
          role={state.ok ? "status" : "alert"}
          style={{
            margin: 0,
            fontSize: "0.85rem",
            fontWeight: 600,
            color: state.ok ? "var(--grade-a)" : "var(--grade-e)",
          }}
        >
          {state.ok ? `✓ ${state.message}` : `✗ ${state.error}`}
        </p>
      )}
    </form>
  );
}
