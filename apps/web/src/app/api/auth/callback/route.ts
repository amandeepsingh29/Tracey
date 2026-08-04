import { NextRequest, NextResponse } from "next/server";
import {
  LOGIN_ATTEMPT_COOKIE,
  exchangeAuthorizationCode,
  seal,
  setSessionCookie,
  webAuthConfig,
} from "../../../../server/oidc";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const config = webAuthConfig();
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const attempt = request.cookies.get(LOGIN_ATTEMPT_COOKIE)?.value;
  if (config.mode !== "oidc" || !code || !state || !attempt || request.nextUrl.searchParams.has("error")) {
    return NextResponse.json({ error: "OIDC callback is incomplete or was rejected" }, { status: 400 });
  }
  try {
    const result = await exchangeAuthorizationCode(code, attempt, state, config);
    const response = NextResponse.redirect(new URL(result.returnTo, config.publicUrl ?? request.nextUrl.origin));
    setSessionCookie(response, request, config, await seal(result.session, config.sessionSecret!), result.session);
    response.cookies.delete(LOGIN_ATTEMPT_COOKIE);
    return response;
  } catch {
    return NextResponse.json({ error: "OIDC callback validation failed" }, { status: 401 });
  }
}
