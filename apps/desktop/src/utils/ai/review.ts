import {
	buildPieces,
	MICRO_CUT_SECONDS,
	MIN_FRAGMENT_SECONDS,
} from "./fragments";
import {
	buildSpeechMap,
	nextSpeechStart,
	previousSpeechEnd,
	type SpeechMap,
	speechContaining,
	speechGaps,
	speechSecondsIn,
} from "./speech";
import type { StoryRun } from "./storyboard";
import {
	buildClipSpans,
	type ClipSpan,
	createRecordingLayout,
	formatSeconds as fmt,
	keptSourceSeconds,
	type RecordingLayout,
	sourceRangeStatus,
	type TimeRange,
} from "./timebase";
import type { WordHit } from "./transcript-check";
import type { ClickEvent, TranscriptLine } from "./video-context";
import {
	activeSpans,
	buildVisualMap,
	describeSpans,
	isUserActivity,
	subtractActivity,
	type VisualMap,
} from "./visual";

export type AllowedSplit = { time: number; reason: string };

export type ReviewInput = {
	layout: RecordingLayout;
	spans: ClipSpan[];
	speech: SpeechMap;
	lines: TranscriptLine[];
	captionsEnabled: boolean;
	storyRuns: StoryRun[] | null;
	clicks: ClickEvent[];
	visual: VisualMap;
	allowedSplits: AllowedSplit[];
	allowedActivity: (TimeRange & { reason: string })[];
	muteRanges: TimeRange[];
	muteReasons: (TimeRange & { reason: string })[];
	fillers: WordHit[];
};

const CONTEXT_SECONDS = 0.5;
const MIN_PADDING_SECONDS = 0.1;
const LONG_KEPT_PAUSE_SECONDS = 0.6;
const IDLE_PART_SECONDS = 0.3;

export function speechText(
	lines: TranscriptLine[],
	range: TimeRange,
): string | null {
	const words = lines
		.flatMap((l) => l.words ?? [])
		.filter((w) => w.end > range.start && w.start < range.end);
	if (words.length > 0) {
		const joined = words.map((w) => w.text.trim());
		const latin = joined.some((w) => /[a-z]/i.test(w));
		return `"${joined.join(latin ? " " : "")}"`;
	}
	const line = lines.find((l) => l.end > range.start && l.start < range.end);
	return line ? `line ${line.id}: "${line.text.slice(0, 60)}"` : null;
}

function sideContext(
	input: ReviewInput,
	range: TimeRange,
	side: "before" | "after",
): string {
	const speech = speechSecondsIn(input.speech, range.start, range.end);
	const text = speech > 0.02 ? speechText(input.lines, range) : null;
	const label = `${side} ${fmt(range.start)}–${fmt(range.end)}`;
	if (speech <= 0.02) return `${label}: silence`;
	return `${label}: ${text ?? `speech ${speech.toFixed(2)} s`}`;
}

function allowedOver(input: ReviewInput, start: number, end: number) {
	return (
		input.allowedActivity.find(
			(a) => a.start <= start + 0.06 && a.end >= end - 0.06,
		) ?? input.allowedActivity.find((a) => a.end > start && a.start < end)
	);
}

function isAllowed(input: ReviewInput, t: number) {
	return input.allowedSplits.find((a) => Math.abs(a.time - t) < 0.06);
}

export function buildReview(input: ReviewInput): {
	text: string;
	warnings: number;
} {
	const out: string[] = [];
	const warnings: string[] = [];
	const suggestions: string[] = [];
	const strict = input.speech.strict;
	const map = input.speech;
	const pieces = buildPieces(input.spans, MICRO_CUT_SECONDS);
	const cuts = buildPieces(input.spans);
	const warn = (message: string) => {
		warnings.push(message);
		return `     ⚠ ${message}`;
	};
	const note = (message: string) => `     · ${message}`;

	out.push(
		`Edit review (source seconds; "final" = position in the edited video). Speech data: ${map.note}.`,
	);
	out.push(
		`Pieces (${pieces.length}; cuts of under ${MICRO_CUT_SECONDS} s inside a piece do not split it): ${pieces
			.map(
				(p, i) =>
					`#${i + 1} ${fmt(p.sourceStart)}–${fmt(p.sourceEnd)} → ${p.duration.toFixed(1)} s${p.duration < MIN_FRAGMENT_SECONDS && pieces.length > 1 ? " (too short)" : ""}`,
			)
			.join(", ")}`,
	);
	for (const piece of pieces) {
		if (pieces.length > 1 && piece.duration < MIN_FRAGMENT_SECONDS) {
			warnings.push(
				`piece ${fmt(piece.sourceStart)}–${fmt(piece.sourceEnd)} lasts only ${piece.duration.toFixed(2)} s (minimum ${MIN_FRAGMENT_SECONDS} s)`,
			);
		}
	}

	out.push("Boundaries:");
	let boundaryCount = 0;
	for (let i = 0; i + 1 < cuts.length; i++) {
		const a = cuts[i];
		const b = cuts[i + 1];
		boundaryCount++;
		out.push(
			`  cut ${boundaryCount} · final ${fmt(a.outputEnd)} · removed source ${fmt(a.sourceEnd)}–${fmt(b.sourceStart)} (${Math.max(0, b.sourceStart - a.sourceEnd).toFixed(2)} s)`,
		);
		out.push(
			`     ${sideContext(input, { start: Math.max(0, a.sourceEnd - CONTEXT_SECONDS), end: a.sourceEnd }, "before")}`,
		);
		out.push(
			`     ${sideContext(input, { start: b.sourceStart, end: b.sourceStart + CONTEXT_SECONDS }, "after")}`,
		);
		const removedActivity = activeSpans(
			input.visual,
			a.sourceEnd,
			b.sourceStart,
		);
		if (removedActivity.length > 0) {
			const allowed = allowedOver(input, a.sourceEnd, b.sourceStart);
			const message = `this cut removes visual activity (${describeSpans(removedActivity)})`;
			if (allowed) out.push(note(`${message}; allowed: ${allowed.reason}`));
			else out.push(warn(message));
		}
		for (const [point, side] of [
			[a.sourceEnd, "before"],
			[b.sourceStart, "after"],
		] as const) {
			const inside = speechContaining(map, point);
			const allowed = isAllowed(input, point);
			if (inside) {
				const message = `the cut ${side === "before" ? "starts" : "ends"} inside speech at ${fmt(point)} (${fmt(inside.start)}–${fmt(inside.end)})`;
				if (allowed) out.push(note(`${message}; allowed: ${allowed.reason}`));
				else if (strict) out.push(warn(message));
				else out.push(note(`${message}, judged from audio level only`));
				continue;
			}
			const neighbour =
				side === "before"
					? previousSpeechEnd(map, point)
					: nextSpeechStart(map, point);
			if (neighbour === null) continue;
			const padding = keptSourceSeconds(
				input.spans,
				Math.min(point, neighbour),
				Math.max(point, neighbour),
			);
			if (padding > 2) continue;
			if (padding < MIN_PADDING_SECONDS && strict && !allowed) {
				out.push(
					warn(
						`only ${padding.toFixed(2)} s of silence ${side === "before" ? "after the speech before" : "before the speech after"} the cut at ${fmt(point)}; speech may sound clipped`,
					),
				);
			} else {
				out.push(
					note(
						`${padding.toFixed(2)} s of silence ${side === "before" ? "kept after the speech before" : "kept before the speech after"} the cut`,
					),
				);
			}
		}
	}

	for (const span of input.spans) {
		if (span.speed === 1) continue;
		boundaryCount++;
		out.push(
			`  speed ${boundaryCount} · source ${fmt(span.sourceStart)}–${fmt(span.sourceEnd)} at ${Number(span.speed.toFixed(2))}x → final ${fmt(span.outputStart)}–${fmt(span.outputEnd)}`,
		);
		const speech = speechSecondsIn(map, span.sourceStart, span.sourceEnd);
		if (speech > 0.2) {
			const message = `${speech.toFixed(1)} s of speech is sped up here and will sound choppy (${speechText(input.lines, { start: span.sourceStart, end: span.sourceEnd }) ?? "speech"})`;
			const allowed =
				isAllowed(input, span.sourceStart) || isAllowed(input, span.sourceEnd);
			if (allowed) out.push(note(`${message}; allowed: ${allowed.reason}`));
			else if (strict) out.push(warn(message));
			else out.push(note(`${message}, judged from audio level only`));
		}
		const user = activeSpans(
			input.visual,
			span.sourceStart,
			span.sourceEnd,
			isUserActivity,
		);
		if (user.length > 0) {
			const allowed = allowedOver(input, span.sourceStart, span.sourceEnd);
			const message = `this speed-up covers user activity (${describeSpans(user)}); user operations should stay at 1x`;
			if (allowed) out.push(note(`${message}; allowed: ${allowed.reason}`));
			else out.push(warn(message));
		}
	}
	if (boundaryCount === 0) out.push("  (no cuts or speed changes yet)");

	const first = map.firstSentence;
	if (first) {
		const kept = keptSourceSeconds(input.spans, first.start, first.end);
		const length = first.end - first.start;
		if (kept > 0.05 && kept < length - 0.05) {
			const message = `the opening sentence ${fmt(first.start)}–${fmt(first.end)} is only partly kept (${kept.toFixed(2)} of ${length.toFixed(2)} s)`;
			const allowed = input.allowedSplits.find(
				(a) => a.time > first.start && a.time < first.end,
			);
			if (allowed) suggestions.push(`${message}; allowed: ${allowed.reason}`);
			else warnings.push(message);
		}
	}

	for (const line of input.lines) {
		const status = sourceRangeStatus(input.spans, line.start, line.end);
		const sped = input.spans.some(
			(s) =>
				s.speed !== 1 &&
				Math.min(s.sourceEnd, line.end) - Math.max(s.sourceStart, line.start) >
					0.2,
		);
		if (status !== "partly cut" && !sped) continue;
		const message = `caption ${line.id} ("${line.text.slice(0, 40)}") ${status === "partly cut" ? "is partly cut" : "overlaps a speed change"}, so it no longer matches the audio`;
		if (input.captionsEnabled) warnings.push(message);
		else
			suggestions.push(
				`${message} (captions are hidden, so only the transcript is affected)`,
			);
	}

	for (const span of input.spans) {
		if (span.speed !== 1) continue;
		for (const gap of speechGaps(map, input.layout, LONG_KEPT_PAUSE_SECONDS)) {
			const start = Math.max(gap.start, span.sourceStart);
			const end = Math.min(gap.end, span.sourceEnd);
			if (end - start < LONG_KEPT_PAUSE_SECONDS) continue;
			const label = `kept pause ${(end - start).toFixed(1)} s at source ${fmt(start)}–${fmt(end)}`;
			const idle = subtractActivity(input.visual, { start, end }).filter(
				(r) => r.end - r.start >= IDLE_PART_SECONDS,
			);
			if (idle.length > 0) {
				suggestions.push(
					`${label}: visually idle ${idle.map((r) => `${fmt(r.start)}–${fmt(r.end)}`).join(", ")} can be cut for tight pacing (tighten_pauses or cut_range add the breathing room)${input.visual.source === "clicks" ? "; screen activity is unknown here" : ""}`,
				);
			} else {
				suggestions.push(
					`${label} with screen activity throughout: keep it at 1x, or speed it up only if it is an automatic wait`,
				);
			}
		}
	}

	if (input.muteRanges.length > 0) {
		out.push(
			`Muted (audio only): ${input.muteRanges
				.map((m) => {
					const reason = input.muteReasons.find(
						(r) => r.start < m.end && r.end > m.start,
					)?.reason;
					return `${fmt(m.start)}–${fmt(m.end)}${reason ? ` (${reason})` : ""}`;
				})
				.join(", ")}`,
		);
	}

	for (const filler of input.fillers) {
		const length = Math.max(0.01, filler.end - filler.start);
		const kept = keptSourceSeconds(input.spans, filler.start, filler.end);
		if (kept < length * 0.5) continue;
		const muted = input.muteRanges.reduce(
			(sum, m) =>
				sum +
				Math.max(
					0,
					Math.min(m.end, filler.end) - Math.max(m.start, filler.start),
				),
			0,
		);
		if (muted >= length * 0.5) continue;
		const active =
			activeSpans(input.visual, filler.start - 0.1, filler.end + 0.1).length >
			0;
		const message = `filler "${filler.text}" at ${fmt(filler.start)}–${fmt(filler.end)} (${filler.lineId}) is still in the video; ${active ? "the screen is active there, so mute it with mute_range" : "the screen is idle, so cut it with cut_range and allow_split_speech"}`;
		if (filler.weak) suggestions.push(`${message} if it is only a filler here`);
		else warnings.push(message);
	}

	if (suggestions.length > 0) {
		out.push("Suggestions:");
		out.push(...suggestions.slice(0, 20).map((s) => `  - ${s}`));
	}
	if (warnings.length > 0) {
		out.push(`Warnings (${warnings.length}):`);
		out.push(...warnings.map((w) => `  ⚠ ${w}`));
		out.push(
			"Fix every warning with the edit tools, then call review_edit again.",
		);
	} else {
		out.push("Warnings: none.");
	}
	return { text: out.join("\n"), warnings: warnings.length };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("buildReview", () => {
		it("flags cuts in speech, short pieces and long kept pauses", () => {
			const layout = createRecordingLayout([40]);
			const spans = buildClipSpans(
				[
					{ recordingSegment: 0, timescale: 1, start: 0, end: 5.5 },
					{ recordingSegment: 0, timescale: 1, start: 9, end: 10 },
					{ recordingSegment: 0, timescale: 1, start: 12, end: 40 },
				],
				layout,
			);
			const speech = buildSpeechMap({
				base: {
					source: "voice activity",
					intervals: [
						{ start: 0.2, end: 3 },
						{ start: 5, end: 6 },
						{ start: 12.1, end: 15 },
						{ start: 20, end: 25 },
					],
					note: "test",
				},
				words: [],
				firstSentence: { start: 0.2, end: 3 },
			});
			const review = buildReview({
				layout,
				spans,
				speech,
				lines: [],
				captionsEnabled: false,
				storyRuns: null,
				clicks: [],
				visual: buildVisualMap({
					layout,
					data: {
						resolution_ms: 100,
						regions: [
							{
								segment_index: 0,
								start: 6,
								end: 8,
								cursor_moving: true,
								clicked: false,
								screen_changing: false,
							},
						],
					},
					storyRuns: null,
					clicks: [],
				}),
				allowedSplits: [],
				allowedActivity: [],
				muteRanges: [],
				muteReasons: [],
				fillers: [
					{ start: 13, end: 13.3, text: "um", lineId: "x", weak: false },
					{ start: 21, end: 21.3, text: "uh", lineId: "y", weak: false },
				],
			});
			expect(review.text).toContain("starts inside speech at 5.50");
			expect(review.text).toContain("too short");
			expect(review.text).toContain("kept pause 5.0 s");
			expect(review.text).toMatch(/only 0\.10 s of silence/);
			expect(review.text).toContain("removes visual activity");
			expect(review.text).toContain('filler "um" at 13.00–13.30');
			expect(review.warnings).toBe(6);
		});

		it("accepts fillers that are muted", () => {
			const layout = createRecordingLayout([10]);
			const spans = buildClipSpans(
				[{ recordingSegment: 0, timescale: 1, start: 0, end: 10 }],
				layout,
			);
			const review = buildReview({
				layout,
				spans,
				speech: buildSpeechMap({
					base: {
						source: "voice activity",
						intervals: [{ start: 1, end: 4 }],
						note: "",
					},
					words: [],
					firstSentence: { start: 1, end: 4 },
				}),
				lines: [],
				captionsEnabled: false,
				storyRuns: null,
				clicks: [],
				visual: buildVisualMap({
					layout,
					data: null,
					storyRuns: null,
					clicks: [],
				}),
				allowedSplits: [],
				allowedActivity: [],
				muteRanges: [{ start: 2.45, end: 2.85 }],
				muteReasons: [{ start: 2.45, end: 2.85, reason: "filler" }],
				fillers: [
					{ start: 2.5, end: 2.8, text: "嗯", lineId: "a", weak: false },
				],
			});
			expect(review.text).toContain("Muted (audio only): 2.45–2.85 (filler)");
			expect(review.warnings).toBe(0);
		});
	});
}
