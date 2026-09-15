import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { ThemeProvider } from "@/components/ThemeProvider";

export const metadata: Metadata = {
  title: "Take One Studio — AI Cinema Engine",
  description: "Agentic Director's Cut | End-to-end AI Film & TV Production Pipeline",
};

// Set <html data-theme> from the saved preference BEFORE first paint (no flash).
const themeInitScript = `(function(){try{
  var raw = localStorage.getItem('takeone-theme');
  var t = raw ? (JSON.parse(raw).state||{}).theme : 'dark';
  var r = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : (t || 'dark');
  document.documentElement.setAttribute('data-theme', r);
}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="h-full overflow-hidden bg-bg text-text-primary antialiased">
        <ThemeProvider />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
