import { buildEnv, serverEnv } from "@cap/env";
import { type NextRequest, NextResponse } from "next/server";

export async function middleware(request: NextRequest) {
	const url = new URL(request.url);
	const path = url.pathname;

	if (path.startsWith("/login")) {
		const response = NextResponse.next();
		response.headers.set("X-Frame-Options", "SAMEORIGIN");
		response.headers.set(
			"Content-Security-Policy",
			"frame-ancestors https://sparkvideo.cc",
		);
		return response;
	}

	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") {
		if (
			!(
				path.startsWith("/s/") ||
				path.startsWith("/middleware") ||
				path.startsWith("/dashboard") ||
				path.startsWith("/onboarding") ||
				path.startsWith("/api") ||
				path.startsWith("/login") ||
				path.startsWith("/signup") ||
				path.startsWith("/invite") ||
				path.startsWith("/self-hosting") ||
				path.startsWith("/terms") ||
				path.startsWith("/verify-otp")
			) &&
			process.env.NODE_ENV !== "development"
		)
			return NextResponse.redirect(new URL("/login", url.origin));
		else return NextResponse.next();
	}

	return NextResponse.next();
}

export const config = {
	runtime: "nodejs",
	matcher: [
		/*
		 * Match all request paths except for the ones starting with:
		 * - api (API routes)
		 * - _next/static (static files)
		 * - _next/image (image optimization files)
		 * - favicon.ico, robots.txt, sitemap.xml (static files)
		 */
		"/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
	],
};
