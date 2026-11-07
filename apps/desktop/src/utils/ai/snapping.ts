import {
	buildSpeechMap,
	type CaptionWord,
	nextSpeechStart,
	previousSpeechEnd,
	type SpeechMap,
	speechContaining,
} from "./speech";
import { clamp, formatSeconds as fmt, type TimeRange } from "./timebase";

export const PAD_MIN = 0.12;
export const PAD_TARGET = 0.16;
export const PAD_MAX = 0.2;
export const WORD_PAD = 0.05;
const STRICT_MAX_SNAP_SECONDS = 1;
const LENIENT_MAX_SNAP_SECONDS = 0.6;
const WORD_SNAP_SECONDS = 0.4;
const EDGE = 0.02;
const MIN_RANGE_SECONDS = 0.1;
const TIGHTEN_WINDOW_SECONDS = 1;

export type BoundaryKind = "start" | "end";

export type SnapOptions = {
	allowSplitSpeech: boolean;
	words: CaptionWord[];
	total: number;
	describe?: (range: TimeRange) => string;
	tighten?: boolean;
};

export type SnapOutcome = {
	time: number;
	note: string | null;
	inSpeech: boolean;
};

export class SnapError extends Error {}

function placeInGap(
	kind: BoundaryKind,
	from: number | null,
	to: number | null,
	preferred: number,
	tighten: boolean,
): number {
	const gap =
		from !== null && to !== null ? to - from : Number.POSITIVE_INFINITY;
	const minPad = Math.min(PAD_MIN, gap / 2);
	const targetPad = Math.min(PAD_TARGET, gap / 2);
	if (kind === "start") {
		const lo = from === null ? Number.NEGATIVE_INFINITY : from + minPad;
		const hi =
			to === null ? Number.POSITIVE_INFINITY : to - Math.min(EDGE, gap / 4);
		const hiTight =
			from !== null && tighten && preferred - from <= TIGHTEN_WINDOW_SECONDS
				? Math.min(hi, from + PAD_MAX)
				: hi;
		let p = preferred;
		if (from !== null && p - from < PAD_MIN) p = from + targetPad;
		return lo > hiTight ? (lo + hi) / 2 : clamp(p, lo, hiTight);
	}
	const hi = to === null ? Number.POSITIVE_INFINITY : to - minPad;
	const lo =
		from === null ? Number.NEGATIVE_INFINITY : from + Math.min(EDGE, gap / 4);
	const loTight =
		to !== null && tighten && to - preferred <= TIGHTEN_WINDOW_SECONDS
			? Math.max(lo, to - PAD_MAX)
			: lo;
	let p = preferred;
	if (to !== null && to - p < PAD_MIN) p = to - targetPad;
	return loTight > hi ? (lo + hi) / 2 : clamp(p, loTight, hi);
}

function snapToWordEdge(
	t: number,
	kind: BoundaryKind,
	words: CaptionWord[],
): number | null {
	let best: number | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	words.forEach((word, index) => {
		const edge = kind === "start" ? word.start : word.end;
		const distance = Math.abs(edge - t);
		if (distance > WORD_SNAP_SECONDS || distance >= bestDistance) return;
		bestDistance = distance;
		if (kind === "start") {
			const prev = words[index - 1];
			best = Math.max(
				prev ? prev.end : Number.NEGATIVE_INFINITY,
				word.start - WORD_PAD,
			);
		} else {
			const next = words[index + 1];
			best = Math.min(
				next ? next.start : Number.POSITIVE_INFINITY,
				word.end + WORD_PAD,
			);
		}
	});
	return best;
}

function overlapsFirstSentence(map: SpeechMap, range: TimeRange) {
	const first = map.firstSentence;
	return !!first && range.start < first.end && range.end > first.start;
}

export function snapBoundary(
	map: SpeechMap,
	t: number,
	kind: BoundaryKind,
	options: SnapOptions,
): SnapOutcome {
	const bound = (value: number) => clamp(value, 0, options.total);
	if (map.intervals.length === 0)
		return { time: t, note: null, inSpeech: false };

	if (options.allowSplitSpeech) {
		const edge = snapToWordEdge(t, kind, options.words);
		if (edge !== null) {
			const time = bound(edge);
			return {
				time,
				note:
					Math.abs(time - t) > 0.01
						? `${kind} ${fmt(t)} → ${fmt(time)} (word edge, ${WORD_PAD} s padding)`
						: null,
				inSpeech: speechContaining(map, time) !== undefined,
			};
		}
	}

	const inside = speechContaining(map, t);
	if (!inside) {
		const time = bound(
			placeInGap(
				kind,
				previousSpeechEnd(map, t),
				nextSpeechStart(map, t),
				t,
				options.tighten !== false,
			),
		);
		const note =
			Math.abs(time - t) > 0.01
				? `${kind === "start" ? "start" : "end"} ${fmt(t)} → ${fmt(time)} (leaves ${PAD_MIN}–${PAD_MAX} s next to speech)`
				: null;
		return { time, note, inSpeech: false };
	}

	const context = options.describe ? ` (${options.describe(inside)})` : "";
	const protectedSpeech = overlapsFirstSentence(map, inside);

	if (options.allowSplitSpeech) {
		const time = bound(snapToWordEdge(t, kind, options.words) ?? t);
		return {
			time,
			note: `${kind} ${fmt(time)} stays inside speech ${fmt(inside.start)}–${fmt(inside.end)}${context} because allow_split_speech was set`,
			inSpeech: true,
		};
	}

	const before = previousSpeechEnd(map, inside.start);
	const after = nextSpeechStart(map, inside.end);
	const left = bound(
		kind === "start"
			? placeInGap("start", before, inside.start, inside.start - EDGE, false)
			: placeInGap(
					"end",
					before,
					inside.start,
					inside.start - PAD_TARGET,
					false,
				),
	);
	const right = bound(
		kind === "start"
			? placeInGap("start", inside.end, after, inside.end + PAD_TARGET, false)
			: placeInGap("end", inside.end, after, inside.end + EDGE, false),
	);
	const keepsSpeech = kind === "start" ? right : left;
	const dropsSpeech = kind === "start" ? left : right;
	const time =
		protectedSpeech || Math.abs(keepsSpeech - t) <= Math.abs(dropsSpeech - t)
			? keepsSpeech
			: dropsSpeech;
	const distance = Math.abs(time - t);
	const strict = map.strict || protectedSpeech;
	const limit = strict ? STRICT_MAX_SNAP_SECONDS : LENIENT_MAX_SNAP_SECONDS;

	if (distance > limit) {
		if (!strict) {
			return {
				time: t,
				note: `${kind} ${fmt(t)} may be inside speech ${fmt(inside.start)}–${fmt(inside.end)}${context}; speech was located from the audio level only`,
				inSpeech: true,
			};
		}
		const where = protectedSpeech
			? "the opening sentence, which must not be cut into unless the user asked for it"
			: `speech ${fmt(inside.start)}–${fmt(inside.end)}`;
		throw new SnapError(
			`The ${kind} boundary ${fmt(t)} falls inside ${where}${context}. The nearest speech-free points are ${fmt(left)} and ${fmt(right)}. Move the boundary there, or pass allow_split_speech: true with a reason (for example to remove a filler word between word timings).`,
		);
	}

	return {
		time,
		note: `${kind} ${fmt(t)} → ${fmt(time)} (moved out of speech ${fmt(inside.start)}–${fmt(inside.end)}${context})`,
		inSpeech: false,
	};
}

export function snapRange(
	map: SpeechMap,
	start: number,
	end: number,
	options: SnapOptions,
): { start: number; end: number; notes: string[]; touchesSpeech: boolean } {
	const a = snapBoundary(map, start, "start", options);
	const b = snapBoundary(map, end, "end", options);
	if (b.time - a.time < MIN_RANGE_SECONDS) {
		throw new SnapError(
			`${fmt(start)}–${fmt(end)} lies inside continuous speech, so nothing is left after moving its boundaries to speech-free points (${fmt(a.time)}–${fmt(b.time)}). To remove words inside a sentence, pass allow_split_speech: true with a reason and use word timings from get_transcript.`,
		);
	}
	return {
		start: a.time,
		end: b.time,
		notes: [a.note, b.note].filter((n): n is string => n !== null),
		touchesSpeech: a.inSpeech || b.inSpeech,
	};
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	const strictMap = buildSpeechMap({
		base: {
			source: "voice activity",
			intervals: [
				{ start: 0.5, end: 2 },
				{ start: 5, end: 7 },
				{ start: 9, end: 15 },
			],
			note: "",
		},
		words: [],
		firstSentence: { start: 0.5, end: 2 },
	});
	const options: SnapOptions = {
		allowSplitSpeech: false,
		words: [],
		total: 30,
	};

	describe("snapRange", () => {
		it("adds padding next to speech", () => {
			const r = snapRange(strictMap, 2.05, 4.9, options);
			expect(r.start).toBeCloseTo(2.16);
			expect(r.end).toBeCloseTo(4.84);
		});

		it("tightens a pause to 0.12–0.2 s of padding", () => {
			const r = snapRange(strictMap, 3, 4, options);
			expect(r.start).toBeCloseTo(2.2);
			expect(r.end).toBeCloseTo(4.8);
		});

		it("leaves boundaries far from speech where they are", () => {
			const r = snapRange(strictMap, 20, 25, options);
			expect(r.start).toBe(20);
			expect(r.end).toBe(25);
			expect(r.notes).toEqual([]);
		});

		it("moves a boundary out of nearby speech and keeps the speech", () => {
			const r = snapRange(strictMap, 6.6, 8.2, options);
			expect(r.start).toBeCloseTo(7.16);
			expect(r.end).toBeCloseTo(8.8);
			expect(r.notes.join(" ")).toContain("moved out of speech");
		});

		it("refuses to split long speech", () => {
			expect(() => snapRange(strictMap, 12, 20, options)).toThrow(SnapError);
		});

		it("refuses to cut into the opening sentence", () => {
			expect(() => snapRange(strictMap, 0.9, 4, options)).toThrow(
				/opening sentence/,
			);
			expect(snapRange(strictMap, 1.5, 4, options).start).toBeCloseTo(2.16);
		});

		it("allows word-level cuts when asked", () => {
			const words: CaptionWord[] = [
				{ text: "so", start: 9.2, end: 9.6 },
				{ text: "um", start: 9.7, end: 10.1 },
				{ text: "next", start: 10.2, end: 10.6 },
			];
			const r = snapRange(strictMap, 9.68, 10.12, {
				...options,
				allowSplitSpeech: true,
				words,
			});
			expect(r.start).toBeCloseTo(9.65);
			expect(r.end).toBeCloseTo(10.15);
			expect(r.touchesSpeech).toBe(true);
		});

		it("snaps targeted filler cuts to word edges even from a gap", () => {
			const words: CaptionWord[] = [
				{ text: "嗯", start: 9.1, end: 9.4 },
				{ text: "next", start: 9.6, end: 10 },
			];
			const r = snapRange(strictMap, 8.9, 9.45, {
				...options,
				allowSplitSpeech: true,
				words,
			});
			expect(r.start).toBeCloseTo(9.05);
			expect(r.end).toBeCloseTo(9.45);
		});

		it("does not stretch toward speech when tightening is off", () => {
			const r = snapRange(strictMap, 3, 4, { ...options, tighten: false });
			expect(r.start).toBe(3);
			expect(r.end).toBe(4);
		});

		it("is lenient when speech comes from audio level only", () => {
			const lenient = buildSpeechMap({
				base: {
					source: "audio level",
					intervals: [{ start: 5, end: 15 }],
					note: "",
				},
				words: [],
				firstSentence: null,
			});
			const r = snapRange(lenient, 10, 20, options);
			expect(r.start).toBe(10);
			expect(r.touchesSpeech).toBe(true);
		});

		it("does nothing without speech data", () => {
			const empty = buildSpeechMap({
				base: { source: "none", intervals: [], note: "" },
				words: [],
				firstSentence: null,
			});
			expect(snapRange(empty, 3, 4, options)).toMatchObject({
				start: 3,
				end: 4,
			});
		});
	});
}
