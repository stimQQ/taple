import { Button } from "@cap/ui-solid";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createEventListener } from "@solid-primitives/event-listener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import * as shell from "@tauri-apps/plugin-shell";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
	For,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import toast from "solid-toast";
import { aiSettingsStore } from "~/store";
import {
	assistantText,
	createEditRun,
	type EditRun,
	isAssistantMessage,
	MAX_TOOL_CALLS,
} from "~/utils/ai/agent";
import {
	formatCost,
	providerInfo,
	resolveModel,
	resolveVisionHelperModel,
} from "~/utils/ai/providers";
import { getApiKey, resolveAISettings, saveApiKey } from "~/utils/ai/settings";
import { createEditorTools, EDIT_TOOL_NAMES } from "~/utils/ai/tools";
import { assessTranscript } from "~/utils/ai/transcript-check";
import {
	downloadDefaultWhisperModel,
	findDownloadedWhisperModel,
	transcribeRecording,
} from "~/utils/ai/video-context";
import { createVisionHelper } from "~/utils/ai/vision";
import { L } from "~/utils/i18n";
import {
	type CaptionSettings,
	commands,
	type ProjectConfiguration,
} from "~/utils/tauri";
import { formatVolumeDb } from "./audioEnhancement";
import { MODEL_FOLDER, MODEL_OPTIONS } from "./CaptionsTab";
import { HIDDEN_CAPTION_SETTINGS } from "./captionDefaults";
import { useEditorContext } from "./context";
import { analyzeRecording, startScreenAnalysis } from "./editAnalysis";

export const [aiPanelOpen, setAIPanelOpen] = createSignal(false);
export const [aiRunBusy, setAIRunBusy] = createSignal(false);

type ToolStep = {
	id: string;
	kind: "tool";
	name: string;
	label: string;
	status: "running" | "done" | "error";
	error?: string;
};

type TextStep = { id: string; kind: "text"; text: string };

type Step = ToolStep | TextStep;

type RunStatus =
	| "idle"
	| "preparing"
	| "running"
	| "done"
	| "error"
	| "stopped";

type KeyState =
	| { state: "saved" }
	| { state: "missing" }
	| { state: "error"; message: string };

const PRESETS = [
	{
		label: L("剪掉停顿和口误", "Tighten pauses and mistakes"),
		prompt: L(
			"把这段录屏剪紧凑：去掉长停顿、空白、说错重来的部分、重复和口头禅。保持每句话完整，保留所有操作步骤。",
			"Tighten this recording: remove long pauses, dead air, false starts, repeated takes and filler words. Keep every sentence intact and keep all the steps.",
		),
	},
	{
		label: L("在点击处放大", "Zoom in on clicks"),
		prompt: L(
			"在我点击的地方，凡是观众需要看清小控件或细节的位置，添加放大效果。不要剪掉任何内容。",
			"Add zooms around my clicks wherever the viewer needs to see small UI details. Don't cut anything.",
		),
	},
	{
		label: L("做成 60 秒精华版", "Make a 60-second highlight"),
		prompt: L(
			"做一个大约 60 秒的精华版：保留最重要的步骤和关键的话，其余都剪掉，等待和打字的部分加速。",
			"Make a highlight version about 60 seconds long: keep the most important steps and key sentences, cut everything else, and speed up waiting and typing.",
		),
	},
];

function issueMessage(issue: KeyState): string | undefined {
	return issue.state === "error" ? issue.message : undefined;
}

function asTextStep(step: Step): TextStep | undefined {
	return step.kind === "text" ? step : undefined;
}

function asToolStep(step: Step): ToolStep | undefined {
	return step.kind === "tool" ? step : undefined;
}

function numberArg(args: unknown, key: string): number | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function stringArg(args: unknown, key: string): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayLength(args: unknown, key: string): number {
	if (typeof args !== "object" || args === null) return 0;
	const value = (args as Record<string, unknown>)[key];
	return Array.isArray(value) ? value.length : 0;
}

function describeToolCall(name: string, args: unknown): string {
	const start = numberArg(args, "start");
	const end = numberArg(args, "end");
	const seconds =
		start !== undefined && end !== undefined
			? Math.max(0, end - start).toFixed(1)
			: "?";
	const reason = stringArg(args, "reason");
	const withReason = (label: string) =>
		reason ? `${label} · ${reason}` : label;
	switch (name) {
		case "get_overview":
			return L("查看项目概况", "Reviewing the project");
		case "get_transcript":
			return L("阅读讲解文字稿", "Reading the transcript");
		case "get_activity":
			return L("分析点击和停顿", "Checking clicks and pauses");
		case "view_frames": {
			const count = arrayLength(args, "times");
			return L(`查看 ${count} 帧画面`, `Looking at ${count} frame(s)`);
		}
		case "cut_range":
			return withReason(L(`剪掉 ${seconds} 秒`, `Cut ${seconds}s`));
		case "set_speed": {
			const speed = numberArg(args, "speed") ?? 1;
			return withReason(
				speed === 1
					? L(`${seconds} 秒恢复原速`, `Restore ${seconds}s to normal speed`)
					: L(
							`${seconds} 秒加速到 ${speed}x`,
							`Speed up ${seconds}s to ${speed}x`,
						),
			);
		}
		case "add_zoom": {
			const amount = (numberArg(args, "amount") ?? 1.8).toFixed(1);
			return withReason(L(`添加 ${amount}x 放大`, `Add a ${amount}x zoom`));
		}
		case "remove_zoom":
			return L(
				`删除缩放 #${numberArg(args, "index") ?? "?"}`,
				`Remove zoom #${numberArg(args, "index") ?? "?"}`,
			);
		case "set_captions":
			return L("调整字幕", "Update captions");
		case "tighten_pauses":
			return withReason(L("收紧所有停顿", "Tighten all pauses"));
		case "mute_range":
			return withReason(L(`静音 ${seconds} 秒`, `Mute ${seconds}s`));
		case "get_storyboard":
			return L("查看画面变化时间线", "Reading the screen timeline");
		case "review_edit":
			return L("检查剪辑结果", "Reviewing the edit");
		default:
			return name;
	}
}

function toolResultText(result: unknown): string {
	if (typeof result !== "object" || result === null) return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) =>
			typeof c === "object" &&
			c !== null &&
			(c as { type?: unknown }).type === "text"
				? String((c as { text?: unknown }).text ?? "")
				: "",
		)
		.join("\n")
		.trim();
}

export function AIEditPanel() {
	const {
		project,
		setProject,
		projectHistory,
		editorInstance,
		editorState,
		setEditorState,
		totalDuration,
		micWaveforms,
		systemAudioWaveforms,
		meta,
		audioEnhancement,
	} = useEditorContext();

	const settingsQuery = aiSettingsStore.createQuery();
	const settings = createMemo(() => resolveAISettings(settingsQuery.data));
	const model = createMemo(() =>
		resolveModel(settings().provider, settings().modelId),
	);

	const [keyState, { refetch: refetchKey, mutate: setKeyState }] =
		createResource(
			() =>
				aiPanelOpen() && settingsQuery.isSuccess
					? { provider: settings().provider, stamp: settings().keysUpdatedAt }
					: false,
			(source): Promise<KeyState> =>
				getApiKey(source.provider, source.stamp)
					.then(
						(key): KeyState =>
							key ? { state: "saved" } : { state: "missing" },
					)
					.catch(
						(error): KeyState => ({ state: "error", message: String(error) }),
					),
		);
	const keyIssue = () => {
		const value = keyState();
		return value && value.state !== "saved" ? value : undefined;
	};

	const hasAudio = () =>
		editorInstance.recordings.segments.some(
			(s) => s.mic !== null || s.system_audio !== null,
		);
	const hasTranscript = () => (project.captions?.segments.length ?? 0) > 0;
	const transcriptUnreliable = createMemo(
		() =>
			hasTranscript() &&
			!assessTranscript(project.captions?.segments ?? []).reliable,
	);

	const [whisperModel, { refetch: refetchWhisper }] = createResource(
		() => aiPanelOpen() && hasAudio() && !hasTranscript(),
		() =>
			findDownloadedWhisperModel(
				MODEL_FOLDER,
				MODEL_OPTIONS.map((m) => m.name),
			).catch(() => null),
	);

	const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload }) => {
		if (!payload || !aiPanelOpen()) return;
		settingsQuery.refetch();
		refetchKey();
		refetchWhisper();
	});
	onCleanup(() => {
		unlistenFocus.then((unlisten) => unlisten());
	});

	const [prompt, setPrompt] = createSignal("");
	const [presetFilled, setPresetFilled] = createSignal<number | null>(null);
	let promptInput: HTMLTextAreaElement | undefined;
	const applyPreset = (index: number) => {
		setPrompt(PRESETS[index].prompt);
		setPresetFilled(index);
		requestAnimationFrame(() => {
			if (!promptInput) return;
			promptInput.focus();
			const end = promptInput.value.length;
			promptInput.setSelectionRange(end, end);
		});
	};
	const [run, setRun] = createStore({
		status: "idle" as RunStatus,
		phase: "",
		steps: [] as Step[],
		cost: 0,
		helperCost: 0,
		summary: "",
		error: "",
		undoAvailable: false,
	});

	let activeRun: EditRun | null = null;
	let resumeHistory: (() => void) | null = null;
	let stopRequested = false;
	let beforeSnapshot: ProjectConfiguration | null = null;
	let afterJson: string | null = null;
	let textStepCounter = 0;
	let currentTextStep: string | null = null;
	let lastAssistant: AssistantMessage | null = null;

	const busy = () => run.status === "preparing" || run.status === "running";
	createEffect(() => setAIRunBusy(busy()));

	createEventListener(
		window,
		"keydown",
		(e) => {
			if (!busy()) return;
			if (!(e.metaKey || e.ctrlKey)) return;
			if (e.code !== "KeyZ" && e.code !== "KeyY") return;
			e.preventDefault();
			e.stopImmediatePropagation();
		},
		{ capture: true },
	);

	onCleanup(() => {
		setAIRunBusy(false);
		stopRequested = true;
		activeRun?.abort();
		resumeHistory?.();
		resumeHistory = null;
	});

	const pushStep = (step: Step) => setRun("steps", (steps) => [...steps, step]);

	const updateStep = (
		id: string,
		patch: Partial<ToolStep> & Partial<TextStep>,
	) =>
		setRun(
			"steps",
			(s) => s.id === id,
			produce((step) => Object.assign(step, patch)),
		);

	const handleEvent = (event: AgentEvent) => {
		switch (event.type) {
			case "message_start": {
				if (!isAssistantMessage(event.message)) return;
				currentTextStep = `text-${textStepCounter++}`;
				pushStep({ id: currentTextStep, kind: "text", text: "" });
				return;
			}
			case "message_update": {
				if (!currentTextStep || !isAssistantMessage(event.message)) return;
				updateStep(currentTextStep, { text: assistantText(event.message) });
				return;
			}
			case "message_end": {
				if (!isAssistantMessage(event.message)) return;
				const message = event.message;
				lastAssistant = message;
				setRun("cost", (c) => c + (message.usage?.cost?.total ?? 0));
				const id = currentTextStep;
				currentTextStep = null;
				if (!id) return;
				const textValue = assistantText(message);
				if (textValue) updateStep(id, { text: textValue });
				else setRun("steps", (steps) => steps.filter((s) => s.id !== id));
				return;
			}
			case "tool_execution_start": {
				pushStep({
					id: event.toolCallId,
					kind: "tool",
					name: event.toolName,
					label: describeToolCall(event.toolName, event.args),
					status: "running",
				});
				return;
			}
			case "tool_execution_end": {
				updateStep(event.toolCallId, {
					status: event.isError ? "error" : "done",
					error: event.isError ? toolResultText(event.result) : undefined,
				});
				if (!event.isError && EDIT_TOOL_NAMES.has(event.toolName)) {
					setEditorState("timeline", "selection", null);
				}
				return;
			}
			default:
				return;
		}
	};

	const onEdited = () => {
		setEditorState("timeline", "selection", null);
		const duration = totalDuration();
		if (editorState.playbackTime > duration) {
			setEditorState("playbackTime", Math.max(0, duration));
		}
	};

	const openAISettings = () =>
		commands.showWindow({ Settings: { page: "ai" } });

	const openAgentSettings = () =>
		commands.showWindow({ Settings: { page: "ai#agents" } });

	const [keyInput, setKeyInput] = createSignal("");
	const [savingKey, setSavingKey] = createSignal(false);
	const saveInlineKey = async () => {
		const value = keyInput().trim();
		if (!value || savingKey()) return;
		setSavingKey(true);
		try {
			await saveApiKey(settings().provider, value);
			setKeyInput("");
			setKeyState({ state: "saved" });
			await settingsQuery.refetch();
			toast.success(L("API 密钥已保存到钥匙串", "API key saved to Keychain"));
		} catch (error) {
			toast.error(
				L("保存 API 密钥失败：", "Failed to save the API key: ") +
					(typeof error === "string" ? error : String(error)),
			);
		} finally {
			setSavingKey(false);
		}
	};

	const prepareAudio = async () => {
		if (!meta().hasMicrophone) return;
		setRun("phase", L("正在优化声音…", "Preparing the audio…"));
		try {
			const outcome = await audioEnhancement.prepare();
			if (outcome.denoise === "done")
				pushStep({
					id: "denoise",
					kind: "tool",
					name: "denoise",
					label: L("已降噪", "Reduced background noise"),
					status: "done",
				});
			if (typeof outcome.level === "object")
				pushStep({
					id: "level",
					kind: "tool",
					name: "level",
					label: L(
						`已把人声调到标准音量（麦克风 ${formatVolumeDb(outcome.level.volumeDb)}）`,
						`Set the voice to standard loudness (microphone ${formatVolumeDb(outcome.level.volumeDb)})`,
					),
					status: "done",
				});
			if (outcome.errors.length > 0)
				pushStep({
					id: "audio-error",
					kind: "tool",
					name: "audio",
					label: L(
						"声音优化失败，继续剪辑",
						"Audio cleanup failed; continuing",
					),
					status: "error",
					error: outcome.errors.join("; "),
				});
		} catch (error) {
			pushStep({
				id: "audio-error",
				kind: "tool",
				name: "audio",
				label: L("声音优化失败，继续剪辑", "Audio cleanup failed; continuing"),
				status: "error",
				error: String(error),
			});
		}
	};

	const ensureTranscript = async (): Promise<string> => {
		if (hasTranscript()) return "";
		if (!hasAudio())
			return "The recording has no audio, so there is no transcript.";
		let found = await findDownloadedWhisperModel(
			MODEL_FOLDER,
			MODEL_OPTIONS.map((m) => m.name),
		);
		if (!found) {
			const downloadPhase = (percent: number) =>
				L(
					`正在下载语音模型（约 466 MB，只需下载一次）… ${Math.round(percent)}%`,
					`Downloading the speech model (about 466 MB, only once)… ${Math.round(percent)}%`,
				);
			setRun("phase", downloadPhase(0));
			try {
				found = await downloadDefaultWhisperModel(MODEL_FOLDER, (percent) =>
					setRun("phase", downloadPhase(percent)),
				);
				refetchWhisper();
			} catch (error) {
				pushStep({
					id: "transcribed",
					kind: "tool",
					name: "transcribe",
					label: L(
						"语音模型下载失败，将不使用文字稿",
						"Could not download the speech model; continuing without a transcript",
					),
					status: "error",
					error: String(error),
				});
				return "The speech model could not be downloaded, so there is no transcript. Rely on pauses, clicks and frames and cut conservatively.";
			}
		}
		setRun(
			"phase",
			L(
				"正在本地转录音频，录制较长时需要一点时间…",
				"Transcribing the audio on this Mac. Long recordings take a while…",
			),
		);
		try {
			const segments = await transcribeRecording(editorInstance.path, found);
			if (segments.length === 0) return "Transcription found no speech.";
			setProject(
				produce((p) => {
					if (p.captions) p.captions.segments = segments;
					else
						p.captions = {
							segments,
							settings: { ...HIDDEN_CAPTION_SETTINGS },
						};
				}),
			);
			pushStep({
				id: "transcribed",
				kind: "tool",
				name: "transcribe",
				label: L(
					`已生成文字稿（${segments.length} 句）`,
					`Transcribed the audio (${segments.length} lines)`,
				),
				status: "done",
			});
			return "";
		} catch (error) {
			pushStep({
				id: "transcribed",
				kind: "tool",
				name: "transcribe",
				label: L(
					"转录失败，将不使用文字稿",
					"Transcription failed; continuing without it",
				),
				status: "error",
				error: String(error),
			});
			return "Automatic transcription failed, so there is no transcript. Rely on pauses, clicks and frames and cut conservatively.";
		}
	};

	const startRun = async () => {
		const instruction = prompt().trim();
		const selectedModel = model();
		if (!instruction || busy() || !selectedModel) return;

		let apiKey: string | null = null;
		try {
			apiKey = await getApiKey(settings().provider, settings().keysUpdatedAt);
		} catch (error) {
			setKeyState({ state: "error", message: String(error) });
			return;
		}
		if (!apiKey) {
			setKeyState({ state: "missing" });
			return;
		}
		setKeyState({ state: "saved" });
		const helperModel =
			resolveVisionHelperModel(settings().provider) ?? selectedModel;

		stopRequested = false;
		lastAssistant = null;
		currentTextStep = null;
		afterJson = null;
		beforeSnapshot = null;
		setRun({
			status: "preparing",
			phase: L("正在分析录制内容…", "Analyzing the recording…"),
			steps: [],
			cost: 0,
			helperCost: 0,
			summary: "",
			error: "",
			undoAvailable: false,
		});

		if (editorState.playing) {
			await commands.stopPlayback().catch(() => undefined);
			setEditorState("playing", false);
		}

		try {
			const screen = startScreenAnalysis(editorInstance.path);
			await prepareAudio();
			if (stopRequested) {
				setRun({ status: "stopped", phase: "" });
				return;
			}
			const transcriptHint = await ensureTranscript();
			if (stopRequested) {
				setRun({ status: "stopped", phase: "" });
				return;
			}
			setRun("phase", L("正在分析录制内容…", "Analyzing the recording…"));

			const analysis = await analyzeRecording({
				editorInstance,
				meta: meta(),
				timelineSegments: project.timeline?.segments,
				micWaveforms: async () =>
					micWaveforms.state === "ready"
						? (micWaveforms() ?? [])
						: commands.getMicWaveforms().catch(() => []),
				systemWaveforms: async () =>
					systemAudioWaveforms.state === "ready"
						? (systemAudioWaveforms() ?? [])
						: commands.getSystemAudioWaveforms().catch(() => []),
				screen,
				onPhase: (phase) => setRun("phase", phase),
			});
			if (stopRequested) {
				setRun({ status: "stopped", phase: "" });
				return;
			}

			const toolkit = createEditorTools({
				...analysis,
				project,
				setProject,
				onEdited,
				projectPath: editorInstance.path,
				transcriptHint,
				vision: createVisionHelper(helperModel, apiKey),
				onHelperCost: (cost) => setRun("helperCost", (c) => c + cost),
			});

			beforeSnapshot = structuredClone(unwrap(project));
			resumeHistory = projectHistory.pause();

			activeRun = createEditRun({
				model: selectedModel,
				apiKey,
				tools: toolkit.tools,
				onEvent: handleEvent,
			});
			setRun({ status: "running", phase: "" });
			await activeRun.start(instruction, toolkit.overview());

			const final = lastAssistant as AssistantMessage | null;
			if (stopRequested || final?.stopReason === "aborted") {
				setRun("status", "stopped");
			} else if (final?.stopReason === "error") {
				setRun({
					status: "error",
					error:
						final.errorMessage ??
						activeRun.agent.state.errorMessage ??
						L("请求失败", "The request failed"),
				});
			} else {
				const summary = final ? assistantText(final) : "";
				setRun({ status: "done", summary });
				if (summary) {
					setRun("steps", (steps) => {
						const last = steps[steps.length - 1];
						return last?.kind === "text" && last.text === summary
							? steps.slice(0, -1)
							: steps;
					});
				}
				if (activeRun.toolCallCount() > MAX_TOOL_CALLS) {
					setRun(
						"error",
						L(
							"已达到单次运行的工具调用上限，剪辑可能没有全部完成。",
							"The run hit its tool call limit, so the edit may be incomplete.",
						),
					);
				}
			}
		} catch (error) {
			setRun({
				status: stopRequested ? "stopped" : "error",
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			resumeHistory?.();
			resumeHistory = null;
			activeRun = null;
			setRun("phase", "");
			if (beforeSnapshot) {
				const current = JSON.stringify(unwrap(project));
				const changed = current !== JSON.stringify(beforeSnapshot);
				afterJson = changed ? current : null;
				setRun("undoAvailable", changed);
			}
		}
	};

	const stopRun = () => {
		stopRequested = true;
		activeRun?.abort();
	};

	const undoAIEdits = async () => {
		const before = beforeSnapshot;
		if (!before) return;
		const current = JSON.stringify(unwrap(project));
		if (current === JSON.stringify(before)) {
			setRun("undoAvailable", false);
			return;
		}
		if (current === afterJson && projectHistory.canUndo()) {
			projectHistory.undo();
		} else {
			const confirmed = await ask(
				L(
					"AI 剪辑之后你又做了修改。撤销 AI 剪辑会把项目恢复到 AI 开始前的状态，之后的修改也会一起撤销。要继续吗？",
					"You changed the project after the AI edit. Undoing restores the project to how it was before the AI started, including your later changes. Continue?",
				),
			);
			if (!confirmed) return;
			setProject(reconcile(structuredClone(before)));
		}
		onEdited();
		setRun("undoAvailable", false);
	};

	const providerName = () => providerInfo(settings().provider).name;

	return (
		<div
			class={cx(
				"flex flex-col flex-1 min-h-0 overflow-hidden",
				!aiPanelOpen() && "hidden",
			)}
		>
			<div class="flex flex-row gap-2 items-center px-4 h-9 border-b border-gray-3 shrink-0">
				<Show when={model()}>
					{(m) => (
						<span class="min-w-0 text-xs truncate text-gray-11">
							{providerName()} · {m().name}
						</span>
					)}
				</Show>
				<button
					type="button"
					class="flex gap-1 items-center px-2 ml-auto h-6 text-xs whitespace-nowrap rounded-md transition-colors shrink-0 text-blue-11 hover:bg-gray-3"
					onClick={openAgentSettings}
					title={L(
						"连接 Claude Code、Codex，用你自己的订阅剪辑，免 API 费用",
						"Connect Claude Code or Codex and edit with your own subscription, no API cost",
					)}
				>
					<IconLucidePlug class="size-3.5" />
					{L("一键连接", "Connect")}
				</button>
				<button
					type="button"
					class="flex justify-center items-center rounded-md transition-colors size-6 shrink-0 text-gray-11 hover:bg-gray-3 hover:text-gray-12"
					onClick={openAISettings}
					title={L("AI 设置", "AI settings")}
				>
					<IconCapSettings class="size-3.5" />
				</button>
			</div>

			<div class="flex overflow-y-auto flex-col flex-1 gap-4 p-4 min-h-0 text-sm custom-scroll">
				<Switch>
					<Match when={keyState.loading && keyState() === undefined}>
						<div class="flex gap-2 items-center text-xs text-gray-11">
							<IconLucideLoaderCircle class="animate-spin size-3.5" />
							{L("正在读取钥匙串…", "Reading Keychain…")}
						</div>
					</Match>
					<Match when={keyIssue()}>
						{(issue) => (
							<div class="flex flex-col gap-3 p-4 rounded-xl border border-gray-3 bg-gray-2 dark:bg-gray-3">
								<div class="flex gap-2 items-center font-medium text-gray-12">
									<IconLucideKeyRound class="size-4" />
									{issue().state === "error"
										? L("重新填写 API 密钥", "Enter your API key again")
										: L(
												`添加 ${providerName()} API 密钥`,
												`Add your ${providerName()} API key`,
											)}
								</div>
								<p class="text-xs leading-relaxed text-gray-11">
									{issue().state === "error"
										? L(
												`读不到之前保存的 ${providerName()} 密钥，重新粘贴一次就能替换。`,
												`The saved ${providerName()} key couldn't be read. Paste it again to replace it.`,
											)
										: L(
												`粘贴 ${providerName()} 的 API 密钥就能开始 AI 剪辑。密钥只保存在本机钥匙串里。`,
												`Paste your ${providerName()} API key to start editing with AI. The key stays in this Mac's Keychain.`,
											)}
								</p>
								<input
									type="password"
									autocomplete="off"
									spellcheck={false}
									class="w-full h-9 px-3 text-sm rounded-lg border outline-none transition-colors border-gray-4 bg-gray-1 text-gray-12 placeholder:text-gray-9 focus:border-blue-9"
									placeholder={providerInfo(settings().provider).keyPlaceholder}
									value={keyInput()}
									onInput={(e) => setKeyInput(e.currentTarget.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") void saveInlineKey();
									}}
								/>
								<div class="flex flex-row flex-wrap gap-2 items-center">
									<Button
										variant="dark"
										size="sm"
										class="whitespace-nowrap"
										disabled={!keyInput().trim() || savingKey()}
										onClick={saveInlineKey}
									>
										{savingKey()
											? L("正在保存…", "Saving…")
											: L("保存密钥", "Save key")}
									</Button>
									<button
										type="button"
										class="flex flex-row gap-1 items-center ml-auto text-xs whitespace-nowrap text-blue-11 hover:underline"
										onClick={() =>
											shell.open(providerInfo(settings().provider).keyUrl)
										}
									>
										{providerInfo(settings().provider).keyLinkLabel}
										<IconLucideArrowUpRight class="size-3" />
									</button>
								</div>
								<Show when={issueMessage(issue())}>
									{(message) => (
										<p class="text-[11px] leading-snug text-gray-10 break-all">
											{message()}
										</p>
									)}
								</Show>
								<div class="flex flex-row flex-wrap gap-3 text-xs text-gray-11">
									<button
										type="button"
										class="hover:text-gray-12 hover:underline"
										onClick={openAISettings}
									>
										{L("换用其他模型服务", "Use another provider")}
									</button>
									<button
										type="button"
										class="hover:text-gray-12 hover:underline"
										onClick={openAgentSettings}
									>
										{L(
											"改用 Claude Code / Codex 剪辑（免 API 费用）",
											"Edit with Claude Code or Codex (no API cost)",
										)}
									</button>
									<Show when={issue().state === "error"}>
										<button
											type="button"
											class="hover:text-gray-12 hover:underline"
											onClick={() => refetchKey()}
										>
											{L("重新读取", "Try reading again")}
										</button>
									</Show>
								</div>
							</div>
						)}
					</Match>
				</Switch>

				<Show when={transcriptUnreliable() && run.status === "idle"}>
					<div class="flex gap-2 p-3 text-xs leading-relaxed rounded-xl bg-gray-2 dark:bg-gray-3 text-gray-11">
						<IconCapInfo class="size-4 shrink-0 mt-px" />
						{L(
							"字幕里同一句话重复了很多次，语音识别可能出错了。AI 会忽略文字稿，只根据停顿、点击和画面剪辑。可以在「字幕」标签里重新生成字幕。",
							"The captions repeat the same line many times, so speech recognition probably failed. The AI will ignore the transcript and edit from pauses, clicks and frames. You can regenerate captions in the Captions tab.",
						)}
					</div>
				</Show>

				<Show when={!hasTranscript() && run.status === "idle"}>
					<div class="flex gap-2 p-3 text-xs leading-relaxed rounded-xl bg-gray-2 dark:bg-gray-3 text-gray-11">
						<IconCapInfo class="size-4 shrink-0 mt-px" />
						<Switch>
							<Match when={!hasAudio()}>
								{L(
									"这段录制没有声音，AI 只能根据点击和画面来剪辑。",
									"This recording has no audio, so the AI will edit from clicks and frames only.",
								)}
							</Match>
							<Match when={whisperModel.loading}>
								{L("正在检查语音识别模型…", "Checking for a speech model…")}
							</Match>
							<Match when={whisperModel()}>
								{L(
									"还没有文字稿。运行时会先在本机用已下载的语音模型转录音频，这样剪辑能保持句子完整。",
									"There is no transcript yet. Before editing, Taple will transcribe the audio on this Mac with your downloaded speech model so cuts keep sentences intact.",
								)}
							</Match>
							<Match when={!whisperModel()}>
								{L(
									"还没有文字稿。运行时会先下载语音模型（约 466 MB，只需下载一次），再在本机转录音频，这样剪辑能保持句子完整。",
									"There is no transcript yet. Before editing, Taple will download the speech model (about 466 MB, only once) and transcribe the audio on this Mac so cuts keep sentences intact.",
								)}
							</Match>
						</Switch>
					</div>
				</Show>

				<div class="flex flex-col gap-2">
					<div class="flex flex-wrap gap-1.5">
						<For each={PRESETS}>
							{(preset, index) => (
								<button
									type="button"
									disabled={busy()}
									class={cx(
										"px-2.5 py-1 text-xs whitespace-nowrap rounded-full border transition-colors text-gray-12 hover:bg-gray-3 disabled:opacity-50",
										presetFilled() === index() && prompt() === preset.prompt
											? "border-blue-9 bg-blue-3"
											: "border-gray-4",
									)}
									onClick={() => applyPreset(index())}
								>
									{preset.label}
								</button>
							)}
						</For>
					</div>
					<textarea
						ref={promptInput}
						class="w-full min-h-[6rem] resize-none rounded-[0.5rem] bg-gray-2 dark:bg-gray-3 p-2.5 text-[0.8125rem] leading-relaxed text-gray-12 placeholder:text-gray-10 outline-none focus:ring-1 focus:ring-gray-10 transition-shadow disabled:opacity-60"
						placeholder={L(
							"描述你想要的剪辑，例如：剪掉开头的等待，在设置页的点击处放大",
							"Describe the edit, e.g. cut the wait at the start and zoom in on the settings page",
						)}
						value={prompt()}
						disabled={busy()}
						onInput={(e) => {
							setPrompt(e.currentTarget.value);
							setPresetFilled(null);
						}}
						on:keydown={(e) => {
							e.stopPropagation();
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								startRun();
							}
						}}
					/>
					<Show
						when={
							presetFilled() !== null &&
							prompt() === PRESETS[presetFilled() ?? 0]?.prompt &&
							!busy()
						}
					>
						<p class="text-xs text-blue-11">
							{L(
								"已填入预设。可以先补充要求（例如保留开场白），再点「开始剪辑」或按 ⌘↩。",
								"Preset added. Add details if you like (for example, keep the intro), then click Run or press ⌘↩.",
							)}
						</p>
					</Show>
					<div class="flex flex-row gap-2 items-center">
						<Show
							when={busy()}
							fallback={
								<Button
									variant="dark"
									size="sm"
									class="gap-1.5 whitespace-nowrap shrink-0"
									disabled={
										!prompt().trim() ||
										!model() ||
										(keyState.loading && keyState() === undefined)
									}
									onClick={startRun}
								>
									<IconCapPlay class="size-3" />
									{L("开始剪辑", "Run")}
								</Button>
							}
						>
							<Button
								variant="white"
								size="sm"
								class="gap-1.5 whitespace-nowrap shrink-0"
								onClick={stopRun}
							>
								<IconCapStopCircle class="size-3.5" />
								{L("停止", "Stop")}
							</Button>
						</Show>
						<Show when={run.status !== "idle"}>
							<span class="flex flex-col items-end ml-auto min-w-0 text-xs tabular-nums text-right text-gray-11">
								<span class="whitespace-nowrap">
									{L("花费", "Cost")} {formatCost(run.cost + run.helperCost)}
								</span>
								<Show when={run.helperCost > 0}>
									<span class="text-[11px] text-gray-10">
										{L(
											`主模型 ${formatCost(run.cost)} · 识图 ${formatCost(run.helperCost)}`,
											`editor ${formatCost(run.cost)} · vision ${formatCost(run.helperCost)}`,
										)}
									</span>
								</Show>
							</span>
						</Show>
					</div>
				</div>

				<Show when={run.phase}>
					<div class="flex gap-2 items-center text-xs text-gray-11">
						<IconLucideLoaderCircle class="animate-spin size-3.5 shrink-0" />
						{audioEnhancement.state.running
							? `${audioEnhancement.state.status}${
									audioEnhancement.state.step === "denoise"
										? ` ${Math.round(audioEnhancement.state.progress * 100)}%`
										: ""
								}`
							: run.phase}
					</div>
				</Show>

				<Show when={run.steps.length > 0}>
					<ol class="flex flex-col gap-1.5">
						<For each={run.steps}>
							{(step) => (
								<Switch>
									<Match when={asTextStep(step)}>
										{(s) => (
											<Show when={s().text}>
												<li class="text-xs leading-relaxed whitespace-pre-wrap text-gray-11">
													{s().text}
												</li>
											</Show>
										)}
									</Match>
									<Match when={asToolStep(step)}>
										{(s) => (
											<li class="flex flex-col gap-0.5 text-xs">
												<div class="flex gap-2 items-center text-gray-12">
													<Switch>
														<Match when={s().status === "running"}>
															<IconLucideLoaderCircle class="animate-spin size-3.5 shrink-0 text-gray-11" />
														</Match>
														<Match when={s().status === "done"}>
															<IconCapCircleCheck class="size-3.5 shrink-0 text-green-500" />
														</Match>
														<Match when={s().status === "error"}>
															<IconCapCircleX class="size-3.5 shrink-0 text-red-500" />
														</Match>
													</Switch>
													<span class="min-w-0 truncate">{s().label}</span>
												</div>
												<Show when={s().error}>
													<span class="pl-5 text-[11px] leading-snug text-gray-10 line-clamp-2">
														{s().error}
													</span>
												</Show>
											</li>
										)}
									</Match>
								</Switch>
							)}
						</For>
					</ol>
				</Show>

				<Show when={run.status === "done" && run.summary}>
					<div class="flex flex-col gap-2 p-3 rounded-xl border border-gray-3 bg-gray-2 dark:bg-gray-3">
						<span class="text-xs font-medium text-gray-12">
							{L("剪辑小结", "Summary")}
						</span>
						<p class="text-xs leading-relaxed whitespace-pre-wrap text-gray-12">
							{run.summary}
						</p>
					</div>
				</Show>

				<Show when={run.status === "stopped"}>
					<p class="text-xs text-gray-11">
						{L(
							"已停止。已经完成的修改保留在时间线上。",
							"Stopped. Edits made so far stay on the timeline.",
						)}
					</p>
				</Show>

				<Show when={run.error}>
					<div class="p-3 text-xs leading-relaxed text-red-500 whitespace-pre-wrap rounded-xl bg-red-500/10">
						{run.error}
					</div>
				</Show>

				<Show when={run.undoAvailable && !busy()}>
					<div class="flex flex-row gap-2 items-center">
						<Button
							variant="white"
							size="sm"
							class="gap-1.5 whitespace-nowrap shrink-0"
							onClick={undoAIEdits}
						>
							<IconCapUndo class="size-3.5" />
							{L("撤销 AI 剪辑", "Undo AI edits")}
						</Button>
						<span class="text-xs text-gray-10">
							{L("或按 ⌘Z", "or press ⌘Z")}
						</span>
					</div>
				</Show>
			</div>
		</div>
	);
}
