const RELEASES_API =
	"https://api.github.com/repos/stimQQ/taple/releases?per_page=20";
const CACHE_SECONDS = 600;

const json = (body, status, cacheSeconds = 0) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control":
				cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store",
		},
	});

export async function onRequestGet({ request, env, waitUntil }) {
	const key = new Request(new URL("/api/releases", request.url));
	const cached = await caches.default.match(key);
	if (cached) return cached;

	const response = await fetch(RELEASES_API, {
		headers: {
			Accept: "application/vnd.github.html+json",
			"User-Agent": "taple.app",
			"X-GitHub-Api-Version": "2022-11-28",
			...(env.GITHUB_TOKEN
				? { Authorization: `Bearer ${env.GITHUB_TOKEN}` }
				: {}),
		},
	});
	if (!response.ok) {
		console.error(`GitHub answered ${response.status}`);
		return json({ error: "unavailable" }, 502);
	}

	const releases = (await response.json())
		.filter((release) => !release.draft)
		.map((release) => ({
			tag_name: release.tag_name,
			name: release.name,
			published_at: release.published_at,
			body_html: release.body_html ?? "",
			html_url: release.html_url,
			draft: false,
			prerelease: release.prerelease,
		}));

	const result = json(releases, 200, CACHE_SECONDS);
	waitUntil(caches.default.put(key, result.clone()));
	return result;
}
