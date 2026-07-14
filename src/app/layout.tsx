import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
});

export const metadata: Metadata = {
  title: "كافيه أوبس — إدارة الكافيهات",
  description: "منصة إدارة الكافيهات والمطاعم متعددة الفروع",
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
      className={`${cairo.variable} h-full antialiased`}
    >
      <body
        className="min-h-full flex flex-col"
        style={{ fontFamily: "var(--font-cairo), system-ui, sans-serif" }}
      >
        {children}
        <Toaster richColors position="top-center" dir="rtl" />
      </body>
    </html>
  );
}
