import {
	type CaptionSegment,
	type CaptionWord,
	commands,
	type SpeechActivity,
} from "~/utils/tauri";
import {
	analyzeAudioLevels,
	quietMask,
	WAVEFORM_STEP_SECONDS,
} from "./audio-levels";
import {
	createRecordingLayout,
	mergeRanges,
	type RecordingLayout,
	segmentToSource,
	type TimeRange,
} from "./timebase";

export type { CaptionWord } from "~/utils/tauri";

export type SpeechSource = "voice activity" | "audio level" | "none";

export type SpeechBase = {
	source: SpeechSource;
	intervals: TimeRange[];
	note: string;
};

export type SpeechMap = {
	source: SpeechSource;
	strict: boolean;
	intervals: TimeRange[];
	firstSentence: TimeRange | null;
	note: string;
};

const MIN_GAP_SECONDS = 0.12;
const EPSILON = 1e-6;

function validWord(word: CaptionWord) {
	return (
		typeof word.text === "string" &&
		Number.isFinite(word.start) &&
		Number.isFinite(word.end) &&
		word.end >= word.start
	);
}

export function readCaptionWords(
	segment: Pick<CaptionSegment, "words">,
): CaptionWord[] {
	return (segment.words ?? [])
		.filter(validWord)
		.map((w) => ({ text: w.text, start: w.start, end: w.end }))
		.sort((a, b) => a.start - b.start);
}

export async function loadSpeechActivity(
	projectPath: string,
): Promise<SpeechActivity | null> {
	try {
		return await commands.getSpeechActivity(projectPath);
	} catch {
		return null;
	}
}

export function speechBaseFromActivity(
	layout: RecordingLayout,
	activity: SpeechActivity,
): SpeechBase {
	const intervals = activity.regions
		.filter((r) => r.segment_index < layout.durations.length && r.end > r.start)
		.map((r) => ({
			start: segmentToSource(layout, r.segment_index, Math.max(0, r.start)),
			end: segmentToSource(
				layout,
				r.segment_index,
				Math.min(r.end, layout.durations[r.segment_index]),
			),
		}));
	return {
		source: "voice activity",
		intervals: bridgeTinyGaps(intervals),
		note: `voice activity detection (${activity.frame_ms} ms frames, noise floor ${activity.noise_floor_db.toFixed(0)} dBFS, speech about ${activity.speech_db.toFixed(0)} dBFS)`,
	};
}

export function speechBaseFromWaveforms(
	layout: RecordingLayout,
	micWaveforms: number[][] | undefined,
	systemWaveforms: number[][] | undefined,
): SpeechBase {
	const intervals: TimeRange[] = [];
	let any = false;
	for (let i = 0; i < layout.durations.length; i++) {
		const mic = micWaveforms?.[i] ?? [];
		const waveform = mic.length > 0 ? mic : (systemWaveforms?.[i] ?? []);
		if (waveform.length === 0) continue;
		const levels = analyzeAudioLevels(waveform);
		if (levels.kind !== "ok") continue;
		any = true;
		const quiet = quietMask(waveform, levels.threshold);
		let runStart: number | null = null;
		for (let f = 0; f <= quiet.length; f++) {
			const loud = f < quiet.length && !quiet[f];
			if (loud && runStart === null) runStart = f;
			if (!loud && runStart !== null) {
				const start = runStart * WAVEFORM_STEP_SECONDS;
				const end = Math.min(f * WAVEFORM_STEP_SECONDS, layout.durations[i]);
				if (end > start) {
					intervals.push({
						start: segmentToSource(layout, i, start),
						end: segmentToSource(layout, i, end),
					});
				}
				runStart = null;
			}
		}
	}
	if (!any) {
		return {
			source: "none",
			intervals: [],
			note: "no usable audio level, so speech could not be located",
		};
	}
	return {
		source: "audio level",
		intervals: bridgeTinyGaps(intervals),
		note: "audio level in 100 ms steps (no voice detection, so keyboard or click noise may count as speech)",
	};
}

export function bridgeTinyGaps(ranges: TimeRange[]): TimeRange[] {
	const merged = mergeRanges(ranges);
	const result: TimeRange[] = [];
	for (const range of merged) {
		const last = result[result.length - 1];
		if (last && range.start - last.end < MIN_GAP_SECONDS) {
			last.end = Math.max(last.end, range.end);
		} else {
			result.push({ ...range });
		}
	}
	return result;
}

export function buildSpeechMap(input: {
	base: SpeechBase;
	words: TimeRange[];
	firstSentence: TimeRange | null;
}): SpeechMap {
	const intervals = bridgeTinyGaps([
		...input.base.intervals,
		...input.words,
		...(input.firstSentence ? [input.firstSentence] : []),
	]);
	const hasWords = input.words.length > 0;
	const source: SpeechSource =
		input.base.source === "none" && hasWords
			? "voice activity"
			: input.base.source;
	return {
		source,
		strict: input.base.source === "voice activity" || hasWords,
		intervals,
		firstSentence: input.firstSentence,
		note: hasWords
			? `${input.base.note}, plus word timings from the transcript`
			: input.base.note,
	};
}

export function speechContaining(
	map: SpeechMap,
	t: number,
): TimeRange | undefined {
	return map.intervals.find(
		(r) => t > r.start + EPSILON && t < r.end - EPSILON,
	);
}

export function speechOverlapping(
	map: SpeechMap,
	start: number,
	end: number,
): TimeRange[] {
	return map.intervals.filter((r) => r.end > start && r.start < end);
}

export function speechSecondsIn(
	map: SpeechMap,
	start: number,
	end: number,
): number {
	let total = 0;
	for (const r of speechOverlapping(map, start, end)) {
		total += Math.min(end, r.end) - Math.max(start, r.start);
	}
	return Math.max(0, total);
}

export function previousSpeechEnd(map: SpeechMap, t: number): number | null {
	let result: number | null = null;
	for (const r of map.intervals) {
		if (r.end <= t + EPSILON) result = r.end;
		else break;
	}
	return result;
}

export function nextSpeechStart(map: SpeechMap, t: number): number | null {
	for (const r of map.intervals) {
		if (r.start >= t - EPSILON) return r.start;
	}
	return null;
}

export function speechGaps(
	map: SpeechMap,
	layout: RecordingLayout,
	minGap: number,
): TimeRange[] {
	const gaps: TimeRange[] = [];
	for (let i = 0; i < layout.durations.length; i++) {
		const segStart = layout.offsets[i];
		const segEnd = segStart + layout.durations[i];
		let cursor = segStart;
		for (const r of map.intervals) {
			if (r.end <= segStart || r.start >= segEnd) continue;
			if (r.start - cursor >= minGap)
				gaps.push({ start: cursor, end: r.start });
			cursor = Math.max(cursor, r.end);
		}
		if (segEnd - cursor >= minGap) gaps.push({ start: cursor, end: segEnd });
	}
	return gaps;
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("speech map", () => {
		const layout = createRecordingLayout([20]);
		const map = buildSpeechMap({
			base: {
				source: "voice activity",
				intervals: [
					{ start: 1, end: 3 },
					{ start: 3.05, end: 4 },
					{ start: 8, end: 10 },
				],
				note: "",
			},
			words: [{ start: 12, end: 12.4 }],
			firstSentence: { start: 1, end: 4.5 },
		});

		it("bridges tiny gaps and includes words and the first sentence", () => {
			expect(map.intervals).toEqual([
				{ start: 1, end: 4.5 },
				{ start: 8, end: 10 },
				{ start: 12, end: 12.4 },
			]);
			expect(map.strict).toBe(true);
		});

		it("finds gaps and neighbours", () => {
			expect(speechGaps(map, layout, 0.5)).toEqual([
				{ start: 0, end: 1 },
				{ start: 4.5, end: 8 },
				{ start: 10, end: 12 },
				{ start: 12.4, end: 20 },
			]);
			expect(previousSpeechEnd(map, 6)).toBe(4.5);
			expect(nextSpeechStart(map, 6)).toBe(8);
			expect(speechContaining(map, 9)?.start).toBe(8);
			expect(speechSecondsIn(map, 9, 13)).toBeCloseTo(1.4);
		});

		it("reads caption word timings in order and tolerates missing words", () => {
			expect(
				readCaptionWords({
					words: [
						{ text: "b", start: 2, end: 2.5 },
						{ text: "a", start: 1, end: 1.5 },
						{ text: "x", start: 3, end: 2 },
					],
				}),
			).toEqual([
				{ text: "a", start: 1, end: 1.5 },
				{ text: "b", start: 2, end: 2.5 },
			]);
			expect(readCaptionWords({})).toEqual([]);
		});
	});
}
