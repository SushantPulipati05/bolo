import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bolo",
  description: "A rehearsal partner that builds fluency and confidence.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
