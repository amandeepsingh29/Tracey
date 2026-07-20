import type { Metadata } from "next";
import { Suspense, type PropsWithChildren } from "react";
import { Shell } from "../client/components/Shell";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Tracey · Reliability operations", template: "%s · Tracey" },
  description: "Evidence-backed reliability operations for production AI agents.",
};

export default function RootLayout({ children }: PropsWithChildren) {
  return <html lang="en"><body><a className="skip-link" href="#main-content">Skip to content</a><Providers><Shell><Suspense fallback={<div className="loading-state" role="status">Loading Tracey workspace…</div>}>{children}</Suspense></Shell></Providers></body></html>;
}
