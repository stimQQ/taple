import type { TimelineSegment } from "~/utils/tauri";

export type TimeRange = { start: number; end: number };

export type RecordingLayout = {
	durations: number[];
	offsets: number[];
	total: number;
};

export type ClipSpan = {
	index: number;
	recordingSegment: number;
	segmentStart: number;
	segmentEnd: number;
	sourceStart: number;
	sourceEnd: number;
	outputStart: number;
	outputEnd: number;
	speed: number;
};

export type SegmentClockOffsets = number[];

const EPSILON = 1e-6;
const MERGE_GAP = 1e-3;
export const MIN_PIECE_SECONDS = 0.05;

export function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

export function createRecordingLayout(durations: number[]): RecordingLayout {
	const clean = durations.map((d) => (Number.isFinite(d) && d > 0 ? d : 0));
	const offsets: number[] = [];
	let total = 0;
	for (const d of clean) {
		offsets.push(total);
		total += d;
	}
	return { durations: clean, offsets, total };
}

export function layoutFromSegmentDurations(
	recordingDurations: number[],
	timelineSegments: TimelineSegment[] | undefined,
): RecordingLayout {
	const durations = [...recordingDurations];
	for (const segment of timelineSegments ?? []) {
		const index = segment.recordingSegment ?? 0;
		while (durations.length <= index) durations.push(0);
		durations[index] = Math.max(durations[index], segment.end);
	}
	return createRecordingLayout(durations);
}

export function segmentToSource(
	layout: RecordingLayout,
	recordingSegment: number,
	time: number,
): number {
	return (layout.offsets[recordingSegment] ?? 0) + time;
}

export function sourceToSegment(
	layout: RecordingLayout,
	source: number,
): { recordingSegment: number; time: number } {
	const t = clamp(source, 0, layout.total);
	const last = layout.durations.length - 1;
	for (let i = 0; i <= last; i++) {
		const end = layout.offsets[i] + layout.durations[i];
		if (t < end || i === last) {
			return {
				recordingSegment: i,
				time: clamp(t - layout.offsets[i], 0, layout.durations[i]),
			};
		}
	}
	return { recordingSegment: 0, time: t };
}

export function defaultTimelineSegments(
	layout: RecordingLayout,
): TimelineSegment[] {
	return layout.durations.map((duration, index) => ({
		recordingSegment: index,
		timescale: 1,
		start: 0,
		end: duration,
	}));
}

export function buildClipSpans(
	segments: TimelineSegment[],
	layout: RecordingLayout,
): ClipSpan[] {
	let output = 0;
	return segments.map((segment, index) => {
		const recordingSegment = segment.recordingSegment ?? 0;
		const speed =
			Number.isFinite(segment.timescale) && segment.timescale > 0
				? segment.timescale
				: 1;
		const duration = Math.max(0, segment.end - segment.start) / speed;
		const span: ClipSpan = {
			index,
			recordingSegment,
			segmentStart: segment.start,
			segmentEnd: segment.end,
			sourceStart: segmentToSource(layout, recordingSegment, segment.start),
			sourceEnd: segmentToSource(layout, recordingSegment, segment.end),
			outputStart: output,
			outputEnd: output + duration,
			speed,
		};
		output += duration;
		return span;
	});
}

export function outputDuration(spans: ClipSpan[]): number {
	return spans.length > 0 ? spans[spans.length - 1].outputEnd : 0;
}

export function sourceToOutput(
	spans: ClipSpan[],
	source: number,
): number | null {
	for (const span of spans) {
		if (
			source >= span.sourceStart - EPSILON &&
			source <= span.sourceEnd + EPSILON
		) {
			const t = clamp(source, span.sourceStart, span.sourceEnd);
			return span.outputStart + (t - span.sourceStart) / span.speed;
		}
	}
	return null;
}

export function outputToSource(
	spans: ClipSpan[],
	output: number,
): number | null {
	for (let i = 0; i < spans.length; i++) {
		const span = spans[i];
		const isLast = i === spans.length - 1;
		if (
			output >= span.outputStart - EPSILON &&
			(output < span.outputEnd ||
				(isLast && output <= span.outputEnd + EPSILON))
		) {
			const t = clamp(output, span.outputStart, span.outputEnd);
			return span.sourceStart + (t - span.outputStart) * span.speed;
		}
	}
	return null;
}

export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
	const sorted = [...ranges]
		.filter((r) => r.end - r.start > EPSILON)
		.sort((a, b) => a.start - b.start);
	const merged: TimeRange[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end + MERGE_GAP) {
			last.end = Math.max(last.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

export function sourceRangeToOutputRanges(
	spans: ClipSpan[],
	start: number,
	end: number,
): TimeRange[] {
	const ranges: TimeRange[] = [];
	for (const span of spans) {
		const s = Math.max(start, span.sourceStart);
		const e = Math.min(end, span.sourceEnd);
		if (e - s <= EPSILON) continue;
		ranges.push({
			start: span.outputStart + (s - span.sourceStart) / span.speed,
			end: span.outputStart + (e - span.sourceStart) / span.speed,
		});
	}
	return mergeRanges(ranges);
}

export function outputRangeToSourceRanges(
	spans: ClipSpan[],
	start: number,
	end: number,
): TimeRange[] {
	const ranges: TimeRange[] = [];
	for (const span of spans) {
		const s = Math.max(start, span.outputStart);
		const e = Math.min(end, span.outputEnd);
		if (e - s <= EPSILON) continue;
		ranges.push({
			start: span.sourceStart + (s - span.outputStart) * span.speed,
			end: span.sourceStart + (e - span.outputStart) * span.speed,
		});
	}
	return mergeRanges(ranges);
}

export function keptSourceSeconds(
	spans: ClipSpan[],
	start: number,
	end: number,
): number {
	let kept = 0;
	for (const span of spans) {
		const s = Math.max(start, span.sourceStart);
		const e = Math.min(end, span.sourceEnd);
		if (e > s) kept += e - s;
	}
	return Math.min(kept, Math.max(0, end - start));
}

export type RangeStatus = "kept" | "cut" | "partly cut";

export function sourceRangeStatus(
	spans: ClipSpan[],
	start: number,
	end: number,
): RangeStatus {
	const length = end - start;
	if (length <= EPSILON) {
		return sourceToOutput(spans, start) === null ? "cut" : "kept";
	}
	const kept = keptSourceSeconds(spans, start, end);
	if (kept <= Math.min(MIN_PIECE_SECONDS, length * 0.05)) return "cut";
	if (length - kept <= Math.min(MIN_PIECE_SECONDS, length * 0.05))
		return "kept";
	return "partly cut";
}

export function cutSourceRange(
	segments: TimelineSegment[],
	layout: RecordingLayout,
	start: number,
	end: number,
): TimelineSegment[] {
	const next: TimelineSegment[] = [];
	for (const segment of segments) {
		const offset = layout.offsets[segment.recordingSegment ?? 0] ?? 0;
		const cutStart = start - offset;
		const cutEnd = end - offset;
		if (
			cutEnd <= segment.start + EPSILON ||
			cutStart >= segment.end - EPSILON
		) {
			next.push({ ...segment });
			continue;
		}
		if (cutStart - segment.start >= MIN_PIECE_SECONDS) {
			next.push({ ...segment, end: cutStart });
		}
		if (segment.end - cutEnd >= MIN_PIECE_SECONDS) {
			next.push({ ...segment, start: cutEnd });
		}
	}
	return next;
}

export function setSpeedInSourceRange(
	segments: TimelineSegment[],
	layout: RecordingLayout,
	start: number,
	end: number,
	speed: number,
): TimelineSegment[] {
	const next: TimelineSegment[] = [];
	for (const segment of segments) {
		const offset = layout.offsets[segment.recordingSegment ?? 0] ?? 0;
		let from = Math.max(segment.start, start - offset);
		let to = Math.min(segment.end, end - offset);
		if (to - from <= EPSILON) {
			next.push({ ...segment });
			continue;
		}
		if (from - segment.start < MIN_PIECE_SECONDS) from = segment.start;
		if (segment.end - to < MIN_PIECE_SECONDS) to = segment.end;
		if (from > segment.start) next.push({ ...segment, end: from });
		next.push({ ...segment, start: from, end: to, timescale: speed });
		if (to < segment.end) next.push({ ...segment, start: to });
	}
	return next;
}

export function remapOutputRanges<T extends TimeRange>(
	before: ClipSpan[],
	after: ClipSpan[],
	items: T[],
	minDuration: number,
): { items: T[]; dropped: number; changed: number } {
	const mapped: T[] = [];
	let dropped = 0;
	let changed = 0;
	for (const item of items) {
		const sources = outputRangeToSourceRanges(before, item.start, item.end);
		const outputs = mergeRanges(
			sources.flatMap((r) => sourceRangeToOutputRanges(after, r.start, r.end)),
		);
		if (outputs.length === 0) {
			dropped++;
			continue;
		}
		const start = outputs[0].start;
		const end = outputs[outputs.length - 1].end;
		if (end - start < minDuration) {
			dropped++;
			continue;
		}
		if (
			Math.abs(start - item.start) > MERGE_GAP ||
			Math.abs(end - item.end) > MERGE_GAP
		)
			changed++;
		mapped.push({ ...item, start, end });
	}
	mapped.sort((a, b) => a.start - b.start);
	const result: T[] = [];
	for (const item of mapped) {
		const prev = result[result.length - 1];
		if (prev && item.start < prev.end) {
			const trimmed = { ...item, start: prev.end };
			if (trimmed.end - trimmed.start < minDuration) {
				dropped++;
				continue;
			}
			result.push(trimmed);
			continue;
		}
		result.push(item);
	}
	return { items: result, dropped, changed };
}

export function captionToSource(layout: RecordingLayout, time: number): number {
	return segmentToSource(layout, 0, time);
}

export function sourceToCaption(
	layout: RecordingLayout,
	source: number,
): number {
	return source - (layout.offsets[0] ?? 0);
}

export function clickToSource(
	layout: RecordingLayout,
	clockOffsets: SegmentClockOffsets,
	segmentIndex: number,
	timeSecs: number,
): number {
	return segmentToSource(
		layout,
		segmentIndex,
		timeSecs - (clockOffsets[segmentIndex] ?? 0),
	);
}

export function formatSeconds(t: number): string {
	return t.toFixed(2);
}

export function formatClock(t: number): string {
	const safe = Math.max(0, t);
	const minutes = Math.floor(safe / 60);
	const seconds = safe - minutes * 60;
	return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	const single = createRecordingLayout([100]);
	const multi = createRecordingLayout([10, 20]);

	describe("recording layout", () => {
		it("maps source time to recording segments", () => {
			expect(sourceToSegment(multi, 5)).toEqual({
				recordingSegment: 0,
				time: 5,
			});
			expect(sourceToSegment(multi, 10)).toEqual({
				recordingSegment: 1,
				time: 0,
			});
			expect(sourceToSegment(multi, 29.5)).toEqual({
				recordingSegment: 1,
				time: 19.5,
			});
			expect(sourceToSegment(multi, 99)).toEqual({
				recordingSegment: 1,
				time: 20,
			});
			expect(segmentToSource(multi, 1, 3)).toBe(13);
		});

		it("extends durations to cover timeline segments", () => {
			const layout = layoutFromSegmentDurations(
				[10],
				[{ recordingSegment: 0, timescale: 1, start: 0, end: 12 }],
			);
			expect(layout.total).toBe(12);
		});
	});

	describe("clip spans", () => {
		const segments: TimelineSegment[] = [
			{ recordingSegment: 0, timescale: 1, start: 0, end: 10 },
			{ recordingSegment: 0, timescale: 2, start: 20, end: 40 },
			{ recordingSegment: 0, timescale: 1, start: 50, end: 60 },
		];
		const spans = buildClipSpans(segments, single);

		it("computes output positions with speed", () => {
			expect(spans.map((s) => [s.outputStart, s.outputEnd])).toEqual([
				[0, 10],
				[10, 20],
				[20, 30],
			]);
			expect(outputDuration(spans)).toBe(30);
		});

		it("converts source to output and back", () => {
			expect(sourceToOutput(spans, 5)).toBe(5);
			expect(sourceToOutput(spans, 15)).toBeNull();
			expect(sourceToOutput(spans, 30)).toBe(15);
			expect(sourceToOutput(spans, 55)).toBe(25);
			expect(outputToSource(spans, 15)).toBe(30);
			expect(outputToSource(spans, 25)).toBe(55);
			expect(outputToSource(spans, 30)).toBe(60);
			expect(outputToSource(spans, 31)).toBeNull();
		});

		it("maps ranges across cuts into contiguous output", () => {
			expect(sourceRangeToOutputRanges(spans, 5, 30)).toEqual([
				{ start: 5, end: 15 },
			]);
			expect(sourceRangeToOutputRanges(spans, 12, 18)).toEqual([]);
			expect(outputRangeToSourceRanges(spans, 5, 15)).toEqual([
				{ start: 5, end: 10 },
				{ start: 20, end: 30 },
			]);
		});

		it("reports range status", () => {
			expect(sourceRangeStatus(spans, 1, 4)).toBe("kept");
			expect(sourceRangeStatus(spans, 11, 19)).toBe("cut");
			expect(sourceRangeStatus(spans, 8, 22)).toBe("partly cut");
		});

		it("maps multi-segment recordings", () => {
			const multiSpans = buildClipSpans(
				[
					{ recordingSegment: 0, timescale: 1, start: 0, end: 10 },
					{ recordingSegment: 1, timescale: 1, start: 5, end: 20 },
				],
				multi,
			);
			expect(sourceToOutput(multiSpans, 12)).toBeNull();
			expect(sourceToOutput(multiSpans, 15)).toBe(10);
			expect(outputToSource(multiSpans, 12)).toBe(17);
		});
	});

	describe("edits", () => {
		const base: TimelineSegment[] = [
			{ recordingSegment: 0, timescale: 1, start: 0, end: 100 },
		];

		it("cuts a range out of a clip", () => {
			expect(cutSourceRange(base, single, 10, 20)).toEqual([
				{ recordingSegment: 0, timescale: 1, start: 0, end: 10 },
				{ recordingSegment: 0, timescale: 1, start: 20, end: 100 },
			]);
		});

		it("cuts across clips and drops slivers", () => {
			const segments: TimelineSegment[] = [
				{ recordingSegment: 0, timescale: 1, start: 0, end: 10 },
				{ recordingSegment: 0, timescale: 1, start: 10, end: 30 },
			];
			expect(cutSourceRange(segments, single, 5, 29.98)).toEqual([
				{ recordingSegment: 0, timescale: 1, start: 0, end: 5 },
			]);
		});

		it("cuts across recording segments", () => {
			const segments = defaultTimelineSegments(multi);
			expect(cutSourceRange(segments, multi, 8, 12)).toEqual([
				{ recordingSegment: 0, timescale: 1, start: 0, end: 8 },
				{ recordingSegment: 1, timescale: 1, start: 2, end: 20 },
			]);
		});

		it("changes speed inside a range", () => {
			expect(setSpeedInSourceRange(base, single, 10, 30, 2)).toEqual([
				{ recordingSegment: 0, timescale: 1, start: 0, end: 10 },
				{ recordingSegment: 0, timescale: 2, start: 10, end: 30 },
				{ recordingSegment: 0, timescale: 1, start: 30, end: 100 },
			]);
		});

		it("keeps zooms attached to content after a cut", () => {
			const before = buildClipSpans(base, single);
			const afterSegments = cutSourceRange(base, single, 10, 20);
			const after = buildClipSpans(afterSegments, single);
			const result = remapOutputRanges(
				before,
				after,
				[
					{ start: 2, end: 6 },
					{ start: 12, end: 15 },
					{ start: 18, end: 25 },
					{ start: 40, end: 45 },
				],
				1,
			);
			expect(result.items).toEqual([
				{ start: 2, end: 6 },
				{ start: 10, end: 15 },
				{ start: 30, end: 35 },
			]);
			expect(result.dropped).toBe(1);
		});

		it("keeps zooms attached to content after a speed change", () => {
			const before = buildClipSpans(base, single);
			const after = buildClipSpans(
				setSpeedInSourceRange(base, single, 10, 30, 2),
				single,
			);
			const result = remapOutputRanges(
				before,
				after,
				[{ start: 40, end: 50 }],
				1,
			);
			expect(result.items).toEqual([{ start: 30, end: 40 }]);
		});
	});

	describe("event time bases", () => {
		it("converts captions and clicks to source time", () => {
			expect(captionToSource(multi, 4)).toBe(4);
			expect(clickToSource(multi, [0, 0.25], 1, 3.25)).toBe(13);
			expect(clickToSource(single, [], 0, 7)).toBe(7);
		});
	});
}
