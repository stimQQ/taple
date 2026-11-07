import {
	type ActivityRegion,
	commands,
	type VisualActivity,
} from "~/utils/tauri";
import type { StoryRun } from "./storyboard";
import {
	createRecordingLayout,
	formatSeconds as fmt,
	type RecordingLayout,
	segmentToSource,
	type TimeRange,
} from "./timebase";

export type VisualRegion = ActivityRegion;

export type VisualActivityData = VisualActivity;

export type ActivitySpan = TimeRange & {
	cursor: boolean;
	click: boolean;
	screen: boolean;
};

export type VisualSource =
	| "visual activity"
	| "storyboard and clicks"
	| "clicks";

export type VisualMap = {
	source: VisualSource;
	spans: ActivitySpan[];
	note: string;
};

const MERGE_GAP_SECONDS = 0.05;
const CLICK_PADDING_SECONDS = 0.3;
const MIN_OVERLAP_SECONDS = 0.05;

export async function loadVisualActivity(
	projectPath: string,
): Promise<VisualActivityData | null> {
	try {
		return await commands.getVisualActivity(projectPath);
	} catch {
		return null;
	}
}

function mergeSpans(spans: ActivitySpan[]): ActivitySpan[] {
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	const merged: ActivitySpan[] = [];
	for (const span of sorted) {
		const last = merged[merged.length - 1];
		if (last && span.start <= last.end + MERGE_GAP_SECONDS) {
			last.end = Math.max(last.end, span.end);
			last.cursor ||= span.cursor;
			last.click ||= span.click;
			last.screen ||= span.screen;
		} else {
			merged.push({ ...span });
		}
	}
	return merged;
}

export function buildVisualMap(input: {
	layout: RecordingLayout;
	data: VisualActivityData | null;
	storyRuns: StoryRun[] | null;
	clicks: { time: number }[];
}): VisualMap {
	const clickSpans: ActivitySpan[] = input.clicks.map((c) => ({
		start: Math.max(0, c.time - CLICK_PADDING_SECONDS),
		end: Math.min(input.layout.total, c.time + CLICK_PADDING_SECONDS),
		cursor: false,
		click: true,
		screen: false,
	}));
	if (input.data) {
		const spans = input.data.regions
			.filter(
				(r) =>
					r.segment_index < input.layout.durations.length && r.end > r.start,
			)
			.filter((r) => r.cursor_moving || r.clicked || r.screen_changing)
			.map((r) => ({
				start: segmentToSource(input.layout, r.segment_index, r.start),
				end: segmentToSource(
					input.layout,
					r.segment_index,
					Math.min(r.end, input.layout.durations[r.segment_index]),
				),
				cursor: r.cursor_moving,
				click: r.clicked,
				screen: r.screen_changing,
			}));
		return {
			source: "visual activity",
			spans: mergeSpans([...spans, ...clickSpans]),
			note: `cursor movement, clicks and screen changes in ${input.data.resolution_ms} ms steps`,
		};
	}
	if (input.storyRuns) {
		const spans: ActivitySpan[] = input.storyRuns
			.filter(
				(r) => r.kind !== "static" && r.kind !== "start" && r.end > r.start,
			)
			.map((r) => ({
				start: r.start,
				end: r.end,
				cursor: r.kind === "small motion" && !r.progress,
				click: false,
				screen: true,
			}));
		return {
			source: "storyboard and clicks",
			spans: mergeSpans([...spans, ...clickSpans]),
			note: "clicks plus 1 s screen samples (no cursor data, so any small motion counts as possible user activity)",
		};
	}
	return {
		source: "clicks",
		spans: mergeSpans(clickSpans),
		note: "clicks only (no screen analysis available)",
	};
}

export function activeSpans(
	map: VisualMap,
	start: number,
	end: number,
	filter: (span: ActivitySpan) => boolean = () => true,
): ActivitySpan[] {
	return map.spans.filter(
		(s) =>
			filter(s) &&
			Math.min(s.end, end) - Math.max(s.start, start) > MIN_OVERLAP_SECONDS,
	);
}

export function isUserActivity(span: ActivitySpan): boolean {
	return span.cursor || span.click;
}

export function activeSeconds(
	map: VisualMap,
	start: number,
	end: number,
	filter?: (span: ActivitySpan) => boolean,
): number {
	return activeSpans(map, start, end, filter).reduce(
		(sum, s) => sum + Math.min(s.end, end) - Math.max(s.start, start),
		0,
	);
}

export function subtractActivity(
	map: VisualMap,
	range: TimeRange,
	filter?: (span: ActivitySpan) => boolean,
): TimeRange[] {
	let free: TimeRange[] = [{ ...range }];
	for (const span of activeSpans(map, range.start, range.end, filter)) {
		free = free.flatMap((f) => {
			if (span.end <= f.start || span.start >= f.end) return [f];
			const parts: TimeRange[] = [];
			if (span.start > f.start) parts.push({ start: f.start, end: span.start });
			if (span.end < f.end) parts.push({ start: span.end, end: f.end });
			return parts;
		});
	}
	return free.filter((f) => f.end - f.start > 1e-6);
}

export function describeSpans(spans: ActivitySpan[], limit = 4): string {
	return spans
		.slice(0, limit)
		.map((s) => {
			const kinds = [
				s.click ? "click" : null,
				s.cursor ? "cursor moving" : null,
				s.screen ? "screen changing" : null,
			].filter(Boolean);
			return `${kinds.join(" + ")} at ${fmt(s.start)}–${fmt(s.end)}`;
		})
		.join("; ");
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;
	const layout = createRecordingLayout([30]);

	describe("visual map", () => {
		const map = buildVisualMap({
			layout,
			data: {
				resolution_ms: 100,
				regions: [
					{
						segment_index: 0,
						start: 2,
						end: 3,
						cursor_moving: true,
						clicked: false,
						screen_changing: false,
					},
					{
						segment_index: 0,
						start: 3,
						end: 3.5,
						cursor_moving: false,
						clicked: false,
						screen_changing: true,
					},
					{
						segment_index: 0,
						start: 10,
						end: 20,
						cursor_moving: false,
						clicked: false,
						screen_changing: true,
					},
				],
			},
			storyRuns: null,
			clicks: [{ time: 25 }],
		});

		it("merges adjacent regions and keeps their kinds", () => {
			expect(map.spans).toEqual([
				{ start: 2, end: 3.5, cursor: true, click: false, screen: true },
				{ start: 10, end: 20, cursor: false, click: false, screen: true },
				{ start: 24.7, end: 25.3, cursor: false, click: true, screen: false },
			]);
		});

		it("splits a range around activity", () => {
			expect(subtractActivity(map, { start: 0, end: 30 })).toEqual([
				{ start: 0, end: 2 },
				{ start: 3.5, end: 10 },
				{ start: 20, end: 24.7 },
				{ start: 25.3, end: 30 },
			]);
			expect(activeSeconds(map, 0, 30, isUserActivity)).toBeCloseTo(2.1);
		});
	});
}
