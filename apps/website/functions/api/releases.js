const RELEASES_API =
	"https://api.github.com/repos/stimQQ/taple/releases?per_page=20";
const RELEASES_FEED = "https://github.com/stimQQ/taple/releases.atom";
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

async function releasesFromApi(env) {
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
	if (!response.ok) throw new Error(`GitHub API answered ${response.status}`);
	return (await response.json())
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
}

const decodeXml = (text) =>
	text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&");

const element = (entry, name) =>
	entry.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "";

export function parseReleasesFeed(feed) {
	return [...feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
		.map(([, entry]) => {
			const url = decodeXml(
				entry.match(/<link\b[^>]*\bhref="([^"]+)"/)?.[1] ?? "",
			);
			const tag = url.split("/releases/tag/")[1];
			return {
				tag_name: tag ? decodeURIComponent(tag) : "",
				name: decodeXml(element(entry, "title")).trim(),
				published_at: element(entry, "updated").trim() || null,
				body_html: decodeXml(element(entry, "content")),
				html_url: url,
				draft: false,
				prerelease: false,
			};
		})
		.filter((release) => release.tag_name);
}

async function releasesFromFeed() {
	const response = await fetch(RELEASES_FEED, {
		headers: { "User-Agent": "taple.app" },
	});
	if (!response.ok) throw new Error(`GitHub feed answered ${response.status}`);
	return parseReleasesFeed(await response.text());
}

export async function onRequestGet({ request, env, waitUntil }) {
	const key = new Request(new URL("/api/releases", request.url));
	const cached = await caches.default.match(key);
	if (cached) return cached;

	let releases;
	try {
		releases = await releasesFromApi(env);
	} catch (apiError) {
		console.error(apiError.message);
		try {
			releases = await releasesFromFeed();
		} catch (feedError) {
			console.error(feedError.message);
			return json({ error: "unavailable" }, 502);
		}
	}

	const result = json(releases, 200, CACHE_SECONDS);
	waitUntil(caches.default.put(key, result.clone()));
	return result;
}
