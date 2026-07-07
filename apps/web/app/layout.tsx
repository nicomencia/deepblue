import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "deepblue",
  description: "Your expert co-pilot for buying a second-hand car",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, sans-serif",
          colorScheme: "light dark",
        }}
      >
        {children}
      </body>
    </html>
  );
}
