import { type NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

export async function GET(
	request: NextRequest,
	props: { params: Promise<{ platform: string }> },
) {
	const params = await props.params;
	const platform = params.platform.toLowerCase();

	const REPO = "stimQQ/taple";
	const BASE = `https://github.com/${REPO}/releases/latest/download`;
	const downloadUrls: Record<string, string> = {
		"apple-intel": `${BASE}/Taple_x86_64.dmg`,
		intel: `${BASE}/Taple_x86_64.dmg`,
		mac: `${BASE}/Taple_aarch64.dmg`,
		macos: `${BASE}/Taple_aarch64.dmg`,
		"apple-silicon": `${BASE}/Taple_aarch64.dmg`,
		aarch64: `${BASE}/Taple_aarch64.dmg`,
		x86_64: `${BASE}/Taple_x86_64.dmg`,
	};

	// Get the download URL for the requested platform
	const downloadUrl = downloadUrls[platform];

	// If the platform is not supported, redirect to the main download page
	if (!downloadUrl) {
		return NextResponse.redirect(new URL("/download", request.url));
	}

	// Redirect to the appropriate download URL
	return NextResponse.redirect(downloadUrl);
}
