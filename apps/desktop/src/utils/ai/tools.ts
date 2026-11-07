import type { AgentTool } from "@earendil-works/pi-agent-core";
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
import { produce } from "solid-js/store";
import { commands, type ZoomMode, type ZoomSegment } from "~/utils/tauri";
import {
	buildContactSheet,
	frameFetchWidth,
	MAX_SHEET_FRAMES,
	type SheetFrame,
} from "./contact-sheet";
import { formatStoryRuns } from "./storyboard";
import {
	formatSeconds as fmt,
	sourceRangeToOutputRanges,
	sourceToOutput,
	sourceToSegment,
} from "./timebase";
import { createTimingTools } from "./timing-tools";
import {
	createToolContext,
	type EditorBridge,
	type EditorTools,
	MAX_LISTED_ITEMS,
	rangeEndParam,
	rangeStartParam,
	reasonParam,
	text,
} from "./tool-context";
import {
	describeTranscriptIssue,
	findFillers,
	findRepeatedPhrases,
	findRetakes,
	hasWordTimings,
} from "./transcript-check";
import { errorCost } from "./vision";
import { activeSpans } from "./visual";

export { MAX_SPEED, MIN_SPEED } from "./timing-tools";
export type { EditorBridge, EditorTools } from "./tool-context";

export const MAX_FRAMES_PER_CALL = MAX_SHEET_FRAMES;
export const MIN_ZOOM_AMOUNT = 1.1;
export const MAX_ZOOM_AMOUNT = 4.5;
export const DEFAULT_ZOOM_AMOUNT = 1.8;
export const MIN_ZOOM_SECONDS = 1;
const BOUNDARY_SLACK = 0.5;

export type EditorToolkit = { tools: EditorTools; overview: () => string };

export function createEditorTools(bridge: EditorBridge): EditorToolkit {
	const ctx = createToolContext(bridge);
	const {
		layout,
		currentSegments,
		currentSpans,
		currentZooms,
		assessment,
		describeZoomMode,
		validateRange,
		zoomLines,
		inWindow,
		statusLabel,
		overview,
	} = ctx;
	const timing = createTimingTools(ctx);
	const fillerAction = (range: { start: number; end: number }) => {
		const active = activeSpans(
			bridge.visual,
			range.start - 0.1,
			range.end + 0.1,
		);
		if (active.length === 0)
			return "screen idle: cut it (cut_range + allow_split_speech)";
		return "screen active: mute it (mute_range), do not cut";
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
			const checked = assessment();
			const lines = checked.lines;
			if (lines.length === 0) {
				return text(`No transcript is available. ${bridge.transcriptHint}`);
			}
			const issue = describeTranscriptIssue(checked);
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
			const extras: string[] = [];
			if (checked.reliable) {
				const windowed = <T extends { start: number; end: number }>(
					items: T[],
				) => items.filter((item) => inWindow(item, params.start, params.end));
				if (hasWordTimings(selected)) {
					const fillers = windowed(findFillers(lines));
					const repeats = windowed(findRepeatedPhrases(lines));
					extras.push(
						fillers.length > 0
							? `Filler words (source start–end | text | line; remove with cut_range + allow_split_speech):\n${fillers
									.slice(0, 80)
									.map(
										(f) =>
											`  ${fmt(f.start)}–${fmt(f.end)} | ${f.text} | ${f.lineId} | ${fillerAction(f)}${f.weak ? " | often a real word, check context" : ""}`,
									)
									.join("\n")}`
							: "Filler words: none found.",
					);
					extras.push(
						repeats.length > 0
							? `Repeated phrases (first take; the repeat follows right after, keep the last take):\n${repeats
									.slice(0, 40)
									.map(
										(r) =>
											`  ${fmt(r.start)}–${fmt(r.end)} | "${r.text}" | ${r.lineId}`,
									)
									.join("\n")}`
							: "Repeated phrases: none found.",
					);
				} else {
					extras.push(
						"No word timings, so filler words cannot be located precisely; cut only between lines or inside pauses.",
					);
				}
				const retakes = findRetakes(lines).filter((r) =>
					inWindow(
						{ start: r.first.start, end: r.second.end },
						params.start,
						params.end,
					),
				);
				if (retakes.length > 0) {
					extras.push(
						`Possible retakes (a line restarts the previous one; usually keep the last take):\n${retakes
							.slice(0, 20)
							.map(
								(r) =>
									`  ${r.first.id} (${fmt(r.first.start)}–${fmt(r.first.end)}) → ${r.second.id} (${fmt(r.second.start)}–${fmt(r.second.end)})`,
							)
							.join("\n")}`,
					);
				}
			}
			return text(
				[
					...(issue ? [issue] : []),
					`Transcript lines (source seconds): id | start–end | status | text`,
					...out,
					...extras,
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
					"Only list pauses at least this long, in seconds. Default 0.4.",
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
			const minPause = Math.max(0.2, params.min_pause ?? 0.4);
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

	const storyboardParams = obj({
		start: opt(num({ description: "Window start, source seconds." })),
		end: opt(num({ description: "Window end, source seconds." })),
	});
	const getStoryboard: AgentTool<typeof storyboardParams, undefined> = {
		name: "get_storyboard",
		label: "Storyboard",
		description:
			"Text timeline of what happens on screen, sampled every second: big changes (new page or dialog), content changes, small motion (cursor, typing, spinners), static stretches, and new on-screen text (OCR) at each change, with kept/cut status. Use it before view_frames to find waits, idle stretches and the steps of the tutorial.",
		parameters: storyboardParams,
		execute: async (_id, params) => {
			const runs = bridge.storyRuns;
			if (!runs) {
				return text(
					`The screen storyboard is unavailable (${bridge.storyboardNote}). Use view_frames instead.`,
				);
			}
			const spans = currentSpans();
			const lines = formatStoryRuns(
				runs,
				(range) =>
					sourceRangeToOutputRanges(spans, range.start, range.end).length > 0
						? statusLabel(spans, range)
						: "CUT",
				params,
			);
			if (lines.length === 0)
				return text("No storyboard entries in that window.");
			const shown = lines.slice(0, 200);
			return text(
				[
					"Screen storyboard (source seconds | what happens | status | new on-screen text):",
					...shown,
					...(lines.length > shown.length
						? [
								`… ${lines.length - shown.length} more; call again with start/end.`,
							]
						: []),
				].join("\n"),
			);
		},
	};

	const framesParams = obj({
		times: arr(
			num({ description: "Source second of the original recording." }),
			{
				description: `1 to ${MAX_FRAMES_PER_CALL} timestamps in source seconds.`,
			},
		),
		question: opt(
			str({
				description:
					"What you need to know about these frames, e.g. 'Is the app loading or waiting in #2–#4?' or 'Where is the Save button in #3 (x/y)?'.",
			}),
		),
	});
	const viewFrames: AgentTool<typeof framesParams, undefined> = {
		name: "view_frames",
		label: "View frames",
		description: bridge.vision
			? `Ask a vision assistant about the raw screen recording. Up to ${MAX_FRAMES_PER_CALL} source timestamps are combined into one labelled contact sheet (#1, #2, … in time order) and the assistant answers your question in text. You never see the images, so ask a specific question. Frames show the captured screen without zoom, background or captions. Batch timestamps into one call instead of many calls.`
			: `Look at the raw screen recording. Up to ${MAX_FRAMES_PER_CALL} source timestamps are combined into one labelled contact sheet image (#1, #2, … in time order) that is returned to you. Frames show the captured screen without zoom, background or captions. Batch timestamps into one call instead of many calls. The question parameter is not needed.`,
		parameters: framesParams,
		execute: async (_id, params, signal) => {
			const question = params.question?.trim() ?? "";
			if (bridge.vision && !question)
				throw new Error("Pass a question about the frames.");
			const times = [...params.times].sort((a, b) => a - b);
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
			const width = frameFetchWidth(times.length);
			const fetched = await Promise.all(
				times.map(async (t) => {
					const { recordingSegment, time } = sourceToSegment(layout, t);
					try {
						const data = await commands.getFrameJpeg(
							bridge.projectPath,
							recordingSegment,
							time,
							width,
						);
						return { t, data, error: null };
					} catch (error) {
						return { t, data: null, error: String(error) };
					}
				}),
			);
			signal?.throwIfAborted();
			const usable = fetched.filter(
				(f): f is { t: number; data: string; error: null } => f.data !== null,
			);
			if (usable.length === 0) {
				throw new Error(
					`Could not read frames: ${fetched.map((f) => f.error).join("; ")}`,
				);
			}
			const sheetFrames: SheetFrame[] = usable.map((f, index) => ({
				label: `#${index + 1}  ${fmt(f.t)}s`,
				data: f.data,
			}));
			const legend = usable.map((f, index) => {
				const output = sourceToOutput(spans, f.t);
				return `#${index + 1} = source ${fmt(f.t)} s (${output === null ? "currently cut" : `final ${fmt(output)} s`})`;
			});
			const missing = fetched
				.filter((f) => f.data === null)
				.map((f) => `${fmt(f.t)} (${f.error})`);
			const sheet = await buildContactSheet(sheetFrames);
			signal?.throwIfAborted();
			const vision = bridge.vision;
			if (!vision) {
				return {
					content: [
						{
							type: "text",
							text: [
								`Contact sheet of ${usable.length} frame(s):`,
								...legend,
								...(missing.length > 0
									? [`Unavailable frames: ${missing.join("; ")}`]
									: []),
							].join("\n"),
						},
						{ type: "image", data: sheet.data, mimeType: "image/jpeg" },
					],
					details: undefined,
				};
			}
			try {
				const answer = await vision.describe(
					{ image: sheet.data, question, frameLabels: legend },
					signal,
				);
				bridge.onHelperCost(answer.cost);
				return text(
					[
						`Vision assistant (${vision.model.name}) looked at ${usable.length} frame(s):`,
						...legend,
						...(missing.length > 0
							? [`Unavailable frames: ${missing.join("; ")}`]
							: []),
						"",
						answer.text,
					].join("\n"),
				);
			} catch (error) {
				bridge.onHelperCost(errorCost(error));
				throw error;
			}
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
			getStoryboard,
			viewFrames,
			timing.cutRange,
			timing.tightenPauses,
			timing.setSpeed,
			timing.muteRange,
			addZoom,
			removeZoom,
			setCaptions,
			timing.reviewEdit,
		],
		overview,
	};
}

export const EDIT_TOOL_NAMES = new Set([
	"cut_range",
	"tighten_pauses",
	"mute_range",
	"set_speed",
	"add_zoom",
	"remove_zoom",
	"set_captions",
]);
