import { NextRequest, NextResponse } from "next/server";
import {
  accessTokenForRequest,
  setSessionCookie,
  webAuthConfig,
} from "../../../../server/oidc";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const config = webAuthConfig();
  if (config.mode === "local") return NextResponse.json({ authenticated: true, mode: "local" });
  try {
    const auth = await accessTokenForRequest(request, config);
    if (!auth.session) return NextResponse.json({ authenticated: false, mode: "oidc" }, { status: 401 });
    const response = NextResponse.json({
      authenticated: true,
      mode: "oidc",
      user: {
        subject: auth.session.subject,
        name: auth.session.name,
        email: auth.session.email,
        tenantId: auth.session.tenantId,
        roles: auth.session.roles,
      },
    });
    if (auth.rotatedCookie) setSessionCookie(response, request, config, auth.rotatedCookie, auth.session);
    return response;
  } catch {
    return NextResponse.json({ authenticated: false, mode: "oidc" }, { status: 401 });
  }
}
