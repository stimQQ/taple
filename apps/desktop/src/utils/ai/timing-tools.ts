import type { AgentTool } from "@earendil-works/pi-agent-core";
import { num, obj, opt } from "@earendil-works/pi-schema";
import { planCut } from "./cut-plan";
import {
	buildPieces,
	dropSlivers,
	type FragmentAction,
	fixShortPieces,
	MICRO_CUT_SECONDS,
	MIN_FRAGMENT_SECONDS,
} from "./fragments";
import { buildReview } from "./review";
import { snapRange, WORD_PAD } from "./snapping";
import { speechGaps, speechOverlapping, speechSecondsIn } from "./speech";
import {
	buildClipSpans,
	type ClipSpan,
	cutSourceRange,
	formatSeconds as fmt,
	keptSourceSeconds,
	outputDuration,
	setSpeedInSourceRange,
	sourceToSegment,
	type TimeRange,
} from "./timebase";
import {
	allowCutActivityParam,
	allowSpeedActivityParam,
	allowSplitSpeechParam,
	MIN_VIDEO_SECONDS,
	type MuteRange,
	rangeEndParam,
	rangeStartParam,
	reasonParam,
	type ToolContext,
	text,
} from "./tool-context";
import { findFillers } from "./transcript-check";
import { activeSeconds, describeSpans, isUserActivity } from "./visual";

export const MIN_SPEED = 1;
export const MAX_SPEED = 8;
export const DEFAULT_MIN_PAUSE_SECONDS = 0.3;
const SPEECH_IN_SPEEDUP_SECONDS = 0.15;
const MAX_MUTE_SECONDS = 3;

function describeFragmentAction(action: FragmentAction): string {
	const where = `a ${action.duration.toFixed(2)} s piece (source ${fmt(action.piece.start)}–${fmt(action.piece.end)})`;
	if (action.kind === "removed") {
		return `Fragment fix: ${where} had no speech or activity and was shorter than ${MIN_FRAGMENT_SECONDS} s, so it was removed.`;
	}
	const restored = `source ${fmt(action.restored.start)}–${fmt(action.restored.end)}`;
	return action.kind === "merged"
		? `Fragment fix: ${where} was shorter than ${MIN_FRAGMENT_SECONDS} s, so it was joined to its neighbour by restoring ${restored}.`
		: `Fragment fix: ${where} was shorter than ${MIN_FRAGMENT_SECONDS} s and holds speech or activity, so ${restored} next to it was restored to make it long enough.`;
}

function describeFragmentActions(actions: FragmentAction[]): string[] {
	return actions.map(describeFragmentAction);
}

function requireReason(
	flags: {
		allow_split_speech?: boolean;
		allow_cut_activity?: boolean;
		allow_speed_activity?: boolean;
	},
	reason: string | undefined,
) {
	if (
		(flags.allow_split_speech ||
			flags.allow_cut_activity ||
			flags.allow_speed_activity) &&
		!reason?.trim()
	) {
		throw new Error("The allow_* options need a reason explaining why.");
	}
}

const ranges = (items: TimeRange[]) =>
	items.map((r) => `${fmt(r.start)}–${fmt(r.end)}`).join(", ");

export function createTimingTools(ctx: ToolContext) {
	const { layout, bridge } = ctx;

	const snapOptions = (allowSplitSpeech: boolean, tighten = true) => ({
		allowSplitSpeech,
		words: ctx.trustedWords(),
		total: layout.total,
		describe: ctx.describeSpeech,
		tighten,
	});

	const measure = () => {
		const map = ctx.speechMap();
		return {
			speech: (s: number, e: number) => speechSecondsIn(map, s, e),
			activity: (s: number, e: number) => activeSeconds(bridge.visual, s, e),
		};
	};

	const finish = (
		before: ClipSpan[],
		segments: ReturnType<typeof ctx.currentSegments>,
	) => {
		const m = measure();
		const cleaned = dropSlivers(segments, layout, m);
		const fixed = fixShortPieces(cleaned.segments, layout, m);
		const duration = outputDuration(buildClipSpans(fixed.segments, layout));
		if (fixed.segments.length === 0 || duration < MIN_VIDEO_SECONDS) {
			throw new Error("This edit would remove the whole video.");
		}
		const { after, notes } = ctx.commitTimeline(before, fixed.segments);
		return {
			after,
			notes: [...notes, ...describeFragmentActions(fixed.actions)],
		};
	};

	const remember = (
		touchedSpeech: boolean,
		touchedActivity: boolean,
		range: TimeRange,
		reason: string | undefined,
	) => {
		if (!reason) return;
		if (touchedSpeech) {
			ctx.allowedSplits.push(
				{ time: range.start, reason },
				{ time: range.end, reason },
			);
		}
		if (touchedActivity) ctx.allowedActivity.push({ ...range, reason });
	};

	const cutParams = obj({
		start: rangeStartParam,
		end: rangeEndParam,
		reason: reasonParam,
		allow_split_speech: allowSplitSpeechParam,
		allow_cut_activity: allowCutActivityParam,
	});
	const cutRange: AgentTool<typeof cutParams, undefined> = {
		name: "cut_range",
		label: "Cut",
		description: `Remove a source time range from the edited video, but only its parts that are both speech-free (or the words you target with allow_split_speech) and visually idle. Parts with cursor movement, clicks or screen changes are kept automatically and the result says what was kept. Boundaries snap to speech-free points with 0.12–0.2 s of breathing room; boundaries deep inside speech or inside the opening sentence are refused. With allow_split_speech (and a reason) boundaries snap to word edges with ~${WORD_PAD} s padding, for removing a filler, repeated phrase or false start. Kept pieces shorter than ${MIN_FRAGMENT_SECONDS} s are merged automatically without removing activity. Zooms move with their content.`,
		parameters: cutParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			requireReason(params, params.reason);
			const requested = ctx.validateRange(params.start, params.end);
			const before = ctx.currentSpans();
			const map = ctx.speechMap();
			const snapped = snapRange(
				map,
				requested.start,
				requested.end,
				snapOptions(params.allow_split_speech === true),
			);
			const range = { start: snapped.start, end: snapped.end };
			if (keptSourceSeconds(before, range.start, range.end) < 0.01) {
				throw new Error(
					`Nothing to cut: ${fmt(range.start)}–${fmt(range.end)} is already removed.`,
				);
			}
			const plan = planCut({
				range,
				speech: map,
				visual: bridge.visual,
				allowActivity: params.allow_cut_activity === true,
				minPart: params.allow_split_speech ? 0.1 : undefined,
			});
			const keptActive = ctx.keptActivity(before, range);
			if (plan.parts.length === 0) {
				throw new Error(
					`Not cut: ${fmt(range.start)}–${fmt(range.end)} has visual activity (${describeSpans(keptActive)}) and no idle part long enough to cut. Silent moments with activity stay in the video; for a filler word here use mute_range instead. Pass allow_cut_activity with a reason only if the user asked for this.`,
				);
			}
			let segments = ctx.currentSegments();
			let removed = 0;
			for (const part of plan.parts) {
				removed += keptSourceSeconds(
					buildClipSpans(segments, layout),
					part.start,
					part.end,
				);
				segments = cutSourceRange(segments, layout, part.start, part.end);
			}
			if (removed < 0.01) {
				throw new Error(
					`Nothing to cut: the idle parts of ${fmt(range.start)}–${fmt(range.end)} are already removed.`,
				);
			}
			const { after, notes } = finish(before, segments);
			remember(
				snapped.touchesSpeech,
				params.allow_cut_activity === true && keptActive.length > 0,
				range,
				params.reason,
			);
			const speechRemoved = plan.parts.reduce(
				(sum, p) => sum + speechSecondsIn(map, p.start, p.end),
				0,
			);
			return text(
				[
					`Cut ${ranges(plan.parts)} (${removed.toFixed(2)} s removed${speechRemoved > 0.05 ? `, including ${speechRemoved.toFixed(2)} s of speech: ${ctx.describeSpeech(range)}` : ""}).`,
					snapped.notes.length > 0
						? `Requested ${fmt(requested.start)}–${fmt(requested.end)}; adjusted: ${snapped.notes.join("; ")}.`
						: null,
					plan.keptActivity.length > 0
						? `Kept because the screen is active: ${describeSpans(plan.keptActivity, 6)}.`
						: null,
					ctx.durationLine(after),
					`Pieces now: ${buildPieces(after, MICRO_CUT_SECONDS).length}.`,
					...notes,
				]
					.filter((line): line is string => !!line)
					.join("\n"),
			);
		},
	};

	const tightenParams = obj({
		start: opt(
			num({ description: "Window start, source seconds. Default 0." }),
		),
		end: opt(
			num({ description: "Window end, source seconds. Default the end." }),
		),
		min_pause: opt(
			num({
				description: `Only tighten silences longer than this, in seconds. Default ${DEFAULT_MIN_PAUSE_SECONDS}.`,
			}),
		),
		reason: reasonParam,
	});
	const tightenPauses: AgentTool<typeof tightenParams, undefined> = {
		name: "tighten_pauses",
		label: "Tighten pauses",
		description: `Cut every speech-free, visually idle silence longer than min_pause (default ${DEFAULT_MIN_PAUSE_SECONDS} s) in a source window in one step, keeping 0.12–0.2 s of breathing room next to speech. Pauses inside the opening sentence and any part with cursor movement, clicks or screen changes are kept. Use it for the tight default pacing, then handle fillers and retakes with cut_range.`,
		parameters: tightenParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const window = {
				start: Math.max(0, params.start ?? 0),
				end: Math.min(layout.total, params.end ?? layout.total),
			};
			const minPause = Math.max(
				0.2,
				params.min_pause ?? DEFAULT_MIN_PAUSE_SECONDS,
			);
			const before = ctx.currentSpans();
			const map = ctx.speechMap();
			if (map.intervals.length === 0) {
				throw new Error(
					"No speech data is available, so pauses cannot be located. Use the storyboard and cut idle stretches with cut_range.",
				);
			}
			const first = map.firstSentence;
			const cuts: TimeRange[] = [];
			const keptForActivity: TimeRange[] = [];
			for (const gap of speechGaps(map, layout, minPause)) {
				const start = Math.max(gap.start, window.start);
				const end = Math.min(gap.end, window.end);
				if (end - start < minPause) continue;
				if (first && start < first.end && end > first.start) continue;
				let snapped: { start: number; end: number };
				try {
					snapped = snapRange(map, start, end, snapOptions(false));
				} catch {
					continue;
				}
				if (keptSourceSeconds(before, snapped.start, snapped.end) < 0.05)
					continue;
				const plan = planCut({
					range: snapped,
					speech: map,
					visual: bridge.visual,
					allowActivity: false,
					minPart: Math.min(0.25, minPause),
				});
				cuts.push(...plan.parts);
				if (plan.keptActivity.length > 0) keptForActivity.push(snapped);
			}
			if (cuts.length === 0) {
				return text(
					`No idle pauses longer than ${minPause} s left to cut in ${fmt(window.start)}–${fmt(window.end)}${keptForActivity.length > 0 ? ` (${keptForActivity.length} pause(s) were kept because the screen is active)` : ""}.`,
				);
			}
			let segments = ctx.currentSegments();
			let removed = 0;
			for (const part of cuts) {
				removed += keptSourceSeconds(
					buildClipSpans(segments, layout),
					part.start,
					part.end,
				);
				segments = cutSourceRange(segments, layout, part.start, part.end);
			}
			const { after, notes } = finish(before, segments);
			return text(
				[
					`Tightened ${cuts.length} pause part(s), ${removed.toFixed(2)} s removed: ${ranges(cuts.slice(0, 40))}${cuts.length > 40 ? " …" : ""}.`,
					keptForActivity.length > 0
						? `${keptForActivity.length} pause(s) were kept fully or partly because the screen is active: ${ranges(keptForActivity.slice(0, 20))}.`
						: null,
					ctx.durationLine(after),
					`Pieces now: ${buildPieces(after, MICRO_CUT_SECONDS).length}.`,
					...notes,
				]
					.filter((line): line is string => !!line)
					.join("\n"),
			);
		},
	};

	const speedParams = obj({
		start: rangeStartParam,
		end: rangeEndParam,
		speed: num({
			description: `Playback speed, ${MIN_SPEED} to ${MAX_SPEED}. 1 restores normal speed. Automatic waits usually 2–8.`,
		}),
		reason: reasonParam,
		allow_split_speech: allowSplitSpeechParam,
		allow_speed_activity: allowSpeedActivityParam,
	});
	const setSpeed: AgentTool<typeof speedParams, undefined> = {
		name: "set_speed",
		label: "Speed",
		description:
			"Speed up an automatic wait (loading, generating, uploading, rendering) that the storyboard shows with progress on screen, while nobody speaks and the user does nothing. The tool refuses ranges with speech, with cursor movement or clicks (user operations, including typing, stay at 1x) and ranges without progress on screen (cut idle dead air instead). Boundaries snap to speech-free points. Speed 1 restores normal speed without these checks.",
		parameters: speedParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			requireReason(params, params.reason);
			const requested = ctx.validateRange(params.start, params.end);
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
			const before = ctx.currentSpans();
			const map = ctx.speechMap();
			let range = requested;
			const adjusted: string[] = [];
			let touchesSpeech = false;
			let touchesActivity = false;
			if (speed > 1) {
				const snapped = snapRange(
					map,
					requested.start,
					requested.end,
					snapOptions(params.allow_split_speech === true, false),
				);
				range = { start: snapped.start, end: snapped.end };
				adjusted.push(...snapped.notes);
				const speech = speechSecondsIn(map, range.start, range.end);
				if (speech > SPEECH_IN_SPEEDUP_SECONDS) {
					touchesSpeech = true;
					if (!params.allow_split_speech) {
						const parts = speechOverlapping(map, range.start, range.end)
							.slice(0, 3)
							.map(
								(r) =>
									`${fmt(r.start)}–${fmt(r.end)} (${ctx.describeSpeech(r)})`,
							);
						const message = `${fmt(range.start)}–${fmt(range.end)} contains ${speech.toFixed(1)} s of speech: ${parts.join("; ")}. Sped-up speech sounds wrong; speed up only the silent wait around it.`;
						if (map.strict) throw new Error(`Not sped up: ${message}`);
						adjusted.push(`warning: ${message} (judged from audio level only)`);
					}
				}
				const user = ctx.keptActivity(before, range, isUserActivity);
				if (user.length > 0) {
					touchesActivity = true;
					if (!params.allow_speed_activity) {
						throw new Error(
							`Not sped up: ${fmt(range.start)}–${fmt(range.end)} contains user activity (${describeSpans(user)}). User operations stay at 1x; speed up only the automatic wait between them.`,
						);
					}
				}
				if (bridge.storyRuns && ctx.progressIn(range).length === 0) {
					touchesActivity = true;
					if (!params.allow_speed_activity) {
						throw new Error(
							`Not sped up: the storyboard shows no loading or progress on screen in ${fmt(range.start)}–${fmt(range.end)}. If it is idle dead air, cut it with cut_range; if the user is doing something, keep it at 1x.`,
						);
					}
				}
				if (!bridge.storyRuns) {
					adjusted.push(
						"warning: no storyboard, so it could not be checked that this is an automatic wait",
					);
				}
			}
			if (keptSourceSeconds(before, range.start, range.end) < 0.01) {
				throw new Error(
					`Nothing to change: ${fmt(range.start)}–${fmt(range.end)} has been cut.`,
				);
			}
			const { after, notes } = finish(
				before,
				setSpeedInSourceRange(
					ctx.currentSegments(),
					layout,
					range.start,
					range.end,
					speed,
				),
			);
			remember(touchesSpeech, touchesActivity, range, params.reason);
			return text(
				[
					`Set source ${fmt(range.start)}–${fmt(range.end)} to ${speed}x.`,
					adjusted.length > 0
						? `Requested ${fmt(requested.start)}–${fmt(requested.end)}; adjusted: ${adjusted.join("; ")}.`
						: null,
					ctx.durationLine(after),
					...notes,
				]
					.filter((line): line is string => !!line)
					.join("\n"),
			);
		},
	};

	const muteParams = obj({
		start: rangeStartParam,
		end: rangeEndParam,
		reason: reasonParam,
	});
	const muteRange: AgentTool<typeof muteParams, undefined> = {
		name: "mute_range",
		label: "Mute",
		description: `Silence the audio of a short source range (at most ${MAX_MUTE_SECONDS} s) without cutting the picture. Use it for a filler word that falls inside visual activity, where cutting is not allowed. Boundaries snap to word edges with ~${WORD_PAD} s padding.`,
		parameters: muteParams,
		executionMode: "sequential",
		execute: async (_id, params) => {
			if (!params.reason?.trim()) throw new Error("Pass a reason.");
			const requested = ctx.validateRange(params.start, params.end);
			const snapped = snapRange(
				ctx.speechMap(),
				requested.start,
				requested.end,
				snapOptions(true),
			);
			if (snapped.end - snapped.start > MAX_MUTE_SECONDS) {
				throw new Error(
					`Mute ranges are for single fillers; ${fmt(snapped.start)}–${fmt(snapped.end)} is longer than ${MAX_MUTE_SECONDS} s.`,
				);
			}
			const a = sourceToSegment(layout, snapped.start);
			const b = sourceToSegment(layout, snapped.end);
			if (a.recordingSegment !== b.recordingSegment) {
				throw new Error(
					"A mute range cannot cross a recording segment boundary.",
				);
			}
			const next: MuteRange = {
				recordingSegment: a.recordingSegment,
				start: a.time,
				end: b.time,
			};
			const existing = ctx.muteRanges();
			const merged: MuteRange[] = [];
			for (const r of [...existing, next].sort(
				(x, y) => x.recordingSegment - y.recordingSegment || x.start - y.start,
			)) {
				const last = merged[merged.length - 1];
				if (
					last &&
					last.recordingSegment === r.recordingSegment &&
					r.start <= last.end + 0.01
				) {
					last.end = Math.max(last.end, r.end);
				} else merged.push({ ...r });
			}
			ctx.setMuteRanges(merged);
			ctx.mutedRanges.push({
				start: snapped.start,
				end: snapped.end,
				reason: params.reason,
			});
			return text(
				`Muted source ${fmt(snapped.start)}–${fmt(snapped.end)} (${ctx.describeSpeech(snapped)}). Mute ranges now: ${merged.length}.`,
			);
		},
	};

	const reviewParams = obj({});
	const reviewEdit: AgentTool<typeof reviewParams, undefined> = {
		name: "review_edit",
		label: "Review",
		description:
			"Check the whole edit: every cut and speed change with 0.5 s of speech or word context on each side, kept piece lengths, and warnings (cut inside speech, too little breathing room, pieces that are too short, the opening sentence partly cut, cuts that remove visual activity, speed-ups over speech or cursor activity, captions that no longer match). Also suggests idle pauses that are still kept. Call it after your edits, fix every warning, and call it again before the final summary.",
		parameters: reviewParams,
		execute: async () => {
			const spans = ctx.currentSpans();
			const review = buildReview({
				layout,
				spans,
				speech: ctx.speechMap(),
				lines: ctx.trustedTranscript(),
				captionsEnabled: bridge.project.captions?.settings.enabled ?? false,
				storyRuns: bridge.storyRuns,
				clicks: bridge.activity.clicks,
				visual: bridge.visual,
				allowedSplits: ctx.allowedSplits,
				allowedActivity: ctx.allowedActivity,
				muteRanges: ctx.mutedSourceRanges(),
				muteReasons: ctx.mutedRanges,
				fillers: findFillers(ctx.trustedTranscript()),
			});
			return text(`${ctx.durationLine(spans)}\n${review.text}`);
		},
	};

	return {
		cutRange,
		tightenPauses,
		setSpeed,
		muteRange,
		reviewEdit,
	};
}
