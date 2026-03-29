import type { Metadata } from "next";
import { ScreenRecordWindowsPage } from "@/components/pages/seo/ScreenRecordWindowsPage";

export const metadata: Metadata = {
	title: "Best Screen Recorder for Windows: Easy, Powerful & Free (2025)",
	description:
		"Cap is the best screen recorder for Windows, offering HD quality recording, unlimited free usage, and seamless sharing. A perfect OBS alternative for tutorials, presentations, and more.",
	openGraph: {
		title: "Best Screen Recorder for Windows: Easy, Powerful & Free (2025)",
		description:
			"Cap is the best screen recorder for Windows, offering HD quality recording, unlimited free usage, and seamless sharing. A perfect OBS alternative for tutorials, presentations, and more.",
		url: "https://sparkvideo.cc/screen-recorder-windows",
		siteName: "SparkVideo",
		images: [
			{
				url: "https://sparkvideo.cc/og.png",
				width: 1200,
				height: 630,
				alt: "SparkVideo: Best Screen Recorder for Windows",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Best Screen Recorder for Windows | SparkVideo",
		description:
			"Cap is the best screen recorder for Windows, offering HD quality recording, unlimited free usage, and seamless sharing. A perfect OBS alternative for tutorials, presentations, and more.",
		images: ["https://sparkvideo.cc/og.png"],
	},
};

export default function Page() {
	return <ScreenRecordWindowsPage />;
}
