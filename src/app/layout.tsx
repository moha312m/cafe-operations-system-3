import type { Metadata, Viewport } from "next";
import { Cairo, IBM_Plex_Sans_Arabic } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// Cairo stays loaded, preloaded as before, only because the 80mm payment
// receipt and the shift print page name `--font-cairo` directly; their
// printing is accepted as-is.
const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
});

// The screen font. Self-hosted by next/font at build time, so the app makes
// no runtime request to Google and keeps working offline.
const plexArabic = IBM_Plex_Sans_Arabic({
  variable: "--font-plex-arabic",
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "كافيه أوبس — إدارة الكافيهات",
  description: "منصة إدارة الكافيهات والمطاعم متعددة الفروع",
};

// viewportFit cover lets fixed bottom bars extend into the iPhone home
// indicator area (padded back with env(safe-area-inset-bottom)).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ar"
      dir="rtl"
      className={`${cairo.variable} ${plexArabic.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        {children}
        <Toaster richColors position="top-center" dir="rtl" />
      </body>
    </html>
  );
}
