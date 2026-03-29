import { motion } from "motion/react";
import type { VideoData } from "../types";

interface ToolbarProps {
	data: VideoData;
	disableReactions?: boolean;
}

export const Toolbar = ({ data, disableReactions }: ToolbarProps) => {
	const handleEmojiClick = async (emoji: string) => {
		// Reactions disabled
	};

	const Emoji = ({ label, emoji }: { label: string; emoji: string }) => (
		<motion.div layout className="relative size-10">
			<motion.button
				layout
				className="inline-flex relative justify-center items-center p-1 text-xl leading-6 align-middle bg-transparent rounded-full transition-colors ease-in-out size-full font-emoji sm:text-2xl duration-600 hover:bg-gray-200 active:bg-blue-500 active:duration-0"
				role="img"
				aria-label={label ? label : ""}
				aria-hidden={label ? "false" : "true"}
				onClick={() => handleEmojiClick(emoji)}
			>
				{emoji}
			</motion.button>
		</motion.div>
	);

	if (disableReactions) {
		return null;
	}

	return (
		<motion.div
			layout
			className="flex overflow-hidden p-2 mx-auto max-w-full bg-white rounded-full border border-gray-5 md:max-w-fit"
		>
			<motion.div
				layout
				key="toolbar"
				initial={{ scale: 0.9 }}
				animate={{ scale: 1 }}
				exit={{ scale: 0.9 }}
				transition={{ duration: 0.2, ease: "easeInOut" }}
				className="flex flex-col gap-2 items-center mx-auto w-full md:justify-center sm:grid sm:grid-flow-col md:w-fit min-h-[28px]"
			>
				<div className="flex gap-2 justify-evenly items-center w-full md:w-fit md:justify-center">
					{REACTIONS.map((reaction) => (
						<Emoji
							key={reaction.emoji}
							emoji={reaction.emoji}
							label={reaction.label}
						/>
					))}
				</div>
			</motion.div>
		</motion.div>
	);
};

const REACTIONS = [
	{
		emoji: "😂",
		label: "joy",
	},
	{
		emoji: "😍",
		label: "love",
	},
	{
		emoji: "😮",
		label: "wow",
	},
	{
		emoji: "🙌",
		label: "yay",
	},
	{
		emoji: "👍",
		label: "up",
	},
	{
		emoji: "👎",
		label: "down",
	},
];
