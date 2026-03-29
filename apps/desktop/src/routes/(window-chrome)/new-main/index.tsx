import { Button } from "@cap/ui-solid";
import { createMutation, useQuery } from "@tanstack/solid-query";
import { listen } from "@tauri-apps/api/event";
import {
	getAllWebviewWindows,
	WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import {
	getCurrentWindow,
	LogicalSize,
	primaryMonitor,
} from "@tauri-apps/api/window";
import * as dialog from "@tauri-apps/plugin-dialog";
import { type as ostype } from "@tauri-apps/plugin-os";
import * as updater from "@tauri-apps/plugin-updater";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createSignal,
	ErrorBoundary,
	onCleanup,
	onMount,
	Show,
	Suspense,
} from "solid-js";
import { reconcile } from "solid-js/store";
import Tooltip from "~/components/Tooltip";
import { Input } from "~/routes/editor/ui";
import { createSignInMutation } from "~/utils/auth";
import {
	createCameraMutation,
	createCurrentRecordingQuery,
	createLicenseQuery,
	getPermissions,
	listAudioDevices,
	listDisplaysWithThumbnails,
	listScreens,
	listVideoDevices,
	listWindows,
	listWindowsWithThumbnails,
} from "~/utils/queries";
import {
	type CameraInfo,
	type CaptureDisplay,
	type CaptureDisplayWithThumbnail,
	type CaptureWindow,
	type CaptureWindowWithThumbnail,
	commands,
	type DeviceOrModelID,
	type ScreenCaptureTarget,
} from "~/utils/tauri";
import IconLucideAppWindowMac from "~icons/lucide/app-window-mac";
import IconLucideSearch from "~icons/lucide/search";
import IconMaterialSymbolsScreenshotFrame2Rounded from "~icons/material-symbols/screenshot-frame-2-rounded";
import IconMdiMonitor from "~icons/mdi/monitor";
import { WindowChromeHeader } from "../Context";
import {
	RecordingOptionsProvider,
	useRecordingOptions,
} from "../OptionsContext";
import CameraSelect from "./CameraSelect";
import MicrophoneSelect from "./MicrophoneSelect";
import SystemAudio from "./SystemAudio";
import TargetMenuGrid from "./TargetMenuGrid";
import TargetTypeButton from "./TargetTypeButton";

function getWindowSize() {
	return {
		width: 270,
		height: 300,
	};
}

const findCamera = (cameras: CameraInfo[], id: DeviceOrModelID) => {
	return cameras.find((c) => {
		if (!id) return false;
		return "DeviceID" in id
			? id.DeviceID === c.device_id
			: id.ModelID === c.model_id;
	});
};

type WindowListItem = Pick<
	CaptureWindow,
	"id" | "owner_name" | "name" | "bounds" | "refresh_rate"
>;

const createWindowSignature = (
	list?: readonly WindowListItem[],
): string | undefined => {
	if (!list) return undefined;

	return list
		.map((item) => {
			const { position, size } = item.bounds;
			return [
				item.id,
				item.owner_name,
				item.name,
				position.x,
				position.y,
				size.width,
				size.height,
				item.refresh_rate,
			].join(":");
		})
		.join("|");
};

type DisplayListItem = Pick<CaptureDisplay, "id" | "name" | "refresh_rate">;

const createDisplaySignature = (
	list?: readonly DisplayListItem[],
): string | undefined => {
	if (!list) return undefined;

	return list
		.map((item) => [item.id, item.name, item.refresh_rate].join(":"))
		.join("|");
};

type InlinePanelProps =
	| {
			variant: "display";
			targets?: CaptureDisplayWithThumbnail[];
			onSelect: (target: CaptureDisplayWithThumbnail) => void;
			selectedId?: string;
	  }
	| {
			variant: "window";
			targets?: CaptureWindowWithThumbnail[];
			onSelect: (target: CaptureWindowWithThumbnail) => void;
			selectedId?: number;
	  };

function InlinePanel(
	props: InlinePanelProps & {
		isLoading: boolean;
		errorMessage?: string;
		disabled: boolean;
	},
) {
	const [search, setSearch] = createSignal("");
	const trimmedSearch = createMemo(() => search().trim());
	const normalizedQuery = createMemo(() => trimmedSearch().toLowerCase());
	const placeholder = props.variant === "display" ? "搜索显示器" : "搜索窗口";
	const noResultsMessage =
		props.variant === "display" ? "没有匹配的显示器" : "没有匹配的窗口";

	const filteredDisplayTargets = createMemo<CaptureDisplayWithThumbnail[]>(
		() => {
			if (props.variant !== "display") return [];
			const query = normalizedQuery();
			const targets = props.targets ?? [];
			if (!query) return targets;
			const matchesQuery = (value?: string | null) =>
				!!value && value.toLowerCase().includes(query);
			return targets.filter(
				(t) => matchesQuery(t.name) || matchesQuery(t.id),
			);
		},
	);

	const filteredWindowTargets = createMemo<CaptureWindowWithThumbnail[]>(() => {
		if (props.variant !== "window") return [];
		const query = normalizedQuery();
		const targets = props.targets ?? [];
		if (!query) return targets;
		const matchesQuery = (value?: string | null) =>
			!!value && value.toLowerCase().includes(query);
		return targets.filter(
			(t) =>
				matchesQuery(t.name) ||
				matchesQuery(t.owner_name) ||
				matchesQuery(t.id),
		);
	});

	return (
		<div class="flex flex-col gap-2">
			<div class="relative h-[36px] flex items-center">
				<IconLucideSearch class="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none size-3 text-gray-10" />
				<Input
					type="search"
					class="py-2 pl-6 h-full w-full"
					value={search()}
					onInput={(e) => setSearch(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape" && search()) {
							e.preventDefault();
							setSearch("");
						}
					}}
					placeholder={placeholder}
					autoCapitalize="off"
					autocorrect="off"
					autocomplete="off"
					spellcheck={false}
					aria-label={placeholder}
				/>
			</div>
			<div class="px-1 custom-scroll overflow-y-auto max-h-[160px]">
				{props.variant === "display" ? (
					<TargetMenuGrid
						variant="display"
						targets={filteredDisplayTargets()}
						isLoading={props.isLoading}
						errorMessage={props.errorMessage}
						onSelect={props.onSelect}
						disabled={props.disabled}
						highlightQuery={trimmedSearch()}
						emptyMessage={trimmedSearch() ? noResultsMessage : undefined}
						selectedId={props.selectedId}
					/>
				) : (
					<TargetMenuGrid
						variant="window"
						targets={filteredWindowTargets()}
						isLoading={props.isLoading}
						errorMessage={props.errorMessage}
						onSelect={props.onSelect}
						disabled={props.disabled}
						highlightQuery={trimmedSearch()}
						emptyMessage={trimmedSearch() ? noResultsMessage : undefined}
						selectedId={props.selectedId}
					/>
				)}
			</div>
		</div>
	);
}

export default function () {
	return (
		<RecordingOptionsProvider>
			<Page />
		</RecordingOptionsProvider>
	);
}

function Page() {
	const { rawOptions, setOptions } = useRecordingOptions();
	const currentRecording = createCurrentRecordingQuery();
	const isRecording = () => !!currentRecording.data;

	const [displayMenuOpen, setDisplayMenuOpen] = createSignal(false);
	const [windowMenuOpen, setWindowMenuOpen] = createSignal(false);
	const [hasOpenedDisplayMenu, setHasOpenedDisplayMenu] = createSignal(false);
	const [hasOpenedWindowMenu, setHasOpenedWindowMenu] = createSignal(false);

	const displayTargets = useQuery(() => ({
		...listDisplaysWithThumbnails,
		refetchInterval: false,
	}));

	const windowTargets = useQuery(() => ({
		...listWindowsWithThumbnails,
		refetchInterval: false,
	}));

	const screens = useQuery(() => listScreens);
	const windows = useQuery(() => listWindows);

	const hasDisplayTargetsData = () => displayTargets.status === "success";
	const hasWindowTargetsData = () => windowTargets.status === "success";

	const existingDisplayIds = createMemo(() => {
		const currentScreens = screens.data;
		if (!currentScreens) return undefined;
		return new Set(currentScreens.map((screen) => screen.id));
	});

	const displayTargetsData = createMemo(() => {
		if (!hasDisplayTargetsData()) return undefined;
		const ids = existingDisplayIds();
		if (!ids) return displayTargets.data;
		return displayTargets.data?.filter((target) => ids.has(target.id));
	});

	const existingWindowIds = createMemo(() => {
		const currentWindows = windows.data;
		if (!currentWindows) return undefined;
		return new Set(currentWindows.map((win) => win.id));
	});

	const windowTargetsData = createMemo(() => {
		if (!hasWindowTargetsData()) return undefined;
		const ids = existingWindowIds();
		if (!ids) return windowTargets.data;
		return windowTargets.data?.filter((target) => ids.has(target.id));
	});

	const displayMenuLoading = () =>
		!hasDisplayTargetsData() &&
		(displayTargets.status === "pending" ||
			displayTargets.fetchStatus === "fetching");
	const windowMenuLoading = () =>
		!hasWindowTargetsData() &&
		(windowTargets.status === "pending" ||
			windowTargets.fetchStatus === "fetching");

	const displayErrorMessage = () => {
		if (!displayTargets.error) return undefined;
		return "无法加载显示器列表，请尝试使用显示器按钮。";
	};

	const windowErrorMessage = () => {
		if (!windowTargets.error) return undefined;
		return "无法加载窗口列表，请尝试使用窗口按钮。";
	};

	const selectDisplayTarget = (target: CaptureDisplayWithThumbnail) => {
		setOptions(
			"captureTarget",
			reconcile({ variant: "display", id: target.id }),
		);
		setOptions("targetMode", "display");
		commands.openTargetSelectOverlays(rawOptions.captureTarget);
		setDisplayMenuOpen(false);
	};

	const selectWindowTarget = async (target: CaptureWindowWithThumbnail) => {
		setOptions(
			"captureTarget",
			reconcile({ variant: "window", id: target.id }),
		);
		setOptions("targetMode", "window");
		commands.openTargetSelectOverlays(rawOptions.captureTarget);
		setWindowMenuOpen(false);

		try {
			await commands.focusWindow(target.id);
		} catch (error) {
			console.error("Failed to focus window:", error);
		}
	};

	createEffect(() => {
		if (!isRecording()) return;
		setDisplayMenuOpen(false);
		setWindowMenuOpen(false);
	});

	const getHeight = () => (displayMenuOpen() || windowMenuOpen() ? 504 : 300);

	createEffect(() => {
		getCurrentWindow().setSize(new LogicalSize(270, getHeight()));
	});

	onMount(async () => {
		const targetMode = (window as any).__CAP__.initialTargetMode;
		setOptions({ targetMode });
		if (rawOptions.targetMode) commands.openTargetSelectOverlays(null);
		else commands.closeTargetSelectOverlays();

		const currentWindow = getCurrentWindow();

		currentWindow.setSize(new LogicalSize(270, getHeight()));

		const unlistenFocus = currentWindow.onFocusChanged(
			({ payload: focused }) => {
				if (focused) {
					currentWindow.setSize(new LogicalSize(270, getHeight()));
				}
			},
		);

		const unlistenResize = currentWindow.onResized(() => {
			currentWindow.setSize(new LogicalSize(270, getHeight()));
		});

		commands.updateAuthPlan();

		onCleanup(async () => {
			(await unlistenFocus)?.();
			(await unlistenResize)?.();
		});

		const monitor = await primaryMonitor();
		if (!monitor) return;
	});

	const cameras = useQuery(() => listVideoDevices);
	const mics = useQuery(() => listAudioDevices);
	const permissions = useQuery(() => getPermissions);

	const windowListSignature = createMemo(() =>
		createWindowSignature(windows.data),
	);
	const displayListSignature = createMemo(() =>
		createDisplaySignature(screens.data),
	);
	const [windowThumbnailsSignature, setWindowThumbnailsSignature] =
		createSignal<string | undefined>();
	const [displayThumbnailsSignature, setDisplayThumbnailsSignature] =
		createSignal<string | undefined>();

	createEffect(() => {
		if (windowTargets.status !== "success") return;
		const signature = createWindowSignature(windowTargets.data);
		if (signature !== undefined) setWindowThumbnailsSignature(signature);
	});

	createEffect(() => {
		if (displayTargets.status !== "success") return;
		const signature = createDisplaySignature(displayTargets.data);
		if (signature !== undefined) setDisplayThumbnailsSignature(signature);
	});

	createEffect(() => {
		if (!hasOpenedWindowMenu()) return;
		const signature = windowListSignature();
		if (signature === undefined) return;
		if (windowTargets.fetchStatus !== "idle") return;
		if (windowThumbnailsSignature() === signature) return;
		void windowTargets.refetch();
	});

	createEffect(() => {
		if (!hasOpenedDisplayMenu()) return;
		const signature = displayListSignature();
		if (signature === undefined) return;
		if (displayTargets.fetchStatus !== "idle") return;
		if (displayThumbnailsSignature() === signature) return;
		void displayTargets.refetch();
	});

	cameras.promise.then((cameras) => {
		if (rawOptions.cameraID && findCamera(cameras, rawOptions.cameraID)) {
			setOptions("cameraLabel", null);
		}
	});

	mics.promise.then((mics) => {
		if (rawOptions.micName && !mics.includes(rawOptions.micName)) {
			setOptions("micName", null);
		}
	});

	const options = {
		screen: () => {
			let screen;

			if (rawOptions.captureTarget.variant === "display") {
				const screenId = rawOptions.captureTarget.id;
				screen =
					screens.data?.find((s) => s.id === screenId) ?? screens.data?.[0];
			} else if (rawOptions.captureTarget.variant === "area") {
				const screenId = rawOptions.captureTarget.screen;
				screen =
					screens.data?.find((s) => s.id === screenId) ?? screens.data?.[0];
			}

			return screen;
		},
		window: () => {
			let win;

			if (rawOptions.captureTarget.variant === "window") {
				const windowId = rawOptions.captureTarget.id;
				win = windows.data?.find((s) => s.id === windowId) ?? windows.data?.[0];
			}

			return win;
		},
		camera: () => {
			if (!rawOptions.cameraID) return undefined;
			return findCamera(cameras.data || [], rawOptions.cameraID);
		},
		micName: () => mics.data?.find((name) => name === rawOptions.micName),
		target: (): ScreenCaptureTarget | undefined => {
			switch (rawOptions.captureTarget.variant) {
				case "display": {
					const screen = options.screen();
					if (!screen) return;
					return { variant: "display", id: screen.id };
				}
				case "window": {
					const window = options.window();
					if (!window) return;
					return { variant: "window", id: window.id };
				}
				case "area": {
					const screen = options.screen();
					if (!screen) return;
					return {
						variant: "area",
						bounds: rawOptions.captureTarget.bounds,
						screen: screen.id,
					};
				}
			}
		},
	};

	createEffect(() => {
		const target = options.target();
		if (!target) return;
		const screen = options.screen();
		if (!screen) return;

		if (target.variant === "window" && windows.data?.length === 0) {
			setOptions(
				"captureTarget",
				reconcile({ variant: "display", id: screen.id }),
			);
		}
	});

	const setMicInput = createMutation(() => ({
		mutationFn: async (name: string | null) => {
			await commands.setMicInput(name);
			setOptions("micName", name);
		},
	}));

	const setCamera = createCameraMutation();

	onMount(() => {
		if (rawOptions.cameraID && "ModelID" in rawOptions.cameraID)
			setCamera.mutate({ ModelID: rawOptions.cameraID.ModelID });
		else if (rawOptions.cameraID && "DeviceID" in rawOptions.cameraID)
			setCamera.mutate({ DeviceID: rawOptions.cameraID.DeviceID });
		else setCamera.mutate(null);
	});

	createEffect(() => {
		const cameraPermission = permissions.data?.camera;
		const cameraList = cameras.data;
		if (
			(cameraPermission === "granted" || cameraPermission === "notNeeded") &&
			cameraList &&
			cameraList.length > 0 &&
			!rawOptions.cameraID
		) {
			const first = cameraList[0];
			if (first.model_id) setCamera.mutate({ ModelID: first.model_id });
			else setCamera.mutate({ DeviceID: first.device_id });
		}
	});

	createEffect(() => {
		const micPermission = permissions.data?.microphone;
		const micList = mics.data;
		if (
			(micPermission === "granted" || micPermission === "notNeeded") &&
			micList &&
			micList.length > 0 &&
			!rawOptions.micName
		) {
			setMicInput.mutate(micList[0]);
		}
	});

	const license = createLicenseQuery();

	const signIn = createSignInMutation();

	const startSignInCleanup = listen("start-sign-in", async () => {
		const abort = new AbortController();
		for (const win of await getAllWebviewWindows()) {
			if (win.label.startsWith("target-select-overlay")) {
				await win.hide();
			}
		}

		await signIn.mutateAsync(abort).catch(() => {});

		for (const win of await getAllWebviewWindows()) {
			if (win.label.startsWith("target-select-overlay")) {
				await win.show();
			}
		}
	});
	onCleanup(() => startSignInCleanup.then((cb) => cb()));

	const openTeleprompter = async () => {
		const wins = await getAllWebviewWindows();
		const existing = wins.find((w) => w.label === "teleprompter");
		if (existing) {
			await existing.close();
			await new Promise((r) => setTimeout(r, 200));
		}

		const monitor = await primaryMonitor();
		const scaleFactor = monitor?.scaleFactor ?? 1;
		const monitorLogicalWidth = (monitor?.size.width ?? 1920) / scaleFactor;
		const windowWidth = 500;
		const windowHeight = 300;
		const x = Math.floor((monitorLogicalWidth - windowWidth) / 2);

		new WebviewWindow("teleprompter", {
			url: "/teleprompter",
			width: windowWidth,
			height: windowHeight,
			x,
			y: 0,
			alwaysOnTop: true,
			decorations: false,
			transparent: true,
			contentProtected: true,
			shadow: false,
			resizable: false,
			title: "提词器",
			skipTaskbar: true,
		});
	};

	const selectedDisplayId = () =>
		rawOptions.captureTarget.variant === "display"
			? rawOptions.captureTarget.id
			: undefined;

	const selectedWindowId = () =>
		rawOptions.captureTarget.variant === "window"
			? rawOptions.captureTarget.id
			: undefined;

	return (
		<div class="flex relative flex-col px-3 gap-2 h-full text-[--text-primary]">
			<WindowChromeHeader hideMaximize>
				<div
					class={cx(
						"flex items-center mx-2 w-full",
						ostype() === "macos" && "flex-row-reverse",
					)}
					data-tauri-drag-region
				>
					<div class="flex gap-1 items-center" data-tauri-drag-region>
						<Tooltip content={<span>设置</span>}>
							<button
								type="button"
								onClick={async () => {
									await commands.showWindow({ Settings: { page: "general" } });
									getCurrentWindow().hide();
								}}
								class="flex items-center justify-center size-5 -ml-[1.5px]"
							>
								<IconCapSettings class="transition-colors text-gray-11 size-4 hover:text-gray-12" />
							</button>
						</Tooltip>

					</div>
					{ostype() === "macos" && (
						<div class="flex-1" data-tauri-drag-region />
					)}
					<ErrorBoundary fallback={<></>}>
						<Suspense>
							<span
								onClick={async () => {
									if (license.data?.type !== "pro") {
										await commands.showWindow("Upgrade");
									}
								}}
								class={cx(
									"text-[0.6rem] ml-2 rounded-full px-1.5 py-0.5",
									license.data?.type === "pro"
										? "bg-[--blue-300] text-gray-1 dark:text-gray-12"
										: "bg-gray-4 cursor-pointer hover:bg-gray-5",
									ostype() === "windows" && "ml-2",
								)}
							>
								{license.data?.type === "commercial"
									? "商业版"
									: license.data?.type === "pro"
										? "专业版"
										: "个人版"}
							</span>
						</Suspense>
					</ErrorBoundary>
				</div>
			</WindowChromeHeader>
			<Show when={signIn.isPending}>
				<div class="flex absolute inset-0 justify-center items-center bg-gray-1 animate-in fade-in">
					<div class="flex flex-col gap-4 justify-center items-center">
						<span>登录中...</span>

						<Button
							onClick={() => {
								signIn.variables?.abort();
								signIn.reset();
							}}
							variant="gray"
							class="w-full"
						>
							取消登录
						</Button>
					</div>
				</div>
			</Show>
			<Show when={!signIn.isPending}>
				<div class="flex flex-col gap-2 w-full">
					<div class="space-y-2">
						<CameraSelect
							disabled={cameras.isPending}
							options={cameras.data ?? []}
							value={options.camera() ?? null}
							onChange={(c) => {
								if (!c) setCamera.mutate(null);
								else if (c.model_id) setCamera.mutate({ ModelID: c.model_id });
								else setCamera.mutate({ DeviceID: c.device_id });
							}}
						/>
						<MicrophoneSelect
							disabled={mics.isPending}
							options={mics.isPending ? [] : (mics.data ?? [])}
							value={
								mics.isPending ? rawOptions.micName : (options.micName() ?? null)
							}
							onChange={(v) => setMicInput.mutate(v)}
						/>
						<SystemAudio />
					</div>
					<div class="flex flex-row gap-2 items-stretch w-full text-xs text-gray-11">
						<TargetTypeButton
							selected={rawOptions.targetMode === "display"}
							Component={IconMdiMonitor}
							disabled={isRecording()}
							onClick={() => {
								if (isRecording()) return;
								setWindowMenuOpen(false);
								const screenList = screens.data ?? [];
								if (screenList.length <= 1) {
									const screen = screenList[0];
									if (screen) {
										setOptions(
											"captureTarget",
											reconcile({ variant: "display", id: screen.id }),
										);
										setOptions("targetMode", "display");
										commands.openTargetSelectOverlays(rawOptions.captureTarget);
									}
								} else {
									setDisplayMenuOpen((prev) => {
										const next = !prev;
										if (next) setHasOpenedDisplayMenu(true);
										return next;
									});
								}
							}}
							name="全屏录制"
							class={cx(
								"flex-1",
								(rawOptions.targetMode === "display" || displayMenuOpen()) &&
									"ring-2 ring-blue-9 ring-offset-2 ring-offset-gray-1",
							)}
						/>
						<TargetTypeButton
							selected={rawOptions.targetMode === "window"}
							Component={IconLucideAppWindowMac}
							disabled={isRecording()}
							onClick={() => {
								if (isRecording()) return;
								setDisplayMenuOpen(false);
								const windowList = windows.data ?? [];
								if (windowList.length <= 1) {
									const win = windowList[0];
									if (win) {
										setOptions(
											"captureTarget",
											reconcile({ variant: "window", id: win.id }),
										);
										setOptions("targetMode", "window");
										commands.openTargetSelectOverlays(rawOptions.captureTarget);
										commands.focusWindow(win.id).catch(console.error);
									}
								} else {
									setWindowMenuOpen((prev) => {
										const next = !prev;
										if (next) setHasOpenedWindowMenu(true);
										return next;
									});
								}
							}}
							name="窗口录制"
							class={cx(
								"flex-1",
								(rawOptions.targetMode === "window" || windowMenuOpen()) &&
									"ring-2 ring-blue-9 ring-offset-2 ring-offset-gray-1",
							)}
						/>
						<TargetTypeButton
							selected={rawOptions.targetMode === "area"}
							Component={IconMaterialSymbolsScreenshotFrame2Rounded}
							disabled={isRecording()}
							onClick={() => {
								if (isRecording()) return;
								setDisplayMenuOpen(false);
								setWindowMenuOpen(false);
								setOptions("targetMode", (v) => (v === "area" ? null : "area"));
								if (rawOptions.targetMode)
									commands.openTargetSelectOverlays(null);
								else commands.closeTargetSelectOverlays();
							}}
							name="区域录制"
							class={cx(
								"flex-1",
								rawOptions.targetMode === "area" &&
									"ring-2 ring-blue-9 ring-offset-2 ring-offset-gray-1",
							)}
						/>
					</div>
					<div class="flex flex-row gap-2">
						<button
							type="button"
							onClick={async () => {
								await commands.showWindow({ Settings: { page: "recordings" } });
								getCurrentWindow().hide();
							}}
							class="flex flex-1 flex-row gap-2 items-center px-2 h-9 rounded-lg transition-colors bg-gray-3 hover:bg-gray-4 text-gray-12"
						>
							<IconLucideSquarePlay class="text-gray-10 size-4" />
							<p class="flex-1 text-xs text-left">历史录制</p>
						</button>
						<button
							type="button"
							onClick={openTeleprompter}
							class="flex flex-1 flex-row gap-2 items-center px-2 h-9 rounded-lg transition-colors bg-gray-3 hover:bg-gray-4 text-gray-12"
						>
							<IconLucideScrollText class="text-gray-10 size-4" />
							<p class="flex-1 text-xs text-left">提词器</p>
						</button>
					</div>
					<Show when={displayMenuOpen()}>
						<InlinePanel
							variant="display"
							targets={displayTargetsData()}
							isLoading={displayMenuLoading()}
							errorMessage={displayErrorMessage()}
							onSelect={selectDisplayTarget}
							disabled={isRecording()}
							selectedId={selectedDisplayId()}
						/>
					</Show>
					<Show when={windowMenuOpen()}>
						<InlinePanel
							variant="window"
							targets={windowTargetsData()}
							isLoading={windowMenuLoading()}
							errorMessage={windowErrorMessage()}
							onSelect={selectWindowTarget}
							disabled={isRecording()}
							selectedId={selectedWindowId()}
						/>
					</Show>
				</div>
			</Show>
		</div>
	);
}
