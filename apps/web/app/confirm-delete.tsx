"use client";

/**
 * Submit button that demands a confirm() before letting the form fire —
 * deletion is the one action with no undo, so the message should say exactly
 * what disappears and what it costs to get back.
 */
export function ConfirmDelete({
  message,
  label = "Eliminar",
  style,
}: {
  message: string;
  label?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="submit"
      style={style}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {label}
    </button>
  );
}
