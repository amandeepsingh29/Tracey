import { NextRequest, NextResponse } from "next/server";
import {
  LOGIN_ATTEMPT_COOKIE,
  newLoginAttempt,
  secureCookies,
  webAuthConfig,
} from "../../../../server/oidc";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const config = webAuthConfig();
  if (config.mode !== "oidc") return NextResponse.redirect(new URL("/", request.url));
  try {
    const login = await newLoginAttempt(request, config, request.nextUrl.searchParams.get("returnTo") ?? "/");
    const response = NextResponse.redirect(login.authorizationUrl);
    response.cookies.set(LOGIN_ATTEMPT_COOKIE, login.cookie, {
      httpOnly: true,
      secure: secureCookies(request, config),
      sameSite: "lax",
      path: "/api/auth/callback",
      maxAge: 10 * 60,
    });
    return response;
  } catch {
    return NextResponse.json({ error: "OIDC login could not be started" }, { status: 503 });
  }
}
