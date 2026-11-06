import { createResource, Show } from "solid-js";
import { createStore } from "solid-js/store";

import { generalSettingsStore } from "~/store";
import { L } from "~/utils/i18n";
import type { GeneralSettingsStore } from "~/utils/tauri";
import { ToggleSettingItem } from "./Setting";

export default function ExperimentalSettings() {
	const [store] = createResource(() => generalSettingsStore.get());

	return (
		<Show when={store.state === "ready" && ([store()] as const)}>
			{(store) => <Inner initialStore={store()[0] ?? null} />}
		</Show>
	);
}

function Inner(props: { initialStore: GeneralSettingsStore | null }) {
	const [settings, setSettings] = createStore<GeneralSettingsStore>(
		props.initialStore ?? {
			uploadIndividualFiles: false,
			hideDockIcon: false,
			autoCreateShareableLink: false,
			enableNotifications: true,
			enableNativeCameraPreview: false,
			enableNewRecordingFlow: false,
			autoZoomOnClicks: false,
			custom_cursor_capture2: true,
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

	return (
		<div class="flex flex-col h-full custom-scroll">
			<div class="p-4 space-y-4">
				<div class="flex flex-col pb-4 border-b border-gray-2">
					<h2 class="text-lg font-medium text-gray-12">
						{L("实验性功能", "Experimental Features")}
					</h2>
					<p class="text-sm text-gray-10">
						{L(
							"这些功能仍在开发中，可能无法按预期工作。",
							"These features are still in development and may not work as expected.",
						)}
					</p>
				</div>
				<div class="space-y-3">
					<h3 class="text-sm text-gray-12 w-fit">
						{L("录制功能", "Recording Features")}
					</h3>
					<div class="px-3 rounded-xl border divide-y divide-gray-3 border-gray-3 bg-gray-2">
						<ToggleSettingItem
							label={L(
								"工作室模式自定义光标捕获",
								"Custom Cursor Capture in Studio Mode",
							)}
							description={L(
								"工作室模式录制将单独捕获光标状态，便于在编辑器中自定义（大小、平滑度）。目前仍处于实验阶段，光标事件可能无法准确捕获。",
								"Studio Mode recordings capture cursor state separately so you can customize it (size, smoothing) in the editor. This is experimental, and cursor events may not be captured accurately.",
							)}
							value={!!settings.custom_cursor_capture2}
							onChange={(value) =>
								handleChange("custom_cursor_capture2", value)
							}
						/>
						<ToggleSettingItem
							label={L("原生摄像头预览", "Native Camera Preview")}
							description={L(
								"使用原生 GPU 表面显示摄像头预览，而非在 webview 中渲染。在某些 Windows 系统上可能无法正常工作。",
								"Show the camera preview using a native GPU surface instead of rendering it in the webview. This may not work on some Windows systems.",
							)}
							value={!!settings.enableNativeCameraPreview}
							onChange={(value) =>
								handleChange("enableNativeCameraPreview", value)
							}
						/>
						<ToggleSettingItem
							label={L("点击自动缩放", "Auto Zoom on Clicks")}
							description={L(
								"在工作室模式录制过程中，自动在鼠标点击处生成缩放片段。这有助于突出显示录制中的重要交互。",
								"Automatically create zoom segments around mouse clicks during Studio Mode recordings. This helps highlight important interactions.",
							)}
							value={!!settings.autoZoomOnClicks}
							onChange={(value) => {
								handleChange("autoZoomOnClicks", value);
								// This is bad code, but I just want the UI to not jank and can't seem to find the issue.
								setTimeout(
									() => window.scrollTo({ top: 0, behavior: "instant" }),
									5,
								);
							}}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}
