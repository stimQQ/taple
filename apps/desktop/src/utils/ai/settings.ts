import { type AISettingsStore, aiSettingsStore } from "~/store";
import { commands } from "~/utils/tauri";
import {
	type AIProviderId,
	DEFAULT_AI_PROVIDER,
	defaultModelId,
	isAIProviderId,
} from "./providers";

export type ResolvedAISettings = {
	provider: AIProviderId;
	modelId: string;
	keysUpdatedAt: number;
};

export function resolveAISettings(
	stored: AISettingsStore | null | undefined,
): ResolvedAISettings {
	const candidate = stored?.provider;
	const provider = isAIProviderId(candidate) ? candidate : DEFAULT_AI_PROVIDER;
	return {
		provider,
		modelId: stored?.models?.[provider] || defaultModelId(provider),
		keysUpdatedAt: stored?.keysUpdatedAt ?? 0,
	};
}

export async function loadAISettings(): Promise<ResolvedAISettings> {
	return resolveAISettings(await aiSettingsStore.get());
}

export async function saveAIProvider(provider: AIProviderId) {
	await aiSettingsStore.set({ provider });
}

export async function saveAIModel(provider: AIProviderId, modelId: string) {
	const current = (await aiSettingsStore.get())?.models ?? {};
	await aiSettingsStore.set({ models: { ...current, [provider]: modelId } });
}

const keyCache = new Map<AIProviderId, string | null>();
let cacheStamp = 0;

function syncCache(keysUpdatedAt: number) {
	if (keysUpdatedAt !== cacheStamp) {
		keyCache.clear();
		cacheStamp = keysUpdatedAt;
	}
}

export async function getApiKey(
	provider: AIProviderId,
	keysUpdatedAt?: number,
): Promise<string | null> {
	syncCache(keysUpdatedAt ?? (await aiSettingsStore.get())?.keysUpdatedAt ?? 0);
	if (keyCache.has(provider)) return keyCache.get(provider) ?? null;
	const key = (await commands.aiGetApiKey(provider))?.trim() || null;
	keyCache.set(provider, key);
	return key;
}

async function markKeysUpdated() {
	const stamp = Date.now();
	keyCache.clear();
	cacheStamp = stamp;
	await aiSettingsStore.set({ keysUpdatedAt: stamp });
}

export async function saveApiKey(provider: AIProviderId, apiKey: string) {
	await commands.aiSetApiKey(provider, apiKey.trim());
	await markKeysUpdated();
	keyCache.set(provider, apiKey.trim());
}

export async function deleteApiKey(provider: AIProviderId) {
	await commands.aiDeleteApiKey(provider);
	await markKeysUpdated();
	keyCache.set(provider, null);
}
