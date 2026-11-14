import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Intersección Inteligente Adaptativa - Dashboard Serial",
  description: "Monitor y control en tiempo real por Web Serial para Arduino Mega 2560",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="antialiased min-h-screen bg-[#090d16] text-slate-100">
        {children}
      </body>
    </html>
  );
}
