import type { Metadata } from "next";
import { ScreenRecordMacPage } from "@/components/pages/seo/ScreenRecordMacPage";

export const metadata: Metadata = {
	title: "Best Screen Recorder for Mac | High-Quality, Free & Easy (2025)",
	description:
		"Cap is the best free screen recorder for Mac, offering HD quality, unlimited recording, and easy export. Ideal for tutorials, presentations, and educational videos.",
	openGraph: {
		title: "Best Screen Recorder for Mac | High-Quality, Free & Easy (2025)",
		description:
			"Cap is the best free screen recorder for Mac, offering HD quality, unlimited recording, and easy export. Ideal for tutorials, presentations, and educational videos.",
		url: "https://taple.app/screen-recorder-mac",
		siteName: "Taple",
		images: [
			{
				url: "https://taple.app/og.png",
				width: 1200,
				height: 630,
				alt: "Taple: Best Screen Recorder for Mac",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Best Screen Recorder for Mac | Taple",
		description:
			"Cap is the best free screen recorder for Mac, offering HD quality, unlimited recording, and easy export. Ideal for tutorials, presentations, and educational videos.",
		images: ["https://taple.app/og.png"],
	},
};

export default function Page() {
	return <ScreenRecordMacPage />;
}
