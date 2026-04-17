import type { Metadata } from "next";
import { TopNav } from "@/components/top-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chaos Arena — Pokemon Card AI Trading",
  description:
    "Three AI bots paper-trade Pokemon Mega Evolution cards with sourced reasoning. Vote for the winning bot.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <TopNav />
        {children}
      </body>
    </html>
  );
}
