import {
	Agent,
	type AgentEvent,
	type AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	clampThinkingLevel,
	type Model,
} from "@earendil-works/pi-ai";
import { isChinese } from "~/utils/i18n";
import { getAIModels, TAPLE_IDENTITY } from "./providers";
import type { EditorTools } from "./tools";

export const MAX_TOOL_CALLS = 60;
const HARD_STOP_TOOL_CALLS = MAX_TOOL_CALLS + 8;
export const MAX_TURNS = 40;
const MAX_OUTPUT_TOKENS = 32000;
const KEPT_IMAGE_RESULTS = 3;

export function editorSystemPrompt(chinese = isChinese): string {
	return `You are the AI editor inside Taple, a macOS screen recorder for product demos and tutorials. You edit the user's recording by calling tools that change the editor timeline, the way a careful human editor would. The user watches the timeline change live and can undo your whole run in one step.

Time base: every time you pass to or read from a tool is in seconds of the ORIGINAL recording ("source time"). Cuts and speed changes never shift source times, so transcript, click and pause times stay valid for the whole run. Tool results also show "final" times in the edited video for reference; never pass final times to tools.

How to work:
1. Start from the project overview in the request. Read get_transcript and get_activity. Use view_frames (up to 6 timestamps per call) when you need to see the screen, for example before zooming or when unsure whether a stretch is waiting, typing or loading.
2. Plan the whole edit, then apply it. Prefer a few deliberate edits over many tiny ones, and check the edited length reported by the tools.
3. End with a short summary of what you changed and why (2 to 5 short bullet points), written in ${chinese ? "Simplified Chinese" : "English"}. Describe changes by content (for example "removed the long pause before opening Settings") rather than by timestamps.

Editing guidelines for demos and tutorials:
- Remove dead air: cut silences and pauses longer than about 1 s, leaving about 0.25 s of padding next to speech so it does not sound clipped. Trim silence before the first meaningful action and after the last one.
- Remove false starts, repeated takes, filler and obvious mistakes using the transcript. Keep sentences intact: cut between transcript lines or inside pauses, never inside a word. When something is said twice, keep the last clean take.
- Speed up (1.5x to 4x) stretches where the viewer only waits: typing long text, loading, installing, rendering, scrolling without narration. Audio is not time-stretched, so only speed up ranges where nobody is speaking.
- Zoom in when the viewer needs to read small UI details: around clicks on small buttons, menus, form fields and code. Start about 0.5 s before the action and end 1 to 2 s after it, keep each zoom at least 1.5 s long on the final timeline, use 1.5x to 2.2x, and merge actions that happen close together into one zoom. Use focus "auto" to follow the cursor, or "manual" with x/y (0..1 of the frame) for a fixed area. Do not zoom on content that is already large, and keep zooms to roughly a third of the video or less.
- Do not over-edit: keep the narrative and every step a viewer needs to follow along. When the user's request differs from these defaults, follow the user.
- If there is no transcript, rely on pauses, clicks and frames, and cut more conservatively.
- If a tool returns an error, fix the input instead of repeating the same call. Do not ask the user questions; make reasonable choices and explain them in the summary.`;
}

function pruneOldImages(messages: AgentMessage[]): AgentMessage[] {
	let keep = KEPT_IMAGE_RESULTS;
	const result = [...messages];
	for (let i = result.length - 1; i >= 0; i--) {
		const message = result[i];
		if (message.role !== "toolResult") continue;
		if (!message.content.some((c) => c.type === "image")) continue;
		if (keep > 0) {
			keep--;
			continue;
		}
		result[i] = {
			...message,
			content: message.content.map((c) =>
				c.type === "image"
					? {
							type: "text" as const,
							text: "[Frame image dropped to save context. Call view_frames again if you need it.]",
						}
					: c,
			),
		};
	}
	return result;
}

export function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
}

export function isAssistantMessage(
	message: AgentMessage,
): message is AssistantMessage {
	return message.role === "assistant";
}

export type EditRunOptions = {
	model: Model<Api>;
	apiKey: string;
	tools: EditorTools;
	onEvent: (event: AgentEvent) => void;
};

export type EditRun = {
	agent: Agent;
	start: (instruction: string, overview: string) => Promise<void>;
	abort: () => void;
	toolCallCount: () => number;
};

export function createEditRun(options: EditRunOptions): EditRun {
	const models = getAIModels();
	let toolCalls = 0;
	let turns = 0;

	const agent = new Agent({
		initialState: {
			systemPrompt: editorSystemPrompt(),
			model: options.model,
			thinkingLevel: options.model.reasoning
				? clampThinkingLevel(options.model, "medium")
				: "off",
			tools: options.tools,
		},
		streamFn: (model, context, streamOptions) =>
			models.streamSimple(model, context, {
				...streamOptions,
				maxTokens: Math.min(MAX_OUTPUT_TOKENS, model.maxTokens),
			}),
		getApiKey: () => options.apiKey,
		identity: TAPLE_IDENTITY,
		toolExecution: "parallel",
		transformContext: async (messages) => pruneOldImages(messages),
		beforeToolCall: async () => {
			toolCalls++;
			if (toolCalls <= MAX_TOOL_CALLS) return undefined;
			return {
				block: true,
				reason: `Tool call limit (${MAX_TOOL_CALLS}) reached for this run. Do not call more tools; write the final summary now.`,
				terminate: toolCalls > HARD_STOP_TOOL_CALLS,
			};
		},
		finishTurn: async ({ message }) => {
			turns++;
			if (message.stopReason === "error" || message.stopReason === "aborted")
				return undefined;
			if (turns >= MAX_TURNS) return { action: "end" };
			return undefined;
		},
	});

	agent.subscribe((event) => options.onEvent(event));

	return {
		agent,
		start: (instruction, overview) =>
			agent.prompt(
				`${instruction.trim()}\n\n---\nProject overview (same as get_overview):\n${overview}`,
			),
		abort: () => agent.abort(),
		toolCallCount: () => toolCalls,
	};
}
