import type { Metadata } from "next";
import { FreeScreenRecorderPage } from "@/components/pages/seo/FreeScreenRecorderPage";

export const metadata: Metadata = {
	title: "Free Screen Recorder: High-Quality Recording at No Cost",
	description:
		"Cap offers a top-rated, free screen recorder with high-quality video capture, making it perfect for creating tutorials, educational content, and professional demos without any hidden fees.",
	openGraph: {
		title: "Free Screen Recorder: High-Quality Recording at No Cost",
		description:
			"Cap offers a top-rated, free screen recorder with high-quality video capture, making it perfect for creating tutorials, educational content, and professional demos without any hidden fees.",
		url: "https://sparkvideo.cc/free-screen-recorder",
		siteName: "SparkVideo",
		images: [
			{
				url: "https://sparkvideo.cc/og.png",
				width: 1200,
				height: 630,
				alt: "SparkVideo: Free Screen Recorder",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Free Screen Recorder: High-Quality Recording at No Cost",
		description:
			"Cap offers a top-rated, free screen recorder with high-quality video capture, making it perfect for creating tutorials, educational content, and professional demos without any hidden fees.",
		images: ["https://sparkvideo.cc/og.png"],
	},
};

export default function Page() {
	return <FreeScreenRecorderPage />;
}
