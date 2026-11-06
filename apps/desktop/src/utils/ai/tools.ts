import type {
	AgentState,
	AgentTool,
	AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	arr,
	bool,
	int,
	num,
	obj,
	oneOf,
	opt,
	str,
} from "@earendil-works/pi-schema";
import { batch } from "solid-js";
import { produce, type SetStoreFunction } from "solid-js/store";
import {
	commands,
	type ProjectConfiguration,
	type SceneSegment,
	type TimelineSegment,
	type ZoomMode,
	type ZoomSegment,
} from "~/utils/tauri";
import {
	buildClipSpans,
	type ClipSpan,
	cutSourceRange,
	defaultTimelineSegments,
	formatSeconds as fmt,
	formatClock,
	keptSourceSeconds,
	outputDuration,
	outputRangeToSourceRanges,
	type RecordingLayout,
	remapOutputRanges,
	setSpeedInSourceRange,
	sourceRangeStatus,
	sourceRangeToOutputRanges,
	sourceToOutput,
	sourceToSegment,
	type TimeRange,
} from "./timebase";
import {
	type TranscriptLine,
	transcriptFromCaptions,
	type VideoActivity,
} from "./video-context";

export type EditorBridge = {
	project: ProjectConfiguration;
	setProject: SetStoreFunction<ProjectConfiguration>;
	onEdited: () => void;
	layout: RecordingLayout;
	projectPath: string;
	activity: VideoActivity;
	transcriptHint: string;
};

export const FRAME_WIDTH = 1024;
export const MAX_FRAMES_PER_CALL = 6;
export const MIN_SPEED = 1;
export const MAX_SPEED = 8;
export const MIN_ZOOM_AMOUNT = 1.1;
export const MAX_ZOOM_AMOUNT = 4.5;
export const DEFAULT_ZOOM_AMOUNT = 1.8;
export const MIN_ZOOM_SECONDS = 1;
const MIN_REMAPPED_ZOOM_SECONDS = 0.5;
const MIN_REMAPPED_SCENE_SECONDS = 0.3;
const MIN_EDIT_SECONDS = 0.1;
const MIN_VIDEO_SECONDS = 1;
const MAX_LISTED_ITEMS = 400;
const BOUNDARY_SLACK = 0.5;

type ToolResult = AgentToolResult<undefined>;

export type EditorTools = AgentState["tools"];

export type EditorToolkit = { tools: EditorTools; overview: () => string };

function text(value: string): ToolResult {
	return { content: [{ type: "text", text: value }], details: undefined };
}

const reasonParam = opt(
	str({
		description:
			"Short note on why you make this edit, shown to the user (e.g. 'long pause', 'false start').",
	}),
);

const rangeStartParam = num({
	description: "Start, in seconds of the original recording (source time).",
});
const rangeEndParam = num({
	description: "End, in seconds of the original recording (source time).",
});

export function createEditorTools(bridge: EditorBridge): EditorToolkit {
	const { layout } = bridge;

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
	const transcript = (): TranscriptLine[] =>
		transcriptFromCaptions(layout, bridge.project.captions?.segments);

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

	const overview = (): string => {
		const spans = currentSpans();
		const lines = transcript();
		const captions = bridge.project.captions;
		const { activity } = bridge;
		const longPauses = activity.pauses.filter((p) => p.duration >= 1).length;
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
				? `Transcript: ${lines.length} lines (captions shown in the video: ${captions?.settings.enabled ? "yes" : "no"}).`
				: `Transcript: none. ${bridge.transcriptHint}`,
			activity.audioSource === "none"
				? "Audio: none."
				: `Audio: ${activity.audioSource}. Detected pauses of 0.5 s or longer: ${activity.pauses.length} (${longPauses} of them 1 s or longer).`,
			`Clicks inside the recorded area: ${activity.clicks.length}${activity.ignoredClicks > 0 ? ` (${activity.ignoredClicks} clicks outside the recording were ignored)` : ""}.`,
		].join("\n");
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

	const lineWarnings = (
		boundaries: number[],
		lines: TranscriptLine[],
	): string[] => {
		const warnings: string[] = [];
		for (const boundary of boundaries) {
			const line = lines.find(
				(l) => boundary > l.start + 0.15 && boundary < l.end - 0.15,
			);
			if (line) {
				warnings.push(
					`Warning: the edit boundary at ${fmt(boundary)} falls inside transcript line ${line.id} (${fmt(line.start)}–${fmt(line.end)}: "${line.text.slice(0, 80)}"). Make sure no words are cut off.`,
				);
			}
		}
		return warnings;
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

	const overviewParams = obj({});
	const getOverview: AgentTool<typeof overviewParams, undefined> = {
		name: "get_overview",
		label: "Overview",
		description:
			"Current state of the edit: original and edited length, clips in playback order (source → final ranges and speed), zooms with their indices, transcript and audio availability, click count. All times are source seconds unless labelled final.",
		parameters: overviewParams,
		execute: async () => text(overview()),
	};

	const transcriptParams = obj({
		start: opt(
			num({ description: "Only lines ending after this source second." }),
		),
		end: opt(
			num({ description: "Only lines starting before this source second." }),
		),
	});
	const getTranscript: AgentTool<typeof transcriptParams, undefined> = {
		name: "get_transcript",
		label: "Transcript",
		description:
			"Speech transcript lines with id, source start–end and whether each line is still kept, already cut, or sped up. Optionally limit to a source time window. Cut between lines or inside pauses so sentences stay intact.",
		parameters: transcriptParams,
		execute: async (_id, params) => {
			const lines = transcript();
			if (lines.length === 0) {
				return text(`No transcript is available. ${bridge.transcriptHint}`);
			}
			const spans = currentSpans();
			const selected = lines.filter((l) =>
				inWindow(l, params.start, params.end),
			);
			if (selected.length === 0)
				return text("No transcript lines in that window.");
			const shown = selected.slice(0, MAX_LISTED_ITEMS);
			const out = shown.map(
				(l) =>
					`${l.id} | ${fmt(l.start)}–${fmt(l.end)} | ${statusLabel(spans, l)} | ${l.text}`,
			);
			if (selected.length > shown.length) {
				out.push(
					`… ${selected.length - shown.length} more lines; call again with start/end to read them.`,
				);
			}
			return text(
				[
					`Transcript lines (source seconds): id | start–end | status | text`,
					...out,
				].join("\n"),
			);
		},
	};

	const activityParams = obj({
		start: opt(num({ description: "Window start, source seconds." })),
		end: opt(num({ description: "Window end, source seconds." })),
		min_pause: opt(
			num({
				description:
					"Only list pauses at least this long, in seconds. Default 0.7.",
			}),
		),
	});
	const getActivity: AgentTool<typeof activityParams, undefined> = {
		name: "get_activity",
		label: "Activity",
		description:
			"Mouse clicks inside the recorded area (source time, x/y as 0..1 of the frame) and pauses/silences detected from the audio waveform (source ranges, with kept/cut status). Clicks made outside the recording are already removed.",
		parameters: activityParams,
		execute: async (_id, params) => {
			const spans = currentSpans();
			const minPause = Math.max(0.3, params.min_pause ?? 0.7);
			const clicks = bridge.activity.clicks.filter(
				(c) =>
					c.time >= (params.start ?? Number.NEGATIVE_INFINITY) &&
					c.time <= (params.end ?? Number.POSITIVE_INFINITY),
			);
			const pauses = bridge.activity.pauses.filter(
				(p) => p.duration >= minPause && inWindow(p, params.start, params.end),
			);
			const out: string[] = [];
			out.push(`Clicks (${clicks.length}): source time | x | y | status`);
			for (const click of clicks.slice(0, MAX_LISTED_ITEMS)) {
				const output = sourceToOutput(spans, click.time);
				out.push(
					`  ${fmt(click.time)} | ${click.x.toFixed(2)} | ${click.y.toFixed(2)} | ${output === null ? "CUT" : `final ${fmt(output)}`}`,
				);
			}
			if (clicks.length > MAX_LISTED_ITEMS)
				out.push(`  … ${clicks.length - MAX_LISTED_ITEMS} more clicks`);
			if (bridge.activity.audioSource === "none") {
				out.push("Pauses: no audio in this recording.");
			} else {
				out.push(
					`Pauses ≥ ${minPause.toFixed(1)} s from ${bridge.activity.audioSource} (${pauses.length}): source start–end | length | status`,
				);
				for (const pause of pauses.slice(0, MAX_LISTED_ITEMS)) {
					out.push(
						`  ${fmt(pause.start)}–${fmt(pause.end)} | ${pause.duration.toFixed(1)} s | ${statusLabel(spans, pause)}`,
					);
				}
				if (pauses.length > MAX_LISTED_ITEMS)
					out.push(`  … ${pauses.length - MAX_LISTED_ITEMS} more pauses`);
			}
			return text(out.join("\n"));
		},
	};

	const framesParams = obj({
		times: arr(
			num({ description: "Source second of the original recording." }),
			{
				description: `1 to ${MAX_FRAMES_PER_CALL} timestamps in source seconds.`,
			},
		),
	});
	const viewFrames: AgentTool<typeof framesParams, undefined> = {
		name: "view_frames",
		label: "View frames",
		description: `Look at the raw screen recording at up to ${MAX_FRAMES_PER_CALL} source timestamps per call. Images are the captured screen without zoom, background or captions. Use it to check what is on screen before zooming, or whether a stretch is waiting, typing or loading.`,
		parameters: framesParams,
		execute: async (_id, params, signal) => {
			const times = params.times;
			if (times.length === 0 || times.length > MAX_FRAMES_PER_CALL) {
				throw new Error(
					`Pass between 1 and ${MAX_FRAMES_PER_CALL} timestamps (got ${times.length}).`,
				);
			}
			for (const t of times) {
				if (!Number.isFinite(t) || t < 0 || t > layout.total + BOUNDARY_SLACK) {
					throw new Error(
						`Timestamp ${t} is outside the recording (0.00–${fmt(layout.total)}).`,
					);
				}
			}
			const spans = currentSpans();
			const frames = await Promise.all(
				times.map(async (t) => {
					const { recordingSegment, time } = sourceToSegment(layout, t);
					try {
						const data = await commands.getFrameJpeg(
							bridge.projectPath,
							recordingSegment,
							time,
							FRAME_WIDTH,
						);
						return { t, data, error: null };
					} catch (error) {
						return { t, data: null, error: String(error) };
					}
				}),
			);
			signal?.throwIfAborted();
			if (frames.every((f) => f.data === null)) {
				throw new Error(
					`Could not read frames: ${frames.map((f) => f.error).join("; ")}`,
				);
			}
			const content: (TextContent | ImageContent)[] = [];
			for (const frame of frames) {
				const output = sourceToOutput(spans, frame.t);
				content.push({
					type: "text",
					text: `Frame at source ${fmt(frame.t)} (${output === null ? "currently cut" : `final ${fmt(output)}`})${frame.error ? `: unavailable (${frame.error})` : ""}`,
				});
				if (frame.data) {
					content.push({
						type: "image",
						data: frame.data,
						mimeType: "image/jpeg",
					});
				}
			}
			return { content, details: undefined };
		},
	};

	const cutParams = obj({
		start: rangeStartParam,
		end: rangeEndParam,
		reason: reasonParam,
	});
	const cutRange: AgentTool<typeof cutParams, undefined> = {
		name: "cut_range",
		label: "Cut",
		description:
			"Remove a source time range from the edited video. Only currently kept parts inside the range are affected. Zooms move with their content. Times are source seconds; they stay valid after the cut.",
		parameters: cutParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const range = validateRange(params.start, params.end);
			const before = currentSpans();
			const removed = keptSourceSeconds(before, range.start, range.end);
			if (removed < 0.01) {
				throw new Error(
					`Nothing to cut: ${fmt(range.start)}–${fmt(range.end)} is already removed.`,
				);
			}
			const nextSegments = cutSourceRange(
				currentSegments(),
				layout,
				range.start,
				range.end,
			);
			const nextDuration = outputDuration(buildClipSpans(nextSegments, layout));
			if (nextSegments.length === 0 || nextDuration < MIN_VIDEO_SECONDS) {
				throw new Error("This cut would remove the whole video.");
			}
			const { after, notes } = commitTimeline(before, nextSegments);
			const warnings = lineWarnings([range.start, range.end], transcript());
			return text(
				[
					`Cut source ${fmt(range.start)}–${fmt(range.end)} (${removed.toFixed(2)} s of kept video removed).`,
					durationLine(after),
					...notes,
					...warnings,
				].join("\n"),
			);
		},
	};

	const speedParams = obj({
		start: rangeStartParam,
		end: rangeEndParam,
		speed: num({
			description: `Playback speed, ${MIN_SPEED} to ${MAX_SPEED}. 1 restores normal speed. Typical: 1.5–4.`,
		}),
		reason: reasonParam,
	});
	const setSpeed: AgentTool<typeof speedParams, undefined> = {
		name: "set_speed",
		label: "Speed",
		description:
			"Change playback speed for a source time range (only parts still kept). Audio is not time-stretched and sounds choppy when sped up, so only speed up ranges where nobody is speaking. Zooms move with their content.",
		parameters: speedParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const range = validateRange(params.start, params.end);
			if (
				!Number.isFinite(params.speed) ||
				params.speed < MIN_SPEED ||
				params.speed > MAX_SPEED
			) {
				throw new Error(
					`speed must be between ${MIN_SPEED} and ${MAX_SPEED} (got ${params.speed}).`,
				);
			}
			const speed = Math.round(params.speed * 100) / 100;
			const before = currentSpans();
			if (keptSourceSeconds(before, range.start, range.end) < 0.01) {
				throw new Error(
					`Nothing to change: ${fmt(range.start)}–${fmt(range.end)} has been cut.`,
				);
			}
			const nextSegments = setSpeedInSourceRange(
				currentSegments(),
				layout,
				range.start,
				range.end,
				speed,
			);
			const { after, notes } = commitTimeline(before, nextSegments);
			const speech = transcript().filter(
				(l) =>
					Math.min(l.end, range.end) - Math.max(l.start, range.start) > 0.3,
			);
			const warnings =
				speed > 1 && speech.length > 0
					? [
							`Warning: ${speech.length} transcript line(s) overlap this range (${speech
								.slice(0, 3)
								.map((l) => l.id)
								.join(
									", ",
								)}). Sped-up speech sounds choppy; revert with speed 1 unless that is intended.`,
						]
					: [];
			return text(
				[
					`Set source ${fmt(range.start)}–${fmt(range.end)} to ${speed}x.`,
					durationLine(after),
					...notes,
					...warnings,
				].join("\n"),
			);
		},
	};

	const zoomParams = obj({
		start: rangeStartParam,
		end: rangeEndParam,
		amount: opt(
			num({
				description: `Zoom factor ${MIN_ZOOM_AMOUNT}–${MAX_ZOOM_AMOUNT}. Default ${DEFAULT_ZOOM_AMOUNT}. Typical 1.5–2.2.`,
			}),
		),
		focus: opt(
			oneOf(["auto", "manual"], {
				description:
					'"auto" follows the cursor (default). "manual" zooms on the fixed point x, y.',
			}),
		),
		x: opt(
			num({
				description: "Manual focus x, 0 (left) to 1 (right) of the frame.",
			}),
		),
		y: opt(
			num({
				description: "Manual focus y, 0 (top) to 1 (bottom) of the frame.",
			}),
		),
		reason: reasonParam,
	});
	const addZoom: AgentTool<typeof zoomParams, undefined> = {
		name: "add_zoom",
		label: "Zoom",
		description: `Add a zoom over a source time range. It is placed on the final timeline where that content plays now and moves with later cuts. Must last at least ${MIN_ZOOM_SECONDS} s on the final timeline (1.5 s or more looks best) and must not overlap an existing zoom (remove that one first).`,
		parameters: zoomParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const range = validateRange(params.start, params.end);
			const amount = params.amount ?? DEFAULT_ZOOM_AMOUNT;
			if (
				!Number.isFinite(amount) ||
				amount < MIN_ZOOM_AMOUNT ||
				amount > MAX_ZOOM_AMOUNT
			) {
				throw new Error(
					`amount must be between ${MIN_ZOOM_AMOUNT} and ${MAX_ZOOM_AMOUNT} (got ${amount}).`,
				);
			}
			const manual =
				params.focus === "manual" ||
				(params.focus === undefined &&
					params.x !== undefined &&
					params.y !== undefined);
			let mode: ZoomMode = "auto";
			if (manual) {
				const { x, y } = params;
				if (
					x === undefined ||
					y === undefined ||
					!Number.isFinite(x) ||
					!Number.isFinite(y) ||
					x < 0 ||
					x > 1 ||
					y < 0 ||
					y > 1
				) {
					throw new Error('focus "manual" needs x and y between 0 and 1.');
				}
				mode = { manual: { x, y } };
			}
			const spans = currentSpans();
			const outputs = sourceRangeToOutputRanges(spans, range.start, range.end);
			if (outputs.length === 0) {
				throw new Error(
					`Source ${fmt(range.start)}–${fmt(range.end)} has been cut, so it cannot be zoomed.`,
				);
			}
			const target = {
				start: outputs[0].start,
				end: outputs[outputs.length - 1].end,
			};
			if (target.end - target.start < MIN_ZOOM_SECONDS) {
				throw new Error(
					`That range lasts only ${(target.end - target.start).toFixed(2)} s on the final timeline; zooms need at least ${MIN_ZOOM_SECONDS} s.`,
				);
			}
			const zooms = currentZooms();
			const conflicts = zooms
				.map((z, index) => ({ z, index }))
				.filter(
					({ z }) => z.start < target.end - 1e-3 && z.end > target.start + 1e-3,
				);
			if (conflicts.length > 0) {
				throw new Error(
					`Overlaps ${conflicts
						.map(
							({ z, index }) =>
								`zoom ${index} (final ${fmt(z.start)}–${fmt(z.end)})`,
						)
						.join(", ")}. Remove it first or pick another range.`,
				);
			}
			const zoom: ZoomSegment = { ...target, amount, mode };
			const index = zooms.filter((z) => z.start < zoom.start).length;
			batch(() => {
				bridge.setProject(
					produce((project) => {
						if (!project.timeline) {
							project.timeline = {
								segments: currentSegments(),
								zoomSegments: [zoom],
								sceneSegments: [],
							};
							return;
						}
						project.timeline.zoomSegments ??= [];
						project.timeline.zoomSegments.splice(index, 0, zoom);
					}),
				);
				bridge.onEdited();
			});
			return text(
				[
					`Added zoom ${index}: source ${fmt(range.start)}–${fmt(range.end)} → final ${fmt(zoom.start)}–${fmt(zoom.end)}, ${amount.toFixed(1)}x, ${describeZoomMode(mode)}.`,
					"Zooms now:",
					...zoomLines(spans, currentZooms()),
				].join("\n"),
			);
		},
	};

	const removeZoomParams = obj({
		index: int({ description: "Zoom index from get_overview or add_zoom." }),
	});
	const removeZoom: AgentTool<typeof removeZoomParams, undefined> = {
		name: "remove_zoom",
		label: "Remove zoom",
		description:
			"Delete one zoom by index. Indices of later zooms shift down by one.",
		parameters: removeZoomParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const zooms = currentZooms();
			if (
				!Number.isInteger(params.index) ||
				params.index < 0 ||
				params.index >= zooms.length
			) {
				throw new Error(
					`No zoom ${params.index}. There are ${zooms.length} zooms (indices 0–${Math.max(0, zooms.length - 1)}).`,
				);
			}
			batch(() => {
				bridge.setProject(
					produce((project) => {
						project.timeline?.zoomSegments.splice(params.index, 1);
					}),
				);
				bridge.onEdited();
			});
			return text(
				[
					`Removed zoom ${params.index}.`,
					"Zooms now:",
					...zoomLines(currentSpans(), currentZooms()),
				].join("\n"),
			);
		},
	};

	const captionParams = obj({
		enabled: opt(
			bool({
				description: "Show captions burned into the video, or hide them.",
			}),
		),
		fixes: opt(
			arr(
				obj({
					id: str({ description: "Transcript line id." }),
					text: str({ description: "Corrected caption text." }),
				}),
				{
					description:
						"Corrections for misheard words, names or punctuation. Keep the meaning and language.",
				},
			),
		),
	});
	const setCaptions: AgentTool<typeof captionParams, undefined> = {
		name: "set_captions",
		label: "Captions",
		description:
			"Turn burned-in captions on or off and fix caption text by transcript line id. Timing is unchanged; captions follow cuts automatically.",
		parameters: captionParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const captions = bridge.project.captions;
			if (!captions || captions.segments.length === 0) {
				throw new Error(
					"There are no captions in this project. The user has to generate them in the Captions tab first.",
				);
			}
			if (params.enabled === undefined && !params.fixes?.length) {
				throw new Error("Pass enabled and/or fixes.");
			}
			const fixes = params.fixes ?? [];
			const ids = new Set(captions.segments.map((s) => s.id));
			const unknown = fixes.filter((f) => !ids.has(f.id)).map((f) => f.id);
			if (unknown.length > 0) {
				throw new Error(
					`Unknown transcript line id(s): ${unknown.join(", ")}.`,
				);
			}
			const empty = fixes.filter((f) => f.text.trim().length === 0);
			if (empty.length > 0) {
				throw new Error(
					`Caption text cannot be empty (${empty.map((f) => f.id).join(", ")}). Cut the range instead.`,
				);
			}
			const byId = new Map(fixes.map((f) => [f.id, f.text.trim()]));
			batch(() => {
				bridge.setProject(
					produce((project) => {
						if (!project.captions) return;
						for (const segment of project.captions.segments) {
							const fixed = byId.get(segment.id);
							if (fixed !== undefined) segment.text = fixed;
						}
						if (params.enabled !== undefined) {
							project.captions.settings.enabled = params.enabled;
						}
					}),
				);
				bridge.onEdited();
			});
			const parts: string[] = [];
			if (fixes.length > 0)
				parts.push(`Updated ${fixes.length} caption line(s).`);
			if (params.enabled !== undefined)
				parts.push(
					params.enabled
						? "Captions are now shown."
						: "Captions are now hidden.",
				);
			return text(parts.join(" "));
		},
	};

	return {
		tools: [
			getOverview,
			getTranscript,
			getActivity,
			viewFrames,
			cutRange,
			setSpeed,
			addZoom,
			removeZoom,
			setCaptions,
		],
		overview,
	};
}

export const EDIT_TOOL_NAMES = new Set([
	"cut_range",
	"set_speed",
	"add_zoom",
	"remove_zoom",
	"set_captions",
]);
