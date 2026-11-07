export const RELEASES_PAGE = "https://github.com/stimQQ/taple/releases";

const DROPPED_TAGS = new Set([
	"SCRIPT",
	"STYLE",
	"IFRAME",
	"OBJECT",
	"EMBED",
	"SVG",
	"IMG",
	"PICTURE",
	"VIDEO",
	"AUDIO",
	"SOURCE",
	"FORM",
	"INPUT",
	"BUTTON",
	"TEXTAREA",
	"SELECT",
	"TEMPLATE",
	"LINK",
	"META",
]);

const KEPT_TAGS = new Set([
	"P",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"UL",
	"OL",
	"LI",
	"STRONG",
	"EM",
	"B",
	"I",
	"DEL",
	"CODE",
	"PRE",
	"A",
	"BR",
	"HR",
	"TABLE",
	"THEAD",
	"TBODY",
	"TR",
	"TH",
	"TD",
]);

export const isExternalLink = (href: string | null): href is string =>
	!!href && /^https?:\/\//i.test(href);

function clean(parent: Node) {
	for (const child of Array.from(parent.childNodes)) {
		if (child.nodeType === Node.COMMENT_NODE) {
			child.remove();
			continue;
		}
		if (!(child instanceof Element)) continue;

		const tag = child.tagName.toUpperCase();
		if (DROPPED_TAGS.has(tag)) {
			child.remove();
			continue;
		}

		clean(child);

		const href = child.getAttribute("href");
		if (!KEPT_TAGS.has(tag) || (tag === "A" && !isExternalLink(href))) {
			child.replaceWith(...Array.from(child.childNodes));
			continue;
		}
		for (const name of child.getAttributeNames()) child.removeAttribute(name);
		if (tag === "A" && href) child.setAttribute("href", href);
	}
}

export function sanitizeReleaseHtml(html: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	clean(doc.body);
	return doc.body.innerHTML.trim();
}

const versionParts = (version: string) =>
	version
		.trim()
		.replace(/^v/i, "")
		.split(/[-+]/)[0]
		.split(".")
		.map((part) => Number.parseInt(part, 10) || 0);

export function compareVersions(a: string, b: string): number {
	const left = versionParts(a);
	const right = versionParts(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return Math.sign(diff);
	}
	return 0;
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("compareVersions", () => {
		it("orders versions numerically", () => {
			expect(compareVersions("0.1.1", "0.1.0")).toBe(1);
			expect(compareVersions("v0.2.0", "0.10.0")).toBe(-1);
			expect(compareVersions("v1.0.0", "1.0")).toBe(0);
			expect(compareVersions("0.2.0-beta.1", "0.2.0")).toBe(0);
		});
	});

	describe("isExternalLink", () => {
		it("only accepts web links", () => {
			expect(isExternalLink("https://taple.app")).toBe(true);
			expect(isExternalLink("#changes")).toBe(false);
			expect(isExternalLink("javascript:alert(1)")).toBe(false);
			expect(isExternalLink(null)).toBe(false);
		});
	});
}
