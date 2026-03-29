import { createResource, Show } from "solid-js";
import { createStore } from "solid-js/store";

import { generalSettingsStore } from "~/store";
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
						实验性功能
					</h2>
					<p class="text-sm text-gray-10">
						这些功能仍在开发中，可能无法按预期工作。
					</p>
				</div>
				<div class="space-y-3">
					<h3 class="text-sm text-gray-12 w-fit">录制功能</h3>
					<div class="px-3 rounded-xl border divide-y divide-gray-3 border-gray-3 bg-gray-2">
						<ToggleSettingItem
							label="工作室模式自定义光标捕获"
							description="工作室模式录制将单独捕获光标状态，便于在编辑器中自定义（大小、平滑度）。目前仍处于实验阶段，光标事件可能无法准确捕获。"
							value={!!settings.custom_cursor_capture2}
							onChange={(value) =>
								handleChange("custom_cursor_capture2", value)
							}
						/>
						<ToggleSettingItem
							label="原生摄像头预览"
							description="使用原生 GPU 表面显示摄像头预览，而非在 webview 中渲染。在某些 Windows 系统上可能无法正常工作。"
							value={!!settings.enableNativeCameraPreview}
							onChange={(value) =>
								handleChange("enableNativeCameraPreview", value)
							}
						/>
						<ToggleSettingItem
							label="点击自动缩放"
							description="在工作室模式录制过程中，自动在鼠标点击处生成缩放片段。这有助于突出显示录制中的重要交互。"
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
