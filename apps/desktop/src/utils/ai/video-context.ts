import { appLocalDataDir, join } from "@tauri-apps/api/path";
import {
	type CaptionSegment,
	type CursorClickInfo,
	commands,
	type MultipleSegment,
} from "~/utils/tauri";
import {
	captionToSource,
	clickToSource,
	createRecordingLayout,
	type RecordingLayout,
	type SegmentClockOffsets,
	segmentToSource,
	type TimeRange,
} from "./timebase";

export type ClickEvent = { time: number; x: number; y: number };

export type PauseRange = TimeRange & { duration: number };

export type TranscriptLine = {
	id: string;
	start: number;
	end: number;
	text: string;
};

export type AudioSource = "microphone" | "system audio" | "none";

export type VideoActivity = {
	clicks: ClickEvent[];
	ignoredClicks: number;
	pauses: PauseRange[];
	audioSource: AudioSource;
};

const WAVEFORM_STEP_SECONDS = 0.1;
export const MIN_REPORTED_PAUSE_SECONDS = 0.5;

export function segmentClockOffsets(
	segments: MultipleSegment[] | null,
): SegmentClockOffsets {
	if (!segments) return [];
	return segments.map((segment) => {
		const starts: (number | null | undefined)[] = [segment.display.start_time];
		if (segment.camera) starts.push(segment.camera.start_time);
		if (segment.mic) starts.push(segment.mic.start_time);
		if (segment.system_audio) starts.push(segment.system_audio.start_time);
		const known = starts.filter((s): s is number => typeof s === "number");
		if (known.length !== starts.length) return 0;
		const latest = Math.max(...known);
		return Number.isFinite(latest) ? latest : 0;
	});
}

export function transcriptFromCaptions(
	layout: RecordingLayout,
	segments: CaptionSegment[] | undefined | null,
): TranscriptLine[] {
	return (segments ?? [])
		.filter((s) => s.text.trim().length > 0 && s.end > s.start)
		.map((s) => ({
			id: s.id,
			start: captionToSource(layout, s.start),
			end: captionToSource(layout, s.end),
			text: s.text.trim(),
		}))
		.sort((a, b) => a.start - b.start);
}

export function validClicks(
	layout: RecordingLayout,
	clockOffsets: SegmentClockOffsets,
	clicks: CursorClickInfo[],
): { clicks: ClickEvent[]; ignored: number } {
	const valid: ClickEvent[] = [];
	let ignored = 0;
	for (const click of clicks) {
		const inside =
			Number.isFinite(click.x) &&
			Number.isFinite(click.y) &&
			click.x >= 0 &&
			click.x <= 1 &&
			click.y >= 0 &&
			click.y <= 1;
		const segmentDuration = layout.durations[click.segment_index];
		const time = clickToSource(
			layout,
			clockOffsets,
			click.segment_index,
			click.time_secs,
		);
		const segmentStart = segmentToSource(layout, click.segment_index, 0);
		const inTime =
			segmentDuration !== undefined &&
			Number.isFinite(time) &&
			time >= segmentStart &&
			time <= segmentStart + segmentDuration;
		if (!inside || !inTime) {
			ignored++;
			continue;
		}
		valid.push({ time, x: click.x, y: click.y });
	}
	valid.sort((a, b) => a.time - b.time);
	return { clicks: valid, ignored };
}

function quantile(sorted: number[], q: number) {
	return sorted[
		Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))
	];
}

export function silenceThreshold(values: number[]): number | null {
	const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (finite.length === 0) return null;
	const floor = quantile(finite, 0.1);
	const loud = quantile(finite, 0.9);
	if (loud < -50) return Number.POSITIVE_INFINITY;
	if (loud - floor < 6) return null;
	return floor + 0.35 * (loud - floor);
}

export function detectPauses(
	waveform: number[],
	minPauseSeconds: number,
): TimeRange[] {
	const threshold = silenceThreshold(waveform);
	if (threshold === null) return [];
	const ranges: TimeRange[] = [];
	let runStart: number | null = null;
	for (let i = 0; i <= waveform.length; i++) {
		const value = waveform[i];
		const quiet =
			i < waveform.length && (!Number.isFinite(value) || value < threshold);
		if (quiet && runStart === null) runStart = i;
		if (!quiet && runStart !== null) {
			const start = runStart * WAVEFORM_STEP_SECONDS;
			const end = i * WAVEFORM_STEP_SECONDS;
			if (end - start >= minPauseSeconds) ranges.push({ start, end });
			runStart = null;
		}
	}
	return ranges;
}

export function collectPauses(
	layout: RecordingLayout,
	micWaveforms: number[][] | undefined,
	systemWaveforms: number[][] | undefined,
): { pauses: PauseRange[]; audioSource: AudioSource } {
	const pauses: PauseRange[] = [];
	let audioSource: AudioSource = "none";
	for (let i = 0; i < layout.durations.length; i++) {
		const mic = micWaveforms?.[i] ?? [];
		const system = systemWaveforms?.[i] ?? [];
		const waveform = mic.length > 0 ? mic : system;
		if (waveform.length === 0) continue;
		if (mic.length > 0) audioSource = "microphone";
		else if (audioSource === "none") audioSource = "system audio";
		for (const range of detectPauses(waveform, MIN_REPORTED_PAUSE_SECONDS)) {
			const end = Math.min(range.end, layout.durations[i]);
			if (end - range.start < MIN_REPORTED_PAUSE_SECONDS) continue;
			const start = segmentToSource(layout, i, range.start);
			const sourceEnd = segmentToSource(layout, i, end);
			pauses.push({ start, end: sourceEnd, duration: sourceEnd - start });
		}
	}
	return { pauses, audioSource };
}

export async function loadVideoActivity(input: {
	projectPath: string;
	layout: RecordingLayout;
	clockOffsets: SegmentClockOffsets;
	micWaveforms: number[][] | undefined;
	systemWaveforms: number[][] | undefined;
}): Promise<VideoActivity> {
	const rawClicks = await commands
		.getCursorClicks(input.projectPath)
		.catch(() => [] as CursorClickInfo[]);
	const { clicks, ignored } = validClicks(
		input.layout,
		input.clockOffsets,
		rawClicks,
	);
	const { pauses, audioSource } = collectPauses(
		input.layout,
		input.micWaveforms,
		input.systemWaveforms,
	);
	return { clicks, ignoredClicks: ignored, pauses, audioSource };
}

export type WhisperModel = { name: string; path: string };

export const WHISPER_MODEL_PREFERENCE = [
	"small",
	"medium",
	"base",
	"large-v3",
	"tiny",
];

export async function findDownloadedWhisperModel(
	modelFolder: string,
	modelNames: string[],
): Promise<WhisperModel | null> {
	const folder = await join(await appLocalDataDir(), modelFolder);
	const ordered = [
		...WHISPER_MODEL_PREFERENCE.filter((name) => modelNames.includes(name)),
		...modelNames.filter((name) => !WHISPER_MODEL_PREFERENCE.includes(name)),
	];
	for (const name of ordered) {
		const path = await join(folder, `${name}.bin`);
		if (await commands.checkModelExists(path).catch(() => false)) {
			return { name, path };
		}
	}
	return null;
}

export async function transcribeRecording(
	projectPath: string,
	model: WhisperModel,
): Promise<CaptionSegment[]> {
	const result = await commands.transcribeAudio(
		projectPath,
		model.path,
		"auto",
	);
	return result.segments;
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("validClicks", () => {
		it("drops clicks outside the recorded area and converts times", () => {
			const layout = createRecordingLayout([10, 20]);
			const result = validClicks(
				layout,
				[0, 0.5],
				[
					{ segment_index: 0, time_secs: 2, x: 0.5, y: 0.5 },
					{ segment_index: 0, time_secs: 3, x: 1.4, y: 0.5 },
					{ segment_index: 0, time_secs: 4, x: 0.2, y: -0.1 },
					{ segment_index: 1, time_secs: 5.5, x: 0, y: 1 },
					{ segment_index: 1, time_secs: 99, x: 0.5, y: 0.5 },
				],
			);
			expect(result.clicks).toEqual([
				{ time: 2, x: 0.5, y: 0.5 },
				{ time: 15, x: 0, y: 1 },
			]);
			expect(result.ignored).toBe(3);
		});
	});

	describe("detectPauses", () => {
		it("finds quiet runs in a waveform", () => {
			const speech = Array.from({ length: 20 }, () => -20);
			const silence = Array.from({ length: 15 }, () => -60);
			const waveform = [
				...speech,
				...silence,
				...speech,
				...silence.slice(0, 3),
			];
			const pauses = detectPauses(waveform, 0.5);
			expect(pauses.length).toBe(1);
			expect(pauses[0].start).toBeCloseTo(2);
			expect(pauses[0].end).toBeCloseTo(3.5);
		});

		it("treats an all-quiet recording as one pause and flat speech as none", () => {
			expect(
				detectPauses(
					Array.from({ length: 10 }, () => -58),
					0.5,
				),
			).toEqual([{ start: 0, end: 1 }]);
			expect(
				detectPauses(
					Array.from({ length: 10 }, () => -20),
					0.5,
				),
			).toEqual([]);
		});
	});

	describe("segmentClockOffsets", () => {
		it("uses the latest stream start like the renderer", () => {
			expect(
				segmentClockOffsets([
					{
						display: { path: "d", start_time: 0.1 },
						mic: { path: "m", start_time: 0.25 },
					},
					{ display: { path: "d" } },
				]),
			).toEqual([0.25, 0]);
			expect(segmentClockOffsets(null)).toEqual([]);
		});
	});
}
