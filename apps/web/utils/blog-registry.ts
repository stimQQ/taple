import type { BlogPost } from "../components/blog/BlogTemplate";

export const INTERACTIVE_BLOG_REGISTRY: Record<string, BlogPost> = {};

export type InteractiveBlogSlug = keyof typeof INTERACTIVE_BLOG_REGISTRY;

export function getInteractiveBlogContent(slug: string) {
	const content = INTERACTIVE_BLOG_REGISTRY[slug as InteractiveBlogSlug];
	if (!content) {
		throw new Error(`No interactive blog content found for slug: ${slug}`);
	}
	return content;
}

export function isInteractiveBlogPost(
	slug: string | number,
): slug is InteractiveBlogSlug {
	return typeof slug === "string" && slug in INTERACTIVE_BLOG_REGISTRY;
}

export function getAllInteractiveBlogPosts() {
	return Object.values(INTERACTIVE_BLOG_REGISTRY);
}
