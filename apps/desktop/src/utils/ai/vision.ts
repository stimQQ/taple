import type { Api, Model } from "@earendil-works/pi-ai";
import { getAIModels } from "./providers";

export type VisionRequest = {
	image: string;
	question: string;
	frameLabels: string[];
};

export type VisionAnswer = { text: string; cost: number };

export type VisionHelper = {
	model: Model<Api>;
	describe: (
		request: VisionRequest,
		signal?: AbortSignal,
	) => Promise<VisionAnswer>;
};

const HELPER_MAX_TOKENS = 600;

const HELPER_SYSTEM_PROMPT = `You look at frames from a screen recording (a product demo or tutorial) for a video editor who cannot see them. The image is a contact sheet: frames in time order, each labelled in its top-left corner with #number and its time in seconds. The frames show the raw captured screen.

Answer the editor's question factually and briefly (at most about 120 words, plain sentences or short bullets, in English). Refer to frames by their # label. Mention what matters for editing: what is on screen, readable UI text, what changes between frames (typing, loading spinners, progress bars, dialogs, scrolling, nothing changing), and where small UI elements are as x/y fractions of the frame (0,0 top-left to 1,1 bottom-right) when asked or useful for zooming. Say clearly when something is too small or unclear to read; never guess text.`;

export function createVisionHelper(
	model: Model<Api>,
	apiKey: string,
): VisionHelper {
	return {
		model,
		describe: async (request, signal) => {
			const message = await getAIModels().completeSimple(
				model,
				{
					systemPrompt: HELPER_SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: `Contact sheet of ${request.frameLabels.length} frame(s):\n${request.frameLabels.join("\n")}\n\nQuestion: ${request.question}`,
								},
								{ type: "image", data: request.image, mimeType: "image/jpeg" },
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey,
					signal,
					maxTokens: HELPER_MAX_TOKENS,
					cacheRetention: "none",
					maxRetries: 1,
				},
			);
			const cost = message.usage?.cost?.total ?? 0;
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw Object.assign(
					new Error(
						`Vision helper (${model.name}) failed: ${message.errorMessage ?? message.stopReason}`,
					),
					{ cost },
				);
			}
			const text = message.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim();
			return { text: text || "(The vision helper returned no answer.)", cost };
		},
	};
}

export function errorCost(error: unknown): number {
	if (typeof error !== "object" || error === null) return 0;
	const cost = (error as { cost?: unknown }).cost;
	return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}
