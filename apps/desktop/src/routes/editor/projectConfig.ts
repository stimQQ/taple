import { L } from "~/utils/i18n";
import type { AspectRatio } from "~/utils/tauri";

export type RGBColor = [number, number, number];

export const DEFAULT_GRADIENT_FROM = [71, 133, 255] satisfies RGBColor;
export const DEFAULT_GRADIENT_TO = [255, 71, 102] satisfies RGBColor;

export const ASPECT_RATIOS = {
	wide: { name: L("宽屏", "Wide"), ratio: [16, 9] },
	vertical: { name: L("竖屏", "Vertical"), ratio: [9, 16] },
	square: { name: L("方形", "Square"), ratio: [1, 1] },
	classic: { name: L("经典", "Classic"), ratio: [4, 3] },
	tall: { name: L("高屏", "Tall"), ratio: [3, 4] },
} satisfies Record<AspectRatio, { name: string; ratio: [number, number] }>;
