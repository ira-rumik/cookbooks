import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Silk voice agent — Next.js",
  description: "Talk to a Rumik Silk voice agent over WebRTC from a Next.js app.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
