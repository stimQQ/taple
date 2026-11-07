import type { TranscriptLine } from "./video-context";

export type TranscriptAssessment = {
	lines: TranscriptLine[];
	originalCount: number;
	hiddenRepeats: number;
	topRepeat: { text: string; count: number } | null;
	reliable: boolean;
};

const MIN_REPEATS_TO_FLAG = 5;
const REPEAT_SHARE_TO_FLAG = 0.3;
const HIDDEN_SHARE_TO_FLAG = 0.2;

export function normalizeCaptionText(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function assessTranscript(
	lines: TranscriptLine[],
): TranscriptAssessment {
	const counts = new Map<string, { text: string; count: number }>();
	const kept: TranscriptLine[] = [];
	let previous: string | null = null;
	let hiddenRepeats = 0;
	let usable = 0;

	for (const line of lines) {
		const key = normalizeCaptionText(line.text);
		if (!key) continue;
		usable++;
		const entry = counts.get(key) ?? { text: line.text, count: 0 };
		entry.count++;
		counts.set(key, entry);
		if (key === previous) {
			hiddenRepeats++;
			continue;
		}
		previous = key;
		kept.push(line);
	}

	let topRepeat: { text: string; count: number } | null = null;
	for (const entry of counts.values()) {
		if (entry.count > 1 && (!topRepeat || entry.count > topRepeat.count)) {
			topRepeat = entry;
		}
	}

	const repeatedTooOften =
		topRepeat !== null &&
		topRepeat.count >= MIN_REPEATS_TO_FLAG &&
		topRepeat.count / Math.max(1, usable) >= REPEAT_SHARE_TO_FLAG;
	const tooManyHidden =
		hiddenRepeats >= 3 &&
		hiddenRepeats / Math.max(1, usable) >= HIDDEN_SHARE_TO_FLAG;

	return {
		lines: kept,
		originalCount: lines.length,
		hiddenRepeats,
		topRepeat,
		reliable: !(repeatedTooOften || tooManyHidden),
	};
}

export function describeTranscriptIssue(
	assessment: TranscriptAssessment,
): string {
	if (assessment.reliable) {
		return assessment.hiddenRepeats > 0
			? `${assessment.hiddenRepeats} back-to-back duplicate line(s) were hidden.`
			: "";
	}
	const repeat = assessment.topRepeat;
	const detail = repeat
		? `the same text "${repeat.text.slice(0, 60)}" appears ${repeat.count} times out of ${assessment.originalCount} lines`
		: `${assessment.hiddenRepeats} of ${assessment.originalCount} lines repeat the previous line`;
	return `WARNING: the transcript looks unreliable: ${detail}, which usually means speech recognition looped. Do not trust its text or timing; base cuts on pauses, clicks and frames instead, and do not fix captions from it.`;
}

export type WordHit = {
	start: number;
	end: number;
	text: string;
	lineId: string;
	weak: boolean;
};

export type Retake = { first: TranscriptLine; second: TranscriptLine };

const STRONG_FILLERS = [
	"嗯",
	"呃",
	"额",
	"嗯嗯",
	"um",
	"uh",
	"erm",
	"hmm",
	"umm",
	"uhm",
];
const WEAK_FILLERS = ["啊", "那个", "就是", "然后", "like", "you know"];

type Token = {
	key: string;
	text: string;
	start: number;
	end: number;
	lineId: string;
};

function tokensOf(lines: TranscriptLine[]): Token[] {
	const tokens: Token[] = [];
	for (const line of lines) {
		for (const word of line.words ?? []) {
			const key = normalizeCaptionText(word.text);
			if (!key) continue;
			tokens.push({
				key,
				text: word.text.trim(),
				start: word.start,
				end: word.end,
				lineId: line.id,
			});
		}
	}
	return tokens.sort((a, b) => a.start - b.start);
}

export function hasWordTimings(lines: TranscriptLine[]): boolean {
	return lines.some((l) => (l.words?.length ?? 0) > 0);
}

export function findFillers(lines: TranscriptLine[]): WordHit[] {
	const tokens = tokensOf(lines);
	const hits: WordHit[] = [];
	const fillers = [
		...STRONG_FILLERS.map((f) => ({ f, weak: false })),
		...WEAK_FILLERS.map((f) => ({ f, weak: true })),
	];
	let i = 0;
	while (i < tokens.length) {
		let matched = false;
		for (const { f, weak } of fillers) {
			const target = normalizeCaptionText(f);
			let joined = "";
			let j = i;
			while (j < tokens.length && joined.length < target.length) {
				joined += tokens[j].key;
				j++;
			}
			if (joined !== target) continue;
			if (j - 1 > i && tokens[j - 1].lineId !== tokens[i].lineId) continue;
			hits.push({
				start: tokens[i].start,
				end: tokens[j - 1].end,
				text: tokens
					.slice(i, j)
					.map((t) => t.text)
					.join(/[a-z]/i.test(target) ? " " : ""),
				lineId: tokens[i].lineId,
				weak,
			});
			i = j;
			matched = true;
			break;
		}
		if (!matched) i++;
	}
	return hits;
}

export function findRepeatedPhrases(lines: TranscriptLine[]): WordHit[] {
	const tokens = tokensOf(lines);
	const hits: WordHit[] = [];
	let i = 0;
	while (i < tokens.length) {
		let found = 0;
		for (let n = 4; n >= 1; n--) {
			if (i + 2 * n > tokens.length) continue;
			let same = true;
			for (let k = 0; k < n; k++) {
				if (tokens[i + k].key !== tokens[i + n + k].key) {
					same = false;
					break;
				}
			}
			if (!same) continue;
			const phrase = tokens.slice(i, i + n);
			if (phrase.map((t) => t.key).join("").length < 1) continue;
			if (tokens[i + 2 * n - 1].start - phrase[n - 1].end > 1.5) continue;
			hits.push({
				start: phrase[0].start,
				end: phrase[n - 1].end,
				text: phrase.map((t) => t.text).join(" "),
				lineId: phrase[0].lineId,
				weak: false,
			});
			found = n;
			break;
		}
		i += found > 0 ? found : 1;
	}
	return hits;
}

export function findRetakes(lines: TranscriptLine[]): Retake[] {
	const retakes: Retake[] = [];
	for (let i = 0; i + 1 < lines.length; i++) {
		const a = normalizeCaptionText(lines[i].text);
		const b = normalizeCaptionText(lines[i + 1].text);
		const shorter = Math.min(a.length, b.length);
		if (shorter < 4) continue;
		let common = 0;
		while (common < shorter && a[common] === b[common]) common++;
		if (common >= 4 && common >= shorter * 0.5) {
			retakes.push({ first: lines[i], second: lines[i + 1] });
		}
	}
	return retakes;
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	const line = (i: number, text: string): TranscriptLine => ({
		id: `segment-${i}`,
		start: i * 2,
		end: i * 2 + 1.5,
		text,
	});

	describe("assessTranscript", () => {
		it("accepts a normal transcript", () => {
			const result = assessTranscript([
				line(0, "Hi, welcome to the demo."),
				line(1, "First open settings."),
				line(2, "Then click save."),
			]);
			expect(result.reliable).toBe(true);
			expect(result.lines).toHaveLength(3);
			expect(describeTranscriptIssue(result)).toBe("");
		});

		it("flags a looping transcript and collapses consecutive repeats", () => {
			const lines = [
				line(0, "Hello everyone."),
				...Array.from({ length: 50 }, (_, i) => line(i + 1, "谢谢观看！")),
				line(51, "Bye."),
			];
			const result = assessTranscript(lines);
			expect(result.reliable).toBe(false);
			expect(result.lines.map((l) => l.text)).toEqual([
				"Hello everyone.",
				"谢谢观看！",
				"Bye.",
			]);
			expect(result.hiddenRepeats).toBe(49);
			expect(result.topRepeat?.count).toBe(50);
			expect(describeTranscriptIssue(result)).toContain("unreliable");
		});

		it("flags text repeated across the transcript even when not consecutive", () => {
			const lines = Array.from({ length: 12 }, (_, i) =>
				line(i, i % 2 === 0 ? "Thank you." : `Step ${i}`),
			);
			expect(assessTranscript(lines).reliable).toBe(false);
		});

		it("treats punctuation and case differences as the same text", () => {
			const result = assessTranscript([
				line(0, "Okay."),
				line(1, "okay"),
				line(2, "Now we export."),
			]);
			expect(result.lines).toHaveLength(2);
			expect(result.hiddenRepeats).toBe(1);
			expect(result.reliable).toBe(true);
		});
	});

	describe("fillers and repeats", () => {
		const words = (
			id: string,
			list: [string, number, number][],
		): TranscriptLine => ({
			id,
			start: list[0][1],
			end: list[list.length - 1][2],
			text: list.map((w) => w[0]).join(" "),
			words: list.map(([text, start, end]) => ({ text, start, end })),
		});

		it("finds Chinese and English fillers with times", () => {
			const lines = [
				words("a", [
					["嗯", 0.2, 0.5],
					["我们", 0.6, 0.9],
					["那", 1.0, 1.1],
					["个", 1.1, 1.3],
					["打开", 1.4, 1.8],
				]),
				words("b", [
					["So", 3.0, 3.2],
					["um,", 3.3, 3.6],
					["you", 3.7, 3.8],
					["know", 3.8, 4.0],
					["likely", 4.1, 4.4],
				]),
			];
			const hits = findFillers(lines);
			expect(hits.map((h) => [h.text, h.start, h.end, h.weak])).toEqual([
				["嗯", 0.2, 0.5, false],
				["那个", 1.0, 1.3, true],
				["um,", 3.3, 3.6, false],
				["you know", 3.7, 4.0, true],
			]);
		});

		it("finds repeated phrases and retakes", () => {
			const lines = [
				words("a", [
					["we", 1, 1.2],
					["can", 1.2, 1.4],
					["we", 1.6, 1.8],
					["can", 1.8, 2.0],
					["save", 2.1, 2.4],
				]),
			];
			expect(findRepeatedPhrases(lines)).toMatchObject([
				{ text: "we can", start: 1, end: 1.4 },
			]);
			const retakes = findRetakes([
				line(0, "Now we open the settings"),
				line(1, "Now we open the settings page and click save"),
				line(2, "Done."),
			]);
			expect(retakes).toHaveLength(1);
			expect(retakes[0].first.id).toBe("segment-0");
		});
	});
}
