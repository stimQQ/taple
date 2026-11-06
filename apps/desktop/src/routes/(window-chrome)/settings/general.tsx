import { Button } from "@cap/ui-solid";
import {
	isPermissionGranted,
	requestPermission,
} from "@tauri-apps/plugin-notification";
import { type OsType, type } from "@tauri-apps/plugin-os";
import "@total-typescript/ts-reset/filter-boolean";
import { CheckMenuItem, Menu, MenuItem } from "@tauri-apps/api/menu";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createResource,
	For,
	type ParentProps,
	Show,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { generalSettingsStore } from "~/store";
import { L } from "~/utils/i18n";
import {
	type CaptureWindow,
	commands,
	events,
	type GeneralSettingsStore,
	type MainWindowRecordingStartBehaviour,
	type PostDeletionBehaviour,
	type PostStudioRecordingBehaviour,
	type WindowExclusion,
} from "~/utils/tauri";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideX from "~icons/lucide/x";
import { SettingItem, ToggleSettingItem } from "./Setting";

const getExclusionPrimaryLabel = (entry: WindowExclusion) =>
	entry.ownerName ??
	entry.windowTitle ??
	entry.bundleIdentifier ??
	L("未知", "Unknown");

const getExclusionSecondaryLabel = (entry: WindowExclusion) => {
	if (entry.ownerName && entry.windowTitle) {
		return entry.windowTitle;
	}

	if (entry.bundleIdentifier && (entry.ownerName || entry.windowTitle)) {
		return entry.bundleIdentifier;
	}

	return entry.bundleIdentifier ?? null;
};

const getWindowOptionLabel = (window: CaptureWindow) => {
	const parts = [window.owner_name];
	if (window.name && window.name !== window.owner_name) {
		parts.push(window.name);
	}
	return parts.join(" • ");
};

type ExtendedGeneralSettingsStore = GeneralSettingsStore;

const createDefaultGeneralSettings = (): ExtendedGeneralSettingsStore => ({
	uploadIndividualFiles: false,
	hideDockIcon: false,
	autoCreateShareableLink: false,
	enableNotifications: true,
	enableNativeCameraPreview: false,
	enableNewRecordingFlow: true,
	autoZoomOnClicks: false,
	custom_cursor_capture2: true,
	excludedWindows: [],
});

const deriveInitialSettings = (
	store: GeneralSettingsStore | null,
): ExtendedGeneralSettingsStore => {
	const defaults = createDefaultGeneralSettings();
	if (!store) return defaults;

	return {
		...defaults,
		...store,
	};
};

export default function GeneralSettings() {
	const [store] = createResource(() => generalSettingsStore.get());

	return (
		<Show when={store.state === "ready" && ([store()] as const)}>
			{(store) => <Inner initialStore={store()[0] ?? null} />}
		</Show>
	);
}

function Inner(props: { initialStore: GeneralSettingsStore | null }) {
	const [settings, setSettings] = createStore<ExtendedGeneralSettingsStore>(
		deriveInitialSettings(props.initialStore),
	);

	createEffect(() => {
		setSettings(reconcile(deriveInitialSettings(props.initialStore)));
	});

	const [windows, { refetch: refetchWindows }] = createResource(
		async () => {
			// Fetch windows with a small delay to avoid blocking initial render
			await new Promise((resolve) => setTimeout(resolve, 100));
			return commands.listCaptureWindows();
		},
		{
			initialValue: [] as CaptureWindow[],
		},
	);

	const handleChange = async <K extends keyof typeof settings>(
		key: K,
		value: (typeof settings)[K],
	) => {
		console.log(`Handling settings change for ${key}: ${value}`);

		setSettings(key as keyof GeneralSettingsStore, value);
		generalSettingsStore.set({ [key]: value });
	};

	const ostype: OsType = type();
	const excludedWindows = createMemo(() => settings.excludedWindows ?? []);

	const matchesExclusion = (
		exclusion: WindowExclusion,
		window: CaptureWindow,
	) => {
		const bundleMatch = exclusion.bundleIdentifier
			? window.bundle_identifier === exclusion.bundleIdentifier
			: false;
		if (bundleMatch) return true;

		const ownerMatch = exclusion.ownerName
			? window.owner_name === exclusion.ownerName
			: false;

		if (exclusion.ownerName && exclusion.windowTitle) {
			return ownerMatch && window.name === exclusion.windowTitle;
		}

		if (ownerMatch && exclusion.ownerName) {
			return true;
		}

		if (exclusion.windowTitle) {
			return window.name === exclusion.windowTitle;
		}

		return false;
	};

	const isManagedWindowsApp = (window: CaptureWindow) => {
		const bundle = window.bundle_identifier?.toLowerCase() ?? "";
		if (bundle.includes("so.cap.desktop")) {
			return true;
		}
		return window.owner_name.toLowerCase().includes("cap");
	};

	const isWindowAvailable = (window: CaptureWindow) => {
		if (excludedWindows().some((entry) => matchesExclusion(entry, window))) {
			return false;
		}
		if (ostype === "windows") {
			return isManagedWindowsApp(window);
		}
		return true;
	};

	const availableWindows = createMemo(() => {
		const data = windows() ?? [];
		return data.filter(isWindowAvailable);
	});

	const refreshAvailableWindows = async (): Promise<CaptureWindow[]> => {
		try {
			const refreshed = (await refetchWindows()) ?? windows() ?? [];
			return refreshed.filter(isWindowAvailable);
		} catch (error) {
			console.error("Failed to refresh available windows", error);
			return availableWindows();
		}
	};

	const applyExcludedWindows = async (windows: WindowExclusion[]) => {
		setSettings("excludedWindows", windows);
		try {
			await generalSettingsStore.set({ excludedWindows: windows });
			await commands.refreshWindowContentProtection();
			if (ostype === "macos") {
				await events.requestScreenCapturePrewarm.emit({ force: true });
			}
		} catch (error) {
			console.error("Failed to update excluded windows", error);
		}
	};

	const handleRemoveExclusion = async (index: number) => {
		const current = [...excludedWindows()];
		current.splice(index, 1);
		await applyExcludedWindows(current);
	};

	const handleAddWindow = async (window: CaptureWindow) => {
		const windowTitle = window.bundle_identifier ? null : window.name;

		const next = [
			...excludedWindows(),
			{
				bundleIdentifier: window.bundle_identifier ?? null,
				ownerName: window.owner_name ?? null,
				windowTitle,
			},
		];
		await applyExcludedWindows(next);
	};

	const handleResetExclusions = async () => {
		const defaults = await commands.getDefaultExcludedWindows();
		await applyExcludedWindows(defaults);
	};

	// Helper function to render select dropdown for recording behaviors
	const SelectSettingItem = <
		T extends
			| MainWindowRecordingStartBehaviour
			| PostStudioRecordingBehaviour
			| PostDeletionBehaviour
			| number,
	>(props: {
		label: string;
		description: string;
		value: T;
		onChange: (value: T) => void;
		options: { text: string; value: any }[];
	}) => {
		return (
			<SettingItem label={props.label} description={props.description}>
				<button
					type="button"
					class="flex flex-row gap-1 text-xs bg-gray-3 items-center px-2.5 py-1.5 rounded-md border border-gray-4"
					onClick={async () => {
						const currentValue = props.value;
						const items = props.options.map((option) =>
							CheckMenuItem.new({
								text: option.text,
								checked: currentValue === option.value,
								action: () => props.onChange(option.value),
							}),
						);
						const menu = await Menu.new({
							items: await Promise.all(items),
						});
						await menu.popup();
						await menu.close();
					}}
				>
					{(() => {
						const currentValue = props.value;
						const option = props.options.find(
							(opt) => opt.value === currentValue,
						);
						return option ? option.text : currentValue;
					})()}
					<IconCapChevronDown class="size-4" />
				</button>
			</SettingItem>
		);
	};

	return (
		<div class="flex flex-col h-full custom-scroll">
			<div class="p-4 space-y-6">
				{ostype === "macos" && (
					<SettingGroup title={L("应用", "App")}>
						<ToggleSettingItem
							label={L("始终显示程序坞图标", "Always Show Dock Icon")}
							description={L(
								"即使没有可关闭的窗口，也在程序坞中显示 Taple。",
								"Show Taple in the Dock even when there are no windows available to close.",
							)}
							value={!settings.hideDockIcon}
							onChange={(v) => handleChange("hideDockIcon", !v)}
						/>
						<ToggleSettingItem
							label={L("启用系统通知", "Enable System Notifications")}
							description={L(
								"在复制到剪贴板、保存文件等操作时显示系统通知。你可能需要在系统通知设置中手动允许 Taple 的通知权限。",
								"Show system notifications for actions like copying to clipboard or saving files. You may need to allow notifications for Taple in System Settings.",
							)}
							value={!!settings.enableNotifications}
							onChange={async (value) => {
								if (value) {
									// Check current permission state
									console.log("Checking notification permission status");
									const permissionGranted = await isPermissionGranted();
									console.log(
										`Current permission status: ${permissionGranted}`,
									);

									if (!permissionGranted) {
										// Request permission if not granted
										console.log(
											"Permission not granted, requesting permission",
										);
										const permission = await requestPermission();
										console.log(`Permission request result: ${permission}`);
										if (permission !== "granted") {
											// If permission denied, don't enable the setting
											console.log("Permission denied, aborting setting change");
											return;
										}
									}
								}
								handleChange("enableNotifications", value);
							}}
						/>
						<ToggleSettingItem
							label={L("启用触觉反馈", "Enable Haptics")}
							description={L(
								"在 Force Touch™ 触控板上使用触觉反馈",
								"Use haptic feedback on Force Touch™ trackpads",
							)}
							value={!!settings.hapticsEnabled}
							onChange={(v) => handleChange("hapticsEnabled", v)}
						/>
					</SettingGroup>
				)}

				<SettingGroup title={L("录制", "Recording")}>
					<SelectSettingItem
						label={L("录制倒计时", "Recording Countdown")}
						description={L(
							"开始录制前的倒计时",
							"Countdown before recording starts",
						)}
						value={settings.recordingCountdown ?? 0}
						onChange={(value) => handleChange("recordingCountdown", value)}
						options={[
							{ text: L("关闭", "Off"), value: 0 },
							{ text: L("3 秒", "3 seconds"), value: 3 },
							{ text: L("5 秒", "5 seconds"), value: 5 },
							{ text: L("10 秒", "10 seconds"), value: 10 },
						]}
					/>
					<SelectSettingItem
						label={L("录制开始时主窗口行为", "Main Window on Recording Start")}
						description={L(
							"开始录制时主窗口的行为",
							"What the main window does when recording starts",
						)}
						value={settings.mainWindowRecordingStartBehaviour ?? "close"}
						onChange={(value) =>
							handleChange("mainWindowRecordingStartBehaviour", value)
						}
						options={[
							{ text: L("关闭", "Close"), value: "close" },
							{ text: L("最小化", "Minimize"), value: "minimise" },
						]}
					/>
					<SelectSettingItem
						label={L("工作室模式录制完成后行为", "After Studio Recording")}
						description={L(
							"工作室模式录制完成后的行为",
							"What happens after a Studio Mode recording finishes",
						)}
						value={settings.postStudioRecordingBehaviour ?? "openEditor"}
						onChange={(value) =>
							handleChange("postStudioRecordingBehaviour", value)
						}
						options={[
							{ text: L("打开编辑器", "Open Editor"), value: "openEditor" },
							{
								text: L("在浮窗中显示", "Show in Overlay"),
								value: "showOverlay",
							},
						]}
					/>
					<SelectSettingItem
						label={L("删除录制后的行为", "After Deleting Recording")}
						description={L(
							"删除进行中的录制后，Taple 是否应重新打开？",
							"Should Taple reopen after deleting an in-progress recording?",
						)}
						value={settings.postDeletionBehaviour ?? "doNothing"}
						onChange={(value) => handleChange("postDeletionBehaviour", value)}
						options={[
							{ text: L("不做任何操作", "Do Nothing"), value: "doNothing" },
							{
								text: L("重新打开录制窗口", "Reopen Recording Window"),
								value: "reopenRecordingWindow",
							},
						]}
					/>
				</SettingGroup>

				<ExcludedWindowsCard
					excludedWindows={excludedWindows()}
					availableWindows={availableWindows()}
					onRequestAvailableWindows={refreshAvailableWindows}
					onRemove={handleRemoveExclusion}
					onAdd={handleAddWindow}
					onReset={handleResetExclusions}
					isLoading={windows.loading}
					isWindows={ostype === "windows"}
				/>
			</div>
		</div>
	);
}

function SettingGroup(
	props: ParentProps<{ title: string; titleStyling?: string }>,
) {
	return (
		<div>
			<h3 class={cx("mb-3 text-sm text-gray-12 w-fit", props.titleStyling)}>
				{props.title}
			</h3>
			<div class="px-3 rounded-xl border divide-y divide-gray-3 border-gray-3 bg-gray-2">
				{props.children}
			</div>
		</div>
	);
}

function ExcludedWindowsCard(props: {
	excludedWindows: WindowExclusion[];
	availableWindows: CaptureWindow[];
	onRequestAvailableWindows: () => Promise<CaptureWindow[]>;
	onRemove: (index: number) => Promise<void>;
	onAdd: (window: CaptureWindow) => Promise<void>;
	onReset: () => Promise<void>;
	isLoading: boolean;
	isWindows: boolean;
}) {
	const hasExclusions = () => props.excludedWindows.length > 0;
	const canAdd = () => !props.isLoading;

	const handleAddClick = async (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();

		if (!canAdd()) return;

		// Use available windows if we have them, otherwise fetch
		let windows = props.availableWindows;

		// Only refresh if we don't have any windows cached
		if (!windows.length) {
			try {
				windows = await props.onRequestAvailableWindows();
			} catch (error) {
				console.error("Failed to fetch windows:", error);
				return;
			}
		}

		if (!windows.length) {
			console.log("No available windows to exclude");
			return;
		}

		try {
			const items = await Promise.all(
				windows.map((window) =>
					MenuItem.new({
						text: getWindowOptionLabel(window),
						action: () => {
							void props.onAdd(window);
						},
					}),
				),
			);

			const menu = await Menu.new({ items });

			// Save scroll position before popup
			const scrollPos = window.scrollY;

			await menu.popup();
			await menu.close();

			// Restore scroll position after menu closes
			requestAnimationFrame(() => {
				window.scrollTo(0, scrollPos);
			});
		} catch (error) {
			console.error("Error showing window menu:", error);
		}
	};

	return (
		<div class="flex flex-col gap-3 px-4 py-3 mt-6 rounded-xl border border-gray-3 bg-gray-2">
			<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
				<div class="flex flex-col gap-1">
					<p class="text-sm text-gray-12">
						{L("排除窗口", "Excluded Windows")}
					</p>
					<p class="text-xs text-gray-10">
						{L(
							"选择在录制时要隐藏的窗口。",
							"Choose which windows to hide from your recordings.",
						)}
					</p>
					<Show when={props.isWindows}>
						<p class="text-xs text-gray-9">
							<span class="font-medium text-gray-11">
								{L("注意：", "Note: ")}
							</span>
							{L(
								"由于技术限制，Windows 系统上只能排除与 Taple 相关的窗口。",
								"Due to technical limitations, only Taple-related windows can be excluded on Windows.",
							)}
						</p>
					</Show>
				</div>
				<div class="flex gap-2">
					<Button
						variant="gray"
						size="sm"
						disabled={props.isLoading}
						onClick={() => {
							if (props.isLoading) return;
							void props.onReset();
						}}
					>
						{L("恢复默认", "Reset to Default")}
					</Button>
					<Button
						variant="dark"
						size="sm"
						disabled={!canAdd()}
						onClick={(e) => void handleAddClick(e)}
						class="flex items-center gap-2"
					>
						<IconLucidePlus class="size-4" />
						{L("添加", "Add")}
					</Button>
				</div>
			</div>
			<Show when={!props.isLoading} fallback={<ExcludedWindowsSkeleton />}>
				<Show
					when={hasExclusions()}
					fallback={
						<p class="text-xs text-gray-10">
							{L(
								"当前没有排除任何窗口。",
								"No windows are currently excluded.",
							)}
						</p>
					}
				>
					<div class="flex flex-wrap gap-2">
						<For each={props.excludedWindows}>
							{(entry, index) => (
								<div class="group flex items-center gap-2 rounded-full border border-gray-4 bg-gray-3 px-3 py-1.5">
									<div class="flex flex-col leading-tight">
										<span class="text-sm text-gray-12">
											{getExclusionPrimaryLabel(entry)}
										</span>
										<Show when={getExclusionSecondaryLabel(entry)}>
											{(label) => (
												<span class="text-[0.65rem] text-gray-9">
													{label()}
												</span>
											)}
										</Show>
									</div>
									<button
										type="button"
										class="flex items-center justify-center rounded-full bg-gray-4/70 text-gray-11 transition-colors hover:bg-gray-5 hover:text-gray-12 size-6"
										onClick={() => void props.onRemove(index())}
										aria-label={L("移除排除的窗口", "Remove excluded window")}
									>
										<IconLucideX class="size-3" />
									</button>
								</div>
							)}
						</For>
					</div>
				</Show>
			</Show>
		</div>
	);
}

function ExcludedWindowsSkeleton() {
	const chipWidths = ["w-32", "w-28", "w-36"] as const;

	return (
		<div class="flex flex-wrap gap-2" aria-hidden="true">
			<For each={chipWidths}>
				{(width) => (
					<div class="flex items-center gap-2 rounded-full border border-gray-4 bg-gray-3 px-3 py-1.5 animate-pulse">
						<div class="flex flex-col gap-1 leading-tight">
							<div class={cx("h-3 rounded bg-gray-4", width)} />
							<div class="h-2 w-16 rounded bg-gray-4" />
						</div>
						<div class="size-6 rounded-full bg-gray-4" />
					</div>
				)}
			</For>
		</div>
	);
}
