import type { Metadata } from "next";
import { LoomAlternativePage } from "@/components/pages/seo/LoomAlternativePage";

export const metadata: Metadata = {
	title:
		"The Ultimate Loom Alternative: Why Cap is the Best Open-Source Screen Recorder for Mac & Windows",
	description:
		"Looking for the best Loom alternative? Discover Cap, the open-source, privacy-focused screen recorder for Mac & Windows. See why users are switching today!",
	openGraph: {
		title:
			"The Ultimate Loom Alternative: Why Cap is the Best Open-Source Screen Recorder",
		description:
			"Looking for the best Loom alternative? Discover Cap, the open-source, privacy-focused screen recorder for Mac & Windows.",
		url: "https://sparkvideo.cc/loom-alternative",
		siteName: "SparkVideo",
		images: [
			{
				url: "https://sparkvideo.cc/og.png",
				width: 1200,
				height: 630,
				alt: "SparkVideo: The Best Loom Alternative",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "The Ultimate Loom Alternative: Cap Screen Recorder",
		description:
			"Looking for the best Loom alternative? Discover Cap, the open-source, privacy-focused screen recorder for Mac & Windows.",
		images: ["https://sparkvideo.cc/og.png"],
	},
};

export default function Page() {
	return <LoomAlternativePage />;
}
