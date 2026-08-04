import { NextRequest, NextResponse } from "next/server";
import {
  clearAuthCookies,
  oidcDiscovery,
  readSession,
  SESSION_COOKIE,
  webAuthConfig,
} from "../../../../server/oidc";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const config = webAuthConfig();
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value, config);
  const localReturn = new URL("/", config.publicUrl ?? request.nextUrl.origin);
  let destination = localReturn;
  if (config.mode === "oidc") {
    try {
      const metadata = await oidcDiscovery(config);
      if (metadata.end_session_endpoint) {
        destination = new URL(metadata.end_session_endpoint);
        destination.searchParams.set("post_logout_redirect_uri", localReturn.toString());
        if (session?.idToken) destination.searchParams.set("id_token_hint", session.idToken);
      }
    } catch {
      destination = localReturn;
    }
  }
  const response = NextResponse.redirect(destination);
  clearAuthCookies(response, request, config);
  return response;
}

export const POST = GET;
