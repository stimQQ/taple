import {
	For,
	Show,
	createEffect,
	createSignal,
	onCleanup,
	onMount,
} from "solid-js";
import { Store } from "@tauri-apps/plugin-store";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import IconLucideHistory from "~icons/lucide/history";
import IconLucidePencil from "~icons/lucide/pencil";
import IconLucidePlus from "~icons/lucide/plus";
import IconLucideTrash2 from "~icons/lucide/trash-2";
import IconLucideX from "~icons/lucide/x";
import IconPhPauseFill from "~icons/ph/pause-fill";
import IconPhPlayFill from "~icons/ph/play-fill";

type TeleprompterScript = {
	id: string;
	title: string;
	content: string;
	createdAt: number;
};

type TeleprompterData = {
	scripts: TeleprompterScript[];
	speed: 0.5 | 0.8 | 1;
};

const PIXELS_PER_SECOND: Record<number, number> = {
	0.5: 15,
	0.8: 25,
	1: 40,
};

export default function TeleprompterPage() {
	const [scripts, setScripts] = createSignal<TeleprompterScript[]>([]);
	const [currentContent, setCurrentContent] = createSignal("");
	const [speed, setSpeed] = createSignal<0.5 | 0.8 | 1>(0.5);
	const [isPlaying, setIsPlaying] = createSignal(false);
	const [mode, setMode] = createSignal<"view" | "edit" | "history">("view");

	let scrollRef: HTMLDivElement | undefined;
	let storeRef: Store | undefined;
	let rafId: number | undefined;
	let lastTimestamp: number | undefined;
	let scrollPosition = 0;
	let unlistenClose: (() => void) | undefined;

	const persistScripts = async (updatedScripts: TeleprompterScript[]) => {
		if (!storeRef) return;
		const data: TeleprompterData = {
			scripts: updatedScripts,
			speed: speed(),
		};
		await storeRef.set("data", data);
		await storeRef.save();
	};

	const persistSpeed = async (s: 1 | 1.5 | 2) => {
		if (!storeRef) return;
		const data: TeleprompterData = {
			scripts: scripts(),
			speed: s,
		};
		await storeRef.set("data", data);
		await storeRef.save();
	};

	const closeWindow = async () => {
		const win = getCurrentWindow();
		await win.destroy();
	};

	onMount(async () => {
		document.documentElement.setAttribute("data-transparent-window", "true");
		document.body.style.background = "transparent";

		storeRef = await Store.load("teleprompter_store");
		const data = await storeRef.get<TeleprompterData>("data");
		if (data) {
			setScripts(data.scripts ?? []);
			setSpeed(data.speed ?? 0.5);
		}

		try {
			const win = getCurrentWindow();
			await win.setResizable(true);
			await win.setSize(new LogicalSize(500, 300));
			await win.setResizable(false);
		} catch (_) {}
	});

	const scrollStep = (timestamp: number) => {
		if (!isPlaying()) return;
		if (lastTimestamp === undefined) {
			lastTimestamp = timestamp;
			rafId = requestAnimationFrame(scrollStep);
			return;
		}

		const elapsed = (timestamp - lastTimestamp) / 1000;
		lastTimestamp = timestamp;

		const pxPerSec = PIXELS_PER_SECOND[speed()] ?? 25;
		scrollPosition += pxPerSec * elapsed;

		if (scrollRef) {
			const maxScroll = scrollRef.scrollHeight - scrollRef.clientHeight;
			if (scrollPosition >= maxScroll) {
				scrollPosition = maxScroll;
				scrollRef.scrollTop = maxScroll;
				setIsPlaying(false);
				return;
			}
			scrollRef.scrollTop = scrollPosition;
		}

		rafId = requestAnimationFrame(scrollStep);
	};

	createEffect(() => {
		if (isPlaying()) {
			if (scrollRef) {
				scrollPosition = scrollRef.scrollTop;
			}
			lastTimestamp = undefined;
			rafId = requestAnimationFrame(scrollStep);
		} else {
			if (rafId !== undefined) {
				cancelAnimationFrame(rafId);
				rafId = undefined;
			}
		}
	});

	onCleanup(() => {
		if (rafId !== undefined) cancelAnimationFrame(rafId);
		if (unlistenClose) unlistenClose();
	});

	const resetScroll = () => {
		scrollPosition = 0;
		if (scrollRef) scrollRef.scrollTop = 0;
		setIsPlaying(false);
		lastTimestamp = undefined;
	};

	const finishEditing = async () => {
		const content = currentContent().trim();
		if (content) {
			const existing = scripts().find((s) => s.content === content);
			if (!existing) {
				const title = content.slice(0, 15);
				const newScript: TeleprompterScript = {
					id: Date.now().toString(),
					title,
					content,
					createdAt: Date.now(),
				};
				const updated = [newScript, ...scripts()];
				setScripts(updated);
				await persistScripts(updated);
			}
		}
		resetScroll();
		setMode("view");
	};

	const newScript = () => {
		setIsPlaying(false);
		resetScroll();
		setCurrentContent("");
		setMode("edit");
	};

	const loadScript = async (script: TeleprompterScript) => {
		resetScroll();
		setCurrentContent(script.content);
		setMode("view");
	};

	const deleteScript = async (id: string) => {
		const updated = scripts().filter((s) => s.id !== id);
		setScripts(updated);
		await persistScripts(updated);
	};

	return (
		<div
			class="relative flex flex-col h-screen overflow-hidden rounded-xl"
			style={{
				background: "rgba(10,10,10,0.7)",
				"backdrop-filter": "blur(24px)",
				border: "1px solid rgba(255,255,255,0.1)",
			}}
		>
			<div
				class="relative flex items-center px-3 shrink-0"
				data-tauri-drag-region
				style={{
					height: "40px",
					background: "rgba(10,10,10,0.88)",
					"border-bottom": "1px solid rgba(255,255,255,0.08)",
				}}
			>
				<button
					type="button"
					class="flex items-center gap-1.5 px-2 h-7 rounded text-[11px] transition-colors"
					style={{
						color: mode() === "history" ? "white" : "rgba(255,255,255,0.55)",
						background:
							mode() === "history" ? "rgba(255,255,255,0.15)" : "transparent",
					}}
					onClick={() => {
						setIsPlaying(false);
						setMode((m) => (m === "history" ? "view" : "history"));
					}}
				>
					<IconLucideHistory class="size-3.5" />
					历史
				</button>

				<button
					type="button"
					class="absolute flex items-center justify-center rounded-full transition-all shrink-0"
					style={{
						left: "50%",
						top: "50%",
						transform: "translate(-50%, -50%)",
						width: "28px",
						height: "28px",
						background: isPlaying()
							? "rgba(255,255,255,0.2)"
							: "rgba(255,255,255,0.1)",
						color: "white",
					}}
					onClick={() => setIsPlaying((p) => !p)}
				>
					<Show
						when={isPlaying()}
						fallback={<IconPhPlayFill class="size-3.5" style={{ "margin-left": "1px" }} />}
					>
						<IconPhPauseFill class="size-3.5" />
					</Show>
				</button>

				<div
					class="absolute flex items-center rounded overflow-hidden"
					style={{
						left: "calc(50% + 22px)",
						top: "50%",
						transform: "translateY(-50%)",
						background: "rgba(255,255,255,0.08)",
					}}
				>
					{([0.5, 0.8, 1] as const).map((s) => (
						<button
							type="button"
							class="h-6 rounded text-[11px] transition-colors"
							style={{
								padding: "0 8px",
								background:
									speed() === s ? "rgba(255,255,255,0.9)" : "transparent",
								color: speed() === s ? "#000" : "rgba(255,255,255,0.55)",
								"font-weight": speed() === s ? "600" : "400",
							}}
							onClick={() => {
								setSpeed(s);
								persistSpeed(s);
							}}
						>
							{s}x
						</button>
					))}
				</div>

				<div class="flex-1" />

				<button
					type="button"
					class="flex items-center gap-1.5 px-2 h-7 rounded text-[11px] transition-colors"
					style={{
						color: mode() === "edit" ? "white" : "rgba(255,255,255,0.55)",
						background:
							mode() === "edit" ? "rgba(255,255,255,0.15)" : "transparent",
					}}
					onClick={() => {
						setIsPlaying(false);
						setMode((m) => (m === "edit" ? "view" : "edit"));
					}}
				>
					<IconLucidePencil class="size-3.5" />
					编辑
				</button>

				<button
					type="button"
					class="flex items-center justify-center rounded-full transition-colors hover:bg-white/10 ml-1.5"
					style={{ width: "26px", height: "26px", color: "rgba(255,255,255,0.45)" }}
					onClick={closeWindow}
				>
					<IconLucideX class="size-3.5" />
				</button>
			</div>

			<div class="flex-1 overflow-hidden relative">
				<Show when={mode() === "history"}>
					<div
						class="absolute inset-0 z-10 flex flex-col overflow-hidden"
						style={{ background: "rgba(5,5,5,0.96)" }}
					>
						<div
							class="flex items-center justify-between px-3 shrink-0"
							style={{
								height: "36px",
								"border-bottom": "1px solid rgba(255,255,255,0.08)",
							}}
						>
							<span
								class="text-[11px] font-medium"
								style={{ color: "rgba(255,255,255,0.45)" }}
							>
								历史脚本
							</span>
							<button
								type="button"
								class="text-[11px] transition-colors hover:text-white"
								style={{ color: "rgba(255,255,255,0.35)" }}
								onClick={() => setMode("view")}
							>
								关闭
							</button>
						</div>
						<div class="flex-1 overflow-y-auto">
							<For
								each={scripts()}
								fallback={
									<div
										class="flex items-center justify-center h-full text-[12px]"
										style={{ color: "rgba(255,255,255,0.2)" }}
									>
										暂无历史脚本
									</div>
								}
							>
								{(script) => (
									<div
										class="flex items-center gap-2 group"
										style={{
											padding: "8px 12px",
											"border-bottom": "1px solid rgba(255,255,255,0.05)",
										}}
									>
										<button
											type="button"
											class="flex-1 text-left min-w-0"
											onClick={() => loadScript(script)}
										>
											<div
												class="text-[12px] font-medium truncate"
												style={{ color: "rgba(255,255,255,0.85)" }}
											>
												{script.title}
											</div>
											<div
												class="text-[11px] truncate mt-0.5"
												style={{ color: "rgba(255,255,255,0.3)" }}
											>
												{script.content.slice(0, 60)}
											</div>
										</button>
										<button
											type="button"
											class="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
											style={{ color: "rgba(220,80,80,0.8)" }}
											onClick={() => deleteScript(script.id)}
										>
											<IconLucideTrash2 class="size-3.5" />
										</button>
									</div>
								)}
							</For>
						</div>
					</div>
				</Show>

				<Show when={mode() === "edit"}>
					<div
						class="absolute inset-0 z-10 flex flex-col overflow-hidden p-3 gap-2"
						style={{ background: "rgba(5,5,5,0.96)" }}
					>
						<textarea
							class="flex-1 rounded p-3 text-[14px] resize-none outline-none"
							style={{
								background: "rgba(255,255,255,0.06)",
								border: "1px solid rgba(255,255,255,0.1)",
								color: "rgba(255,255,255,0.85)",
								"line-height": "3",
								"font-family": "inherit",
							}}
							placeholder="在此输入您的脚本..."
							value={currentContent()}
							onInput={(e) => setCurrentContent(e.currentTarget.value)}
						/>
						<button
							type="button"
							class="h-8 rounded text-[11px] font-medium transition-colors hover:opacity-90"
							style={{
								background: "rgba(255,255,255,0.9)",
								color: "#000",
							}}
							onClick={finishEditing}
						>
							完成
						</button>
					</div>
				</Show>

				<div class="absolute inset-0 overflow-hidden">
					<div
						ref={scrollRef}
						class="h-full px-8 py-4"
						style={{ "overflow-y": isPlaying() ? "hidden" : "auto" }}
					>
						<Show
							when={currentContent().trim()}
							fallback={
								<div
									class="h-full flex flex-col items-center justify-center gap-3"
								>
									<button
										type="button"
										class="flex items-center gap-1.5 px-4 h-9 rounded-lg text-[12px] transition-colors hover:opacity-80"
										style={{
											background: "rgba(255,255,255,0.1)",
											color: "rgba(255,255,255,0.7)",
										}}
										onClick={newScript}
									>
										<IconLucidePlus class="size-3.5" />
										新建脚本
									</button>
									<Show when={scripts().length > 0}>
										<button
											type="button"
											class="text-[11px] transition-colors hover:text-white"
											style={{ color: "rgba(255,255,255,0.3)" }}
											onClick={() => setMode("history")}
										>
											或从历史记录中选择
										</button>
									</Show>
								</div>
							}
						>
							<p
								class="text-white whitespace-pre-wrap text-center"
								style={{
									"font-size": "17px",
									"font-weight": "500",
									"line-height": "3",
									"padding-bottom": "60px",
								}}
							>
								{currentContent()}
							</p>
						</Show>
					</div>
				</div>
			</div>
		</div>
	);
}
