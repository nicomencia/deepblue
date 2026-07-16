import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "deepblue",
  description: "Your expert co-pilot for buying a second-hand car",
};

/** Status tokens for confidence grades — dark mode gets selected values, not a flip. */
const tokens = `
:root {
  --grade-a: #1a7f37; --grade-b: #4d8f2f; --grade-c: #9a6700;
  --grade-d: #bc4c00; --grade-e: #cf222e;
  --ink-muted: #656d76; --border: #8884; --card: #8881;
  --track: #8883;
  /* Chat bubbles: ours blue-tinted, the seller's neutral — alpha keeps both themes honest. */
  --chat-out: #388bfd1a; --chat-out-border: #388bfd55;
  --chat-in: #8881; --chat-in-border: #8884;
}
@media (prefers-color-scheme: dark) {
  :root {
    --grade-a: #3fb950; --grade-b: #8ac926; --grade-c: #d4a72c;
    --grade-d: #f0883e; --grade-e: #ff7b72;
    --ink-muted: #9198a1; --card: #ffffff0d;
  }
}
a { color: inherit; }
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, sans-serif",
          colorScheme: "light dark",
        }}
      >
        <style>{tokens}</style>
        <header
          style={{
            display: "flex",
            gap: "1.5rem",
            alignItems: "baseline",
            padding: "0.9rem 1.5rem",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <Link href="/" style={{ fontWeight: 700, textDecoration: "none" }}>
            deepblue
          </Link>
          <nav style={{ display: "flex", gap: "1rem", fontSize: "0.9rem" }}>
            <Link href="/" style={{ textDecoration: "none", opacity: 0.85 }}>
              Leads
            </Link>
            <Link href="/briefs" style={{ textDecoration: "none", opacity: 0.85 }}>
              Búsquedas
            </Link>
            <Link href="/discovery" style={{ textDecoration: "none", opacity: 0.85 }}>
              Descubrir
            </Link>
            <Link href="/dossiers" style={{ textDecoration: "none", opacity: 0.85 }}>
              Dossiers
            </Link>
            <Link href="/activity" style={{ textDecoration: "none", opacity: 0.85 }}>
              Actividad
            </Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
