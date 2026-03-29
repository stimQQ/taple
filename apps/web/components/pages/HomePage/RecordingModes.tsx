"use client";

import { Button } from "@cap/ui";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { Clapperboard } from "lucide-react";
import {
	getDownloadButtonText,
	getDownloadUrl,
	getPlatformIcon,
} from "@/utils/platform";
import { homepageCopy } from "../../../data/homepage-copy";
import UpgradeToPro from "../_components/UpgradeToPro";

const RecordingModes = () => {
	const { platform, isIntel } = useDetectPlatform();
	const loading = platform === null;

	const studioMode = homepageCopy.recordingModes.modes.find(
		(m) => m.name === "Studio Mode"
	);

	return (
		<div className="w-full max-w-[1000px] mx-auto px-5">
			<div className="flex flex-col gap-2 justify-center items-center text-center">
				<h1 className="text-4xl font-medium text-gray-12">
					{homepageCopy.recordingModes.title}
				</h1>
				<p className="text-lg text-gray-10 w-full max-w-[670px] mx-auto">
					{homepageCopy.recordingModes.subtitle}
				</p>
			</div>
			{/* Studio Mode Header */}
			<div className="flex justify-center mt-[52px]">
				<div className="flex overflow-hidden relative flex-1 max-w-md gap-3 justify-center items-center px-6 py-4 text-lg md:text-2xl font-medium rounded-2xl border bg-blue-2 border-blue-6 text-blue-12">
					<div className="flex gap-1.5 z-[2] items-center">
						<Clapperboard
							fill="var(--blue-9)"
							className="size-5 md:size-6"
							strokeWidth={1.5}
						/>
						Studio Mode
					</div>
				</div>
			</div>
			{/* Video */}
			<div className="mt-5 w-full rounded-2xl border shadow-xl h-fit bg-gray-1 border-gray-5 shadow-black/5">
				{/* Video Content */}
				<div className="relative h-full">
					<div
						key="studio-mode"
						className="overflow-hidden w-full rounded-t-xl"
						style={{
							position: "relative",
							paddingBottom: "56.25%",
							height: 0,
						}}
					>
						<iframe
							src="https://sparkvideo.cc/embed/qk8gt56e1q1r735"
							frameBorder="0"
							allowFullScreen
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								width: "100%",
								height: "100%",
								borderTopLeftRadius: "0.75rem",
								borderTopRightRadius: "0.75rem",
							}}
						/>
					</div>
				</div>
				{/* Video Description */}
				<div className="p-4 border-t border-b bg-gray-2 border-gray-5">
					<p className="mx-auto w-full text-lg text-center text-gray-12">
						{studioMode?.description}
					</p>
				</div>
				<div className="p-6">
					<div className="flex flex-col items-center space-y-4 sm:flex-row sm:space-y-0 sm:space-x-4 sm:justify-center">
						<Button
							variant="dark"
							href={
								platform === "windows"
									? "/download"
									: getDownloadUrl(platform, isIntel)
							}
							size="lg"
							className="flex justify-center items-center font-medium w-fit"
						>
							{!loading && getPlatformIcon(platform)}
							{getDownloadButtonText(platform, loading, isIntel)}
						</Button>
						<UpgradeToPro text={homepageCopy.header.cta.primaryButton} />
					</div>
				</div>
			</div>
		</div>
	);
};

export default RecordingModes;
