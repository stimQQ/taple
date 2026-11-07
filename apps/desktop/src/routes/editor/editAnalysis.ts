import {
	buildStoryRuns,
	loadStoryboard,
	type StoryRun,
} from "~/utils/ai/storyboard";
import {
	layoutFromSegmentDurations,
	type RecordingLayout,
} from "~/utils/ai/timebase";
import {
	loadVideoActivity,
	segmentClockOffsets,
	type VideoActivity,
} from "~/utils/ai/video-context";
import {
	buildVisualMap,
	loadVisualActivity,
	type VisualMap,
} from "~/utils/ai/visual";
import { L } from "~/utils/i18n";
import type {
	MultipleSegment,
	SerializedEditorInstance,
	TimelineSegment,
} from "~/utils/tauri";

export type RecordingAnalysis = {
	layout: RecordingLayout;
	activity: VideoActivity;
	storyRuns: StoryRun[] | null;
	storyboardNote: string;
	visual: VisualMap;
};

export function multipleSegments(meta: unknown): MultipleSegment[] | null {
	if (typeof meta !== "object" || meta === null) return null;
	const segments = (meta as { segments?: unknown }).segments;
	return Array.isArray(segments) ? (segments as MultipleSegment[]) : null;
}

export function startScreenAnalysis(projectPath: string) {
	return {
		storyboard: loadStoryboard(projectPath).then(
			(entries) => ({ entries, error: null as string | null }),
			(error) => ({ entries: null, error: String(error) }),
		),
		visual: loadVisualActivity(projectPath),
	};
}

export type ScreenAnalysis = ReturnType<typeof startScreenAnalysis>;

export async function analyzeRecording(input: {
	editorInstance: SerializedEditorInstance;
	meta: unknown;
	timelineSegments: TimelineSegment[] | undefined;
	micWaveforms: () => Promise<number[][]>;
	systemWaveforms: () => Promise<number[][]>;
	screen?: ScreenAnalysis;
	onPhase?: (phase: string) => void;
}): Promise<RecordingAnalysis> {
	const projectPath = input.editorInstance.path;
	const screen = input.screen ?? startScreenAnalysis(projectPath);
	const durations = input.editorInstance.recordings.segments.map((s) =>
		Math.max(s.display.duration, s.camera?.duration ?? 0, s.mic?.duration ?? 0),
	);
	const layout = layoutFromSegmentDurations(durations, input.timelineSegments);
	const [mic, system] = await Promise.all([
		input.micWaveforms(),
		input.systemWaveforms(),
	]);
	const activity = await loadVideoActivity({
		projectPath,
		layout,
		clockOffsets: segmentClockOffsets(multipleSegments(input.meta)),
		micWaveforms: mic,
		systemWaveforms: system,
	});

	input.onPhase?.(
		L(
			"正在分析画面变化和屏幕文字…",
			"Analyzing screen changes and on-screen text…",
		),
	);
	const [board, visualData] = await Promise.all([
		screen.storyboard,
		screen.visual,
	]);
	const storyRuns = board.entries
		? buildStoryRuns(layout, board.entries)
		: null;

	return {
		layout,
		activity,
		storyRuns,
		storyboardNote: board.error ?? "",
		visual: buildVisualMap({
			layout,
			data: visualData,
			storyRuns,
			clicks: activity.clicks,
		}),
	};
}
