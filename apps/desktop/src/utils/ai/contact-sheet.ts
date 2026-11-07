export const CONTACT_SHEET_WIDTH = 1280;
export const MAX_SHEET_FRAMES = 9;
const CELL_GAP = 4;
const JPEG_QUALITY = 0.82;

export type SheetFrame = { label: string; data: string };

export type SheetLayout = {
	columns: number;
	rows: number;
	cellWidth: number;
	cellHeight: number;
	width: number;
	height: number;
};

export function sheetColumns(count: number): number {
	if (count <= 1) return 1;
	if (count <= 4) return 2;
	return 3;
}

export function frameFetchWidth(count: number): number {
	if (count <= 1) return CONTACT_SHEET_WIDTH;
	if (count <= 4) return 640;
	return 480;
}

export function contactSheetLayout(
	count: number,
	aspect: number,
	width = CONTACT_SHEET_WIDTH,
): SheetLayout {
	const columns = sheetColumns(count);
	const rows = Math.max(1, Math.ceil(count / columns));
	const cellWidth = Math.floor((width - CELL_GAP * (columns - 1)) / columns);
	const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 9 / 16;
	const cellHeight = Math.max(1, Math.round(cellWidth * safeAspect));
	return {
		columns,
		rows,
		cellWidth,
		cellHeight,
		width,
		height: rows * cellHeight + CELL_GAP * (rows - 1),
	};
}

async function loadImage(base64: string): Promise<HTMLImageElement> {
	const image = new Image();
	image.src = `data:image/jpeg;base64,${base64}`;
	await image.decode();
	return image;
}

function drawLabel(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	size: number,
) {
	ctx.font = `600 ${size}px -apple-system, "Helvetica Neue", sans-serif`;
	ctx.textBaseline = "top";
	const padding = Math.round(size * 0.35);
	const width = ctx.measureText(text).width + padding * 2;
	const height = size + padding * 2;
	ctx.fillStyle = "rgba(0, 0, 0, 0.78)";
	ctx.fillRect(x, y, width, height);
	ctx.fillStyle = "#FFD400";
	ctx.fillText(text, x + padding, y + padding);
}

export async function buildContactSheet(
	frames: SheetFrame[],
): Promise<{ data: string; layout: SheetLayout }> {
	if (frames.length === 0 || frames.length > MAX_SHEET_FRAMES) {
		throw new Error(`A contact sheet needs 1 to ${MAX_SHEET_FRAMES} frames.`);
	}
	const images = await Promise.all(frames.map((f) => loadImage(f.data)));
	const first = images[0];
	const layout = contactSheetLayout(
		frames.length,
		first.naturalHeight / Math.max(1, first.naturalWidth),
	);

	const canvas = document.createElement("canvas");
	canvas.width = layout.width;
	canvas.height = layout.height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas 2D is not available.");
	ctx.fillStyle = "#202020";
	ctx.fillRect(0, 0, layout.width, layout.height);
	ctx.imageSmoothingQuality = "high";

	const labelSize = Math.max(14, Math.round(layout.cellWidth / 22));
	images.forEach((image, index) => {
		const column = index % layout.columns;
		const row = Math.floor(index / layout.columns);
		const x = column * (layout.cellWidth + CELL_GAP);
		const y = row * (layout.cellHeight + CELL_GAP);
		const scale = Math.min(
			layout.cellWidth / Math.max(1, image.naturalWidth),
			layout.cellHeight / Math.max(1, image.naturalHeight),
		);
		const w = image.naturalWidth * scale;
		const h = image.naturalHeight * scale;
		ctx.drawImage(
			image,
			x + (layout.cellWidth - w) / 2,
			y + (layout.cellHeight - h) / 2,
			w,
			h,
		);
		drawLabel(ctx, frames[index].label, x + 6, y + 6, labelSize);
	});

	const url = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
	const data = url.slice(url.indexOf(",") + 1);
	if (!data) throw new Error("Could not encode the contact sheet.");
	return { data, layout };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("contactSheetLayout", () => {
		it("lays out up to 9 frames within 1280 px", () => {
			expect(contactSheetLayout(1, 0.5)).toMatchObject({
				columns: 1,
				rows: 1,
				cellWidth: 1280,
				height: 640,
			});
			expect(contactSheetLayout(4, 0.625)).toMatchObject({
				columns: 2,
				rows: 2,
				cellWidth: 638,
				height: 2 * 399 + 4,
			});
			const nine = contactSheetLayout(9, 0.625);
			expect(nine.columns).toBe(3);
			expect(nine.rows).toBe(3);
			expect(nine.cellWidth * 3 + 8).toBeLessThanOrEqual(1280);
			expect(contactSheetLayout(5, 0.625).rows).toBe(2);
		});

		it("fetches smaller frames for bigger sheets", () => {
			expect(frameFetchWidth(1)).toBe(1280);
			expect(frameFetchWidth(3)).toBe(640);
			expect(frameFetchWidth(9)).toBe(480);
		});
	});
}
