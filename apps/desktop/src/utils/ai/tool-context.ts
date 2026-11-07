import type {
	AgentState,
	AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { bool, num, opt, str } from "@earendil-works/pi-schema";
import { batch } from "solid-js";
import { produce, type SetStoreFunction } from "solid-js/store";
import { isChinese } from "~/utils/i18n";
import type {
	ProjectConfiguration,
	SceneSegment,
	TimelineSegment,
	ZoomMode,
	ZoomSegment,
} from "~/utils/tauri";
import type { AllowedSplit } from "./review";
import { speechText } from "./review";
import { buildSpeechMap, type CaptionWord, type SpeechMap } from "./speech";
import { type StoryRun, summarizeStoryRuns } from "./storyboard";
import {
	buildClipSpans,
	type ClipSpan,
	defaultTimelineSegments,
	formatSeconds as fmt,
	formatClock,
	outputDuration,
	outputRangeToSourceRanges,
	type RecordingLayout,
	remapOutputRanges,
	segmentToSource,
	sourceRangeStatus,
	sourceRangeToOutputRanges,
	sourceToOutput,
	type TimeRange,
} from "./timebase";
import {
	assessTranscript,
	describeTranscriptIssue,
	type TranscriptAssessment,
} from "./transcript-check";
import {
	type TranscriptLine,
	transcriptFromCaptions,
	type VideoActivity,
} from "./video-context";
import type { VisionHelper } from "./vision";
import { type ActivitySpan, activeSpans, type VisualMap } from "./visual";

export type EditorBridge = {
	project: ProjectConfiguration;
	setProject: SetStoreFunction<ProjectConfiguration>;
	onEdited: () => void;
	layout: RecordingLayout;
	projectPath: string;
	activity: VideoActivity;
	transcriptHint: string;
	vision: VisionHelper | null;
	onHelperCost: (cost: number) => void;
	storyRuns: StoryRun[] | null;
	storyboardNote: string;
	visual: VisualMap;
};

export type MuteRange = {
	recordingSegment: number;
	start: number;
	end: number;
};

export type EditorTools = AgentState["tools"];

export const MIN_EDIT_SECONDS = 0.1;
export const MIN_VIDEO_SECONDS = 1;
export const MAX_LISTED_ITEMS = 400;
const BOUNDARY_SLACK = 0.5;
const MIN_REMAPPED_ZOOM_SECONDS = 0.5;
const MIN_REMAPPED_SCENE_SECONDS = 0.3;

export type ToolResult = AgentToolResult<undefined>;

export function text(value: string): ToolResult {
	return { content: [{ type: "text", text: value }], details: undefined };
}

export const reasonParam = opt(
	str({
		description: isChinese
			? "Very short note on why you make this edit, shown to the user. Write it in Simplified Chinese (e.g. '长停顿', '说错重来')."
			: "Very short note on why you make this edit, shown to the user (e.g. 'long pause', 'false start').",
	}),
);

export const rangeStartParam = num({
	description: "Start, in seconds of the original recording (source time).",
});

export const rangeEndParam = num({
	description: "End, in seconds of the original recording (source time).",
});

export const allowSplitSpeechParam = opt(
	bool({
		description:
			"Set only to cut or speed up inside speech on purpose (a filler word, a repeated phrase, a false start mid-sentence, or the user asked to cut the opening). Boundaries then snap to word gaps. Requires reason.",
	}),
);

export const allowCutActivityParam = opt(
	bool({
		description:
			"Set only when the user explicitly asked to remove a stretch with visible activity (cursor moving, clicks, screen changes). Without it, active parts are kept automatically. Requires reason.",
	}),
);

export const allowSpeedActivityParam = opt(
	bool({
		description:
			"Set only when the user explicitly asked to speed up a stretch with user activity or without progress on screen. Requires reason.",
	}),
);

export function createToolContext(bridge: EditorBridge) {
	const { layout } = bridge;
	const allowedSplits: AllowedSplit[] = [];
	const allowedActivity: (TimeRange & { reason: string })[] = [];
	const mutedRanges: (TimeRange & { reason: string })[] = [];

	const currentSegments = (): TimelineSegment[] => {
		const segments = bridge.project.timeline?.segments;
		if (segments && segments.length > 0) return segments.map((s) => ({ ...s }));
		return defaultTimelineSegments(layout);
	};
	const currentSpans = (): ClipSpan[] =>
		buildClipSpans(currentSegments(), layout);
	const currentZooms = (): ZoomSegment[] =>
		(bridge.project.timeline?.zoomSegments ?? []).map((z) => ({
			...z,
			mode:
				typeof z.mode === "string" ? z.mode : { manual: { ...z.mode.manual } },
		}));
	const currentScenes = (): SceneSegment[] | null => {
		const scenes = bridge.project.timeline?.sceneSegments;
		return scenes ? scenes.map((s) => ({ ...s })) : null;
	};
	const assessment = (): TranscriptAssessment =>
		assessTranscript(
			transcriptFromCaptions(layout, bridge.project.captions?.segments),
		);
	const trustedTranscript = (): TranscriptLine[] => {
		const checked = assessment();
		return checked.reliable ? checked.lines : [];
	};
	const trustedWords = (): CaptionWord[] =>
		trustedTranscript()
			.flatMap((l) => l.words ?? [])
			.sort((a, b) => a.start - b.start);

	let cachedSpeech: { key: string; map: SpeechMap } | null = null;
	const speechMap = (): SpeechMap => {
		const lines = trustedTranscript();
		const key = `${lines.length}:${lines[0]?.start ?? ""}:${lines[0]?.end ?? ""}:${lines.reduce((n, l) => n + (l.words?.length ?? 0), 0)}`;
		if (cachedSpeech?.key === key) return cachedSpeech.map;
		const words = lines.flatMap((l) => l.words ?? []);
		const firstLine = lines[0];
		const firstBase = bridge.activity.speechBase.intervals[0];
		const firstSentence: TimeRange | null = firstLine
			? { start: firstLine.start, end: firstLine.end }
			: firstBase
				? { ...firstBase }
				: null;
		const map = buildSpeechMap({
			base: bridge.activity.speechBase,
			words: words.map((w) => ({ start: w.start, end: w.end })),
			firstSentence,
		});
		cachedSpeech = { key, map };
		return map;
	};
	const describeSpeech = (range: TimeRange) =>
		speechText(trustedTranscript(), range) ?? "speech";

	const keptActivity = (
		spans: ClipSpan[],
		range: TimeRange,
		filter?: (span: ActivitySpan) => boolean,
	): ActivitySpan[] =>
		activeSpans(bridge.visual, range.start, range.end, filter).filter(
			(span) =>
				sourceRangeToOutputRanges(
					spans,
					Math.max(span.start, range.start),
					Math.min(span.end, range.end),
				).length > 0,
		);

	const progressIn = (range: TimeRange): StoryRun[] =>
		(bridge.storyRuns ?? []).filter(
			(r) =>
				r.progress &&
				Math.min(r.end, range.end) - Math.max(r.start, range.start) > 0.25,
		);

	const muteRanges = (): MuteRange[] =>
		(bridge.project.audio.muteRanges ?? []).map((r) => ({
			recordingSegment: r.recordingSegment ?? 0,
			start: r.start,
			end: r.end,
		}));

	const mutedSourceRanges = (): TimeRange[] =>
		muteRanges()
			.filter((r) => r.end > r.start)
			.map((r) => ({
				start: segmentToSource(layout, r.recordingSegment, r.start),
				end: segmentToSource(layout, r.recordingSegment, r.end),
			}));

	const setMuteRanges = (ranges: MuteRange[]) => {
		batch(() => {
			bridge.setProject(
				produce((project) => {
					project.audio.muteRanges = ranges;
				}),
			);
			bridge.onEdited();
		});
	};

	const validateRange = (start: number, end: number) => {
		if (!Number.isFinite(start) || !Number.isFinite(end)) {
			throw new Error("start and end must be numbers of seconds.");
		}
		if (start < -BOUNDARY_SLACK || end > layout.total + BOUNDARY_SLACK) {
			throw new Error(
				`Range ${fmt(start)}–${fmt(end)} is outside the recording (0.00–${fmt(layout.total)} source seconds).`,
			);
		}
		const s = Math.max(0, start);
		const e = Math.min(layout.total, end);
		if (e - s < MIN_EDIT_SECONDS) {
			throw new Error(
				`end must be at least ${MIN_EDIT_SECONDS} s after start (got ${fmt(start)}–${fmt(end)}).`,
			);
		}
		return { start: s, end: e };
	};

	const describeZoomMode = (mode: ZoomMode) =>
		mode === "auto"
			? "follows cursor"
			: `fixed point x=${mode.manual.x.toFixed(2)} y=${mode.manual.y.toFixed(2)}`;

	const sourceHull = (
		spans: ClipSpan[],
		range: TimeRange,
	): TimeRange | null => {
		const sources = outputRangeToSourceRanges(spans, range.start, range.end);
		if (sources.length === 0) return null;
		return { start: sources[0].start, end: sources[sources.length - 1].end };
	};

	const zoomLines = (spans: ClipSpan[], zooms: ZoomSegment[]) => {
		if (zooms.length === 0) return ["  (none)"];
		return zooms.map((zoom, index) => {
			const source = sourceHull(spans, zoom);
			const sourceText = source
				? `source ${fmt(source.start)}–${fmt(source.end)}`
				: "source (cut)";
			return `  zoom ${index}: ${sourceText}, final ${fmt(zoom.start)}–${fmt(zoom.end)}, ${zoom.amount.toFixed(1)}x, ${describeZoomMode(zoom.mode)}`;
		});
	};

	const clipLines = (spans: ClipSpan[]) => {
		const lines = spans.slice(0, 60).map((span) => {
			const speed =
				span.speed !== 1 ? ` at ${Number(span.speed.toFixed(2))}x` : "";
			return `  clip ${span.index}: source ${fmt(span.sourceStart)}–${fmt(span.sourceEnd)}${speed} → final ${fmt(span.outputStart)}–${fmt(span.outputEnd)}`;
		});
		if (spans.length > 60) lines.push(`  … ${spans.length - 60} more clips`);
		return lines;
	};

	const durationLine = (spans: ClipSpan[]) => {
		const edited = outputDuration(spans);
		return `Original length ${fmt(layout.total)} s (${formatClock(layout.total)}); edited length ${fmt(edited)} s (${formatClock(edited)}).`;
	};

	const inWindow = (range: TimeRange, start?: number, end?: number) =>
		range.end > (start ?? Number.NEGATIVE_INFINITY) &&
		range.start < (end ?? Number.POSITIVE_INFINITY);

	const statusLabel = (spans: ClipSpan[], range: TimeRange) => {
		const status = sourceRangeStatus(spans, range.start, range.end);
		if (status === "cut") return "CUT";
		const output = sourceToOutput(spans, range.start);
		const span = spans.find(
			(s) => range.start >= s.sourceStart && range.start < s.sourceEnd,
		);
		const speed =
			span && span.speed !== 1 ? ` ${Number(span.speed.toFixed(2))}x` : "";
		const final = output !== null ? ` @final ${fmt(output)}` : "";
		return `${status === "kept" ? "kept" : "partly cut"}${speed}${final}`;
	};

	const commitTimeline = (
		before: ClipSpan[],
		nextSegments: TimelineSegment[],
	) => {
		const after = buildClipSpans(nextSegments, layout);
		const zooms = remapOutputRanges(
			before,
			after,
			currentZooms(),
			MIN_REMAPPED_ZOOM_SECONDS,
		);
		const existingScenes = currentScenes();
		const scenes = existingScenes
			? remapOutputRanges(
					before,
					after,
					existingScenes,
					MIN_REMAPPED_SCENE_SECONDS,
				)
			: null;
		batch(() => {
			bridge.setProject(
				produce((project) => {
					if (!project.timeline) {
						project.timeline = {
							segments: nextSegments,
							zoomSegments: zooms.items,
							sceneSegments: scenes?.items ?? [],
						};
						return;
					}
					project.timeline.segments = nextSegments;
					project.timeline.zoomSegments = zooms.items;
					if (scenes) project.timeline.sceneSegments = scenes.items;
				}),
			);
			bridge.onEdited();
		});
		const notes: string[] = [];
		if (zooms.dropped > 0)
			notes.push(
				`${zooms.dropped} zoom(s) inside the removed part were deleted.`,
			);
		if (zooms.changed > 0)
			notes.push(`${zooms.changed} zoom(s) moved with their content.`);
		if (scenes && scenes.dropped > 0)
			notes.push(`${scenes.dropped} scene segment(s) were removed.`);
		return { after, notes };
	};

	const overview = (): string => {
		const spans = currentSpans();
		const checked = assessment();
		const lines = checked.lines;
		const transcriptIssue = describeTranscriptIssue(checked);
		const captions = bridge.project.captions;
		const { activity } = bridge;
		const longPauses = activity.pauses.filter((p) => p.duration >= 1).length;
		const speech = speechMap();
		const words = trustedWords().length;
		return [
			`Time base: every time you pass to or read from tools is in seconds of the ORIGINAL recording ("source time", 0.00–${fmt(layout.total)}). Cuts and speed changes never shift source times. "final" times are positions in the edited video, for reference only.`,
			durationLine(spans),
			`Recording segments: ${layout.durations.length}.`,
			"Clips in playback order:",
			...clipLines(spans),
			"Zooms (final timeline order):",
			...zoomLines(spans, currentZooms()),
			`Scene segments: ${currentScenes()?.length ?? 0}.`,
			lines.length > 0
				? `Transcript: ${lines.length} lines${words > 0 ? ` with ${words} word timings` : " (no word timings)"} (captions shown in the video: ${captions?.settings.enabled ? "yes" : "no"}).${transcriptIssue ? ` ${transcriptIssue}` : ""}`
				: `Transcript: none. ${bridge.transcriptHint}`,
			activity.audioSource === "none"
				? "Audio: none."
				: `Audio: ${activity.audioSource} (${activity.audioNote}). Detected pauses of 0.3 s or longer: ${activity.pauses.length} (${longPauses} of them 1 s or longer).`,
			`Speech boundaries for snapping: ${speech.note}${speech.strict ? "" : " (lenient: boundaries are snapped when possible but never refused)"}.${speech.firstSentence ? ` Opening sentence: ${fmt(speech.firstSentence.start)}–${fmt(speech.firstSentence.end)}.` : ""}`,
			bridge.storyRuns
				? `Screen storyboard: ${summarizeStoryRuns(bridge.storyRuns)}. Call get_storyboard for the timeline.`
				: `Screen storyboard: unavailable (${bridge.storyboardNote}).`,
			`Visual activity used to protect user actions: ${bridge.visual.note}; ${bridge.visual.spans.length} active stretch(es).`,
			`Audio mute ranges: ${muteRanges().length} (mute_range mutes a filler that falls inside visual activity).`,
			`Clicks inside the recorded area: ${activity.clicks.length}${activity.ignoredClicks > 0 ? ` (${activity.ignoredClicks} clicks outside the recording were ignored)` : ""}.`,
		].join("\n");
	};

	return {
		bridge,
		layout,
		allowedSplits,
		allowedActivity,
		mutedRanges,
		currentSegments,
		currentSpans,
		currentZooms,
		currentScenes,
		assessment,
		trustedTranscript,
		trustedWords,
		speechMap,
		describeSpeech,
		keptActivity,
		progressIn,
		muteRanges,
		mutedSourceRanges,
		setMuteRanges,
		validateRange,
		describeZoomMode,
		zoomLines,
		durationLine,
		inWindow,
		statusLabel,
		commitTimeline,
		overview,
	};
}

export type ToolContext = ReturnType<typeof createToolContext>;
