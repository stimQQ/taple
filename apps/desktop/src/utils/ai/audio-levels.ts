import type { TimeRange } from "./timebase";

export const WAVEFORM_STEP_SECONDS = 0.1;

const DIGITAL_SILENCE_DB = -59.5;
const MIN_DYNAMIC_RANGE_DB = 8;
const MIN_MARGIN_ABOVE_FLOOR_DB = 4;
const MIN_MARGIN_BELOW_SPEECH_DB = 6;
const THRESHOLD_POSITION = 0.3;
const SILENT_TRACK_PEAK_DB = -55;
const MAX_ABSORBED_BLIP_FRAMES = 1;

export type AudioLevels =
	| { kind: "silent"; peak: number }
	| { kind: "flat"; floor: number; speech: number }
	| { kind: "ok"; floor: number; speech: number; threshold: number };

function percentile(sorted: number[], q: number) {
	if (sorted.length === 0) return Number.NaN;
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.round(q * (sorted.length - 1))),
	);
	return sorted[index];
}

export function analyzeAudioLevels(waveform: number[]): AudioLevels {
	const values = waveform
		.map((v) => (Number.isFinite(v) ? Math.max(-60, Math.min(0, v)) : -60))
		.sort((a, b) => a - b);
	if (values.length === 0) return { kind: "silent", peak: -60 };

	const peak = percentile(values, 0.99);
	if (peak < SILENT_TRACK_PEAK_DB) return { kind: "silent", peak };

	const audible = values.filter((v) => v > DIGITAL_SILENCE_DB);
	const floorSource = audible.length >= values.length * 0.2 ? audible : values;
	const floor = percentile(floorSource, 0.15);

	let speech = percentile(values, 0.95);
	if (speech - floor < MIN_DYNAMIC_RANGE_DB) speech = peak;
	if (speech - floor < MIN_DYNAMIC_RANGE_DB) {
		return { kind: "flat", floor, speech };
	}

	const range = speech - floor;
	const threshold = Math.min(
		speech - MIN_MARGIN_BELOW_SPEECH_DB,
		floor + Math.max(MIN_MARGIN_ABOVE_FLOOR_DB, THRESHOLD_POSITION * range),
	);
	return { kind: "ok", floor, speech, threshold };
}

export function quietMask(waveform: number[], threshold: number): boolean[] {
	const quiet = waveform.map((v) => !Number.isFinite(v) || v < threshold);
	let i = 0;
	while (i < quiet.length) {
		if (quiet[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j < quiet.length && !quiet[j]) j++;
		const length = j - i;
		const boundedByQuiet = i > 0 && j < quiet.length;
		if (boundedByQuiet && length <= MAX_ABSORBED_BLIP_FRAMES) {
			for (let k = i; k < j; k++) quiet[k] = true;
		}
		i = j;
	}
	return quiet;
}

export function detectPauses(
	waveform: number[],
	minPauseSeconds: number,
	levels: AudioLevels = analyzeAudioLevels(waveform),
): TimeRange[] {
	if (levels.kind !== "ok") return [];
	const quiet = quietMask(waveform, levels.threshold);
	const ranges: TimeRange[] = [];
	let runStart: number | null = null;
	for (let i = 0; i <= quiet.length; i++) {
		const isQuiet = i < quiet.length && quiet[i];
		if (isQuiet && runStart === null) runStart = i;
		if (!isQuiet && runStart !== null) {
			const start = runStart * WAVEFORM_STEP_SECONDS;
			const end = i * WAVEFORM_STEP_SECONDS;
			if (end - start >= minPauseSeconds - 1e-9) ranges.push({ start, end });
			runStart = null;
		}
	}
	return ranges;
}

export function describeAudioLevels(levels: AudioLevels): string {
	switch (levels.kind) {
		case "silent":
			return `the track is silent (peak ${levels.peak.toFixed(0)} dBFS), so no pauses could be detected`;
		case "flat":
			return `the level barely changes (noise floor ${levels.floor.toFixed(0)} dBFS, loudest ${levels.speech.toFixed(0)} dBFS), so pauses could not be told apart from speech`;
		case "ok":
			return `noise floor ${levels.floor.toFixed(0)} dBFS, speech about ${levels.speech.toFixed(0)} dBFS, pause threshold ${levels.threshold.toFixed(0)} dBFS`;
	}
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	const jitter = (i: number) => Math.sin(i * 12.9898) * 1.5;
	const frames = (count: number, level: number, offset = 0) =>
		Array.from({ length: count }, (_, i) => level + jitter(i + offset));

	describe("analyzeAudioLevels", () => {
		it("adapts the threshold to a quiet microphone", () => {
			const waveform = [
				...frames(40, -57),
				...frames(30, -34, 40),
				...frames(15, -57, 70),
				...frames(30, -31, 85),
				...frames(25, -57, 115),
			];
			waveform[90] = -17.8;
			const levels = analyzeAudioLevels(waveform);
			expect(levels.kind).toBe("ok");
			if (levels.kind !== "ok") return;
			expect(levels.threshold).toBeGreaterThan(-55);
			expect(levels.threshold).toBeLessThan(-40);
		});

		it("reports silent and flat tracks", () => {
			expect(analyzeAudioLevels(frames(100, -59)).kind).toBe("silent");
			expect(analyzeAudioLevels(frames(100, -25)).kind).toBe("flat");
			expect(analyzeAudioLevels([]).kind).toBe("silent");
		});
	});

	describe("detectPauses", () => {
		it("finds pauses in a quiet recording with sparse speech", () => {
			const waveform = [
				...frames(600, -56),
				...frames(40, -32, 600),
				...frames(500, -56, 640),
				...frames(40, -30, 1140),
				...frames(270, -56, 1180),
			];
			waveform[620] = -17.8;
			const pauses = detectPauses(waveform, 0.5);
			expect(pauses).toHaveLength(3);
			expect(pauses[0].start).toBeCloseTo(0);
			expect(pauses[0].end).toBeCloseTo(60);
			expect(pauses[1].start).toBeCloseTo(64);
			expect(pauses[1].end).toBeCloseTo(114);
			expect(pauses[2].start).toBeCloseTo(118);
		});

		it("finds pauses in a normal recording", () => {
			const waveform = [
				...frames(20, -22),
				...frames(15, -50, 20),
				...frames(20, -20, 35),
				...frames(3, -50, 55),
			];
			const pauses = detectPauses(waveform, 0.5);
			expect(pauses).toHaveLength(1);
			expect(pauses[0].start).toBeCloseTo(2);
			expect(pauses[0].end).toBeCloseTo(3.5);
		});

		it("keeps a single click inside a pause from splitting it", () => {
			const waveform = [
				...frames(20, -24),
				...frames(10, -52, 20),
				-28,
				...frames(10, -52, 31),
				...frames(20, -24, 41),
			];
			const pauses = detectPauses(waveform, 0.5);
			expect(pauses).toHaveLength(1);
			expect(pauses[0].end - pauses[0].start).toBeCloseTo(2.1);
		});

		it("returns nothing for silent or flat tracks", () => {
			expect(detectPauses(frames(100, -59.8), 0.5)).toEqual([]);
			expect(detectPauses(frames(100, -20), 0.5)).toEqual([]);
		});
	});
}
