import { commands, type StoryboardEntry } from "~/utils/tauri";
import {
	createRecordingLayout,
	formatSeconds as fmt,
	type RecordingLayout,
	segmentToSource,
	type TimeRange,
} from "./timebase";

export const STORYBOARD_INTERVAL_SECONDS = 1;

export type StoryKind =
	| "start"
	| "scene change"
	| "change"
	| "small motion"
	| "static";

export type StoryRun = TimeRange & {
	kind: StoryKind;
	maxChange: number;
	texts: string[];
	progress: boolean;
};

const SCENE_CHANGE = 0.3;
const CHANGE = 0.03;
const MOTION = 0.005;
const MAX_TEXTS_PER_RUN = 6;
const MAX_TEXT_CHARS = 70;

const PROGRESS_PATTERN =
	/(load|generat|upload|download|process|render|export|install|build|compil|sync|wait|preparing|analy[sz]|transcrib|please wait|\d{1,3}\s?%|\d+\s?s\b|remaining|正在|加载|生成|上传|下载|处理|渲染|导出|安装|编译|同步|等待|请稍|准备|分析|转录|剩余|进度)/i;

const CLOCK_PATTERNS = [
	/^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s+)?(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+)?\d{1,2}[:：]\d{2}(?:[:：]\d{2})?\s*(?:am|pm)?$/i,
	/^(?:\d{1,2}月\d{1,2}日\s*)?(?:周|星期)?[一二三四五六日天]?\s*(?:上午|下午|中午|晚上)?\s*\d{1,2}[:：]\d{2}(?:[:：]\d{2})?$/,
	/^\d{1,3}\s?%$/,
];

const cache = new Map<string, Promise<StoryboardEntry[]>>();

export function loadStoryboard(
	projectPath: string,
): Promise<StoryboardEntry[]> {
	const cached = cache.get(projectPath);
	if (cached) return cached;
	const promise = commands
		.getScreenStoryboard(projectPath, STORYBOARD_INTERVAL_SECONDS)
		.catch((error) => {
			cache.delete(projectPath);
			throw error;
		});
	cache.set(projectPath, promise);
	return promise;
}

export function isNoiseText(line: string): boolean {
	const text = line.trim();
	if (text.length < 2) return true;
	if (!/[\p{L}\p{N}]/u.test(text)) return true;
	if (/^[\p{Co}\p{S}\p{P}\s]*.?[\p{Co}\p{S}\p{P}\s]*$/u.test(text)) return true;
	return CLOCK_PATTERNS.some((pattern) => pattern.test(text));
}

function classify(score: number): StoryKind {
	if (score >= SCENE_CHANGE) return "scene change";
	if (score >= CHANGE) return "change";
	if (score >= MOTION) return "small motion";
	return "static";
}

export function buildStoryRuns(
	layout: RecordingLayout,
	entries: StoryboardEntry[],
): StoryRun[] {
	const sorted = [...entries].sort(
		(a, b) => a.segment_index - b.segment_index || a.time_secs - b.time_secs,
	);
	const runs: StoryRun[] = [];
	const cleanTexts = (entry: StoryboardEntry) =>
		entry.text
			.map((t) => t.trim())
			.filter((t) => !isNoiseText(t))
			.map((t) =>
				t.length > MAX_TEXT_CHARS ? `${t.slice(0, MAX_TEXT_CHARS)}…` : t,
			);
	sorted.forEach((entry, index) => {
		const prev = sorted[index - 1];
		const next = sorted[index + 1];
		const segment = entry.segment_index;
		const time = segmentToSource(layout, segment, entry.time_secs);
		const texts = cleanTexts(entry);
		if (!prev || prev.segment_index !== segment) {
			runs.push({
				start: time,
				end: time,
				kind: "start",
				maxChange: entry.change_score,
				texts: texts.slice(0, MAX_TEXTS_PER_RUN),
				progress: false,
			});
		} else {
			const start = segmentToSource(layout, segment, prev.time_secs);
			const kind = classify(entry.change_score);
			const last = runs[runs.length - 1];
			const mergeable =
				last &&
				Math.abs(last.end - start) < 0.05 &&
				kind !== "scene change" &&
				last.kind === kind &&
				(kind !== "change" ||
					texts.length === 0 ||
					last.texts.length < MAX_TEXTS_PER_RUN);
			if (mergeable && last) {
				last.end = time;
				last.maxChange = Math.max(last.maxChange, entry.change_score);
				for (const t of texts) {
					if (!last.texts.includes(t) && last.texts.length < MAX_TEXTS_PER_RUN)
						last.texts.push(t);
				}
			} else {
				runs.push({
					start,
					end: time,
					kind,
					maxChange: entry.change_score,
					texts: texts.slice(0, MAX_TEXTS_PER_RUN),
					progress: false,
				});
			}
		}
		if (!next || next.segment_index !== segment) {
			const segmentEnd = segmentToSource(
				layout,
				segment,
				layout.durations[segment] ?? entry.time_secs,
			);
			const last = runs[runs.length - 1];
			if (last && last.kind !== "start" && segmentEnd > last.end) {
				last.end = segmentEnd;
			} else if (segmentEnd > time + 0.05) {
				runs.push({
					start: time,
					end: segmentEnd,
					kind: "static",
					maxChange: 0,
					texts: [],
					progress: false,
				});
			}
		}
	});
	runs.forEach((run, index) => {
		const nearby = [run, runs[index - 1]].filter(Boolean) as StoryRun[];
		run.progress =
			run.kind !== "static" &&
			run.kind !== "start" &&
			nearby.some((r) => r.texts.some((t) => PROGRESS_PATTERN.test(t)));
	});
	return runs;
}

export function describeRun(run: StoryRun): string {
	const length = run.end - run.start;
	switch (run.kind) {
		case "start":
			return "start of the recording";
		case "scene change":
			return "big change (new page, window or dialog)";
		case "change":
			return "screen content changes";
		case "small motion":
			return run.progress
				? `small motion for ${length.toFixed(0)} s (looks like waiting/progress)`
				: `small motion for ${length.toFixed(0)} s (cursor, typing, spinner or scrolling)`;
		case "static":
			return `static, nothing changes for ${length.toFixed(0)} s`;
	}
}

export function formatStoryRuns(
	runs: StoryRun[],
	status: (range: TimeRange) => string,
	window?: { start?: number; end?: number },
): string[] {
	const lines: string[] = [];
	for (const run of runs) {
		if (window?.start !== undefined && run.end <= window.start) continue;
		if (window?.end !== undefined && run.start >= window.end) continue;
		const texts =
			run.texts.length > 0
				? ` · text: ${run.texts.map((t) => `"${t}"`).join(", ")}`
				: "";
		const progress =
			run.progress && run.kind !== "small motion" ? " · progress text" : "";
		lines.push(
			`  ${fmt(run.start)}–${fmt(run.end)} | ${describeRun(run)}${progress} | ${status(run)}${texts}`,
		);
	}
	return lines;
}

export function summarizeStoryRuns(runs: StoryRun[]): string {
	if (runs.length === 0) return "no samples";
	const staticLong = runs.filter(
		(r) => r.kind === "static" && r.end - r.start >= 5,
	);
	const waiting = runs.filter(
		(r) => r.progress && r.kind === "small motion" && r.end - r.start >= 3,
	);
	const changes = runs.filter(
		(r) => r.kind === "scene change" || r.kind === "change",
	).length;
	const list = (items: StoryRun[]) =>
		items
			.slice(0, 6)
			.map((r) => `${fmt(r.start)}–${fmt(r.end)}`)
			.join(", ");
	return [
		`${changes} visible change(s)`,
		staticLong.length > 0
			? `static stretches of 5 s or more: ${list(staticLong)}`
			: "no long static stretches",
		waiting.length > 0
			? `stretches that look like waiting/progress: ${list(waiting)}`
			: null,
	]
		.filter(Boolean)
		.join("; ");
}

export function idleRanges(
	runs: StoryRun[] | null,
	clicks: { time: number }[],
	range: TimeRange,
	minLength: number,
	clickPadding = 0.5,
): TimeRange[] {
	let free: TimeRange[] = [{ ...range }];
	const busy: TimeRange[] = [
		...(runs ?? [])
			.filter((r) => r.kind !== "static" && r.end > r.start)
			.map((r) => ({ start: r.start, end: r.end })),
		...clicks.map((c) => ({
			start: c.time - clickPadding,
			end: c.time + clickPadding,
		})),
	];
	for (const b of busy) {
		free = free.flatMap((f) => {
			if (b.end <= f.start || b.start >= f.end) return [f];
			const parts: TimeRange[] = [];
			if (b.start > f.start) parts.push({ start: f.start, end: b.start });
			if (b.end < f.end) parts.push({ start: b.end, end: f.end });
			return parts;
		});
	}
	return free.filter((f) => f.end - f.start >= minLength);
}

export function activityInRange(
	runs: StoryRun[],
	start: number,
	end: number,
): StoryRun[] {
	return runs.filter(
		(r) =>
			r.kind !== "static" &&
			Math.min(r.end, end) - Math.max(r.start, start) > 0.25,
	);
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("isNoiseText", () => {
		it("drops clocks, glyphs and battery levels", () => {
			for (const noise of [
				"10:42",
				"Thu 10:42 AM",
				"Fri Nov 7 9:05 PM",
				"11月7日 周五 10:42",
				"下午3:15",
				"85%",
				"",
				"",
				"•",
				"⌘",
			]) {
				expect(isNoiseText(noise)).toBe(true);
			}
			for (const keep of ["Generating your edit...", "设置", "Save", "v2.1"]) {
				expect(isNoiseText(keep)).toBe(false);
			}
		});
	});

	describe("buildStoryRuns", () => {
		it("describes the interval before each sample and flags progress", () => {
			const layout = createRecordingLayout([60]);
			const entries: StoryboardEntry[] = [
				{
					segment_index: 0,
					time_secs: 0,
					change_score: 1,
					text: ["Taple", "10:42"],
				},
				{ segment_index: 0, time_secs: 1, change_score: 0.001, text: [] },
				{ segment_index: 0, time_secs: 2, change_score: 0, text: [] },
				{
					segment_index: 0,
					time_secs: 3,
					change_score: 0.12,
					text: ["Generating your edit...", "usually ~45s"],
				},
				{ segment_index: 0, time_secs: 4, change_score: 0.01, text: [] },
				{ segment_index: 0, time_secs: 5, change_score: 0.008, text: [] },
			];
			const runs = buildStoryRuns(layout, entries);
			expect(runs.map((r) => [r.start, r.end, r.kind])).toEqual([
				[0, 0, "start"],
				[0, 2, "static"],
				[2, 3, "change"],
				[3, 60, "small motion"],
			]);
			expect(runs[0].texts).toEqual(["Taple"]);
			expect(runs[3].progress).toBe(true);
			expect(summarizeStoryRuns(runs)).toContain("waiting/progress");
			expect(activityInRange(runs, 0, 2)).toHaveLength(0);
			expect(activityInRange(runs, 1, 5)).toHaveLength(2);
		});

		it("finds idle parts between activity and clicks", () => {
			const runs: StoryRun[] = [
				{
					start: 0,
					end: 10,
					kind: "static",
					maxChange: 0,
					texts: [],
					progress: false,
				},
				{
					start: 10,
					end: 12,
					kind: "change",
					maxChange: 0.1,
					texts: [],
					progress: false,
				},
				{
					start: 12,
					end: 30,
					kind: "static",
					maxChange: 0,
					texts: [],
					progress: false,
				},
			];
			expect(
				idleRanges(runs, [{ time: 20 }], { start: 5, end: 30 }, 1),
			).toEqual([
				{ start: 5, end: 10 },
				{ start: 12, end: 19.5 },
				{ start: 20.5, end: 30 },
			]);
		});
	});
}
