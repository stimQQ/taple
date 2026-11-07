import { A, type RouteSectionProps, useNavigate } from "@solidjs/router";
import { getVersion } from "@tauri-apps/api/app";
import {
	getAllWebviewWindows,
	WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { primaryMonitor } from "@tauri-apps/api/window";
import "@total-typescript/ts-reset/filter-boolean";
import { createResource, For, Show, Suspense } from "solid-js";
import { CapErrorBoundary } from "~/components/CapErrorBoundary";
import { createTauriEventListener } from "~/utils/createEventListener";
import { L } from "~/utils/i18n";
import { events } from "~/utils/tauri";

const SUPPORT_PAGES = () => [
	{
		href: "feedback",
		name: L("反馈问题", "Send Feedback"),
		icon: IconLucideMessageSquarePlus,
	},
	{
		href: "changelog",
		name: L("更新日志", "Changelog"),
		icon: IconLucideBell,
	},
];

export default function Settings(props: RouteSectionProps) {
	const [version] = createResource(() => getVersion());
	const navigate = useNavigate();

	createTauriEventListener(events.navigateSettings, (payload) =>
		navigate(`/settings/${payload.page}`),
	);

	return (
		<div class="flex-1 flex flex-row divide-x divide-gray-3 text-[0.875rem] leading-[1.25rem] overflow-y-hidden">
			<div class="flex flex-col h-full bg-gray-2">
				<ul class="min-w-[8rem] h-full p-[0.625rem] space-y-1 text-gray-12 whitespace-nowrap">
					<For
						each={[
							{
								href: "recordings",
								name: L("历史录制", "Recordings"),
								icon: IconLucideSquarePlay,
							},
							{
								href: "ai",
								name: L("AI 剪辑", "AI Edit"),
								icon: IconLucideSparkles,
							},
							{
								href: "general",
								name: L("通用设置", "General"),
								icon: IconCapSettings,
							},
							{
								href: "hotkeys",
								name: L("快捷键", "Shortcuts"),
								icon: IconCapHotkeys,
							},
						].filter(Boolean)}
					>
						{(item) => (
							<li>
								<A
									href={item.href}
									activeClass="bg-gray-5 pointer-events-none"
									class="rounded-lg h-[2rem] hover:bg-gray-3 text-[13px] px-2 flex flex-row items-center gap-[0.375rem] transition-colors"
								>
									<item.icon class="opacity-60 size-4" />
									<span>{item.name}</span>
								</A>
							</li>
						)}
					</For>
					<For each={SUPPORT_PAGES()}>
						{(item) => (
							<li>
								<A
									href={item.href}
									activeClass="bg-gray-5 pointer-events-none"
									class="rounded-lg h-[2rem] hover:bg-gray-3 text-[13px] px-2 flex flex-row items-center gap-[0.375rem] transition-colors"
								>
									<item.icon class="opacity-60 size-4" />
									<span>{item.name}</span>
								</A>
							</li>
						)}
					</For>
				</ul>
				<div class="p-[0.625rem] text-left flex flex-col">
					<Show when={version()}>
						{(v) => <p class="mb-2 text-xs text-gray-11">v{v()}</p>}
					</Show>
					<button
						type="button"
						onClick={async () => {
							const wins = await getAllWebviewWindows();
							const existing = wins.find((w) => w.label === "teleprompter");
							if (existing) {
								await existing.close();
								await new Promise((r) => setTimeout(r, 200));
							}

							const monitor = await primaryMonitor();
							const scaleFactor = monitor?.scaleFactor ?? 1;
							const monitorLogicalWidth =
								(monitor?.size.width ?? 1920) / scaleFactor;
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
								title: L("提词器", "Teleprompter"),
								skipTaskbar: true,
							});
						}}
						class="rounded-lg h-[2rem] hover:bg-gray-3 text-[13px] px-2 flex flex-row items-center gap-[0.375rem] transition-colors text-gray-12"
					>
						<IconLucideScrollText class="opacity-60 size-4" />
						<span>{L("提词器", "Teleprompter")}</span>
					</button>
					{import.meta.env.DEV && (
						<button
							type="button"
							onClick={() => new WebviewWindow("debug", { url: "/debug" })}
							class="rounded-lg h-[2rem] hover:bg-gray-3 text-[13px] px-2 flex flex-row items-center gap-[0.375rem] transition-colors text-gray-12"
						>
							<IconLucideBug class="opacity-60 size-4" />
							<span>Debug</span>
						</button>
					)}
				</div>
			</div>
			<div class="overflow-y-hidden flex-1 animate-in">
				<CapErrorBoundary>
					<Suspense>{props.children}</Suspense>
				</CapErrorBoundary>
			</div>
		</div>
	);
}
