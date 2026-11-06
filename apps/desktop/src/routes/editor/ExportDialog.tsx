import { Button } from "@cap/ui-solid";
import { Select as KSelect } from "@kobalte/core/select";
import { makePersisted } from "@solid-primitives/storage";
import {
	createMutation,
	createQuery,
	keepPreviousData,
} from "@tanstack/solid-query";
import { Channel } from "@tauri-apps/api/core";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import { desktopDir, homeDir } from "@tauri-apps/api/path";
import {
	open as openDialog,
	save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { cx } from "cva";
import {
	createEffect,
	createRoot,
	createSignal,
	For,
	type JSX,
	Match,
	mergeProps,
	on,
	Show,
	Suspense,
	Switch,
	type ValidComponent,
} from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import toast from "solid-toast";
import { SignInButton } from "~/components/SignInButton";
import Tooltip from "~/components/Tooltip";
import { authStore } from "~/store";
import { trackEvent } from "~/utils/analytics";
import { createSignInMutation } from "~/utils/auth";
import { exportVideo } from "~/utils/export";
import { L } from "~/utils/i18n";
import { createOrganizationsQuery } from "~/utils/queries";
import {
	commands,
	type ExportCompression,
	type ExportSettings,
	type FramesRendered,
	type UploadProgress,
} from "~/utils/tauri";
import { type RenderState, useEditorContext } from "./context";
import { RESOLUTION_OPTIONS } from "./Header";
import {
	Dialog,
	DialogContent,
	MenuItem,
	MenuItemList,
	PopperContent,
	topSlideAnimateClasses,
} from "./ui";

class SilentError extends Error {}

export const COMPRESSION_OPTIONS: Array<{
	label: string;
	value: ExportCompression;
}> = [
	{ label: L("最小压缩", "Minimal"), value: "Minimal" },
	{ label: L("社交媒体", "Social Media"), value: "Social" },
	{ label: L("网页", "Web"), value: "Web" },
	{ label: L("极限压缩", "Maximum"), value: "Potato" },
];

export const FPS_OPTIONS = [
	{ label: "15 FPS", value: 15 },
	{ label: "30 FPS", value: 30 },
	{ label: "60 FPS", value: 60 },
] satisfies Array<{ label: string; value: number }>;

export const GIF_FPS_OPTIONS = [
	{ label: "10 FPS", value: 10 },
	{ label: "15 FPS", value: 15 },
	{ label: "20 FPS", value: 20 },
	{ label: "25 FPS", value: 25 },
	{ label: "30 FPS", value: 30 },
] satisfies Array<{ label: string; value: number }>;

type ExportToOption = "file" | "clipboard" | "link";

export const EXPORT_TO_OPTIONS: {
	label: string;
	value: ExportToOption;
	icon: JSX.Element;
}[] = [
	{
		label: L("文件", "File"),
		value: "file",
		icon: <IconCapFile class="text-gray-12 size-3.5" />,
	},
	{
		label: L("剪贴板", "Clipboard"),
		value: "clipboard",
		icon: <IconCapCopy class="text-gray-12 size-3.5" />,
	},
	// {
	// 	label: "分享链接",
	// 	value: "link",
	// 	icon: <IconCapLink class="text-gray-12 size-3.5" />,
	// },
];

type ExportFormat = ExportSettings["format"];

const FORMAT_OPTIONS = [
	{ label: "MP4", value: "Mp4" },
	{ label: "GIF", value: "Gif" },
] as { label: string; value: ExportFormat; disabled?: boolean }[];

interface Settings {
	format: ExportFormat;
	fps: number;
	exportTo: ExportToOption;
	resolution: { label: string; value: string; width: number; height: number };
	compression: ExportCompression;
	organizationId?: string | null;
	saveDirectory?: string;
}
export function ExportDialog() {
	const {
		dialog,
		setDialog,
		editorInstance,
		setExportState,
		exportState,
		meta,
		refetchMeta,
	} = useEditorContext();

	const auth = authStore.createQuery();
	const organisations = createOrganizationsQuery();

	const hasTransparentBackground = () => {
		const backgroundSource =
			editorInstance.savedProjectConfig.background.source;
		return (
			backgroundSource.type === "color" &&
			backgroundSource.alpha !== undefined &&
			backgroundSource.alpha < 255
		);
	};

	const [_settings, setSettings] = makePersisted(
		createStore<Settings>({
			format: "Mp4",
			fps: 30,
			exportTo: "file",
			resolution: { label: "720p", value: "720p", width: 1280, height: 720 },
			compression: "Minimal",
		}),
		{ name: "export_settings" },
	);

	const settings = mergeProps(_settings, () => {
		const ret: Partial<Settings> = {};
		if (hasTransparentBackground() && _settings.format === "Mp4")
			ret.format = "Gif";
		// Ensure GIF is not selected when exportTo is "link"
		else if (_settings.format === "Gif" && _settings.exportTo === "link")
			ret.format = "Mp4";
		else if (!["Mp4", "Gif"].includes(_settings.format)) ret.format = "Mp4";

		Object.defineProperty(ret, "organizationId", {
			get() {
				if (!_settings.organizationId && organisations().length > 0)
					return organisations()[0].id;

				return _settings.organizationId;
			},
		});

		return ret;
	});

	const exportWithSettings = (onProgress: (progress: FramesRendered) => void) =>
		exportVideo(
			projectPath,
			settings.format === "Mp4"
				? {
						format: "Mp4",
						fps: settings.fps,
						resolution_base: {
							x: settings.resolution.width,
							y: settings.resolution.height,
						},
						compression: settings.compression,
					}
				: {
						format: "Gif",
						fps: settings.fps,
						resolution_base: {
							x: settings.resolution.width,
							y: settings.resolution.height,
						},
						quality: null,
					},
			onProgress,
		);

	const [outputPath, setOutputPath] = createSignal<string | null>(null);
	const [customFileName, setCustomFileName] = createSignal<string>("");

	// Initialize file name from meta
	createEffect(() => {
		if (customFileName() === "") {
			setCustomFileName(meta().prettyName);
		}
	});

	// Initialize save directory
	createEffect(async () => {
		if (!_settings.saveDirectory) {
			const desktop = await desktopDir();
			setSettings("saveDirectory", desktop);
		}
	});

	const projectPath = editorInstance.path;

	const exportEstimates = createQuery(() => ({
		// prevents flicker when modifying settings
		placeholderData: keepPreviousData,
		queryKey: [
			"exportEstimates",
			{
				resolution: {
					x: settings.resolution.width,
					y: settings.resolution.height,
				},
				fps: settings.fps,
			},
		] as const,
		queryFn: ({ queryKey: [_, { resolution, fps }] }) =>
			commands.getExportEstimates(projectPath, resolution, fps),
	}));

	const exportButtonIcon: Record<"file" | "clipboard" | "link", JSX.Element> = {
		file: <IconCapFile class="text-gray-1 size-3.5" />,
		clipboard: <IconCapCopy class="text-gray-1 size-3.5" />,
		link: <IconCapLink class="text-gray-1 size-3.5" />,
	};

	const copy = createMutation(() => ({
		mutationFn: async () => {
			if (exportState.type !== "idle") return;
			setExportState(reconcile({ action: "copy", type: "starting" }));

			const outputPath = await exportWithSettings((progress) => {
				setExportState({ type: "rendering", progress });
			});

			setExportState({ type: "copying" });

			await commands.copyVideoToClipboard(outputPath);
		},
		onError: (error) => {
			commands.globalMessageDialog(
				error instanceof Error
					? error.message
					: L("复制录制失败", "Failed to copy recording"),
			);
			setExportState(reconcile({ type: "idle" }));
		},
		onSuccess() {
			setExportState({ type: "done" });

			if (dialog().open) {
				createRoot((dispose) => {
					createEffect(
						on(
							() => dialog().open,
							() => {
								dispose();
							},
							{ defer: true },
						),
					);
				});
			} else
				toast.success(
					L(
						`${settings.format === "Gif" ? "GIF" : "录制"}已复制到剪贴板`,
						`${settings.format === "Gif" ? "GIF" : "Recording"} copied to clipboard`,
					),
				);
		},
	}));

	const save = createMutation(() => ({
		mutationFn: async () => {
			if (exportState.type !== "idle") return;

			const extension = settings.format === "Gif" ? "gif" : "mp4";
			const fileName = customFileName() || meta().prettyName;
			const saveDir = settings.saveDirectory || (await desktopDir());
			const savePath = `${saveDir}/${fileName}.${extension}`;

			setExportState(reconcile({ action: "save", type: "starting" }));

			setOutputPath(savePath);

			trackEvent("export_started", {
				resolution: settings.resolution,
				fps: settings.fps,
				path: savePath,
			});

			const videoPath = await exportWithSettings((progress) => {
				setExportState({ type: "rendering", progress });
			});

			setExportState({ type: "copying" });

			await commands.copyFileToPath(videoPath, savePath);

			setExportState({ type: "done" });
		},
		onError: (error) => {
			commands.globalMessageDialog(
				error instanceof Error
					? error.message
					: L(`导出录制失败: ${error}`, `Failed to export recording: ${error}`),
			);
			setExportState({ type: "idle" });
		},
		onSuccess() {
			if (dialog().open) {
				createRoot((dispose) => {
					createEffect(
						on(
							() => dialog().open,
							() => {
								dispose();
							},
							{ defer: true },
						),
					);
				});
			} else
				toast.success(
					L(
						`${settings.format === "Gif" ? "GIF" : "录制"}已导出到文件`,
						`${settings.format === "Gif" ? "GIF" : "Recording"} exported to file`,
					),
				);
		},
	}));

	const upload = createMutation(() => ({
		mutationFn: async () => {
			if (exportState.type !== "idle") return;
			setExportState(reconcile({ action: "upload", type: "starting" }));

			// Check authentication first
			const existingAuth = await authStore.get();
			if (!existingAuth) createSignInMutation();
			trackEvent("create_shareable_link_clicked", {
				resolution: settings.resolution,
				fps: settings.fps,
				has_existing_auth: !!existingAuth,
			});

			const metadata = await commands.getVideoMetadata(projectPath);
			const plan = await commands.checkUpgradedAndUpdate();
			const canShare = {
				allowed: plan || metadata.duration < 300,
				reason: !plan && metadata.duration >= 300 ? "upgrade_required" : null,
			};

			if (!canShare.allowed) {
				if (canShare.reason === "upgrade_required") {
					await commands.showWindow("Upgrade");
					// The window takes a little to show and this prevents the user seeing it glitch
					await new Promise((resolve) => setTimeout(resolve, 1000));
					throw new SilentError();
				}
			}

			const uploadChannel = new Channel<UploadProgress>((progress) => {
				console.log("Upload progress:", progress);
				setExportState(
					produce((state) => {
						if (state.type !== "uploading") return;

						state.progress = Math.round(progress.progress * 100);
					}),
				);
			});

			await exportWithSettings((progress) =>
				setExportState({ type: "rendering", progress }),
			);

			setExportState({ type: "uploading", progress: 0 });

			console.log({ organizationId: settings.organizationId });

			// Now proceed with upload
			const result = meta().sharing
				? await commands.uploadExportedVideo(
						projectPath,
						"Reupload",
						uploadChannel,
						settings.organizationId ?? null,
					)
				: await commands.uploadExportedVideo(
						projectPath,
						{ Initial: { pre_created_video: null } },
						uploadChannel,
						settings.organizationId ?? null,
					);

			if (result === "NotAuthenticated")
				throw new Error(
					L(
						"你需要登录才能分享录制",
						"You need to sign in to share recordings",
					),
				);
			else if (result === "PlanCheckFailed")
				throw new Error(
					L("验证订阅状态失败", "Failed to verify subscription status"),
				);
			else if (result === "UpgradeRequired")
				throw new Error(
					L("此功能需要升级订阅", "This feature requires an upgraded plan"),
				);
		},
		onSuccess: async () => {
			const d = dialog();
			if ("type" in d && d.type === "export") setDialog({ ...d, open: true });

			await refetchMeta();

			console.log(meta().sharing);

			setExportState({ type: "done" });
		},
		onError: (error) => {
			console.error(error);
			if (!(error instanceof SilentError)) {
				commands.globalMessageDialog(
					error instanceof Error
						? error.message
						: L("上传录制失败", "Failed to upload recording"),
				);
			}

			setExportState(reconcile({ type: "idle" }));
		},
	}));

	return (
		<>
			<Show when={exportState.type === "idle"}>
				<DialogContent
					title={L("导出 Taple", "Export Taple")}
					onClose={() => setDialog((d) => ({ ...d, open: false }))}
					confirm={
						settings.exportTo === "link" && !auth.data ? (
							<SignInButton>
								{exportButtonIcon[settings.exportTo]}
								<span class="ml-1.5">
									{L("登录以分享", "Sign In to Share")}
								</span>
							</SignInButton>
						) : (
							<Button
								class="flex gap-1.5 items-center"
								variant="dark"
								onClick={() => {
									if (settings.exportTo === "file") save.mutate();
									else if (settings.exportTo === "link") upload.mutate();
									else copy.mutate();
								}}
							>
								{L("导出", "Export")}
							</Button>
						)
					}
					leftFooterContent={
						<div
							class={cx(
								"flex overflow-hidden z-40 justify-between items-center max-w-full text-xs font-medium transition-all pointer-events-none",
							)}
						>
							<Suspense>
								<Show when={exportEstimates.data}>
									{(est) => (
										<p class="flex gap-4 items-center">
											<span class="flex items-center text-gray-12">
												<IconLucideClock class="w-[14px] h-[14px] mr-1.5 text-gray-12" />
												{(() => {
													const totalSeconds = Math.round(
														est().estimated_time_seconds,
													);
													const hours = Math.floor(totalSeconds / 3600);
													const minutes = Math.floor(
														(totalSeconds % 3600) / 60,
													);
													const seconds = totalSeconds % 60;

													if (hours > 0) {
														return `~${hours}:${minutes
															.toString()
															.padStart(2, "0")}:${seconds
															.toString()
															.padStart(2, "0")}`;
													}
													return `~${minutes}:${seconds
														.toString()
														.padStart(2, "0")}`;
												})()}
											</span>
											<span class="flex items-center text-gray-12">
												<IconLucideMonitor class="w-[14px] h-[14px] mr-1.5 text-gray-12" />
												{settings.resolution.width}×{settings.resolution.height}
											</span>
											<span class="flex items-center text-gray-12">
												<IconLucideHardDrive class="w-[14px] h-[14px] mr-1.5 text-gray-12" />
												{est().estimated_size_mb.toFixed(2)} MB
											</span>
											<span class="flex items-center text-gray-12">
												<IconCapCamera class="w-[14px] h-[14px] mr-1.5 text-gray-12" />
												{(() => {
													const totalSeconds = Math.round(
														est().duration_seconds,
													);
													const hours = Math.floor(totalSeconds / 3600);
													const minutes = Math.floor(
														(totalSeconds % 3600) / 60,
													);
													const seconds = totalSeconds % 60;

													if (hours > 0) {
														return `${hours}:${minutes
															.toString()
															.padStart(2, "0")}:${seconds
															.toString()
															.padStart(2, "0")}`;
													}
													return `${minutes}:${seconds
														.toString()
														.padStart(2, "0")}`;
												})()}
											</span>
										</p>
									)}
								</Show>
							</Suspense>
						</div>
					}
				>
					<div class="flex flex-col gap-3">
						{/* 1. 文件名称 */}
						<div class="flex items-center justify-between p-3 rounded-xl dark:bg-gray-2 bg-gray-3">
							<span class="text-sm text-gray-11">
								{L("文件名称", "File Name")}
							</span>
							<input
								type="text"
								value={customFileName()}
								onInput={(e) => setCustomFileName(e.currentTarget.value)}
								class="text-sm text-gray-12 font-medium bg-transparent border-none outline-none text-right max-w-[200px] focus:ring-1 focus:ring-gray-6 rounded px-2 py-1"
								placeholder={L("输入文件名", "Enter file name")}
							/>
						</div>

						{/* 2. 保存位置 */}
						<div class="flex items-center justify-between p-3 rounded-xl dark:bg-gray-2 bg-gray-3">
							<span class="text-sm text-gray-11">
								{L("导出到", "Export To")}
							</span>
							<div class="flex gap-2">
								<For each={EXPORT_TO_OPTIONS}>
									{(option) => (
										<Button
											onClick={() => {
												setSettings(
													produce((newSettings) => {
														newSettings.exportTo = option.value;
														if (
															option.value === "link" &&
															settings.format === "Gif"
														) {
															newSettings.format = "Mp4";
														}
													}),
												);
											}}
											data-selected={settings.exportTo === option.value}
											class="flex gap-1.5 items-center text-nowrap px-2.5 py-1.5 text-xs"
											variant="gray"
										>
											{option.icon}
											{option.label}
										</Button>
									)}
								</For>
							</div>
						</div>

						{/* 3. 文件保存路径 (仅当导出到文件时显示) */}
						<Show when={settings.exportTo === "file"}>
							<div class="flex items-center justify-between p-3 rounded-xl dark:bg-gray-2 bg-gray-3">
								<span class="text-sm text-gray-11">
									{L("保存路径", "Save Location")}
								</span>
								<div class="flex items-center gap-2">
									<span
										class="text-xs text-gray-11 max-w-[180px] truncate"
										title={settings.saveDirectory}
									>
										{settings.saveDirectory?.replace(/^\/Users\/[^/]+/, "~") ||
											"~/Desktop"}
									</span>
									<Button
										variant="gray"
										class="px-2 py-1 text-xs"
										onClick={async () => {
											const selected = await openDialog({
												directory: true,
												multiple: false,
												defaultPath: settings.saveDirectory,
											});
											if (selected && typeof selected === "string") {
												setSettings("saveDirectory", selected);
											}
										}}
									>
										<IconLucideFolderOpen class="size-3.5" />
									</Button>
								</div>
							</div>
						</Show>

						{/* 3. 分辨率 */}
						<div class="flex items-center justify-between p-3 rounded-xl dark:bg-gray-2 bg-gray-3">
							<span class="text-sm text-gray-11">
								{L("分辨率", "Resolution")}
							</span>
							<div class="flex gap-2">
								<For
									each={
										settings.format === "Gif"
											? [RESOLUTION_OPTIONS._720p, RESOLUTION_OPTIONS._1080p]
											: [
													RESOLUTION_OPTIONS._720p,
													RESOLUTION_OPTIONS._1080p,
													RESOLUTION_OPTIONS._4k,
												]
									}
								>
									{(option) => (
										<Button
											data-selected={settings.resolution.value === option.value}
											class="px-2.5 py-1.5 text-xs"
											variant="gray"
											onClick={() => setSettings("resolution", option)}
										>
											{option.label}
										</Button>
									)}
								</For>
							</div>
						</div>

						{/* 4. 格式和帧率 */}
						<div class="flex items-center justify-between p-3 rounded-xl dark:bg-gray-2 bg-gray-3">
							<span class="text-sm text-gray-11">
								{L("格式 / 帧率", "Format / Frame Rate")}
							</span>
							<div class="flex gap-3 items-center">
								{/* Format buttons */}
								<div class="flex gap-1.5">
									<For each={FORMAT_OPTIONS}>
										{(option) => {
											const disabledReason = () => {
												if (
													option.value === "Mp4" &&
													hasTransparentBackground()
												)
													return L(
														"MP4 格式不支持透明背景",
														"MP4 doesn't support transparent backgrounds",
													);
												if (
													option.value === "Gif" &&
													settings.exportTo === "link"
												)
													return L(
														"无法从 GIF 创建分享链接",
														"Shareable links can't be created from GIFs",
													);
											};

											return (
												<Tooltip
													content={disabledReason()}
													disabled={disabledReason() === undefined}
												>
													<Button
														variant="gray"
														class="px-2.5 py-1.5 text-xs"
														onClick={() => {
															setSettings(
																produce((newSettings) => {
																	newSettings.format =
																		option.value as ExportFormat;

																	if (
																		option.value === "Gif" &&
																		!(
																			settings.resolution.value === "720p" ||
																			settings.resolution.value === "1080p"
																		)
																	)
																		newSettings.resolution = {
																			...RESOLUTION_OPTIONS._720p,
																		};

																	if (
																		option.value === "Gif" &&
																		GIF_FPS_OPTIONS.every(
																			(v) => v.value !== settings.fps,
																		)
																	)
																		newSettings.fps = 15;

																	if (
																		option.value === "Mp4" &&
																		FPS_OPTIONS.every(
																			(v) => v.value !== settings.fps,
																		)
																	)
																		newSettings.fps = 30;
																}),
															);
														}}
														autofocus={false}
														data-selected={settings.format === option.value}
														disabled={!!disabledReason()}
													>
														{option.label}
													</Button>
												</Tooltip>
											);
										}}
									</For>
								</div>
								{/* Frame rate dropdown */}
								<KSelect<{ label: string; value: number }>
									options={
										settings.format === "Gif" ? GIF_FPS_OPTIONS : FPS_OPTIONS
									}
									optionValue="value"
									optionTextValue="label"
									placeholder={L("选择帧率", "Select frame rate")}
									value={(settings.format === "Gif"
										? GIF_FPS_OPTIONS
										: FPS_OPTIONS
									).find((opt) => opt.value === settings.fps)}
									onChange={(option) => {
										const value =
											option?.value ?? (settings.format === "Gif" ? 10 : 30);
										trackEvent("export_fps_changed", {
											fps: value,
										});
										setSettings("fps", value);
									}}
									itemComponent={(props) => (
										<MenuItem<typeof KSelect.Item>
											as={KSelect.Item}
											item={props.item}
										>
											<KSelect.ItemLabel class="flex-1">
												{props.item.rawValue.label}
											</KSelect.ItemLabel>
										</MenuItem>
									)}
								>
									<KSelect.Trigger class="flex flex-row gap-1.5 items-center px-2.5 py-1.5 h-auto rounded-lg transition-colors dark:bg-gray-3 bg-gray-4 disabled:text-gray-11 text-xs">
										<KSelect.Value<
											(typeof FPS_OPTIONS)[number]
										> class="text-xs tabular-nums text-gray-12">
											{(state) => <span>{state.selectedOption()?.label}</span>}
										</KSelect.Value>
										<KSelect.Icon<ValidComponent>
											as={(props) => (
												<IconCapChevronDown
													{...props}
													class="size-3 shrink-0 transform transition-transform ui-expanded:rotate-180 text-gray-11"
												/>
											)}
										/>
									</KSelect.Trigger>
									<KSelect.Portal>
										<PopperContent<typeof KSelect.Content>
											as={KSelect.Content}
											class={cx(topSlideAnimateClasses, "z-50")}
										>
											<MenuItemList<typeof KSelect.Listbox>
												class="max-h-32 custom-scroll"
												as={KSelect.Listbox}
											/>
										</PopperContent>
									</KSelect.Portal>
								</KSelect>
							</div>
						</div>
					</div>
				</DialogContent>
			</Show>
			<Show when={exportState.type !== "idle" && exportState} keyed>
				{(exportState) => {
					const [copyPressed, setCopyPressed] = createSignal(false);
					const [clipboardCopyPressed, setClipboardCopyPressed] =
						createSignal(false);
					const [showCompletionScreen, setShowCompletionScreen] = createSignal(
						exportState.type === "done" && exportState.action === "save",
					);

					createEffect(() => {
						if (exportState.type === "done" && exportState.action === "save") {
							setShowCompletionScreen(true);
						}
					});

					return (
						<>
							<Dialog.Header>
								<div class="flex justify-between items-center w-full">
									<span class="text-gray-12">{L("导出", "Export")}</span>
									<div
										onClick={() => setDialog((d) => ({ ...d, open: false }))}
										class="flex justify-center items-center p-1 rounded-full transition-colors cursor-pointer hover:bg-gray-3"
									>
										<IconCapCircleX class="text-gray-12 size-4" />
									</div>
								</div>
							</Dialog.Header>
							<Dialog.Content class="text-gray-12">
								<div class="relative z-10 px-5 py-4 mx-auto space-y-6 w-full text-center">
									<Switch>
										<Match
											when={exportState.action === "copy" && exportState}
											keyed
										>
											{(copyState) => (
												<div class="flex flex-col gap-4 justify-center items-center h-full">
													<h1 class="text-lg font-medium text-gray-12">
														{copyState.type === "starting"
															? L("准备中...", "Preparing...")
															: copyState.type === "rendering"
																? settings.format === "Gif"
																	? L("正在渲染 GIF...", "Rendering GIF...")
																	: L("正在渲染视频...", "Rendering video...")
																: copyState.type === "copying"
																	? L(
																			"正在复制到剪贴板...",
																			"Copying to clipboard...",
																		)
																	: L("已复制到剪贴板", "Copied to clipboard")}
													</h1>
													<Show
														when={
															(copyState.type === "rendering" ||
																copyState.type === "starting") &&
															copyState
														}
														keyed
													>
														{(copyState) => (
															<RenderProgress
																state={copyState}
																format={settings.format}
															/>
														)}
													</Show>
												</div>
											)}
										</Match>
										<Match
											when={exportState.action === "save" && exportState}
											keyed
										>
											{(saveState) => (
												<div class="flex flex-col gap-4 justify-center items-center h-full">
													<Show
														when={
															showCompletionScreen() &&
															saveState.type === "done"
														}
														fallback={
															<>
																<h1 class="text-lg font-medium text-gray-12">
																	{saveState.type === "starting"
																		? L("准备中...", "Preparing...")
																		: saveState.type === "rendering"
																			? settings.format === "Gif"
																				? L(
																						"正在渲染 GIF...",
																						"Rendering GIF...",
																					)
																				: L(
																						"正在渲染视频...",
																						"Rendering video...",
																					)
																			: saveState.type === "copying"
																				? L(
																						"正在导出到文件...",
																						"Exporting to file...",
																					)
																				: L("导出完成", "Export Complete")}
																</h1>
																<Show
																	when={
																		(saveState.type === "rendering" ||
																			saveState.type === "starting") &&
																		saveState
																	}
																	keyed
																>
																	{(copyState) => (
																		<RenderProgress
																			state={copyState}
																			format={settings.format}
																		/>
																	)}
																</Show>
															</>
														}
													>
														<div class="flex flex-col gap-6 items-center duration-500 animate-in fade-in">
															<div class="flex flex-col gap-3 items-center">
																<div class="flex justify-center items-center mb-2 rounded-full bg-gray-12 size-10">
																	<IconLucideCheck class="text-gray-1 size-5" />
																</div>
																<div class="flex flex-col gap-1 items-center">
																	<h1 class="text-xl font-medium text-gray-12">
																		{L("导出完成", "Export Complete")}
																	</h1>
																	<p class="text-sm text-gray-11">
																		{L(
																			`你的${settings.format === "Gif" ? "GIF" : "视频"}已成功导出`,
																			`Your ${settings.format === "Gif" ? "GIF" : "video"} has been exported`,
																		)}
																	</p>
																</div>
															</div>
														</div>
													</Show>
												</div>
											)}
										</Match>
										<Match
											when={exportState.action === "upload" && exportState}
											keyed
										>
											{(uploadState) => (
												<Switch>
													<Match
														when={uploadState.type !== "done" && uploadState}
														keyed
													>
														{(uploadState) => (
															<div class="flex flex-col gap-4 justify-center items-center">
																<h1 class="text-lg font-medium text-center text-gray-12">
																	{L("正在上传...", "Uploading...")}
																</h1>
																<Switch>
																	<Match
																		when={
																			uploadState.type === "uploading" &&
																			uploadState
																		}
																		keyed
																	>
																		{(uploadState) => (
																			<ProgressView
																				amount={uploadState.progress}
																				label={L(
																					`正在上传 - ${Math.floor(uploadState.progress)}%`,
																					`Uploading - ${Math.floor(uploadState.progress)}%`,
																				)}
																			/>
																		)}
																	</Match>
																	<Match
																		when={
																			uploadState.type !== "uploading" &&
																			uploadState
																		}
																		keyed
																	>
																		{(renderState) => (
																			<RenderProgress
																				state={renderState}
																				format={settings.format}
																			/>
																		)}
																	</Match>
																</Switch>
															</div>
														)}
													</Match>
													<Match when={uploadState.type === "done"}>
														<div class="flex flex-col gap-5 justify-center items-center">
															<div class="flex flex-col gap-1 items-center">
																<h1 class="mx-auto text-lg font-medium text-center text-gray-12">
																	{L("上传完成", "Upload Complete")}
																</h1>
																<p class="text-sm text-gray-11">
																	{L(
																		"你的视频已成功上传",
																		"Your video has been uploaded",
																	)}
																</p>
															</div>
														</div>
													</Match>
												</Switch>
											)}
										</Match>
									</Switch>
								</div>
							</Dialog.Content>
							<Dialog.Footer>
								<Show
									when={
										exportState.action === "upload" &&
										exportState.type === "done"
									}
								>
									<div class="relative">
										<a
											href={meta().sharing?.link}
											target="_blank"
											rel="noreferrer"
											class="block"
										>
											<Button
												onClick={() => {
													setCopyPressed(true);
													setTimeout(() => {
														setCopyPressed(false);
													}, 2000);
													navigator.clipboard.writeText(meta().sharing?.link!);
												}}
												variant="dark"
												class="flex gap-2 justify-center items-center"
											>
												{!copyPressed() ? (
													<IconCapCopy class="transition-colors duration-200 text-gray-1 size-4 group-hover:text-gray-12" />
												) : (
													<IconLucideCheck class="transition-colors duration-200 text-gray-1 size-4 svgpathanimation group-hover:text-gray-12" />
												)}
												<p>{L("打开链接", "Open Link")}</p>
											</Button>
										</a>
									</div>
								</Show>

								<Show
									when={
										exportState.action === "save" && exportState.type === "done"
									}
								>
									<div class="flex gap-4 w-full">
										<Button
											variant="dark"
											class="flex gap-2 items-center"
											onClick={() => {
												const path = outputPath();
												if (path) {
													commands.openFilePath(path);
												}
											}}
										>
											<IconCapFile class="size-4" />
											{L("打开文件", "Open File")}
										</Button>
										<Button
											variant="dark"
											class="flex gap-2 items-center"
											onClick={async () => {
												const path = outputPath();
												if (path) {
													setClipboardCopyPressed(true);
													setTimeout(() => {
														setClipboardCopyPressed(false);
													}, 2000);
													await commands.copyVideoToClipboard(path);
													toast.success(
														L(
															`${settings.format === "Gif" ? "GIF" : "视频"}已复制到剪贴板`,
															`${settings.format === "Gif" ? "GIF" : "Video"} copied to clipboard`,
														),
													);
												}
											}}
										>
											{!clipboardCopyPressed() ? (
												<IconCapCopy class="size-4" />
											) : (
												<IconLucideCheck class="size-4 svgpathanimation" />
											)}
											{L("复制到剪贴板", "Copy to Clipboard")}
										</Button>
									</div>
								</Show>
							</Dialog.Footer>
						</>
					);
				}}
			</Show>
		</>
	);
}

function RenderProgress(props: { state: RenderState; format?: ExportFormat }) {
	return (
		<ProgressView
			amount={
				props.state.type === "rendering"
					? (props.state.progress.renderedCount /
							props.state.progress.totalFrames) *
						100
					: 0
			}
			label={
				props.state.type === "rendering"
					? L(
							`正在渲染${props.format === "Gif" ? " GIF" : "视频"} (${
								props.state.progress.renderedCount
							}/${props.state.progress.totalFrames} 帧)`,
							`Rendering ${props.format === "Gif" ? "GIF" : "video"} (${
								props.state.progress.renderedCount
							}/${props.state.progress.totalFrames} frames)`,
						)
					: L("正在准备渲染...", "Preparing to render...")
			}
		/>
	);
}

function ProgressView(props: { amount: number; label?: string }) {
	return (
		<>
			<div class="w-full bg-gray-3 rounded-full h-2.5">
				<div
					class="bg-blue-9 h-2.5 rounded-full"
					style={{ width: `${props.amount}%` }}
				/>
			</div>
			<p class="text-xs tabular-nums">{props.label}</p>
		</>
	);
}
