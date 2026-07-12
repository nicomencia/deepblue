"use client";

import { useFormStatus } from "react-dom";

/** Submit button with pending feedback — the only client island on the page. */
export function AdoptSubmit({ style }: { style?: React.CSSProperties }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} style={{ ...style, opacity: pending ? 0.6 : 1 }}>
      {pending ? "Adoptando…" : "Adoptar"}
    </button>
  );
}
