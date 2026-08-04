import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense, type PropsWithChildren } from "react";
import { Shell } from "../client/components/Shell";
import { readSession, SESSION_COOKIE, webAuthConfig } from "../server/oidc";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Tracey · Reliability operations", template: "%s · Tracey" },
  description: "Evidence-backed reliability operations for production AI agents.",
};

export default async function RootLayout({ children }: PropsWithChildren) {
  const authConfig = webAuthConfig();
  const session = authConfig.mode === "oidc"
    ? await readSession((await cookies()).get(SESSION_COOKIE)?.value, authConfig)
    : undefined;
  if (authConfig.mode === "oidc" && !session) redirect("/api/auth/login?returnTo=%2F");
  const user = session ? {
    subject: session.subject,
    ...(session.name ? { name: session.name } : {}),
    ...(session.email ? { email: session.email } : {}),
    roles: session.roles,
  } : undefined;
  return <html lang="en"><body><a className="skip-link" href="#main-content">Skip to content</a><Providers><Shell {...(user ? { user } : {})}><Suspense fallback={<div className="loading-state" role="status">Loading Tracey workspace…</div>}>{children}</Suspense></Shell></Providers></body></html>;
}
