import { NextResponse, type NextRequest } from "next/server";

/**
 * Convenience redirect only: sends visitors without a session cookie to the
 * login page. It is NOT a security boundary - every API route authenticates
 * and authorises on its own (see src/server/http/router.ts).
 */
const PUBLIC_PREFIXES = ["/login", "/forgot-password", "/auth/", "/m/", "/invoice/", "/verify/", "/sw.js", "/offline.html", "/manifest.webmanifest", "/icons/"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) return NextResponse.next();
  if (!req.cookies.get("saf_session")) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|webmanifest)$).*)"],
};
