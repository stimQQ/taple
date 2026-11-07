import type { TimelineSegment } from "~/utils/tauri";
import {
	buildClipSpans,
	type ClipSpan,
	createRecordingLayout,
	cutSourceRange,
	type RecordingLayout,
	segmentToSource,
	type TimeRange,
} from "./timebase";

export const MIN_FRAGMENT_SECONDS = 1.5;
export const MICRO_CUT_SECONDS = 0.8;
const CONTIGUOUS_SECONDS = 0.02;
const MAX_FIX_ROUNDS = 30;

export type Piece = {
	first: number;
	last: number;
	sourceStart: number;
	sourceEnd: number;
	outputStart: number;
	outputEnd: number;
	duration: number;
};

export type FragmentAction =
	| {
			kind: "merged" | "extended";
			piece: TimeRange;
			duration: number;
			restored: TimeRange;
			speech: number;
			activity: number;
	  }
	| {
			kind: "removed";
			piece: TimeRange;
			duration: number;
			speech: number;
			activity: number;
	  };

export type FragmentMeasure = {
	speech: (start: number, end: number) => number;
	activity: (start: number, end: number) => number;
};

const FULL_MERGE_SLACK_SECONDS = 0.8;

export function buildPieces(spans: ClipSpan[], joinGapSeconds = 0): Piece[] {
	const pieces: Piece[] = [];
	spans.forEach((span, index) => {
		const last = pieces[pieces.length - 1];
		const gap = last ? span.sourceStart - last.sourceEnd : Number.NaN;
		if (
			last &&
			gap > -CONTIGUOUS_SECONDS &&
			gap < Math.max(CONTIGUOUS_SECONDS, joinGapSeconds)
		) {
			last.last = index;
			last.sourceEnd = span.sourceEnd;
			last.outputEnd = span.outputEnd;
			last.duration = last.outputEnd - last.outputStart;
			return;
		}
		pieces.push({
			first: index,
			last: index,
			sourceStart: span.sourceStart,
			sourceEnd: span.sourceEnd,
			outputStart: span.outputStart,
			outputEnd: span.outputEnd,
			duration: span.outputEnd - span.outputStart,
		});
	});
	return pieces;
}

function sameRun(a: TimelineSegment, b: TimelineSegment) {
	return (
		(a.recordingSegment ?? 0) === (b.recordingSegment ?? 0) &&
		a.timescale === b.timescale &&
		Math.abs(a.end - b.start) < CONTIGUOUS_SECONDS
	);
}

export function restoreSourceRange(
	segments: TimelineSegment[],
	layout: RecordingLayout,
	start: number,
	end: number,
): TimelineSegment[] {
	let result = segments.map((s) => ({ ...s }));
	for (let rs = 0; rs < layout.durations.length; rs++) {
		const offset = layout.offsets[rs];
		let from = Math.max(0, start - offset);
		const to = Math.min(layout.durations[rs], end - offset);
		if (to - from < 0.01) continue;
		const covering = result
			.filter(
				(s) => (s.recordingSegment ?? 0) === rs && s.end > from && s.start < to,
			)
			.sort((a, b) => a.start - b.start);
		const holes: [number, number][] = [];
		for (const s of covering) {
			if (s.start > from) holes.push([from, Math.min(s.start, to)]);
			from = Math.max(from, s.end);
		}
		if (to > from) holes.push([from, to]);
		for (const [s, e] of holes) {
			if (e - s < 0.01) continue;
			const piece: TimelineSegment = {
				recordingSegment: rs,
				timescale: 1,
				start: s,
				end: e,
			};
			const globalStart = segmentToSource(layout, rs, s);
			let index = result.findIndex(
				(seg) =>
					segmentToSource(layout, seg.recordingSegment ?? 0, seg.start) >
					globalStart,
			);
			if (index === -1) index = result.length;
			result.splice(index, 0, piece);
			result = mergeAround(result, index);
		}
	}
	return result;
}

function mergeAround(segments: TimelineSegment[], index: number) {
	const result = [...segments];
	let i = index;
	if (i + 1 < result.length && sameRun(result[i], result[i + 1])) {
		result[i] = { ...result[i], end: result[i + 1].end };
		result.splice(i + 1, 1);
	}
	if (i > 0 && sameRun(result[i - 1], result[i])) {
		result[i - 1] = { ...result[i - 1], end: result[i].end };
		result.splice(i, 1);
		i--;
	}
	return result;
}

export function fixShortPieces(
	segments: TimelineSegment[],
	layout: RecordingLayout,
	measure: FragmentMeasure,
	minDuration = MIN_FRAGMENT_SECONDS,
): { segments: TimelineSegment[]; actions: FragmentAction[] } {
	let current = segments.map((s) => ({ ...s }));
	const actions: FragmentAction[] = [];
	for (let round = 0; round < MAX_FIX_ROUNDS; round++) {
		const pieces = buildPieces(
			buildClipSpans(current, layout),
			MICRO_CUT_SECONDS,
		);
		if (pieces.length <= 1) break;
		let shortest = -1;
		for (let i = 0; i < pieces.length; i++) {
			if (pieces[i].duration >= minDuration) continue;
			if (shortest === -1 || pieces[i].duration < pieces[shortest].duration)
				shortest = i;
		}
		if (shortest === -1) break;
		const piece = pieces[shortest];
		const range = { start: piece.sourceStart, end: piece.sourceEnd };
		const speech = measure.speech(range.start, range.end);
		const activity = measure.activity(range.start, range.end);
		const base = { piece: range, duration: piece.duration, speech, activity };
		if (speech <= 0.1 && activity <= 0.05) {
			current = cutSourceRange(current, layout, range.start, range.end);
			actions.push({ kind: "removed", ...base });
			continue;
		}
		const prev = pieces[shortest - 1];
		const next = pieces[shortest + 1];
		const need = minDuration - piece.duration + 0.05;
		const options: { gap: TimeRange; window: TimeRange }[] = [];
		if (prev && piece.sourceStart > prev.sourceEnd) {
			const gap = { start: prev.sourceEnd, end: piece.sourceStart };
			options.push({
				gap,
				window: { start: Math.max(gap.start, gap.end - need), end: gap.end },
			});
		}
		if (next && next.sourceStart > piece.sourceEnd) {
			const gap = { start: piece.sourceEnd, end: next.sourceStart };
			options.push({
				gap,
				window: { start: gap.start, end: Math.min(gap.end, gap.start + need) },
			});
		}
		if (options.length === 0) break;
		const length = (r: TimeRange) => r.end - r.start;
		const fullMerge = options
			.filter((o) => length(o.gap) <= need + FULL_MERGE_SLACK_SECONDS)
			.sort((a, b) => length(a.gap) - length(b.gap))[0];
		const choice =
			fullMerge ??
			[...options].sort(
				(a, b) =>
					measure.speech(a.window.start, a.window.end) -
						measure.speech(b.window.start, b.window.end) ||
					length(a.gap) - length(b.gap),
			)[0];
		const restored = fullMerge ? choice.gap : choice.window;
		current = restoreSourceRange(current, layout, restored.start, restored.end);
		actions.push({
			kind: fullMerge ? "merged" : "extended",
			...base,
			restored,
		});
	}
	return { segments: current, actions };
}

export const SLIVER_SECONDS = 0.15;

export function dropSlivers(
	segments: TimelineSegment[],
	layout: RecordingLayout,
	measure: FragmentMeasure,
): { segments: TimelineSegment[]; dropped: TimeRange[] } {
	let current = segments.map((s) => ({ ...s }));
	const dropped: TimeRange[] = [];
	for (const span of buildClipSpans(current, layout)) {
		if (span.outputEnd - span.outputStart >= SLIVER_SECONDS) continue;
		if (measure.speech(span.sourceStart, span.sourceEnd) > 0.02) continue;
		if (measure.activity(span.sourceStart, span.sourceEnd) > 0.02) continue;
		if (buildClipSpans(current, layout).length <= 1) break;
		current = cutSourceRange(current, layout, span.sourceStart, span.sourceEnd);
		dropped.push({ start: span.sourceStart, end: span.sourceEnd });
	}
	return { segments: current, dropped };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;
	const layout = createRecordingLayout([100]);
	const seg = (start: number, end: number, timescale = 1): TimelineSegment => ({
		recordingSegment: 0,
		timescale,
		start,
		end,
	});

	describe("buildPieces", () => {
		it("joins source-contiguous clips, including speed changes", () => {
			const pieces = buildPieces(
				buildClipSpans([seg(0, 10), seg(10, 14, 4), seg(20, 30)], layout),
			);
			expect(
				pieces.map((p) => [p.sourceStart, p.sourceEnd, p.duration]),
			).toEqual([
				[0, 14, 11],
				[20, 30, 10],
			]);
		});
	});

	describe("fixShortPieces", () => {
		it("removes a short fragment without speech", () => {
			const result = fixShortPieces(
				[seg(0, 10), seg(12, 12.6), seg(20, 30)],
				layout,
				{ speech: () => 0, activity: () => 0 },
			);
			expect(result.segments).toEqual([seg(0, 10), seg(20, 30)]);
			expect(result.actions[0].kind).toBe("removed");
		});

		it("merges a short fragment with speech across a short gap", () => {
			const result = fixShortPieces(
				[seg(0, 10), seg(11, 11.6), seg(20, 30)],
				layout,
				{ speech: () => 0.5, activity: () => 0 },
			);
			expect(result.segments).toEqual([seg(0, 11.6), seg(20, 30)]);
			expect(result.actions[0]).toMatchObject({
				kind: "merged",
				restored: { start: 10, end: 11 },
			});
		});

		it("extends a short fragment with speech into a long gap", () => {
			const result = fixShortPieces(
				[seg(0, 10), seg(12, 12.6), seg(20, 30)],
				layout,
				{ speech: () => 0.5, activity: () => 0 },
			);
			expect(result.actions[0].kind).toBe("extended");
			expect(result.segments[1].start).toBeCloseTo(11.05);
			expect(result.segments[1].end).toBeCloseTo(12.6);
		});

		it("treats small word-level cuts as part of the same piece", () => {
			const result = fixShortPieces(
				[seg(0, 1.4), seg(1.95, 14), seg(40, 60)],
				layout,
				{ speech: () => 1, activity: () => 0 },
			);
			expect(result.actions).toEqual([]);
		});

		it("keeps a short piece with activity and extends it into a long gap", () => {
			const result = fixShortPieces(
				[seg(0, 10), seg(20, 20.6), seg(40, 60)],
				layout,
				{
					speech: (s, e) => (s < 20 && e > 19 ? 0.5 : 0),
					activity: (s, e) => (s < 20.6 && e > 20 ? 0.6 : 0),
				},
			);
			expect(result.actions[0].kind).toBe("extended");
			expect(result.segments).toEqual([
				seg(0, 10),
				seg(20, 21.55),
				seg(40, 60),
			]);
		});

		it("leaves long pieces alone", () => {
			const segments = [seg(0, 10), seg(20, 30)];
			expect(
				fixShortPieces(segments, layout, {
					speech: () => 1,
					activity: () => 0,
				}).actions,
			).toEqual([]);
		});

		it("handles a short first piece", () => {
			const result = fixShortPieces(
				[seg(0, 1), seg(2, 10), seg(50, 60)],
				layout,
				{ speech: () => 0.8, activity: () => 0 },
			);
			expect(result.segments).toEqual([seg(0, 10), seg(50, 60)]);
		});
	});

	describe("dropSlivers", () => {
		it("removes tiny silent leftovers between cuts", () => {
			const result = dropSlivers(
				[seg(0, 3), seg(4.84, 4.9), seg(5.45, 10)],
				layout,
				{ speech: () => 0, activity: () => 0 },
			);
			expect(result.segments).toEqual([seg(0, 3), seg(5.45, 10)]);
		});
	});

	describe("restoreSourceRange", () => {
		it("restores across recording segments", () => {
			const multi = createRecordingLayout([10, 10]);
			const result = restoreSourceRange(
				[
					{ recordingSegment: 0, timescale: 1, start: 0, end: 8 },
					{ recordingSegment: 1, timescale: 1, start: 3, end: 10 },
				],
				multi,
				8,
				13,
			);
			expect(result).toEqual([
				{ recordingSegment: 0, timescale: 1, start: 0, end: 10 },
				{ recordingSegment: 1, timescale: 1, start: 0, end: 10 },
			]);
		});
	});
}
