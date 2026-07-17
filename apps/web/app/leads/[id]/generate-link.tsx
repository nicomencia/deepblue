"use client";

/**
 * The Generar button navigates to ?sugerir=1 and the server may spend a few
 * seconds drafting (Haiku call). useLinkStatus gives the pending state of
 * that navigation, so the user sees the work instead of a dead button.
 */

import Link, { useLinkStatus } from "next/link";
import type { CSSProperties } from "react";

function PendingLabel({ label }: { label: string }) {
  const { pending } = useLinkStatus();
  return <>{pending ? "⏳ Generando…" : label}</>;
}

export function GenerateLink({
  href,
  label,
  style,
}: {
  href: string;
  label: string;
  style?: CSSProperties;
}) {
  return (
    <Link href={href} scroll={false} style={style}>
      <PendingLabel label={label} />
    </Link>
  );
}
