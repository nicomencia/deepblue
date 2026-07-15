"use client";

/**
 * Submit button that demands a confirm() before letting the form fire —
 * deletion is the one action on this page with no undo.
 */
export function ConfirmDelete({
  message,
  style,
}: {
  message: string;
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
      Eliminar
    </button>
  );
}
