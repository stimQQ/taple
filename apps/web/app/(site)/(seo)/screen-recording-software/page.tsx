import type { Metadata } from "next";
import { ScreenRecordingSoftwarePage } from "@/components/pages/seo/ScreenRecordingSoftwarePage";

export const metadata: Metadata = {
	title: "Screen Recording Software: High-Quality, User-Friendly, and Free",
	description:
		"Cap is an all-in-one screen recording software offering high-quality video capture with an intuitive interface. Ideal for creating tutorials, presentations, and educational content, Cap provides everything you need at no cost.",
	openGraph: {
		title: "Screen Recording Software: High-Quality, User-Friendly, and Free",
		description:
			"Cap is an all-in-one screen recording software offering high-quality video capture with an intuitive interface. Ideal for creating tutorials, presentations, and educational content, Cap provides everything you need at no cost.",
		url: "https://sparkvideo.cc/screen-recording-software",
		siteName: "SparkVideo",
		images: [
			{
				url: "https://sparkvideo.cc/og.png",
				width: 1200,
				height: 630,
				alt: "SparkVideo: Screen Recording Software",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Screen Recording Software: High-Quality, User-Friendly, and Free",
		description:
			"Cap is an all-in-one screen recording software offering high-quality video capture with an intuitive interface. Ideal for creating tutorials, presentations, and educational content.",
		images: ["https://sparkvideo.cc/og.png"],
	},
};

export default function Page() {
	return <ScreenRecordingSoftwarePage />;
}
