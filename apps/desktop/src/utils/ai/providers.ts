import {
	type Api,
	type ClientIdentity,
	createModels,
	createProvider,
	envApiKeyAuth,
	type Model,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { AIProviderId } from "~/store";
import { L } from "~/utils/i18n";

export type { AIProviderId } from "~/store";

export const AI_PROVIDER_IDS: AIProviderId[] = [
	"apimodels",
	"anthropic",
	"openai",
];

export const DEFAULT_AI_PROVIDER: AIProviderId = "apimodels";

export const APIMODELS_BASE_URL = "https://api.apimodels.app";
export const APIMODELS_SITE_URL = "https://apimodels.app";

const OPUS_MODEL_ID = "claude-opus-5-5";
const OPENAI_DEFAULT_MODEL_ID = "gpt-6.1-sol";

export const TAPLE_IDENTITY: ClientIdentity = {
	attribution: { name: "Taple", url: "https://taple.app" },
};

export type AIProviderInfo = {
	id: AIProviderId;
	name: string;
	description: string;
	keyUrl: string;
	keyLinkLabel: string;
	keyPlaceholder: string;
	recommended: boolean;
};

export function providerInfo(id: AIProviderId): AIProviderInfo {
	switch (id) {
		case "apimodels":
			return {
				id,
				name: "apimodels.app",
				description: L(
					"一个密钥即可使用 Claude Opus 5.5，价格比官方更低。",
					"One key for Claude Opus 5.5 at a lower price than the official API.",
				),
				keyUrl: APIMODELS_SITE_URL,
				keyLinkLabel: L("获取 apimodels.app 密钥", "Get an apimodels.app key"),
				keyPlaceholder: "sk-...",
				recommended: true,
			};
		case "anthropic":
			return {
				id,
				name: "Anthropic",
				description: L(
					"使用你自己的 Anthropic 官方 API 密钥。",
					"Use your own official Anthropic API key.",
				),
				keyUrl: "https://console.anthropic.com/settings/keys",
				keyLinkLabel: L("获取 Anthropic 密钥", "Get an Anthropic key"),
				keyPlaceholder: "sk-ant-...",
				recommended: false,
			};
		case "openai":
			return {
				id,
				name: "OpenAI",
				description: L(
					"使用你自己的 OpenAI 官方 API 密钥。",
					"Use your own official OpenAI API key.",
				),
				keyUrl: "https://platform.openai.com/api-keys",
				keyLinkLabel: L("获取 OpenAI 密钥", "Get an OpenAI key"),
				keyPlaceholder: "sk-...",
				recommended: false,
			};
	}
}

export function isAIProviderId(value: unknown): value is AIProviderId {
	return (
		typeof value === "string" && (AI_PROVIDER_IDS as string[]).includes(value)
	);
}

function apimodelsOpusModel(
	catalog: readonly Model<"anthropic-messages">[],
): Model<"anthropic-messages"> {
	const builtin = catalog.find((m) => m.id === OPUS_MODEL_ID);
	return {
		id: OPUS_MODEL_ID,
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider: "apimodels",
		baseUrl: APIMODELS_BASE_URL,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 2.4, output: 12, cacheRead: 0.12, cacheWrite: 3 },
		contextWindow: builtin?.contextWindow ?? 200000,
		maxTokens: builtin?.maxTokens ?? 32000,
		...(builtin?.inputLimits ? { inputLimits: builtin.inputLimits } : {}),
		...(builtin?.promptCache ? { promptCache: builtin.promptCache } : {}),
	};
}

let modelsInstance: MutableModels | undefined;

export function getAIModels(): MutableModels {
	if (modelsInstance) return modelsInstance;

	const anthropic = anthropicProvider();
	const apimodels = createProvider<"anthropic-messages">({
		id: "apimodels",
		name: "apimodels.app",
		baseUrl: APIMODELS_BASE_URL,
		auth: {
			apiKey: envApiKeyAuth("apimodels.app API key", ["APIMODELS_API_KEY"]),
		},
		models: [apimodelsOpusModel(anthropic.getModels())],
		api: anthropicMessagesApi(),
	});

	const models = createModels({ identity: TAPLE_IDENTITY });
	models.setProvider(apimodels);
	models.setProvider(anthropic);
	models.setProvider(openaiProvider());
	modelsInstance = models;
	return models;
}

const ANTHROPIC_FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];

function anthropicRank(id: string): [number, number] {
	const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
	if (!match) return [0, ANTHROPIC_FAMILY_ORDER.length];
	const minor = match[3] && match[3].length <= 2 ? Number(match[3]) / 10 : 0;
	const family = ANTHROPIC_FAMILY_ORDER.indexOf(match[1]);
	return [
		Number(match[2]) + minor,
		family === -1 ? ANTHROPIC_FAMILY_ORDER.length : family,
	];
}

function openaiRank(id: string): number {
	const match = /^gpt-(\d+(?:\.\d+)?)/.exec(id);
	return match ? Number(match[1]) : 0;
}

function sortModels(
	provider: AIProviderId,
	models: readonly Model<Api>[],
): Model<Api>[] {
	const list = [...models];
	if (provider === "anthropic") {
		return list.sort((a, b) => {
			const [va, fa] = anthropicRank(a.id);
			const [vb, fb] = anthropicRank(b.id);
			return vb - va || fa - fb || a.id.localeCompare(b.id);
		});
	}
	if (provider === "openai") {
		return list.sort(
			(a, b) =>
				openaiRank(b.id) - openaiRank(a.id) ||
				a.id.localeCompare(b.id, undefined, { numeric: true }),
		);
	}
	return list;
}

export function listProviderModels(provider: AIProviderId): Model<Api>[] {
	const models = getAIModels()
		.getModels(provider)
		.filter((m) => m.input.includes("image"))
		.filter((m) => !/-(\d{8}|\d{4}-\d{2}-\d{2})$/.test(m.id));
	return sortModels(provider, models);
}

export function defaultModelId(provider: AIProviderId): string {
	const models = listProviderModels(provider);
	const preferred =
		provider === "openai" ? OPENAI_DEFAULT_MODEL_ID : OPUS_MODEL_ID;
	return models.find((m) => m.id === preferred)?.id ?? models[0]?.id ?? "";
}

export function resolveModel(
	provider: AIProviderId,
	modelId: string | undefined,
): Model<Api> | undefined {
	const models = listProviderModels(provider);
	return (
		models.find((m) => m.id === modelId) ??
		models.find((m) => m.id === defaultModelId(provider))
	);
}

export function formatModelPrice(model: Model<Api>): string {
	const price = (n: number) => `$${Number(n.toFixed(2))}`;
	return L(
		`每百万 token：输入 ${price(model.cost.input)}，输出 ${price(model.cost.output)}`,
		`Per 1M tokens: ${price(model.cost.input)} input, ${price(model.cost.output)} output`,
	);
}

export function formatCost(usd: number): string {
	if (usd <= 0) return "$0.00";
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}

export type ConnectionTestResult =
	| { ok: true; cost: number; latencyMs: number }
	| { ok: false; message: string };

export async function testConnection(
	model: Model<Api>,
	apiKey: string,
	signal?: AbortSignal,
): Promise<ConnectionTestResult> {
	const startedAt = performance.now();
	try {
		const message = await getAIModels().completeSimple(
			model,
			{
				messages: [
					{ role: "user", content: "Reply with OK.", timestamp: Date.now() },
				],
			},
			{ apiKey, maxTokens: 32, signal, maxRetries: 0 },
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return {
				ok: false,
				message: message.errorMessage ?? L("请求失败", "The request failed"),
			};
		}
		return {
			ok: true,
			cost: message.usage.cost.total,
			latencyMs: Math.round(performance.now() - startedAt),
		};
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}
