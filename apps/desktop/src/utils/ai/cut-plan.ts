import { PAD_MIN, PAD_TARGET } from "./snapping";
import {
	buildSpeechMap,
	nextSpeechStart,
	previousSpeechEnd,
	type SpeechMap,
	speechContaining,
} from "./speech";
import { createRecordingLayout, type TimeRange } from "./timebase";
import {
	type ActivitySpan,
	activeSpans,
	buildVisualMap,
	subtractActivity,
	type VisualMap,
} from "./visual";

export const MIN_CUT_PART_SECONDS = 0.25;
const ACTIVITY_MARGIN_SECONDS = 0.1;

export type CutPlan = {
	parts: TimeRange[];
	keptActivity: ActivitySpan[];
	skipped: TimeRange[];
};

function fixEdges(
	part: TimeRange,
	requested: TimeRange,
	speech: SpeechMap,
): TimeRange {
	let { start, end } = part;
	if (start > requested.start + 1e-6) {
		start += ACTIVITY_MARGIN_SECONDS;
		const inside = speechContaining(speech, start);
		if (inside) start = inside.end + PAD_TARGET;
		else {
			const prev = previousSpeechEnd(speech, start);
			if (prev !== null && start - prev < PAD_MIN) start = prev + PAD_TARGET;
		}
	}
	if (end < requested.end - 1e-6) {
		end -= ACTIVITY_MARGIN_SECONDS;
		const inside = speechContaining(speech, end);
		if (inside) end = inside.start - PAD_TARGET;
		else {
			const next = nextSpeechStart(speech, end);
			if (next !== null && next - end < PAD_MIN) end = next - PAD_TARGET;
		}
	}
	return { start, end };
}

export function planCut(input: {
	range: TimeRange;
	speech: SpeechMap;
	visual: VisualMap;
	allowActivity: boolean;
	minPart?: number;
}): CutPlan {
	const minPart = input.minPart ?? MIN_CUT_PART_SECONDS;
	const keptActivity = input.allowActivity
		? []
		: activeSpans(input.visual, input.range.start, input.range.end);
	if (keptActivity.length === 0) {
		return { parts: [{ ...input.range }], keptActivity: [], skipped: [] };
	}
	const parts: TimeRange[] = [];
	const skipped: TimeRange[] = [];
	for (const free of subtractActivity(input.visual, input.range)) {
		const fixed = fixEdges(free, input.range, input.speech);
		if (fixed.end - fixed.start >= minPart) parts.push(fixed);
		else if (free.end - free.start > 1e-6) skipped.push(free);
	}
	return { parts, keptActivity, skipped };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;
	const layout = createRecordingLayout([60]);
	const speech = buildSpeechMap({
		base: {
			source: "voice activity",
			intervals: [
				{ start: 0, end: 2 },
				{ start: 11, end: 13 },
				{ start: 30, end: 32 },
			],
			note: "",
		},
		words: [],
		firstSentence: { start: 0, end: 2 },
	});
	const visual = buildVisualMap({
		layout,
		data: {
			resolution_ms: 100,
			regions: [
				{
					segment_index: 0,
					start: 5,
					end: 6,
					cursor_moving: true,
					clicked: false,
					screen_changing: false,
				},
				{
					segment_index: 0,
					start: 12.5,
					end: 14,
					cursor_moving: true,
					clicked: false,
					screen_changing: false,
				},
			],
		},
		storyRuns: null,
		clicks: [],
	});

	describe("planCut", () => {
		it("cuts the whole range when it is idle", () => {
			expect(
				planCut({
					range: { start: 20, end: 29.8 },
					speech,
					visual,
					allowActivity: false,
				}).parts,
			).toEqual([{ start: 20, end: 29.8 }]);
		});

		it("splits around activity and keeps a margin", () => {
			const plan = planCut({
				range: { start: 2.2, end: 10.8 },
				speech,
				visual,
				allowActivity: false,
			});
			expect(plan.parts).toEqual([
				{ start: 2.2, end: 4.9 },
				{ start: 6.1, end: 10.8 },
			]);
			expect(plan.keptActivity).toHaveLength(1);
		});

		it("does not cut into speech next to activity", () => {
			const plan = planCut({
				range: { start: 13.2, end: 29.8 },
				speech,
				visual,
				allowActivity: false,
			});
			expect(plan.parts).toEqual([{ start: 14.1, end: 29.8 }]);
		});

		it("cuts everything when activity is allowed", () => {
			expect(
				planCut({
					range: { start: 2.2, end: 10.8 },
					speech,
					visual,
					allowActivity: true,
				}).parts,
			).toEqual([{ start: 2.2, end: 10.8 }]);
		});
	});
}
