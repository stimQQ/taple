import type { CaptionSettings } from "~/utils/tauri";

export const DEFAULT_CAPTION_SETTINGS: CaptionSettings = {
	enabled: true,
	font: "System Sans-Serif",
	size: 40,
	color: "#FFFFFF",
	backgroundColor: "#000000",
	backgroundOpacity: 80,
	position: "bottom",
	bold: true,
	italic: false,
	outline: true,
	outlineColor: "#000000",
	background: false,
	exportWithSubtitles: false,
};

export const HIDDEN_CAPTION_SETTINGS: CaptionSettings = {
	...DEFAULT_CAPTION_SETTINGS,
	enabled: false,
};
