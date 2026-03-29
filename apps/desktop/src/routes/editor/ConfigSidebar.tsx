import { Button } from "@cap/ui-solid";
import { NumberField } from "@kobalte/core";
import {
	Collapsible,
	Collapsible as KCollapsible,
} from "@kobalte/core/collapsible";
import {
	RadioGroup as KRadioGroup,
	RadioGroup,
} from "@kobalte/core/radio-group";
import { Select as KSelect } from "@kobalte/core/select";
import { Tabs as KTabs } from "@kobalte/core/tabs";
import { createElementBounds } from "@solid-primitives/bounds";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { createWritableMemo } from "@solid-primitives/memo";
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, resolveResource } from "@tauri-apps/api/path";
import { BaseDirectory, writeFile } from "@tauri-apps/plugin-fs";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	batch,
	createEffect,
	createMemo,
	createResource,
	createRoot,
	createSignal,
	For,
	Index,
	on,
	onMount,
	Show,
	Suspense,
	type ValidComponent,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Dynamic } from "solid-js/web";
import toast from "solid-toast";
import colorBg from "~/assets/illustrations/color.webp";
import gradientBg from "~/assets/illustrations/gradient.webp";
import imageBg from "~/assets/illustrations/image.webp";
import transparentBg from "~/assets/illustrations/transparent.webp";
import { Toggle } from "~/components/Toggle";
import { generalSettingsStore } from "~/store";
import {
	type BackgroundSource,
	type CameraShape,
	type ClipOffsets,
	commands,
	events,
	type SceneSegment,
	type StereoMode,
	type TimelineSegment,
	type ZoomSegment,
} from "~/utils/tauri";
import IconLucideMonitor from "~icons/lucide/monitor";
import IconLucideMousePointerClick from "~icons/lucide/mouse-pointer-click";
import IconLucideSparkles from "~icons/lucide/sparkles";
import IconLucideTimer from "~icons/lucide/timer";
import { CaptionsTab } from "./CaptionsTab";
import { useEditorContext } from "./context";
import {
	DEFAULT_GRADIENT_FROM,
	DEFAULT_GRADIENT_TO,
	type RGBColor,
} from "./projectConfig";
import ShadowSettings from "./ShadowSettings";
import { TextInput } from "./TextInput";
import {
	ComingSoonTooltip,
	EditorButton,
	Field,
	MenuItem,
	MenuItemList,
	PopperContent,
	Slider,
	Subfield,
	topSlideAnimateClasses,
} from "./ui";

const BACKGROUND_SOURCES = {
	wallpaper: "壁纸",
	image: "图片",
	color: "纯色",
	gradient: "渐变",
} satisfies Record<BackgroundSource["type"], string>;

const BACKGROUND_ICONS = {
	wallpaper: imageBg,
	image: transparentBg,
	color: colorBg,
	gradient: gradientBg,
} satisfies Record<BackgroundSource["type"], string>;

const BACKGROUND_SOURCES_LIST = [
	"wallpaper",
	"image",
	"color",
	"gradient",
] satisfies Array<BackgroundSource["type"]>;

const BACKGROUND_COLORS = [
	"#FF0000", // Red
	"#FF4500", // Orange-Red
	"#FF8C00", // Orange
	"#FFD700", // Gold
	"#FFFF00", // Yellow
	"#ADFF2F", // Green-Yellow
	"#32CD32", // Lime Green
	"#008000", // Green
	"#00CED1", // Dark Turquoise
	"#4785FF", // Dodger Blue
	"#0000FF", // Blue
	"#4B0082", // Indigo
	"#800080", // Purple
	"#A9A9A9", // Dark Gray
	"#FFFFFF", // White
	"#000000", // Black
	"#00000000", // Transparent
];

const BACKGROUND_GRADIENTS = [
	{ from: [15, 52, 67], to: [52, 232, 158] }, // Dark Blue to Teal
	{ from: [34, 193, 195], to: [253, 187, 45] }, // Turquoise to Golden Yellow
	{ from: [29, 253, 251], to: [195, 29, 253] }, // Cyan to Purple
	{ from: [69, 104, 220], to: [176, 106, 179] }, // Blue to Violet
	{ from: [106, 130, 251], to: [252, 92, 125] }, // Soft Blue to Pinkish Red
	{ from: [131, 58, 180], to: [253, 29, 29] }, // Purple to Red
	{ from: [249, 212, 35], to: [255, 78, 80] }, // Yellow to Coral Red
	{ from: [255, 94, 0], to: [255, 42, 104] }, // Orange to Reddish Pink
	{ from: [255, 0, 150], to: [0, 204, 255] }, // Pink to Sky Blue
	{ from: [0, 242, 96], to: [5, 117, 230] }, // Green to Blue
	{ from: [238, 205, 163], to: [239, 98, 159] }, // Peach to Soft Pink
	{ from: [44, 62, 80], to: [52, 152, 219] }, // Dark Gray Blue to Light Blue
	{ from: [168, 239, 255], to: [238, 205, 163] }, // Light Blue to Peach
	{ from: [74, 0, 224], to: [143, 0, 255] }, // Deep Blue to Bright Purple
	{ from: [252, 74, 26], to: [247, 183, 51] }, // Deep Orange to Soft Yellow
	{ from: [0, 255, 255], to: [255, 20, 147] }, // Cyan to Deep Pink
	{ from: [255, 127, 0], to: [255, 255, 0] }, // Orange to Yellow
	{ from: [255, 0, 255], to: [0, 255, 0] }, // Magenta to Green
] satisfies Array<{ from: RGBColor; to: RGBColor }>;

const WALLPAPER_NAMES = [
	// macOS wallpapers
	"macOS/tahoe-dusk-min",
	"macOS/tahoe-dawn-min",
	"macOS/tahoe-day-min",
	"macOS/tahoe-night-min",
	"macOS/tahoe-dark",
	"macOS/tahoe-light",
	"macOS/sequoia-dark",
	"macOS/sequoia-light",
	"macOS/sonoma-clouds",
	"macOS/sonoma-dark",
	"macOS/sonoma-evening",
	"macOS/sonoma-fromabove",
	"macOS/sonoma-horizon",
	"macOS/sonoma-light",
	"macOS/sonoma-river",
	"macOS/ventura-dark",
	"macOS/ventura-semi-dark",
	"macOS/ventura",
	// Blue wallpapers
	"blue/1",
	"blue/2",
	"blue/3",
	"blue/4",
	"blue/5",
	"blue/6",
	// Purple wallpapers
	"purple/1",
	"purple/2",
	"purple/3",
	"purple/4",
	"purple/5",
	"purple/6",
	// Dark wallpapers
	"dark/1",
	"dark/2",
	"dark/3",
	"dark/4",
	"dark/5",
	"dark/6",
	// Orange wallpapers
	"orange/1",
	"orange/2",
	"orange/3",
	"orange/4",
	"orange/5",
	"orange/6",
	"orange/7",
	"orange/8",
	"orange/9",
] as const;

const STEREO_MODES = [
	{ name: "立体声", value: "stereo" },
	{ name: "单声道左", value: "monoL" },
	{ name: "单声道右", value: "monoR" },
] satisfies Array<{ name: string; value: StereoMode }>;

const CAMERA_SHAPES = [
	{
		name: "正方形",
		value: "square",
	},
	{
		name: "原始比例",
		value: "source",
	},
] satisfies Array<{ name: string; value: CameraShape }>;

const BACKGROUND_THEMES = {
	macOS: "macOS",
	dark: "深色",
	blue: "蓝色",
	purple: "紫色",
	orange: "橙色",
};

const TAB_IDS = {
	segments: "segments",
	background: "background",
	camera: "camera",
	transcript: "transcript",
	audio: "audio",
	cursor: "cursor",
	hotkeys: "hotkeys",
} as const;

export function ConfigSidebar() {
	const {
		project,
		setProject,
		setEditorState,
		projectActions,
		editorInstance,
		editorState,
		meta,
	} = useEditorContext();

	const [isDenoising, setIsDenoising] = createSignal(false);
	const [denoiseProgress, setDenoiseProgress] = createSignal(0);
	const [denoiseStatus, setDenoiseStatus] = createSignal("");

	const runDenoise = async () => {
		if (!editorInstance) return;
		setIsDenoising(true);
		setDenoiseProgress(0);
		setDenoiseStatus("正在准备...");

		const unlisten = await events.denoiseProgress.listen((event) => {
			setDenoiseProgress(event.payload.progress * 100);
			setDenoiseStatus(event.payload.status);
		});

		try {
			await commands.denoiseRecordingAudio(editorInstance.path);
			toast.success("降噪处理完成，正在刷新...");
			setTimeout(() => window.location.reload(), 500);
			return;
		} catch (error) {
			toast.error(
				"降噪失败：" + (typeof error === "string" ? error : String(error)),
			);
		} finally {
			unlisten();
			setIsDenoising(false);
			setDenoiseProgress(0);
			setDenoiseStatus("");
		}
	};

	const cursorIdleDelay = () =>
		((project.cursor as { hideWhenIdleDelay?: number }).hideWhenIdleDelay ??
			2) as number;

	const clampIdleDelay = (value: number) =>
		Math.round(Math.min(5, Math.max(0.5, value)) * 10) / 10;

	const [state, setState] = createStore({
		selectedTab: "segments" as
			| "segments"
			| "background"
			| "camera"
			| "transcript"
			| "audio"
			| "cursor"
			| "hotkeys"
			| "captions",
	});

	let scrollRef!: HTMLDivElement;

	// Auto-switch to segments tab when a zoom or scene segment is selected
	createEffect(() => {
		const selection = editorState.timeline.selection;
		if (selection && (selection.type === "zoom" || selection.type === "scene")) {
			setState("selectedTab", "segments");
		}
	});

	return (
		<KTabs
			value={state.selectedTab}
			class="flex flex-col min-h-0 shrink-0 flex-1 max-w-[26rem] overflow-hidden rounded-xl z-10 relative bg-gray-1 dark:bg-gray-2 border border-gray-3"
		>
			<KTabs.List class="flex overflow-hidden sticky top-0 z-[60] flex-row items-center h-12 text-sm border-b border-gray-3 shrink-0 bg-gray-1 dark:bg-gray-2">
				<For
					each={[
						{
							id: TAB_IDS.segments,
							icon: IconLucideLayers,
							label: "画面片段",
						},
						{
							id: TAB_IDS.cursor,
							icon: IconCapCursor,
							label: "光标",
							disabled: !(
								meta().type === "multiple" && (meta() as any).segments[0].cursor
							),
						},
						{ id: TAB_IDS.audio, icon: IconCapAudioOn, label: "音频" },
						{
							id: TAB_IDS.camera,
							icon: IconCapCamera,
							label: "摄像头",
							disabled: editorInstance.recordings.segments.every(
								(s) => s.camera === null,
							),
						},
						{ id: TAB_IDS.background, icon: IconCapImage, label: "背景" },
						window.FLAGS.captions && {
							id: "captions" as const,
							icon: IconCapMessageBubble,
							label: "字幕",
						},
					].filter(Boolean)}
				>
					{(item) => (
						<KTabs.Trigger
							value={item.id}
							class="flex relative z-10 flex-1 justify-center items-center gap-1 px-1.5 py-2 transition-colors group disabled:opacity-50 focus:outline-none rounded-lg mx-0.5 text-gray-11 hover:bg-gray-3 ui-selected:text-blue-11 ui-selected:bg-blue-3 whitespace-nowrap"
							onClick={() => {
								// Clear selection when switching away from segments tab
								if (item.id !== "segments" && editorState.timeline.selection) {
									setEditorState("timeline", "selection", null);
								}
								setState("selectedTab", item.id);
								scrollRef.scrollTo({
									top: 0,
								});
							}}
							disabled={item.disabled}
						>
							<Dynamic component={item.icon} class="size-3.5 shrink-0" />
							<span class="text-xs font-medium">{item.label}</span>
						</KTabs.Trigger>
					)}
				</For>
			</KTabs.List>
			<div
				ref={scrollRef}
				style={{
					"--margin-top-scroll": "5px",
				}}
				class="p-4 custom-scroll overflow-x-hidden overflow-y-scroll text-[0.875rem] flex-1 min-h-0"
			>
				<BackgroundConfig scrollRef={scrollRef} />
				<CameraConfig scrollRef={scrollRef} />
				<KTabs.Content value={TAB_IDS.segments} class="flex flex-col gap-6">
					<SegmentsConfig />
				</KTabs.Content>
				<KTabs.Content value="audio" class="flex flex-col gap-6">
					<Field
						name="音频控制"
					>
						<Subfield name="静音">
							<Toggle
								checked={project.audio.mute}
								onChange={(v) => setProject("audio", "mute", v)}
							/>
						</Subfield>
						{editorInstance.recordings.segments[0].mic?.channels === 2 && (
							<Subfield name="麦克风立体声模式">
								<KSelect<{ name: string; value: StereoMode }>
									options={STEREO_MODES}
									optionValue="value"
									optionTextValue="name"
									value={STEREO_MODES.find(
										(v) => v.value === project.audio.micStereoMode,
									)}
									onChange={(v) => {
										if (v) setProject("audio", "micStereoMode", v.value);
									}}
									disallowEmptySelection
									itemComponent={(props) => (
										<MenuItem<typeof KSelect.Item>
											as={KSelect.Item}
											item={props.item}
										>
											<KSelect.ItemLabel class="flex-1">
												{props.item.rawValue.name}
											</KSelect.ItemLabel>
										</MenuItem>
									)}
								>
									<KSelect.Trigger class="flex flex-row gap-2 items-center px-2 w-full h-8 rounded-lg transition-colors bg-gray-3 disabled:text-gray-11">
										<KSelect.Value<{
											name: string;
											value: StereoMode;
										}> class="flex-1 text-sm text-left truncate text-[--gray-500] font-normal">
											{(state) => <span>{state.selectedOption().name}</span>}
										</KSelect.Value>
										<KSelect.Icon<ValidComponent>
											as={(props) => (
												<IconCapChevronDown
													{...props}
													class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-[--gray-500]"
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
												class="overflow-y-auto max-h-32"
												as={KSelect.Listbox}
											/>
										</PopperContent>
									</KSelect.Portal>
								</KSelect>
							</Subfield>
						)}

						{/* <Subfield name="Mute Audio">
                <Toggle
                  checked={project.audio.mute}
                  onChange={(v) => setProject("audio", "mute", v)}
                />
              </Subfield> */}

						{/* <ComingSoonTooltip>
                <Subfield name="Improve Mic Quality">
                  <Toggle disabled />
                </Subfield>
              </ComingSoonTooltip> */}
					</Field>
					{meta().hasMicrophone && (
						<Field
							name="麦克风音量"
							inline
						>
							<Slider
								disabled={project.audio.mute}
								value={[project.audio.micVolumeDb ?? 0]}
								onChange={(v) => setProject("audio", "micVolumeDb", v[0])}
								minValue={-30}
								maxValue={20}
								step={0.1}
								formatTooltip={(v) =>
									v <= -30 ? "已静音" : `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`
								}
							/>
						</Field>
					)}
					{meta().hasSystemAudio && (
						<Field
							name="系统音频音量"
							inline
						>
							<Slider
								disabled={project.audio.mute}
								value={[project.audio.systemVolumeDb ?? 0]}
								onChange={(v) => setProject("audio", "systemVolumeDb", v[0])}
								minValue={-30}
								maxValue={20}
								step={0.1}
								formatTooltip={(v) =>
									v <= -30 ? "已静音" : `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`
								}
							/>
						</Field>
					)}
					{meta().hasMicrophone && (
						<Field name="音频降噪">
							<div class="flex flex-col gap-3">
								<Show
									when={isDenoising()}
									fallback={
										<Button class="w-full" onClick={runDenoise}>
											开始降噪
										</Button>
									}
								>
									<div class="space-y-2">
										<div class="w-full bg-gray-100 rounded-full h-2">
											<div
												class="bg-blue-500 h-2 rounded-full transition-all duration-300"
												style={{ width: `${denoiseProgress()}%` }}
											/>
										</div>
										<p class="text-xs text-center text-gray-500">
											{denoiseStatus()} — {Math.round(denoiseProgress())}%
										</p>
									</div>
								</Show>
							</div>
						</Field>
					)}
				</KTabs.Content>
				<KTabs.Content value="cursor" class="flex flex-col gap-6">
					<Field
						name="光标"
						value={
							<Toggle
								checked={!project.cursor.hide}
								onChange={(v) => {
									setProject("cursor", "hide", !v);
								}}
							/>
						}
					/>
					<Show when={!project.cursor.hide}>
						<Field name="大小" inline>
							<Slider
								value={[project.cursor.size]}
								onChange={(v) => setProject("cursor", "size", v[0])}
								minValue={20}
								maxValue={300}
								step={1}
							/>
						</Field>
						<KCollapsible open={(project.cursor as any).clickEffect?.enabled ?? true}>
							<Field
								name="点击效果"
								value={
									<Toggle
										checked={(project.cursor as any).clickEffect?.enabled ?? true}
										onChange={(value) => {
											setProject("cursor", "clickEffect" as any, {
												...((project.cursor as any).clickEffect ?? {}),
												enabled: value,
											});
										}}
									/>
								}
							/>
							<KCollapsible.Content class="overflow-hidden border-b opacity-0 transition-opacity border-gray-3 animate-collapsible-up ui-expanded:animate-collapsible-down ui-expanded:opacity-100">
								<div class="flex flex-col gap-4 pt-4 pb-6">
									<Field name="圆环大小" inline>
										<Slider
											value={[(project.cursor as any).clickEffect?.size ?? 60]}
											onChange={(v) => {
												setProject("cursor", "clickEffect" as any, {
													...((project.cursor as any).clickEffect ?? {}),
													size: v[0],
												});
											}}
											minValue={20}
											maxValue={150}
											step={1}
										/>
									</Field>
									<Field name="持续时间" inline>
										<Slider
											value={[(project.cursor as any).clickEffect?.duration ?? 0.4]}
											onChange={(v) => {
												setProject("cursor", "clickEffect" as any, {
													...((project.cursor as any).clickEffect ?? {}),
													duration: v[0],
												});
											}}
											minValue={0.1}
											maxValue={1.0}
											step={0.05}
											formatTooltip={(value) => `${value.toFixed(2)}s`}
										/>
									</Field>
									<Field name="不透明度" inline>
										<Slider
											value={[(project.cursor as any).clickEffect?.opacity ?? 0.6]}
											onChange={(v) => {
												setProject("cursor", "clickEffect" as any, {
													...((project.cursor as any).clickEffect ?? {}),
													opacity: v[0],
												});
											}}
											minValue={0.1}
											maxValue={1.0}
											step={0.05}
										/>
									</Field>
									<Field name="颜色" inline>
										<input
											type="color"
											value={(project.cursor as any).clickEffect?.color ?? "#FFCB03"}
											onChange={(e) => {
												setProject("cursor", "clickEffect" as any, {
													...((project.cursor as any).clickEffect ?? {}),
													color: e.currentTarget.value,
												});
											}}
											class="w-8 h-8 rounded cursor-pointer border border-gray-6"
										/>
									</Field>
								</div>
							</KCollapsible.Content>
						</KCollapsible>
						<Field
							name="空闲时隐藏"
							value={
								<Toggle
									checked={project.cursor.hideWhenIdle}
									onChange={(value) =>
										setProject("cursor", "hideWhenIdle", value)
									}
								/>
							}
						/>
						<Show when={project.cursor.hideWhenIdle}>
							<Subfield name="空闲延迟" class="gap-4 items-center">
								<div class="flex flex-1 gap-3 items-center">
									<Slider
										class="flex-1"
										value={[cursorIdleDelay()]}
										onChange={(v) => {
											const rounded = clampIdleDelay(v[0]);
											setProject("cursor", "hideWhenIdleDelay" as any, rounded);
										}}
										minValue={0.5}
										maxValue={5}
										step={0.1}
										formatTooltip={(value) => `${value.toFixed(1)}s`}
									/>
									<span class="w-12 text-xs text-right text-gray-11">
										{cursorIdleDelay().toFixed(1)}s
									</span>
								</div>
							</Subfield>
						</Show>
						<KCollapsible open={!project.cursor.raw}>
							<Field
								name="平滑移动"
								value={
									<Toggle
										checked={!project.cursor.raw}
										onChange={(value) => {
											setProject("cursor", "raw", !value);
										}}
									/>
								}
							/>
							<KCollapsible.Content class="overflow-hidden border-b opacity-0 transition-opacity border-gray-3 animate-collapsible-up ui-expanded:animate-collapsible-down ui-expanded:opacity-100">
								<div class="flex flex-col gap-4 pt-4 pb-6">
									<Field name="张力" inline>
										<Slider
											value={[project.cursor.tension]}
											onChange={(v) => setProject("cursor", "tension", v[0])}
											minValue={1}
											maxValue={500}
											step={1}
										/>
									</Field>
									<Field name="阻力" inline>
										<Slider
											value={[project.cursor.friction]}
											onChange={(v) => setProject("cursor", "friction", v[0])}
											minValue={0}
											maxValue={50}
											step={0.1}
										/>
									</Field>
									<Field name="质量" inline>
										<Slider
											value={[project.cursor.mass]}
											onChange={(v) => setProject("cursor", "mass", v[0])}
											minValue={0.1}
											maxValue={10}
											step={0.01}
										/>
									</Field>
								</div>
							</KCollapsible.Content>
						</KCollapsible>
						<Field
							name="高质量SVG光标"
							value={
								<Toggle
									checked={(project.cursor as any).useSvg ?? true}
									onChange={(value) => {
										setProject("cursor", "useSvg" as any, value);
									}}
								/>
							}
						/>
					</Show>

					{/* <Field name="Motion Blur">
                <Slider
                  value={[project.cursor.motionBlur]}
                  onChange={(v) => setProject("cursor", "motionBlur", v[0])}
                  minValue={0}
                  maxValue={1}
                  step={0.001}
                />
              </Field> */}
					{/* <Field name="Animation Style" icon={<IconLucideRabbit />}>
            <RadioGroup
              defaultValue="regular"
              value={project.cursor.animationStyle}
              onChange={(value) => {
                setProject(
                  "cursor",
                  "animationStyle",
                  value as CursorAnimationStyle
                );
              }}
              class="flex flex-col gap-2"
              disabled
            >
              {(
                Object.entries(CURSOR_ANIMATION_STYLES) as [
                  CursorAnimationStyle,
                  string
                ][]
              ).map(([value, label]) => (
                <RadioGroup.Item value={value} class="flex items-center">
                  <RadioGroup.ItemInput class="sr-only peer" />
                  <RadioGroup.ItemControl
                    class={cx(
                      "mr-2 w-4 h-4 rounded-full border border-gray-300",
                      "relative after:absolute after:inset-0 after:m-auto after:block after:w-2 after:h-2 after:rounded-full",
                      "after:transition-colors after:duration-200",
                      "peer-checked:border-blue-500 peer-checked:after:bg-blue-400",
                      "peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400/50",
                      "peer-disabled:opacity-50"
                    )}
                  />
                  <span
                    class={cx(
                      "text-gray-12",
                      "peer-checked:text-gray-900",
                      "peer-disabled:opacity-50"
                    )}
                  >
                    {label}
                  </span>
                </RadioGroup.Item>
              ))}
            </RadioGroup>
          </Field> */}
				</KTabs.Content>
				<KTabs.Content value="hotkeys">
					<Field name="快捷键" icon={<IconCapHotkeys />}>
						<ComingSoonTooltip>
							<Subfield name="显示快捷键">
								<Toggle disabled />
							</Subfield>
						</ComingSoonTooltip>
					</Field>
				</KTabs.Content>
				<KTabs.Content value="captions" class="flex flex-col gap-6">
					<CaptionsTab />
				</KTabs.Content>
			</div>
		</KTabs>
	);
}

function BackgroundConfig(props: { scrollRef: HTMLDivElement }) {
	const { project, setProject, projectHistory } = useEditorContext();

	// Background tabs
	const [backgroundTab, setBackgroundTab] =
		createSignal<keyof typeof BACKGROUND_THEMES>("macOS");

	const [wallpapers] = createResource(async () => {
		// Only load visible wallpapers initially
		const visibleWallpaperPaths = WALLPAPER_NAMES.map(async (id) => {
			try {
				const path = await resolveResource(`assets/backgrounds/${id}.jpg`);
				return { id, path };
			} catch (err) {
				return { id, path: null };
			}
		});

		// Load initial batch
		const initialPaths = await Promise.all(visibleWallpaperPaths);

		return initialPaths
			.filter((p) => p.path !== null)
			.map(({ id, path }) => ({
				id,
				url: convertFileSrc(path!),
				rawPath: path!,
			}));
	});

	// set padding if background is selected
	const ensurePaddingForBackground = () => {
		if (project.background.padding === 0)
			setProject("background", "padding", 10);
	};

	// Validate background source path on mount
	onMount(async () => {
		if (
			project.background.source.type === "wallpaper" ||
			project.background.source.type === "image"
		) {
			const path = project.background.source.path;

			if (path) {
				if (project.background.source.type === "wallpaper") {
					// If the path is just the wallpaper ID (e.g. "sequoia-dark"), get the full path
					if (
						WALLPAPER_NAMES.includes(path as (typeof WALLPAPER_NAMES)[number])
					) {
						// Wait for wallpapers to load
						const loadedWallpapers = wallpapers();
						if (!loadedWallpapers) return;

						// Find the wallpaper with matching ID
						const wallpaper = loadedWallpapers.find((w) => w.id === path);
						if (!wallpaper?.url) return;

						// Directly trigger the radio group's onChange handler
						const radioGroupOnChange = async (photoUrl: string) => {
							try {
								const wallpaper = wallpapers()?.find((w) => w.url === photoUrl);
								if (!wallpaper) return;

								// Get the raw path without any URL prefixes
								const rawPath = decodeURIComponent(
									photoUrl.replace("file://", ""),
								);

								debouncedSetProject(rawPath);
							} catch (err) {
								toast.error("设置壁纸失败");
							}
						};

						await radioGroupOnChange(wallpaper.url);
					}
				} else if (project.background.source.type === "image") {
					(async () => {
						try {
							const convertedPath = convertFileSrc(path);
							await fetch(convertedPath, { method: "HEAD" });
						} catch (err) {
							setProject("background", "source", {
								type: "image",
								path: null,
							});
						}
					})();
				}
			}
		}
	});

	const filteredWallpapers = createMemo(() => {
		const currentTab = backgroundTab();
		return wallpapers()?.filter((wp) => wp.id.startsWith(currentTab)) || [];
	});

	const [scrollX, setScrollX] = createSignal(0);
	const [reachedEndOfScroll, setReachedEndOfScroll] = createSignal(false);

	const [backgroundRef, setBackgroundRef] = createSignal<HTMLDivElement>();

	createEventListenerMap(
		() => backgroundRef() ?? [],
		{
			/** Handle background tabs overflowing to show fade */
			scroll: () => {
				const el = backgroundRef();
				if (el) {
					setScrollX(el.scrollLeft);
					const reachedEnd = el.scrollWidth - el.clientWidth - el.scrollLeft;
					setReachedEndOfScroll(reachedEnd === 0);
				}
			},
			//Mouse wheel and touchpad support
			wheel: (e: WheelEvent) => {
				const el = backgroundRef();
				if (el) {
					e.preventDefault();
					el.scrollLeft +=
						Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
				}
			},
		},
		{ passive: false },
	);

	let fileInput!: HTMLInputElement;

	// Optimize the debounced set project function
	const debouncedSetProject = (wallpaperPath: string) => {
		const resumeHistory = projectHistory.pause();
		queueMicrotask(() => {
			batch(() => {
				setProject("background", "source", {
					type: "wallpaper",
					path: wallpaperPath,
				} as const);
				resumeHistory();
			});
		});
	};

	const backgrounds: {
		[K in BackgroundSource["type"]]: Extract<BackgroundSource, { type: K }>;
	} = {
		wallpaper: {
			type: "wallpaper",
			path: null,
		},
		image: {
			type: "image",
			path: null,
		},
		color: {
			type: "color",
			value: DEFAULT_GRADIENT_FROM,
		},
		gradient: {
			type: "gradient",
			from: DEFAULT_GRADIENT_FROM,
			to: DEFAULT_GRADIENT_TO,
		},
	};

	const generalSettings = generalSettingsStore.createQuery();
	const hapticsEnabled = () =>
		generalSettings.data?.hapticsEnabled && ostype() === "macos";

	return (
		<KTabs.Content value={TAB_IDS.background} class="flex flex-col gap-6">
			<Field name="背景图像">
				<KTabs
					value={project.background.source.type}
					onChange={(v) => {
						const tab = v as BackgroundSource["type"];
						ensurePaddingForBackground();
						switch (tab) {
							case "image": {
								setProject("background", "source", {
									type: "image",
									path:
										project.background.source.type === "image"
											? project.background.source.path
											: null,
								});
								break;
							}
							case "color": {
								setProject("background", "source", {
									type: "color",
									value:
										project.background.source.type === "color"
											? project.background.source.value
											: DEFAULT_GRADIENT_FROM,
								});
								break;
							}
							case "gradient": {
								setProject("background", "source", {
									type: "gradient",
									from:
										project.background.source.type === "gradient"
											? project.background.source.from
											: DEFAULT_GRADIENT_FROM,
									to:
										project.background.source.type === "gradient"
											? project.background.source.to
											: DEFAULT_GRADIENT_TO,
									angle:
										project.background.source.type === "gradient"
											? project.background.source.angle
											: 90,
								});
								break;
							}
							case "wallpaper": {
								setProject("background", "source", {
									type: "wallpaper",
									path:
										project.background.source.type === "wallpaper"
											? project.background.source.path
											: null,
								});
								break;
							}
						}
					}}
				>
					<KTabs.List class="flex flex-row gap-2 items-center rounded-[0.5rem] relative">
						<For each={BACKGROUND_SOURCES_LIST}>
							{(item) => {
								const el = (props?: object) => (
									<KTabs.Trigger
										class="z-10 flex-1 py-2.5 px-2 text-xs text-gray-11  ui-selected:border-gray-3 ui-selected:bg-gray-3 ui-not-selected:hover:border-gray-7 rounded-[10px] transition-colors duration-200 outline-none border ui-selected:text-gray-12 peer"
										value={item}
										{...props}
									>
										<div class="flex gap-1.5 justify-center items-center">
											{(() => {
												const getGradientBackground = () => {
													const angle =
														project.background.source.type === "gradient"
															? project.background.source.angle
															: 90;
													const fromColor =
														project.background.source.type === "gradient"
															? project.background.source.from
															: DEFAULT_GRADIENT_FROM;
													const toColor =
														project.background.source.type === "gradient"
															? project.background.source.to
															: DEFAULT_GRADIENT_TO;

													return (
														<div
															class="size-3.5 rounded"
															style={{
																background: `linear-gradient(${angle}deg, rgb(${fromColor}), rgb(${toColor}))`,
															}}
														/>
													);
												};

												const getColorBackground = () => {
													const backgroundColor =
														project.background.source.type === "color"
															? project.background.source.value
															: hexToRgb(BACKGROUND_COLORS[9]);

													return (
														<div
															class="size-3.5 rounded-[5px]"
															style={{
																"background-color": `rgb(${backgroundColor})`,
															}}
														/>
													);
												};

												const getImageBackground = () => {
													// Always start with the default icon
													let imageSrc: string = BACKGROUND_ICONS[item];

													// Only override for "image" if a valid path exists
													if (
														item === "image" &&
														project.background.source.type === "image" &&
														project.background.source.path
													) {
														const convertedPath = convertFileSrc(
															project.background.source.path,
														);
														// Only use converted path if it's valid
														if (convertedPath) {
															imageSrc = convertedPath;
														}
													}
													// Only override for "wallpaper" if a valid wallpaper is found
													else if (
														item === "wallpaper" &&
														project.background.source.type === "wallpaper" &&
														project.background.source.path
													) {
														const selectedWallpaper = wallpapers()?.find((w) =>
															(
																project.background.source as { path?: string }
															).path?.includes(w.id),
														);
														// Only use wallpaper URL if it exists
														if (selectedWallpaper?.url) {
															imageSrc = selectedWallpaper.url;
														}
													}

													return (
														<img
															loading="eager"
															alt={BACKGROUND_SOURCES[item]}
															class="size-3.5 rounded"
															src={imageSrc}
														/>
													);
												};

												switch (item) {
													case "gradient":
														return getGradientBackground();
													case "color":
														return getColorBackground();
													case "image":
													case "wallpaper":
														return getImageBackground();
													default:
														return null;
												}
											})()}
											{BACKGROUND_SOURCES[item]}
										</div>
									</KTabs.Trigger>
								);

								return el({});
							}}
						</For>
					</KTabs.List>
					{/** Dashed divider */}
					<div class="my-5 w-full border-t border-dashed border-gray-5" />
					<KTabs.Content value="wallpaper">
						{/** Background Tabs */}
						<KTabs class="overflow-hidden relative" value={backgroundTab()}>
							<KTabs.List
								ref={setBackgroundRef}
								class="flex overflow-x-auto overscroll-contain relative z-10 flex-row gap-2 items-center mb-3 text-xs hide-scroll"
								style={{
									"-webkit-mask-image": `linear-gradient(to right, transparent, black ${
										scrollX() > 0 ? "24px" : "0"
									}, black calc(100% - ${
										reachedEndOfScroll() ? "0px" : "24px"
									}), transparent)`,

									"mask-image": `linear-gradient(to right, transparent, black ${
										scrollX() > 0 ? "24px" : "0"
									}, black calc(100% - ${
										reachedEndOfScroll() ? "0px" : "24px"
									}), transparent);`,
								}}
							>
								<For each={Object.entries(BACKGROUND_THEMES)}>
									{([key, value]) => (
										<>
											<KTabs.Trigger
												onClick={() =>
													setBackgroundTab(
														key as keyof typeof BACKGROUND_THEMES,
													)
												}
												value={key}
												class="flex relative z-10 flex-1 justify-center items-center px-4 py-2 bg-transparent rounded-lg border transition-colors duration-200 text-gray-11 ui-not-selected:hover:border-gray-7 ui-selected:bg-gray-3 ui-selected:border-gray-3 group ui-selected:text-gray-12 disabled:opacity-50 focus:outline-none"
											>
												{value}
											</KTabs.Trigger>
										</>
									)}
								</For>
							</KTabs.List>
						</KTabs>
						{/** End of Background Tabs */}
						<KRadioGroup
							value={
								project.background.source.type === "wallpaper"
									? (wallpapers()?.find((w) =>
											(
												project.background.source as { path?: string }
											).path?.includes(w.id),
										)?.url ?? undefined)
									: undefined
							}
							onChange={(photoUrl) => {
								try {
									const wallpaper = wallpapers()?.find(
										(w) => w.url === photoUrl,
									);
									if (!wallpaper) return;

									// Get the raw path without any URL prefixes

									debouncedSetProject(wallpaper.rawPath);

									ensurePaddingForBackground();
								} catch (err) {
									toast.error("设置壁纸失败");
								}
							}}
							class="grid grid-cols-7 gap-2 h-auto"
						>
							<Show
								when={!wallpapers.loading}
								fallback={
									<div class="flex col-span-7 justify-center items-center h-32 text-gray-11">
										<div class="flex flex-col gap-2 items-center">
											<div class="w-6 h-6 rounded-full border-2 animate-spin border-gray-5 border-t-blue-400" />
											<span>正在加载壁纸...</span>
										</div>
									</div>
								}
							>
								<For each={filteredWallpapers().slice(0, 21)}>
									{(photo) => (
										<KRadioGroup.Item
											value={photo.url!}
											class="relative aspect-square group"
										>
											<KRadioGroup.ItemInput class="peer" />
											<KRadioGroup.ItemControl class="overflow-hidden w-full h-full rounded-lg transition cursor-pointer ui-not-checked:ring-offset-1 ui-not-checked:ring-offset-gray-200 ui-not-checked:hover:ring-1 ui-not-checked:hover:ring-gray-400 ui-checked:ring-2 ui-checked:ring-gray-500 ui-checked:ring-offset-2 ui-checked:ring-offset-gray-200">
												<img
													src={photo.url!}
													loading="eager"
													class="object-cover w-full h-full"
													alt="Wallpaper option"
												/>
											</KRadioGroup.ItemControl>
										</KRadioGroup.Item>
									)}
								</For>
								<Collapsible class="col-span-7">
									<Collapsible.Content class="animate-in slide-in-from-top-2 fade-in">
										<div class="grid grid-cols-7 gap-2">
											<For each={filteredWallpapers()}>
												{(photo) => (
													<KRadioGroup.Item
														value={photo.url!}
														class="relative aspect-square group"
													>
														<KRadioGroup.ItemInput class="peer" />
														<KRadioGroup.ItemControl class="overflow-hidden w-full h-full rounded-lg border cursor-pointer border-gray-5 ui-checked:border-blue-9 ui-checked:ring-2 ui-checked:ring-blue-9 peer-focus-visible:border-2 peer-focus-visible:border-blue-9">
															<img
																src={photo.url!}
																alt="Wallpaper option"
																class="object-cover w-full h-full"
																loading="lazy"
															/>
														</KRadioGroup.ItemControl>
													</KRadioGroup.Item>
												)}
											</For>
										</div>
									</Collapsible.Content>
								</Collapsible>
							</Show>
						</KRadioGroup>
					</KTabs.Content>
					<KTabs.Content value="image">
						<Show
							when={
								project.background.source.type === "image" &&
								project.background.source.path
							}
							fallback={
								<button
									type="button"
									onClick={() => fileInput.click()}
									class="p-6 bg-gray-2 text-[13px] w-full rounded-[0.5rem] border border-gray-5 border-dashed flex flex-col items-center justify-center gap-[0.5rem] hover:bg-gray-3 transition-colors duration-100"
								>
									<IconCapImage class="text-gray-11 size-6" />
									<span class="text-gray-12">
										Click to select or drag and drop image
									</span>
								</button>
							}
						>
							{(source) => (
								<div class="overflow-hidden relative w-full h-48 rounded-md border border-gray-3 group">
									<img
										src={convertFileSrc(source())}
										class="object-cover w-full h-full"
										alt="Selected background"
									/>
									<div class="absolute top-2 right-2">
										<button
											type="button"
											onClick={() =>
												setProject("background", "source", {
													type: "image",
													path: null,
												})
											}
											class="p-2 text-white rounded-full transition-colors bg-black/50 hover:bg-black/70"
										>
											<IconCapCircleX class="w-4 h-4" />
										</button>
									</div>
								</div>
							)}
						</Show>
						<input
							type="file"
							ref={fileInput}
							class="hidden"
							accept="image/apng, image/avif, image/jpeg, image/png, image/webp"
							onChange={async (e) => {
								const file = e.currentTarget.files?.[0];
								if (!file) return;

								/*
                    this is a Tauri bug in WebKit so we need to validate the file type manually
                    https://github.com/tauri-apps/tauri/issues/9158
                    */
								const validExtensions = [
									"jpg",
									"jpeg",
									"png",
									"gif",
									"webp",
									"bmp",
								];
								const extension = file.name.split(".").pop()?.toLowerCase();
								if (!extension || !validExtensions.includes(extension)) {
									toast.error("无效的图片文件类型");
									return;
								}

								try {
									const fileName = `bg-${Date.now()}-${file.name}`;
									const arrayBuffer = await file.arrayBuffer();
									const uint8Array = new Uint8Array(arrayBuffer);

									const fullPath = `${await appDataDir()}/${fileName}`;

									await writeFile(fileName, uint8Array, {
										baseDir: BaseDirectory.AppData,
									});

									setProject("background", "source", {
										type: "image",
										path: fullPath,
									});
								} catch (err) {
									toast.error("保存图片失败");
								}
							}}
						/>
					</KTabs.Content>
					<KTabs.Content value="color">
						<Show
							when={
								project.background.source.type === "color" &&
								project.background.source
							}
						>
							<div class="flex flex-col flex-wrap gap-3">
								<div class="flex flex-row items-center w-full h-10">
									<RgbInput
										value={
											project.background.source.type === "color"
												? project.background.source.value
												: [0, 0, 0]
										}
										onChange={(value) => {
											setProject("background", "source", {
												type: "color",
												value,
											});
										}}
									/>
								</div>

								<div class="flex flex-wrap gap-2">
									<For each={BACKGROUND_COLORS}>
										{(color) => (
											<label class="relative">
												<input
													type="radio"
													class="sr-only peer"
													name="colorPicker"
													onChange={(e) => {
														if (!e.target.checked) return;

														const rgbValue = hexToRgb(color);
														if (!rgbValue) return;

														const [r, g, b, a] = rgbValue;
														backgrounds.color = {
															type: "color",
															value: [r, g, b],
															alpha: a,
														};

														setProject(
															"background",
															"source",
															backgrounds.color,
														);
													}}
												/>
												<div
													class="rounded-lg transition-all duration-200 cursor-pointer size-8 peer-checked:hover:opacity-100 peer-hover:opacity-70 peer-checked:ring-2 peer-checked:ring-gray-500 peer-checked:ring-offset-2 peer-checked:ring-offset-gray-200"
													style={{
														background:
															color === "#00000000"
																? CHECKERED_BUTTON_BACKGROUND
																: color,
													}}
												/>
											</label>
										)}
									</For>
								</div>
								{/* <Tooltip content="Add custom color">
                      <button
                        class="flex justify-center items-center w-6 h-6 rounded-lg border border-gray-400 border-dashed text-gray-12 hover:border-gray-500"
                        onClick={() => {
                          // Function to add a new color (you can modify this)
                          console.log(
                            "Open color picker or modal to add a color"
                          );
                        }}
                      >
                        +
                      </button>
                    </Tooltip> */}
							</div>
						</Show>
					</KTabs.Content>
					<KTabs.Content value="gradient" class="flex flex-row justify-between">
						<Show
							when={
								project.background.source.type === "gradient" &&
								project.background.source
							}
						>
							{(source) => {
								const max = 360;

								const { projectHistory } = useEditorContext();

								const angle = () => source().angle ?? 90;

								return (
									<>
										<div class="flex flex-col gap-3">
											<div class="flex gap-5 h-10">
												<RgbInput
													value={source().from}
													onChange={(from) => {
														backgrounds.gradient.from = from;
														setProject("background", "source", {
															type: "gradient",
															from,
														});
													}}
												/>
												<RgbInput
													value={source().to}
													onChange={(to) => {
														backgrounds.gradient.to = to;
														setProject("background", "source", {
															type: "gradient",
															to,
														});
													}}
												/>
												<div
													class="flex relative flex-col items-center p-1 ml-auto rounded-full border bg-gray-1 border-gray-3 size-10 cursor-ns-resize shrink-0"
													style={{ transform: `rotate(${angle()}deg)` }}
													onMouseDown={(downEvent) => {
														const start = angle();
														const resumeHistory = projectHistory.pause();

														createRoot((dispose) =>
															createEventListenerMap(window, {
																mouseup: () => dispose(),
																mousemove: (moveEvent) => {
																	const rawNewAngle =
																		Math.round(
																			start +
																				(downEvent.clientY - moveEvent.clientY),
																		) % max;
																	const newAngle = moveEvent.shiftKey
																		? rawNewAngle
																		: Math.round(rawNewAngle / 45) * 45;

																	if (
																		!moveEvent.shiftKey &&
																		hapticsEnabled() &&
																		project.background.source.type ===
																			"gradient" &&
																		project.background.source.angle !== newAngle
																	) {
																		commands.performHapticFeedback(
																			"Alignment",
																			"Now",
																		);
																	}

																	setProject("background", "source", {
																		type: "gradient",
																		angle:
																			newAngle < 0 ? newAngle + max : newAngle,
																	});
																},
															}),
														);
													}}
												>
													<div class="bg-blue-9 rounded-full size-1.5" />
												</div>
											</div>
											<div class="flex flex-wrap gap-2">
												<For each={BACKGROUND_GRADIENTS}>
													{(gradient) => (
														<label class="relative">
															<input
																type="radio"
																class="sr-only peer"
																name="colorPicker"
																onChange={(e) => {
																	if (e.target.checked) {
																		backgrounds.gradient = {
																			type: "gradient",
																			from: gradient.from,
																			to: gradient.to,
																		};
																		setProject(
																			"background",
																			"source",
																			backgrounds.gradient,
																		);
																	}
																}}
															/>
															<div
																class="rounded-lg transition-all duration-200 cursor-pointer size-8 peer-checked:hover:opacity-100 peer-hover:opacity-70 peer-checked:ring-2 peer-checked:ring-gray-500 peer-checked:ring-offset-2 peer-checked:ring-offset-gray-200"
																style={{
																	background: `linear-gradient(${angle()}deg, rgb(${gradient.from.join(
																		",",
																	)}), rgb(${gradient.to.join(",")}))`,
																}}
															/>
														</label>
													)}
												</For>
											</div>
										</div>
									</>
								);
							}}
						</Show>
					</KTabs.Content>
				</KTabs>
			</Field>

			<Field name="背景模糊" inline>
				<Slider
					value={[project.background.blur]}
					onChange={(v) => setProject("background", "blur", v[0])}
					minValue={0}
					maxValue={100}
					step={0.1}
					formatTooltip="%"
				/>
			</Field>
			{/** Dashed divider */}
			<div class="w-full border-t border-gray-300 border-dashed" />
			<Field name="视频内边距" inline>
				<Slider
					value={[project.background.padding]}
					onChange={(v) => setProject("background", "padding", v[0])}
					minValue={0}
					maxValue={40}
					step={0.1}
					formatTooltip="%"
				/>
			</Field>
			<Field name="视频框圆角" inline>
				<Slider
					value={[project.background.rounding]}
					onChange={(v) => setProject("background", "rounding", v[0])}
					minValue={0}
					maxValue={100}
					step={0.1}
					formatTooltip="%"
				/>
			</Field>
			<Field
				name="视频边框"
				value={
					<Toggle
						checked={project.background.border?.enabled ?? false}
						onChange={(enabled) => {
							const prev = project.background.border ?? {
								enabled: false,
								width: 5.0,
								color: [0, 0, 0],
								opacity: 50.0,
							};

							setProject("background", "border", {
								...prev,
								enabled,
							});
						}}
					/>
				}
			/>
			<Show when={project.background.border?.enabled}>
				<Field name="边框宽度" inline>
					<Slider
						value={[project.background.border?.width ?? 5.0]}
						onChange={(v) =>
							setProject("background", "border", {
								...(project.background.border ?? {
									enabled: true,
									width: 5.0,
									color: [0, 0, 0],
									opacity: 50.0,
								}),
								width: v[0],
							})
						}
						minValue={1}
						maxValue={20}
						step={0.1}
						formatTooltip="px"
					/>
				</Field>
				<Field name="边框颜色" inline>
					<RgbInput
						value={project.background.border?.color ?? [0, 0, 0]}
						onChange={(color) =>
							setProject("background", "border", {
								...(project.background.border ?? {
									enabled: true,
									width: 5.0,
									color: [0, 0, 0],
									opacity: 50.0,
								}),
								color,
							})
						}
					/>
				</Field>
				<Field name="边框不透明度" inline>
					<Slider
						value={[project.background.border?.opacity ?? 50.0]}
						onChange={(v) =>
							setProject("background", "border", {
								...(project.background.border ?? {
									enabled: true,
									width: 5.0,
									color: [0, 0, 0],
									opacity: 50.0,
								}),
								opacity: v[0],
							})
						}
						minValue={0}
						maxValue={100}
						step={0.1}
						formatTooltip="%"
					/>
				</Field>
			</Show>
			<Field name="阴影" inline>
				<Slider
					value={[project.background.shadow!]}
					onChange={(v) => {
						batch(() => {
							setProject("background", "shadow", v[0]);
							if (v[0] > 0 && !project.background.advancedShadow) {
								setProject("background", "advancedShadow", {
									size: 50,
									opacity: 18,
									blur: 50,
								});
							}
						});
					}}
					minValue={0}
					maxValue={100}
					step={0.1}
					formatTooltip="%"
				/>
			</Field>
			<ShadowSettings
				scrollRef={props.scrollRef}
				size={{
					value: [project.background.advancedShadow?.size ?? 50],
					onChange: (v) => {
						setProject("background", "advancedShadow", {
							...(project.background.advancedShadow ?? {
								size: 50,
								opacity: 18,
								blur: 50,
							}),
							size: v[0],
						});
					},
				}}
				opacity={{
					value: [project.background.advancedShadow?.opacity ?? 18],
					onChange: (v) => {
						setProject("background", "advancedShadow", {
							...(project.background.advancedShadow ?? {
								size: 50,
								opacity: 18,
								blur: 50,
							}),
							opacity: v[0],
						});
					},
				}}
				blur={{
					value: [project.background.advancedShadow?.blur ?? 50],
					onChange: (v) => {
						setProject("background", "advancedShadow", {
							...(project.background.advancedShadow ?? {
								size: 50,
								opacity: 18,
								blur: 50,
							}),
							blur: v[0],
						});
					},
				}}
			/>
			{/* <ComingSoonTooltip>
            <Field name="Inset" icon={<IconCapInset />}>
              <Slider
                disabled
                value={[project.background.inset]}
                onChange={(v) => setProject("background", "inset", v[0])}
                minValue={0}
                maxValue={100}
              />
            </Field>
          </ComingSoonTooltip> */}
		</KTabs.Content>
	);
}

function CameraConfig(props: { scrollRef: HTMLDivElement }) {
	const { project, setProject } = useEditorContext();

	return (
		<KTabs.Content value={TAB_IDS.camera} class="flex flex-col gap-6">
			<Field name="摄像头">
				<div class="flex flex-col gap-6">
					<div>
						<Subfield name="位置" />
						<KRadioGroup
							value={`${project.camera.position.x}:${project.camera.position.y}`}
							onChange={(v) => {
								const [x, y] = v.split(":");
								setProject("camera", "position", { x, y } as any);
							}}
							class="mt-[0.75rem] rounded-[0.5rem] border border-gray-3 bg-gray-2 w-full h-[7.5rem] relative"
						>
							<For
								each={[
									{ x: "left", y: "top" } as const,
									{ x: "center", y: "top" } as const,
									{ x: "right", y: "top" } as const,
									{ x: "left", y: "bottom" } as const,
									{ x: "center", y: "bottom" } as const,
									{ x: "right", y: "bottom" } as const,
								]}
							>
								{(item) => (
									<RadioGroup.Item value={`${item.x}:${item.y}`}>
										<RadioGroup.ItemInput class="peer" />
										<RadioGroup.ItemControl
											class={cx(
												"cursor-pointer size-6 shrink-0 rounded-[0.375rem] bg-gray-5 absolute flex justify-center items-center ui-checked:bg-blue-9 focus-visible:outline peer-focus-visible:outline outline-2 outline-blue-9 outline-offset-2 transition-colors duration-100",
												item.x === "left"
													? "left-2"
													: item.x === "right"
														? "right-2"
														: "left-1/2 transform -translate-x-1/2",
												item.y === "top" ? "top-2" : "bottom-2",
											)}
											onClick={() => setProject("camera", "position", item)}
										>
											<div class="size-[0.5rem] shrink-0 bg-solid-white rounded-full" />
										</RadioGroup.ItemControl>
									</RadioGroup.Item>
								)}
							</For>
						</KRadioGroup>
					</div>
					<Subfield name="隐藏摄像头">
						<Toggle
							checked={project.camera.hide}
							onChange={(hide) => setProject("camera", "hide", hide)}
						/>
					</Subfield>
					<Subfield name="镜像摄像头">
						<Toggle
							checked={project.camera.mirror}
							onChange={(mirror) => setProject("camera", "mirror", mirror)}
						/>
					</Subfield>
					<Subfield name="形状">
						<KSelect<{ name: string; value: CameraShape }>
							options={CAMERA_SHAPES}
							optionValue="value"
							optionTextValue="name"
							value={CAMERA_SHAPES.find(
								(v) => v.value === project.camera.shape,
							)}
							onChange={(v) => {
								if (v) setProject("camera", "shape", v.value);
							}}
							disallowEmptySelection
							itemComponent={(props) => (
								<MenuItem<typeof KSelect.Item>
									as={KSelect.Item}
									item={props.item}
								>
									<KSelect.ItemLabel class="flex-1">
										{props.item.rawValue.name}
									</KSelect.ItemLabel>
								</MenuItem>
							)}
						>
							<KSelect.Trigger class="flex flex-row gap-2 items-center px-2 w-full h-8 rounded-lg transition-colors bg-gray-3 disabled:text-gray-11">
								<KSelect.Value<{
									name: string;
									value: StereoMode;
								}> class="flex-1 text-sm text-left truncate text-[--gray-500] font-normal">
									{(state) => <span>{state.selectedOption().name}</span>}
								</KSelect.Value>
								<KSelect.Icon<ValidComponent>
									as={(props) => (
										<IconCapChevronDown
											{...props}
											class="size-4 shrink-0 transform transition-transform ui-expanded:rotate-180 text-[--gray-500]"
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
										class="overflow-y-auto max-h-32"
										as={KSelect.Listbox}
									/>
								</PopperContent>
							</KSelect.Portal>
						</KSelect>
					</Subfield>

					{/* <Subfield name="Use Camera Aspect Ratio">
            <Toggle
              checked={project.camera.use_camera_aspect}
              onChange={(v) => setProject("camera", "use_camera_aspect", v)}
            />
          </Subfield> */}
				</div>
			</Field>
			{/** Dashed divider */}
			<div class="w-full border-t border-dashed border-gray-5" />
			<Field name="大小" inline>
				<Slider
					value={[project.camera.size]}
					onChange={(v) => setProject("camera", "size", v[0])}
					minValue={20}
					maxValue={80}
					step={0.1}
					formatTooltip="%"
				/>
			</Field>
			<Field name="缩放时大小" inline>
				<Slider
					value={[project.camera.zoom_size ?? 60]}
					onChange={(v) => setProject("camera", "zoom_size", v[0])}
					minValue={10}
					maxValue={60}
					step={0.1}
					formatTooltip="%"
				/>
			</Field>
			<Field name="圆角" inline>
				<Slider
					value={[project.camera.rounding!]}
					onChange={(v) => setProject("camera", "rounding", v[0])}
					minValue={0}
					maxValue={100}
					step={0.1}
					formatTooltip="%"
				/>
			</Field>
			{/* <ComingSoonTooltip>
            <Field name="Shadow" icon={<IconCapShadow />}>
              <Slider
                disabled
                value={[project.camera.shadow]}
                onChange={(v) => setProject("camera", "shadow", v[0])}
                minValue={0}
                maxValue={100}
              />
            </Field>
          </ComingSoonTooltip> */}
		</KTabs.Content>
	);
}

function SegmentsConfig() {
	const { project, setProject, editorState, setEditorState, projectActions } =
		useEditorContext();

	const zoomSegments = () => project.timeline?.zoomSegments ?? [];
	const sceneSegments = () => project.timeline?.sceneSegments ?? [];

	const selectedZoomSegment = () => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "zoom") return null;
		if (selection.indices.length !== 1) return null;
		const index = selection.indices[0];
		const segment = zoomSegments()[index];
		return segment ? { index, segment } : null;
	};

	const selectedSceneSegment = () => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "scene") return null;
		if (selection.indices.length !== 1) return null;
		const index = selection.indices[0];
		const segment = sceneSegments()[index];
		return segment ? { index, segment } : null;
	};

	return (
		<>
			{/* Zoom Segments Section */}
			<Field name="缩放片段" icon={<IconLucideSearch />}>
				<Show
					when={selectedZoomSegment()}
					fallback={
						<Show
							when={zoomSegments().length > 0}
							fallback={
								<div class="text-sm text-gray-10 py-2">
									在时间轴上点击"缩放"轨道添加缩放片段
								</div>
							}
						>
							<div class="flex flex-col gap-2">
								<For each={zoomSegments()}>
									{(segment, index) => (
										<div
											class="flex items-center justify-between p-2 rounded-lg border border-gray-3 hover:border-gray-5 cursor-pointer transition-colors"
											onClick={() => {
												setEditorState("timeline", "selection", {
													type: "zoom",
													indices: [index()],
												});
											}}
										>
											<span class="text-sm">缩放片段 {index() + 1}</span>
											<span class="text-xs text-gray-10">
												{segment.amount.toFixed(1)}x
											</span>
										</div>
									)}
								</For>
							</div>
						</Show>
					}
				>
					{(selected) => (
						<ZoomSegmentConfigInline
							segment={selected().segment}
							segmentIndex={selected().index}
						/>
					)}
				</Show>
			</Field>

			{/* Camera Layout Segments Section */}
			<Field name="摄像头布局片段" icon={<IconLucideLayout />}>
				<Show
					when={selectedSceneSegment()}
					fallback={
						<Show
							when={sceneSegments().length > 0}
							fallback={
								<div class="text-sm text-gray-10 py-2">
									在时间轴上点击"摄像头布局"轨道添加片段
								</div>
							}
						>
							<div class="flex flex-col gap-2">
								<For each={sceneSegments()}>
									{(segment, index) => (
										<div
											class="flex items-center justify-between p-2 rounded-lg border border-gray-3 hover:border-gray-5 cursor-pointer transition-colors"
											onClick={() => {
												setEditorState("timeline", "selection", {
													type: "scene",
													indices: [index()],
												});
											}}
										>
											<span class="text-sm">摄像头布局片段 {index() + 1}</span>
											<span class="text-xs text-gray-10">
												{segment.mode === "cameraOnly"
													? "仅摄像头"
													: segment.mode === "hideCamera"
														? "隐藏摄像头"
														: "默认"}
											</span>
										</div>
									)}
								</For>
							</div>
						</Show>
					}
				>
					{(selected) => (
						<SceneSegmentConfigInline
							segment={selected().segment}
							segmentIndex={selected().index}
						/>
					)}
				</Show>
			</Field>
		</>
	);
}

function ZoomSegmentConfigInline(props: {
	segmentIndex: number;
	segment: ZoomSegment;
}) {
	const generalSettings = generalSettingsStore.createQuery();
	const {
		project,
		setProject,
		editorInstance,
		setEditorState,
		projectHistory,
		projectActions,
	} = useEditorContext();

	const states = {
		manual:
			props.segment.mode === "auto"
				? { x: 0.5, y: 0.5 }
				: props.segment.mode.manual,
	};

	return (
		<div class="flex flex-col gap-4">
			{/* Zoom Mode - Top row */}
			<div class="flex items-center justify-between">
				<span class="text-sm text-gray-11">缩放模式</span>
				<KTabs
					value={props.segment.mode === "auto" ? "auto" : "manual"}
					onChange={(v) => {
						setProject(
							"timeline",
							"zoomSegments",
							props.segmentIndex,
							"mode",
							v === "auto" ? "auto" : { manual: states.manual },
						);
					}}
				>
					<KTabs.List class="flex flex-row items-center rounded-[0.5rem] relative border">
						<KTabs.Trigger
							value="auto"
							class="z-10 px-3 py-1.5 text-sm text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12"
							disabled={!generalSettings.data?.custom_cursor_capture2}
						>
							自动
						</KTabs.Trigger>
						<KTabs.Trigger
							value="manual"
							class="z-10 px-3 py-1.5 text-sm text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12"
						>
							手动
						</KTabs.Trigger>
						<KTabs.Indicator class="absolute flex p-px inset-0 transition-transform rounded-[0.5rem] overflow-hidden">
							<div class="flex-1 bg-gray-3" />
						</KTabs.Indicator>
					</KTabs.List>
				</KTabs>
			</div>

			{/* Manual mode preview */}
			<Show
				when={(() => {
					const m = props.segment.mode;
					if (m === "auto") return;
					return m.manual;
				})()}
			>
				{(mode) => {
					const start = createMemo<number>((prev) => {
						if (projectHistory.isPaused()) return prev;
						return props.segment.start;
					}, 0);

					const segmentIndex = createMemo<number>((prev) => {
						if (projectHistory.isPaused()) return prev;
						const st = start();
						const i = project.timeline?.segments.findIndex(
							(s) => s.start <= st && s.end > st,
						);
						if (i === undefined || i === -1) return 0;
						return i;
					}, 0);

					const relativeTime = createMemo(() => {
						const st = start();
						const segment = project.timeline?.segments[segmentIndex()];
						if (!segment) return 0;
						return Math.max(0, st - segment.start);
					});

					const video = document.createElement("video");
					video.muted = true;
					video.playsInline = true;

					createEffect(() => {
						const path = convertFileSrc(
							`${editorInstance.path}/content/segments/segment-${segmentIndex()}/display.mp4`,
						);
						video.src = path;
						video.preload = "auto";
						video.load();
					});

					createEffect(() => {
						const t = relativeTime();
						if (t === undefined) return;

						if (video.readyState >= 2) {
							video.currentTime = t;
						} else {
							const handleCanPlay = () => {
								video.currentTime = t;
								video.removeEventListener("canplay", handleCanPlay);
							};
							video.addEventListener("canplay", handleCanPlay);
						}
					});

					const rawSize = () => {
						const raw = editorInstance.recordings.segments[0].display;
						return { x: raw.width, y: raw.height };
					};

					const croppedPosition = () => {
						const cropped = project.background.crop?.position;
						if (cropped) return cropped;
						return { x: 0, y: 0 };
					};

					const croppedSize = () => {
						const cropped = project.background.crop?.size;
						if (cropped) return cropped;
						return rawSize();
					};

					let canvasRef!: HTMLCanvasElement;

					const render = () => {
						if (!canvasRef || video.readyState < 2) return;

						const ctx = canvasRef.getContext("2d");
						if (!ctx) return;

						ctx.imageSmoothingEnabled = false;
						ctx.clearRect(0, 0, canvasRef.width, canvasRef.height);
						ctx.drawImage(
							video,
							croppedPosition().x,
							croppedPosition().y,
							croppedSize().x,
							croppedSize().y,
							0,
							0,
							canvasRef.width!,
							canvasRef.height!,
						);
					};

					const [loaded, setLoaded] = createSignal(false);
					video.onloadeddata = () => {
						setLoaded(true);
						render();
					};
					video.onseeked = render;

					video.onerror = (e) => {
						console.error("Failed to load video for zoom preview:", e);
						setTimeout(() => {
							video.load();
						}, 100);
					};

					createEffect(
						on(
							() => {
								croppedPosition();
								croppedSize();
							},
							() => {
								if (loaded()) {
									render();
								}
							},
						),
					);

					const [containerRef, setContainerRef] = createSignal<HTMLDivElement>();
					const bounds = createElementBounds(containerRef);
					const visualHeight = () =>
						(bounds.width! / croppedSize().x) * croppedSize().y;

					return (
						<div
							ref={setContainerRef}
							class="relative w-full cursor-crosshair"
							style={{
								height: `calc(${visualHeight()}px + 0.25rem)`,
							}}
							onMouseDown={(downEvent) => {
								const rect = downEvent.currentTarget.getBoundingClientRect();
								createRoot((dispose) =>
									createEventListenerMap(window, {
										mouseup: () => dispose(),
										mousemove: (moveEvent) => {
											setProject(
												"timeline",
												"zoomSegments",
												props.segmentIndex,
												"mode",
												"manual",
												{
													x: Math.max(
														Math.min(
															(moveEvent.clientX - rect.left) / rect.width,
															1,
														),
														0,
													),
													y: Math.max(
														Math.min(
															(moveEvent.clientY - rect.top) / rect.height,
															1,
														),
														0,
													),
												},
											);
										},
									}),
								);
							}}
						>
							<div
								class="absolute z-10 w-6 h-6 rounded-full border border-gray-400 -translate-x-1/2 -translate-y-1/2 bg-gray-1"
								style={{
									left: `${mode().x * 100}%`,
									top: `${mode().y * 100}%`,
								}}
							>
								<div class="size-1.5 bg-gray-5 rounded-full" />
							</div>
							<div class="overflow-hidden relative rounded-lg border border-gray-3 bg-gray-2">
								<canvas
									ref={canvasRef}
									width={croppedSize().x}
									height={croppedSize().y}
									data-loaded={loaded()}
									class="z-10 bg-gray-3 opacity-0 transition-opacity data-[loaded='true']:opacity-100 w-full h-full duration-200"
								/>
								<Show when={!loaded()}>
									<div class="flex absolute inset-0 justify-center items-center bg-gray-2">
										<div class="text-sm text-gray-11">
											加载预览中...
										</div>
									</div>
								</Show>
							</div>
						</div>
					);
				}}
			</Show>

			{/* Zoom amount - Same row */}
			<div class="flex items-center justify-between gap-4">
				<span class="text-sm text-gray-11 shrink-0">
					缩放倍数
				</span>
				<div class="flex-1">
					<Slider
						value={[props.segment.amount]}
						onChange={(v) =>
							setProject(
								"timeline",
								"zoomSegments",
								props.segmentIndex,
								"amount",
								v[0],
							)
						}
						minValue={1}
						maxValue={4.5}
						step={0.001}
						formatTooltip="x"
					/>
				</div>
			</div>

			{/* Bottom buttons */}
			<div class="flex items-center justify-between pt-2 border-t border-gray-3">
				<Button
					variant="blue"
					size="sm"
					onClick={() => setEditorState("timeline", "selection", null)}
				>
					完成
				</Button>
				<button
					type="button"
					class="flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300 transition-colors"
					onClick={() => {
						projectActions.deleteZoomSegments([props.segmentIndex]);
					}}
				>
					<IconCapTrash class="size-4" />
					删除
				</button>
			</div>
		</div>
	);
}

function SceneSegmentConfigInline(props: {
	segmentIndex: number;
	segment: SceneSegment;
}) {
	const { setProject, setEditorState, projectActions } = useEditorContext();

	return (
		<div class="flex flex-col gap-4">
			{/* Camera Layout Mode */}
			<div class="flex items-center justify-between">
				<span class="text-sm text-gray-11">布局模式</span>
				<KTabs
					value={props.segment.mode || "default"}
					onChange={(v) => {
						setProject(
							"timeline",
							"sceneSegments",
							props.segmentIndex,
							"mode",
							v as "default" | "cameraOnly" | "hideCamera",
						);
					}}
				>
					<KTabs.List class="flex flex-row items-center rounded-[0.5rem] relative border">
						<KTabs.Trigger
							value="default"
							class="z-10 px-2 py-1.5 text-sm text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12"
						>
							默认
						</KTabs.Trigger>
						<KTabs.Trigger
							value="cameraOnly"
							class="z-10 px-2 py-1.5 text-sm text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12"
						>
							仅摄像头
						</KTabs.Trigger>
						<KTabs.Trigger
							value="hideCamera"
							class="z-10 px-2 py-1.5 text-sm text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12"
						>
							隐藏
						</KTabs.Trigger>
						<KTabs.Indicator class="absolute flex p-px inset-0 transition-transform rounded-[0.5rem] overflow-hidden">
							<div class="flex-1 bg-gray-3" />
						</KTabs.Indicator>
					</KTabs.List>
				</KTabs>
			</div>

			{/* Segment info */}
			<div class="text-sm text-gray-10">
				摄像头布局片段 {props.segmentIndex + 1}
			</div>

			{/* Bottom buttons */}
			<div class="flex items-center justify-between pt-2 border-t border-gray-3">
				<Button
					variant="blue"
					size="sm"
					onClick={() => setEditorState("timeline", "selection", null)}
				>
					完成
				</Button>
				<button
					type="button"
					class="flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300 transition-colors"
					onClick={() => {
						projectActions.deleteSceneSegment(props.segmentIndex);
					}}
				>
					<IconCapTrash class="size-4" />
					删除
				</button>
			</div>
		</div>
	);
}

function ZoomSegmentPreview(props: {
	segmentIndex: number;
	segment: ZoomSegment;
}) {
	const { project, editorInstance } = useEditorContext();

	const start = createMemo(() => props.segment.start);

	const clipSegment = createMemo(() => {
		const st = start();
		return project.timeline?.segments.find((s) => s.start <= st && s.end > st);
	});

	const relativeTime = createMemo(() => {
		const st = start();
		const segment = clipSegment();
		if (!segment) return 0;
		return Math.max(0, st - segment.start);
	});

	const video = document.createElement("video");
	createEffect(() => {
		// TODO: make this not hardcoded
		const path = convertFileSrc(
			`${editorInstance.path}/content/segments/segment-${
				clipSegment()?.recordingSegment ?? 0
			}/display.mp4`,
		);
		video.src = path;
		video.preload = "auto";
		video.load();
	});

	createEffect(() => {
		const t = relativeTime();
		if (t === undefined) return;

		if (video.readyState >= 2) {
			video.currentTime = t;
		} else {
			const handleCanPlay = () => {
				video.currentTime = t;
				video.removeEventListener("canplay", handleCanPlay);
			};
			video.addEventListener("canplay", handleCanPlay);
		}
	});

	const render = () => {
		if (!canvasRef || video.readyState < 2) return;

		const ctx = canvasRef.getContext("2d");
		if (!ctx) return;

		ctx.imageSmoothingEnabled = false;
		ctx.clearRect(0, 0, canvasRef.width, canvasRef.height);

		const raw = editorInstance.recordings.segments[0].display;
		const croppedPosition = project.background.crop?.position || { x: 0, y: 0 };
		const croppedSize = project.background.crop?.size || {
			x: raw.width,
			y: raw.height,
		};

		ctx.drawImage(
			video,
			croppedPosition.x,
			croppedPosition.y,
			croppedSize.x,
			croppedSize.y,
			0,
			0,
			canvasRef.width,
			canvasRef.height,
		);
	};

	const [loaded, setLoaded] = createSignal(false);
	video.onloadeddata = () => {
		setLoaded(true);
		render();
	};
	video.onseeked = render;
	video.onerror = () => {
		setTimeout(() => video.load(), 100);
	};

	let canvasRef!: HTMLCanvasElement;

	return (
		<>
			<div class="space-y-1.5">
				<div class="text-xs font-medium text-center text-gray-12">
					缩放 {props.segmentIndex + 1}
				</div>
				<div class="overflow-hidden relative rounded border aspect-video border-gray-3 bg-gray-3">
					<canvas
						ref={canvasRef}
						width={160}
						height={90}
						data-loaded={loaded()}
						class="w-full h-full opacity-0 transition-opacity data-[loaded='true']:opacity-100 duration-200"
					/>
					<Show when={!loaded()}>
						<p class="flex absolute inset-0 justify-center items-center text-xs text-gray-11">
							加载中...
						</p>
					</Show>
				</div>
			</div>
			<div class="flex gap-1 justify-center items-center mt-3 w-full text-xs text-center text-gray-11">
				<IconLucideSearch class="size-3" />
				<p>{props.segment.amount.toFixed(1)}x</p>
			</div>
		</>
	);
}

function ZoomSegmentConfig(props: {
	segmentIndex: number;
	segment: ZoomSegment;
}) {
	const generalSettings = generalSettingsStore.createQuery();
	const {
		project,
		setProject,
		editorInstance,
		setEditorState,
		projectHistory,
	} = useEditorContext();

	const states = {
		manual:
			props.segment.mode === "auto"
				? { x: 0.5, y: 0.5 }
				: props.segment.mode.manual,
	};

	return (
		<>
			<Field
				name={`缩放 ${props.segmentIndex + 1}`}
				icon={<IconLucideSearch />}
			>
				<Slider
					value={[props.segment.amount]}
					onChange={(v) =>
						setProject(
							"timeline",
							"zoomSegments",
							props.segmentIndex,
							"amount",
							v[0],
						)
					}
					minValue={1}
					maxValue={4.5}
					step={0.001}
					formatTooltip="x"
				/>
			</Field>
			<Field name="缩放模式" icon={<IconCapSettings />}>
				<KTabs
					class="space-y-6"
					value={props.segment.mode === "auto" ? "auto" : "manual"}
					onChange={(v) => {
						setProject(
							"timeline",
							"zoomSegments",
							props.segmentIndex,
							"mode",
							v === "auto" ? "auto" : { manual: states.manual },
						);
					}}
				>
					<KTabs.List class="flex flex-row items-center rounded-[0.5rem] relative border">
						<KTabs.Trigger
							value="auto"
							class="z-10 flex-1 py-2.5 text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12 peer"
							disabled={!generalSettings.data?.custom_cursor_capture2}
						>
							自动
						</KTabs.Trigger>
						<KTabs.Trigger
							value="manual"
							class="z-10 flex-1 py-2.5 text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12 peer"
						>
							手动
						</KTabs.Trigger>
						<KTabs.Indicator class="absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-9 outline-offset-2 rounded-[0.6rem] overflow-hidden">
							<div class="flex-1 bg-gray-3" />
						</KTabs.Indicator>
					</KTabs.List>
					<KTabs.Content value="manual" tabIndex="">
						<Show
							when={(() => {
								const m = props.segment.mode;
								if (m === "auto") return;

								return m.manual;
							})()}
						>
							{(mode) => {
								const start = createMemo<number>((prev) => {
									if (projectHistory.isPaused()) return prev;

									return props.segment.start;
								}, 0);

								const segmentIndex = createMemo<number>((prev) => {
									if (projectHistory.isPaused()) return prev;

									const st = start();
									const i = project.timeline?.segments.findIndex(
										(s) => s.start <= st && s.end > st,
									);
									if (i === undefined || i === -1) return 0;
									return i;
								}, 0);

								// Calculate the time relative to the video segment
								const relativeTime = createMemo(() => {
									const st = start();
									const segment = project.timeline?.segments[segmentIndex()];
									if (!segment) return 0;
									// The time within the actual video file
									return Math.max(0, st - segment.start);
								});

								const video = document.createElement("video");
								createEffect(() => {
									const path = convertFileSrc(
										// TODO: this shouldn't be so hardcoded
										`${
											editorInstance.path
										}/content/segments/segment-${segmentIndex()}/display.mp4`,
									);
									video.src = path;
									video.preload = "auto";
									// Force reload if video fails to load
									video.load();
								});

								createEffect(() => {
									const t = relativeTime();
									if (t === undefined) return;

									// Ensure video is ready before seeking
									if (video.readyState >= 2) {
										video.currentTime = t;
									} else {
										// Wait for video to be ready, then seek
										const handleCanPlay = () => {
											video.currentTime = t;
											video.removeEventListener("canplay", handleCanPlay);
										};
										video.addEventListener("canplay", handleCanPlay);
									}
								});

								createEffect(
									on(
										() => {
											croppedPosition();
											croppedSize();
										},
										() => {
											if (loaded()) {
												render();
											}
										},
									),
								);

								const render = () => {
									if (!canvasRef || video.readyState < 2) return;

									const ctx = canvasRef.getContext("2d");
									if (!ctx) return;

									ctx.imageSmoothingEnabled = false;
									// Clear canvas first
									ctx.clearRect(0, 0, canvasRef.width, canvasRef.height);
									// Draw video frame
									ctx.drawImage(
										video,
										croppedPosition().x,
										croppedPosition().y,
										croppedSize().x,
										croppedSize().y,
										0,
										0,
										canvasRef.width!,
										canvasRef.height!,
									);
								};

								const [loaded, setLoaded] = createSignal(false);
								video.onloadeddata = () => {
									setLoaded(true);
									render();
								};
								video.onseeked = render;

								// Add error handling
								video.onerror = (e) => {
									console.error("Failed to load video for zoom preview:", e);
									// Try to reload after a short delay
									setTimeout(() => {
										video.load();
									}, 100);
								};

								let canvasRef!: HTMLCanvasElement;

								const [ref, setRef] = createSignal<HTMLDivElement>();
								const bounds = createElementBounds(ref);
								const rawSize = () => {
									const raw = editorInstance.recordings.segments[0].display;
									return { x: raw.width, y: raw.height };
								};

								const croppedPosition = () => {
									const cropped = project.background.crop?.position;
									if (cropped) return cropped;

									return { x: 0, y: 0 };
								};

								const croppedSize = () => {
									const cropped = project.background.crop?.size;
									if (cropped) return cropped;

									return rawSize();
								};

								const visualHeight = () =>
									(bounds.width! / croppedSize().x) * croppedSize().y;

								return (
									<div
										ref={setRef}
										class="relative w-full"
										style={{
											height: `calc(${visualHeight()}px + 0.25rem)`,
										}}
										onMouseDown={(downEvent) => {
											const bounds =
												downEvent.currentTarget.getBoundingClientRect();

											createRoot((dispose) =>
												createEventListenerMap(window, {
													mouseup: () => dispose(),
													mousemove: (moveEvent) => {
														setProject(
															"timeline",
															"zoomSegments",
															props.segmentIndex,
															"mode",
															"manual",
															{
																x: Math.max(
																	Math.min(
																		(moveEvent.clientX - bounds.left) /
																			bounds.width,
																		1,
																	),
																	0,
																),
																y: Math.max(
																	Math.min(
																		(moveEvent.clientY - bounds.top) /
																			bounds.height,
																		1,
																	),
																	0,
																),
															},
														);
													},
												}),
											);
										}}
									>
										<div
											class="absolute z-10 w-6 h-6 rounded-full border border-gray-400 -translate-x-1/2 -translate-y-1/2 bg-gray-1"
											style={{
												left: `${mode().x * 100}%`,
												top: `${mode().y * 100}%`,
											}}
										>
											<div class="size-1.5 bg-gray-5 rounded-full" />
										</div>
										<div class="overflow-hidden relative rounded-lg border border-gray-3 bg-gray-2">
											<canvas
												ref={canvasRef}
												width={croppedSize().x}
												height={croppedSize().y}
												data-loaded={loaded()}
												class="z-10 bg-gray-3 opacity-0 transition-opacity data-[loaded='true']:opacity-100 w-full h-full duration-200"
											/>
											<Show when={!loaded()}>
												<div class="flex absolute inset-0 justify-center items-center bg-gray-2">
													<div class="text-sm text-gray-11">
														Loading preview...
													</div>
												</div>
											</Show>
										</div>
									</div>
								);
							}}
						</Show>
					</KTabs.Content>
				</KTabs>
			</Field>
		</>
	);
}

function ClipSegmentConfig(props: {
	segmentIndex: number;
	segment: TimelineSegment;
}) {
	const { setProject, setEditorState, project, projectActions, meta } =
		useEditorContext();

	// Get current clip configuration
	const clipConfig = () =>
		project.clips?.find((c) => c.index === props.segmentIndex);
	const offsets = () => clipConfig()?.offsets || {};

	function setOffset(type: keyof ClipOffsets, offset: number) {
		if (Number.isNaN(offset)) return;

		setProject(
			produce((proj) => {
				const clips = (proj.clips ??= []);
				let clip = clips.find(
					(clip) => clip.index === (props.segment.recordingSegment ?? 0),
				);
				if (!clip) {
					clip = { index: 0, offsets: {} };
					clips.push(clip);
				}

				clip.offsets[type] = offset / 1000;
			}),
		);
	}

	return (
		<>
			<div class="flex flex-row justify-between items-center">
				<div class="flex gap-2 items-center">
					<EditorButton
						onClick={() => setEditorState("timeline", "selection", null)}
						leftIcon={<IconLucideCheck />}
					>
						完成
					</EditorButton>
				</div>
				<EditorButton
					variant="danger"
					onClick={() => {
						projectActions.deleteClipSegment(props.segmentIndex);
					}}
					disabled={
						(
							project.timeline?.segments.filter(
								(s) => s.recordingSegment === props.segment.recordingSegment,
							) ?? []
						).length < 2
					}
					leftIcon={<IconCapTrash />}
				>
					Delete
				</EditorButton>
			</div>

			<div class="space-y-1">
				<h3 class="font-medium text-gray-12">片段设置</h3>
				<p class="text-gray-11">
					这些设置适用于当前片段的所有段
				</p>
			</div>

			{meta().hasSystemAudio && (
				<SourceOffsetField
					name="系统音频偏移"
					value={offsets().system_audio}
					onChange={(offset) => {
						setOffset("system_audio", offset);
					}}
				/>
			)}
			{meta().hasMicrophone && (
				<SourceOffsetField
					name="麦克风偏移"
					value={offsets().mic}
					onChange={(offset) => {
						setOffset("mic", offset);
					}}
				/>
			)}
			{meta().hasCamera && (
				<SourceOffsetField
					name="摄像头偏移"
					value={offsets().camera}
					onChange={(offset) => {
						setOffset("camera", offset);
					}}
				/>
			)}

			{/*<ComingSoonTooltip>
			<Field name="Hide Cursor" disabled value={<Toggle disabled />} />
		</ComingSoonTooltip>
		<ComingSoonTooltip>
			<Field
				name="Disable Smooth Cursor Movement"
				disabled
				value={<Toggle disabled />}
			/>
		</ComingSoonTooltip>*/}
		</>
	);
}

function SourceOffsetField(props: {
	name: string;
	// seconds
	value?: number;
	onChange: (value: number) => void;
}) {
	const rawValue = () => Math.round((props.value ?? 0) * 1000);

	const [value, setValue] = createSignal(rawValue().toString());

	return (
		<Field name={props.name}>
			<div class="flex flex-row justify-between items-center -mt-2 w-full">
				<div class="flex flex-row items-end space-x-1">
					<NumberField.Root
						value={value()}
						onChange={setValue}
						rawValue={rawValue()}
						onRawValueChange={(v) => {
							props.onChange(v);
						}}
					>
						<NumberField.Input
							onBlur={() => {
								if (!rawValue() || value() === "" || Number.isNaN(rawValue())) {
									setValue("0");
									props.onChange(0);
								}
							}}
							class="w-[5rem] p-[0.375rem] border rounded-[0.5rem] bg-gray-1 focus-visible:outline-none"
						/>
					</NumberField.Root>
					<span class="text-gray-11">ms</span>
				</div>
				<div class="flex flex-row space-x-1 text-gray-11">
					{[-100, -10, 10, 100].map((v) => (
						<button
							type="button"
							onClick={() => {
								const currentValue = rawValue() + v;
								props.onChange(currentValue);
								setValue(currentValue.toString());
							}}
							class="text-gray-11 hover:text-gray-12 text-xs px-1 py-0.5 bg-gray-1 border border-gray-3 rounded"
						>
							{Math.sign(v) > 0 ? "+" : "-"}
							{Math.abs(v)}ms
						</button>
					))}
				</div>
			</div>
		</Field>
	);
}

function SceneSegmentConfig(props: {
	segmentIndex: number;
	segment: SceneSegment;
}) {
	const { setProject, setEditorState, projectActions } = useEditorContext();

	return (
		<>
			<div class="flex flex-row justify-between items-center">
				<div class="flex gap-2 items-center">
					<EditorButton
						onClick={() => setEditorState("timeline", "selection", null)}
						leftIcon={<IconLucideCheck />}
					>
						完成
					</EditorButton>
				</div>
				<EditorButton
					variant="danger"
					onClick={() => {
						projectActions.deleteSceneSegment(props.segmentIndex);
					}}
					leftIcon={<IconCapTrash />}
				>
					删除
				</EditorButton>
			</div>
			<Field name="摄像头布局" icon={<IconLucideLayout />}>
				<KTabs
					class="space-y-6"
					value={props.segment.mode || "default"}
					onChange={(v) => {
						setProject(
							"timeline",
							"sceneSegments",
							props.segmentIndex,
							"mode",
							v as "default" | "cameraOnly" | "hideCamera",
						);
					}}
				>
					<KTabs.List class="flex flex-col gap-3">
						<div class="flex flex-row items-center rounded-[0.5rem] relative border">
							<KTabs.Trigger
								value="default"
								class="z-10 flex-1 py-2.5 text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12 peer"
							>
								默认
							</KTabs.Trigger>
							<KTabs.Trigger
								value="cameraOnly"
								class="z-10 flex-1 py-2.5 text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12 peer"
							>
								仅摄像头
							</KTabs.Trigger>
							<KTabs.Trigger
								value="hideCamera"
								class="z-10 flex-1 py-2.5 text-gray-11 transition-colors duration-100 outline-none ui-selected:text-gray-12 peer"
							>
								隐藏摄像头
							</KTabs.Trigger>
							<KTabs.Indicator class="absolute flex p-px inset-0 transition-transform peer-focus-visible:outline outline-2 outline-blue-9 outline-offset-2 rounded-[0.6rem] overflow-hidden">
								<div class="flex-1 bg-gray-3" />
							</KTabs.Indicator>
						</div>

						<div class="relative">
							<div
								class="absolute -top-3 w-px h-3 transition-all duration-200 bg-gray-3"
								style={{
									left:
										props.segment.mode === "cameraOnly"
											? "50%"
											: props.segment.mode === "hideCamera"
												? "83.33%"
												: "16.67%",
								}}
							/>
							<div
								class="absolute -top-1 w-2 h-2 rounded-full transition-all duration-200 -translate-x-1/2 bg-gray-3"
								style={{
									left:
										props.segment.mode === "cameraOnly"
											? "50%"
											: props.segment.mode === "hideCamera"
												? "83.33%"
												: "16.67%",
								}}
							/>
							<div class="p-2.5 rounded-md bg-gray-2 border border-gray-3">
								<div class="text-xs text-center text-gray-11">
									{props.segment.mode === "cameraOnly"
										? "仅显示摄像头画面"
										: props.segment.mode === "hideCamera"
											? "仅显示屏幕录制"
											: "同时显示屏幕和摄像头"}
								</div>
							</div>
						</div>
					</KTabs.List>
				</KTabs>
			</Field>
		</>
	);
}

function RgbInput(props: {
	value: [number, number, number];
	onChange: (value: [number, number, number]) => void;
}) {
	const [text, setText] = createWritableMemo(() => rgbToHex(props.value));
	let prevHex = rgbToHex(props.value);

	let colorInput!: HTMLInputElement;

	return (
		<div class="flex flex-row items-center gap-[0.75rem] relative">
			<button
				type="button"
				class="size-[2rem] rounded-[0.5rem]"
				style={{
					"background-color": rgbToHex(props.value),
				}}
				onClick={() => colorInput.click()}
			/>
			<input
				ref={colorInput}
				type="color"
				class="absolute left-0 bottom-0 w-[3rem] opacity-0"
				value={rgbToHex(props.value)}
				onChange={(e) => {
					const value = hexToRgb(e.target.value);
					if (!value) return;

					// RgbInput only handles RGB values, so extract RGB part if RGBA is returned
					const [r, g, b] = value;
					props.onChange([r, g, b]);
				}}
			/>
			<TextInput
				class="w-[4.60rem] p-[0.375rem] text-gray-12 text-[13px] border rounded-[0.5rem] bg-gray-1 outline-none focus:ring-1 transition-shadows duration-200 focus:ring-gray-500 focus:ring-offset-1 focus:ring-offset-gray-200"
				value={text()}
				onFocus={() => {
					prevHex = rgbToHex(props.value);
				}}
				onInput={(e) => {
					setText(e.currentTarget.value);

					const value = hexToRgb(e.target.value);
					if (!value) return;

					const [r, g, b] = value;
					props.onChange([r, g, b]);
				}}
				onBlur={(e) => {
					const value = hexToRgb(e.target.value);
					if (value) {
						const [r, g, b] = value;
						// RgbInput only handles RGB values, so extract RGB part if RGBA is returned
						props.onChange([r, g, b]);
					} else {
						setText(prevHex);
						const fallbackValue = hexToRgb(text());
						if (!fallbackValue) return;

						const [r, g, b] = fallbackValue;
						props.onChange([r, g, b]);
					}
				}}
			/>
		</div>
	);
}

function rgbToHex(rgb: [number, number, number]) {
	return `#${rgb
		.map((c) => c.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase()}`;
}

function hexToRgb(hex: string): [number, number, number, number] | null {
	// Support both 6-digit (RGB) and 8-digit (RGBA) hex colors
	const match = hex.match(
		/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})?$/i,
	);
	if (!match) return null;

	const [, r, g, b, a] = match;
	const rgb = [
		Number.parseInt(r, 16),
		Number.parseInt(g, 16),
		Number.parseInt(b, 16),
	] as const;

	// If alpha is provided, return RGBA tuple
	if (a) {
		return [...rgb, Number.parseInt(a, 16)];
	}

	return [...rgb, 255];
}

const CHECKERED_BUTTON_BACKGROUND = `url("data:image/svg+xml,%3Csvg width='16' height='16' xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='8' height='8' fill='%23a0a0a0'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23a0a0a0'/%3E%3C/svg%3E")`;
