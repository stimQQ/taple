import { Button } from "@cap/ui-solid";
import { useLocation } from "@solidjs/router";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import * as shell from "@tauri-apps/plugin-shell";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
	For,
	on,
	Show,
} from "solid-js";
import toast from "solid-toast";
import { aiSettingsStore } from "~/store";
import {
	AI_PROVIDER_IDS,
	type AIProviderId,
	type ConnectionTestResult,
	formatCost,
	formatModelPrice,
	listProviderModels,
	providerInfo,
	resolveModel,
	testConnection,
} from "~/utils/ai/providers";
import {
	deleteApiKey,
	getApiKey,
	resolveAISettings,
	saveAIModel,
	saveAIProvider,
	saveApiKey,
} from "~/utils/ai/settings";
import { createTauriEventListener } from "~/utils/createEventListener";
import { L } from "~/utils/i18n";
import {
	commands,
	events,
	type McpClient,
	type McpClientStatus,
} from "~/utils/tauri";
import { Group } from "./Setting";

type KeyState = { saved: boolean; suffix?: string; error?: string };

function keySuffix(key: string): string | undefined {
	return key.length >= 12 ? key.slice(-4) : undefined;
}

function errorText(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export default function AISettings() {
	const settingsQuery = aiSettingsStore.createQuery();
	const settings = createMemo(() => resolveAISettings(settingsQuery.data));
	const provider = () => settings().provider;
	const info = () => providerInfo(provider());
	const models = createMemo(() => listProviderModels(provider()));
	const model = createMemo(() => resolveModel(provider(), settings().modelId));

	const [keyState, { refetch: refetchKey }] = createResource(
		() =>
			settingsQuery.isSuccess
				? { provider: provider(), stamp: settings().keysUpdatedAt }
				: false,
		(source): Promise<KeyState> =>
			getApiKey(source.provider, source.stamp)
				.then((key) => ({
					saved: key !== null,
					suffix: key ? keySuffix(key) : undefined,
				}))
				.catch((error) => ({ saved: false, error: errorText(error) })),
	);

	const [keyInput, setKeyInput] = createSignal("");
	const [saving, setSaving] = createSignal(false);
	const [testing, setTesting] = createSignal(false);
	const [testResult, setTestResult] = createSignal<ConnectionTestResult | null>(
		null,
	);

	const chooseProvider = async (id: AIProviderId) => {
		if (id === provider()) return;
		setKeyInput("");
		setTestResult(null);
		await saveAIProvider(id);
		settingsQuery.refetch();
	};

	const chooseModel = async () => {
		const current = model()?.id;
		const items = await Promise.all(
			models().map((m) =>
				CheckMenuItem.new({
					text: m.name,
					checked: m.id === current,
					action: async () => {
						setTestResult(null);
						await saveAIModel(provider(), m.id);
						settingsQuery.refetch();
					},
				}),
			),
		);
		const menu = await Menu.new({ items });
		await menu.popup();
		await menu.close();
	};

	const saveKey = async () => {
		const value = keyInput().trim();
		if (!value) return;
		setSaving(true);
		try {
			await saveApiKey(provider(), value);
			setKeyInput("");
			setTestResult(null);
			toast.success(L("API 密钥已保存到钥匙串", "API key saved to Keychain"));
			settingsQuery.refetch();
			refetchKey();
		} catch (error) {
			toast.error(
				L("保存 API 密钥失败：", "Failed to save the API key: ") +
					errorText(error),
			);
		} finally {
			setSaving(false);
		}
	};

	const removeKey = async () => {
		setSaving(true);
		try {
			await deleteApiKey(provider());
			setTestResult(null);
			toast.success(L("已删除 API 密钥", "API key removed"));
			settingsQuery.refetch();
			refetchKey();
		} catch (error) {
			toast.error(
				L("删除 API 密钥失败：", "Failed to remove the API key: ") +
					errorText(error),
			);
		} finally {
			setSaving(false);
		}
	};

	const runTest = async () => {
		const selected = model();
		if (!selected) return;
		setTesting(true);
		setTestResult(null);
		try {
			const key =
				keyInput().trim() ||
				(await getApiKey(provider(), settings().keysUpdatedAt));
			if (!key) {
				setTestResult({
					ok: false,
					message: L(
						"请先输入或保存 API 密钥",
						"Enter or save an API key first",
					),
				});
				return;
			}
			setTestResult(await testConnection(selected, key));
		} catch (error) {
			setTestResult({ ok: false, message: errorText(error) });
		} finally {
			setTesting(false);
		}
	};

	return (
		<div class="flex flex-col h-full custom-scroll">
			<div class="p-4 space-y-6">
				<p class="text-xs leading-relaxed text-gray-11">
					{L(
						"AI 剪辑会像剪辑师一样帮你处理录制：剪掉停顿和口误、给等待加速、在点击处放大。选择一个模型服务并填入 API 密钥即可使用，费用由该服务按用量收取。",
						"AI Edit works on your recording like a human editor: it cuts pauses and mistakes, speeds up waiting and zooms in on clicks. Choose a model provider and add its API key; the provider bills you for usage.",
					)}
				</p>

				<Group title={L("模型服务", "Provider")}>
					<div class="flex flex-col gap-2 py-3">
						<For each={AI_PROVIDER_IDS}>
							{(id) => {
								const item = providerInfo(id);
								return (
									<button
										type="button"
										class={cx(
											"flex flex-row gap-3 items-start p-3 text-left rounded-lg border transition-colors",
											provider() === id
												? "border-blue-9 bg-blue-3"
												: "border-gray-4 hover:bg-gray-3",
										)}
										onClick={() => chooseProvider(id)}
									>
										<span
											class={cx(
												"mt-0.5 flex justify-center items-center rounded-full border size-4 shrink-0",
												provider() === id ? "border-blue-9" : "border-gray-7",
											)}
										>
											<Show when={provider() === id}>
												<span class="rounded-full size-2 bg-blue-9" />
											</Show>
										</span>
										<span class="flex flex-col gap-0.5">
											<span class="flex flex-row flex-wrap gap-2 items-center text-sm text-gray-12">
												{item.name}
												<Show when={item.recommended}>
													<span class="px-1.5 py-px text-[11px] whitespace-nowrap rounded-full bg-blue-9 text-gray-1">
														{L("推荐", "Recommended")}
													</span>
												</Show>
											</span>
											<span class="text-xs text-gray-11">
												{item.description}
											</span>
										</span>
									</button>
								);
							}}
						</For>
					</div>
				</Group>

				<Group title={L("API 密钥", "API key")}>
					<div class="flex flex-col gap-3 py-3">
						<div class="flex flex-row gap-2 items-center text-xs">
							<Show
								when={!keyState.loading || keyState.latest}
								fallback={
									<span class="text-gray-11">
										{L("正在读取钥匙串…", "Reading Keychain…")}
									</span>
								}
							>
								<Show
									when={keyState.latest?.error}
									fallback={
										<span
											class={cx(
												"flex flex-row gap-1.5 items-center",
												keyState.latest?.saved
													? "text-green-600"
													: "text-gray-11",
											)}
										>
											<Show
												when={keyState.latest?.saved}
												fallback={
													<>
														<IconCapInfo class="size-3.5" />
														{L(
															`还没有保存 ${info().name} 的密钥`,
															`No ${info().name} key saved yet`,
														)}
													</>
												}
											>
												<IconCapCircleCheck class="size-3.5" />
												{keyState.latest?.suffix
													? L(
															`已保存密钥 …${keyState.latest.suffix}（在 macOS 钥匙串中）`,
															`Key …${keyState.latest.suffix} is saved in the macOS Keychain`,
														)
													: L(
															"已有密钥保存在 macOS 钥匙串中",
															"A key is saved in the macOS Keychain",
														)}
											</Show>
										</span>
									}
								>
									{(error) => <span class="text-red-500">{error()}</span>}
								</Show>
							</Show>
						</div>
						<input
							type="password"
							autocomplete="off"
							spellcheck={false}
							class="w-full h-9 px-3 text-sm rounded-lg border outline-none transition-colors border-gray-4 bg-gray-1 text-gray-12 placeholder:text-gray-9 focus:border-blue-9"
							placeholder={
								keyState.latest?.saved
									? L("输入新密钥以替换", "Enter a new key to replace it")
									: info().keyPlaceholder
							}
							value={keyInput()}
							onInput={(e) => setKeyInput(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") saveKey();
							}}
						/>
						<div class="flex flex-row flex-wrap gap-2 items-center">
							<Button
								variant="dark"
								size="sm"
								class="whitespace-nowrap"
								disabled={!keyInput().trim() || saving()}
								onClick={saveKey}
							>
								{L("保存", "Save")}
							</Button>
							<Show when={keyState.latest?.saved}>
								<Button
									variant="white"
									size="sm"
									class="whitespace-nowrap"
									disabled={saving()}
									onClick={removeKey}
								>
									{L("删除", "Remove")}
								</Button>
							</Show>
							<button
								type="button"
								class="flex flex-row gap-1 items-center ml-auto text-xs whitespace-nowrap text-blue-11 hover:underline"
								onClick={() => shell.open(info().keyUrl)}
							>
								{info().keyLinkLabel}
								<IconLucideArrowUpRight class="size-3" />
							</button>
						</div>
						<p class="text-xs text-gray-10">
							{L(
								"密钥只保存在本机钥匙串里，只会发送给你选择的模型服务。",
								"The key stays in this Mac's Keychain and is only sent to the provider you choose.",
							)}
						</p>
					</div>
				</Group>

				<Group title={L("模型", "Model")}>
					<div class="flex flex-row gap-2 justify-between items-center py-3">
						<div class="flex flex-col gap-0.5 min-w-0">
							<span class="text-sm text-gray-12">
								{model()?.name ?? L("没有可用模型", "No model available")}
							</span>
							<Show when={model()}>
								{(m) => (
									<span class="text-xs text-gray-11">
										{formatModelPrice(m())}
									</span>
								)}
							</Show>
						</div>
						<Show when={models().length > 1}>
							<button
								type="button"
								class="flex flex-row gap-1 items-center px-2.5 py-1.5 text-xs whitespace-nowrap rounded-md border bg-gray-3 border-gray-4 shrink-0"
								onClick={chooseModel}
							>
								{L("更换模型", "Change model")}
								<IconCapChevronDown class="size-4" />
							</button>
						</Show>
					</div>
					<div class="flex flex-row flex-wrap gap-2 items-center py-3">
						<Button
							variant="white"
							size="sm"
							class="whitespace-nowrap shrink-0"
							disabled={testing() || !model()}
							onClick={runTest}
						>
							{testing()
								? L("测试中…", "Testing…")
								: L("测试连接", "Test connection")}
						</Button>
						<Show when={testResult()}>
							{(result) => {
								const r = result();
								return r.ok ? (
									<span class="text-xs text-green-600">
										{L(
											`连接成功 · ${(r.latencyMs / 1000).toFixed(1)} 秒 · ${formatCost(r.cost)}`,
											`Connected · ${(r.latencyMs / 1000).toFixed(1)} s · ${formatCost(r.cost)}`,
										)}
									</span>
								) : (
									<span class="text-xs text-red-500 break-all">
										{r.message}
									</span>
								);
							}}
						</Show>
					</div>
				</Group>
				<AgentConnections />
			</div>
		</div>
	);
}

const CLIENT_NAMES: Record<McpClient, string> = {
	claudeCode: "Claude Code",
	codex: "Codex",
	claudeDesktop: "Claude Desktop",
	cursor: "Cursor",
};

const AGENT_SECTION_ID = "agents";

function AgentConnections() {
	const [statuses, { refetch }] = createResource(
		() => commands.mcpClientStatuses().catch(() => []),
		{ initialValue: [] },
	);
	const [busy, setBusy] = createSignal<McpClient | null>(null);
	const [highlighted, setHighlighted] = createSignal(false);
	const location = useLocation();
	let section: HTMLDivElement | undefined;

	let highlightTimer: ReturnType<typeof setTimeout> | undefined;
	const reveal = () => {
		const scroll = () =>
			section?.scrollIntoView({ behavior: "smooth", block: "start" });
		requestAnimationFrame(scroll);
		setTimeout(scroll, 400);
		setHighlighted(true);
		clearTimeout(highlightTimer);
		highlightTimer = setTimeout(() => setHighlighted(false), 2400);
	};

	createEffect(
		on(
			() => location.hash,
			(hash) => {
				if (hash === `#${AGENT_SECTION_ID}`) reveal();
			},
		),
	);

	createTauriEventListener(events.navigateSettings, (payload) => {
		if (payload.page.endsWith(`#${AGENT_SECTION_ID}`)) reveal();
	});

	const update = async (client: McpClient, connect: boolean) => {
		setBusy(client);
		const name = CLIENT_NAMES[client];
		try {
			if (connect) {
				await commands.mcpConnectClient(client);
				toast.success(
					L(
						`已连接 ${name}。重新打开 ${name} 后，对它说「用 Taple 剪辑我最新的录制」就能开始。`,
						`${name} is connected. Restart ${name}, then ask it to "edit my latest Taple recording".`,
					),
				);
			} else {
				await commands.mcpDisconnectClient(client);
				toast.success(L(`已断开 ${name}`, `${name} is disconnected`));
			}
		} catch (error) {
			toast.error(errorText(error));
		} finally {
			setBusy(null);
			refetch();
		}
	};

	const statusText = (status: McpClientStatus) => {
		if (!status.available) return L("未安装", "Not installed");
		if (status.connected && status.needsUpdate)
			return L("Taple 位置变了，需要重新连接", "Taple moved, reconnect it");
		if (status.connected) return L("已连接", "Connected");
		return L("未连接", "Not connected");
	};

	return (
		<Group
			ref={(element) => {
				section = element;
			}}
			id={AGENT_SECTION_ID}
			highlighted={highlighted()}
			title={L("接入 Agent", "AI Agents")}
		>
			<p class="py-3 text-xs leading-relaxed text-gray-11">
				{L(
					"通过 MCP 把 Taple 接入 Claude Code、Codex 等 Agent。连接后对它说「用 Taple 剪辑我最新的录制」，它就会在 Taple 里剪辑。用的是你自己的订阅，不需要 API 密钥，也不产生 API 费用。你在 Taple 编辑器里能实时看到每一步，随时可以撤销。",
					'Connect Taple to agents such as Claude Code and Codex over MCP. Then ask them to "edit my latest Taple recording" and they edit it in Taple with your own subscription, so no API key or API cost is needed. You watch every step live in the Taple editor and can undo any of it.',
				)}
			</p>
			<For each={statuses()}>
				{(status) => (
					<div class="flex flex-row gap-3 items-center py-3">
						<div class="flex-1 min-w-0">
							<div class="text-sm text-gray-12">
								{CLIENT_NAMES[status.client]}
							</div>
							<div
								class={cx(
									"text-xs",
									status.connected && !status.needsUpdate
										? "text-green-600"
										: "text-gray-10",
								)}
							>
								{statusText(status)}
							</div>
						</div>
						<Show when={status.available}>
							<Show
								when={status.connected && !status.needsUpdate}
								fallback={
									<Button
										variant="dark"
										size="sm"
										class="whitespace-nowrap"
										disabled={busy() !== null}
										onClick={() => update(status.client, true)}
									>
										{busy() === status.client
											? L("连接中…", "Connecting…")
											: status.needsUpdate
												? L("重新连接", "Reconnect")
												: L("一键连接", "Connect")}
									</Button>
								}
							>
								<Button
									variant="white"
									size="sm"
									class="whitespace-nowrap"
									disabled={busy() !== null}
									onClick={() => update(status.client, false)}
								>
									{L("断开", "Disconnect")}
								</Button>
							</Show>
						</Show>
					</div>
				)}
			</For>
			<p class="py-3 text-xs leading-relaxed text-gray-10">
				{L(
					"不需要安装 Node.js 或其他工具，连接程序就内置在 Taple 里。使用时保持 Taple 打开（没打开时会自动启动）。连接只会在这些工具的配置里加入 Taple 这一项，修改前会自动备份原文件。",
					"No Node.js or other tools are needed: the connector is built into Taple. Keep Taple open while you use it (it starts automatically if needed). Connecting only adds a Taple entry to each tool's settings, and the original file is backed up first.",
				)}
			</p>
		</Group>
	);
}
