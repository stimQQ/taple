import { Octokit } from "@octokit/rest";

const octokit = new Octokit();

export const runtime = "edge";

export async function GET(
	req: Request,
	props: RouteContext<"/api/releases/tauri/[version]/[target]/[arch]">,
) {
	const { target, arch } = await props.params;

	try {
		const owner = process.env.GITHUB_UPDATE_OWNER ?? "capsoftware";
		const repo = process.env.GITHUB_UPDATE_REPO ?? "cap";

		const { data: release } = await octokit.repos.getLatestRelease({
			owner,
			repo,
		});

		const version = release.tag_name.replace(/^[a-z-]*v/i, "");
		const notes = release.body;
		const pub_date = release.published_at
			? new Date(release.published_at).toISOString()
			: null;

		const asset = release.assets.find((a) => {
			const name = a.name.toLowerCase();
			if (name.endsWith(".sig")) return false;

			if (target === "darwin") {
				if (!name.includes(".app.tar.gz")) return false;
			} else if (target === "windows") {
				if (!name.endsWith(".nsis.zip") && !name.endsWith(".msi.zip"))
					return false;
			} else if (target === "linux") {
				if (!name.includes(".appimage.tar.gz")) return false;
			} else {
				return false;
			}

			return name.includes(arch.toLowerCase());
		});

		if (!asset) {
			return new Response(null, { status: 204 });
		}

		const signatureAsset = release.assets.find(
			({ name }) => name === `${asset.name}.sig`,
		);

		if (!signatureAsset) {
			return new Response(null, { status: 204 });
		}

		const signature = await fetch(signatureAsset.browser_download_url).then(
			(r) => r.text(),
		);

		return Response.json(
			{ version, notes, pub_date, url: asset.browser_download_url, signature },
			{ status: 200 },
		);
	} catch (error) {
		console.error("Error fetching latest release:", error);
		return Response.json({ error: "Failed to fetch release" }, { status: 400 });
	}
}
