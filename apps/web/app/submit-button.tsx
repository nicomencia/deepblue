"use client";

import { useFormStatus } from "react-dom";

/**
 * Submit button for server-action forms — the pending feedback a server
 * component can't give on its own. useFormStatus flips the label and disables
 * the button while the action runs, so slow work (investigar un dossier,
 * crear una búsqueda) reads as work instead of a dead click.
 */
export function SubmitButton({
  label,
  pendingLabel = "⏳ Un momento…",
  style,
  disabled,
}: {
  label: string;
  pendingLabel?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      style={{ ...style, opacity: pending ? 0.6 : 1, cursor: pending ? "wait" : style?.cursor }}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
