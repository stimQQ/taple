import type { AgentTool } from "@earendil-works/pi-agent-core";
import { compile } from "@earendil-works/pi-schema";
import { createSignal, onCleanup, onMount } from "solid-js";
import { produce } from "solid-js/store";
import { MCP_SESSION_TOOL_NAMES } from "~/utils/ai/mcp";
import { createEditorTools } from "~/utils/ai/tools";
import {
	downloadDefaultWhisperModel,
	findDownloadedWhisperModel,
	transcribeRecording,
} from "~/utils/ai/video-context";
import { commands, events } from "~/utils/tauri";
import { formatVolumeDb } from "./audioEnhancement";
import { MODEL_FOLDER, MODEL_OPTIONS } from "./CaptionsTab";
import { HIDDEN_CAPTION_SETTINGS } from "./captionDefaults";
import { useEditorContext } from "./context";
import { analyzeRecording } from "./editAnalysis";

type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

type McpResult = { content: McpContent[]; isError: boolean };

const IDLE_AFTER_MS = 4000;

export const [mcpActivity, setMcpActivity] = createSignal<{
	client: string;
	tool: string;
} | null>(null);

const textResult = (text: string, isError = false): McpResult => ({
	content: [{ type: "text", text }],
	isError,
});

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export function useMcpHost() {
	const {
		editorInstance,
		project,
		setProject,
		projectHistory,
		meta,
		audioEnhancement,
		editorState,
		setEditorState,
		totalDuration,
	} = useEditorContext();
	const projectPath = editorInstance.path;

	let toolkit: Promise<Map<string, AgentTool>> | null = null;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const hasTranscript = () => (project.captions?.segments.length ?? 0) > 0;

	const onEdited = () => {
		setEditorState("timeline", "selection", null);
		const duration = totalDuration();
		if (editorState.playbackTime > duration) {
			setEditorState("playbackTime", Math.max(0, duration));
		}
	};

	const loadTools = () => {
		toolkit ??= (async () => {
			const analysis = await analyzeRecording({
				editorInstance,
				meta: meta(),
				timelineSegments: project.timeline?.segments,
				micWaveforms: () => commands.getMicWaveforms().catch(() => []),
				systemWaveforms: () =>
					commands.getSystemAudioWaveforms().catch(() => []),
			});
			const { tools } = createEditorTools({
				...analysis,
				project,
				setProject,
				onEdited,
				projectPath,
				transcriptHint: hasTranscript()
					? ""
					: "There is no transcript yet. Call transcribe first, or rely on pauses, clicks and frames and cut conservatively.",
				vision: null,
				onHelperCost: () => undefined,
			});
			return new Map(tools.map((tool) => [tool.name, tool]));
		})().catch((error) => {
			toolkit = null;
			throw error;
		});
		return toolkit;
	};

	const prepareAudio = async () => {
		const outcome = await audioEnhancement.prepare();
		toolkit = null;
		const lines = [
			{
				done: "Removed background noise.",
				already: "Noise reduction was already applied.",
				"kept-original":
					"The user chose to keep the original audio, so noise reduction was skipped.",
				unavailable: "The recording has no microphone audio.",
				failed: "Noise reduction failed.",
			}[outcome.denoise],
			typeof outcome.level === "object"
				? `Set the microphone volume to ${formatVolumeDb(outcome.level.volumeDb)} so the voice reaches standard loudness (measured ${outcome.level.loudnessLufs.toFixed(1)} LUFS before the change).`
				: {
						already: "The voice volume was already set.",
						unavailable: "No voice was found to measure.",
						failed: "Setting the voice volume failed.",
					}[outcome.level],
			...outcome.errors.map((error) => `Error: ${error}`),
		];
		return textResult(
			lines.join("\n"),
			outcome.denoise === "failed" || outcome.level === "failed",
		);
	};

	const transcribe = async () => {
		if (hasTranscript()) {
			return textResult(
				`Captions already exist (${project.captions?.segments.length ?? 0} lines). Use get_transcript.`,
			);
		}
		let model = await findDownloadedWhisperModel(
			MODEL_FOLDER,
			MODEL_OPTIONS.map((option) => option.name),
		);
		if (!model) {
			try {
				model = await downloadDefaultWhisperModel(MODEL_FOLDER);
			} catch (error) {
				return textResult(
					`The speech model could not be downloaded (${String(error)}). Ask the user to check the internet connection, then call transcribe again.`,
					true,
				);
			}
		}
		const segments = await transcribeRecording(projectPath, model);
		if (segments.length === 0) {
			return textResult("Transcription found no speech.");
		}
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
		toolkit = null;
		return textResult(
			`Transcribed the recording into ${segments.length} caption lines with word timings. Use get_transcript.`,
		);
	};

	const runSessionTool = (name: string): Promise<McpResult> => {
		switch (name) {
			case "prepare_audio":
				return prepareAudio();
			case "transcribe":
				return transcribe();
			case "undo":
				if (!projectHistory.canUndo())
					return Promise.resolve(textResult("There is nothing to undo."));
				projectHistory.undo();
				onEdited();
				return Promise.resolve(textResult("Undid the last change."));
			case "redo":
				if (!projectHistory.canRedo())
					return Promise.resolve(textResult("There is nothing to redo."));
				projectHistory.redo();
				onEdited();
				return Promise.resolve(textResult("Redid the last undone change."));
			default:
				return Promise.resolve(textResult(`Unknown tool: ${name}`, true));
		}
	};

	const runEditorTool = async (
		name: string,
		args: unknown,
	): Promise<McpResult> => {
		const tool = (await loadTools()).get(name);
		if (!tool) return textResult(`Unknown tool: ${name}`, true);

		const parsed = compile(tool.parameters, { coerce: true }).parse(args);
		if (!parsed.ok) {
			return textResult(
				`Invalid arguments for ${name}: ${parsed.errors
					.map((error) => `${error.path || "(root)"} ${error.message}`)
					.join("; ")}`,
				true,
			);
		}

		const result = await tool.execute(`mcp-${Date.now()}`, parsed.value);
		return {
			content: result.content.map(
				(item): McpContent =>
					item.type === "text"
						? { type: "text", text: item.text }
						: { type: "image", data: item.data, mimeType: item.mimeType },
			),
			isError: false,
		};
	};

	onMount(() => {
		const unlisten = events.mcpToolCall.listen(async (event) => {
			const call = event.payload;
			if (call.projectPath !== projectPath) return;

			clearTimeout(idleTimer);
			setMcpActivity({ client: call.client, tool: call.name });

			let result: McpResult;
			try {
				const args = JSON.parse(call.argumentsJson || "{}");
				result = MCP_SESSION_TOOL_NAMES.has(call.name)
					? await runSessionTool(call.name)
					: await runEditorTool(call.name, args);
			} catch (error) {
				result = textResult(errorMessage(error), true);
			}

			idleTimer = setTimeout(() => setMcpActivity(null), IDLE_AFTER_MS);
			await commands
				.mcpToolResult(call.requestId, JSON.stringify(result))
				.catch(() => undefined);
		});

		void commands.mcpEditorReady(projectPath).catch(() => undefined);

		onCleanup(() => {
			clearTimeout(idleTimer);
			setMcpActivity(null);
			void unlisten.then((stop) => stop());
			void commands.mcpEditorClosed(projectPath).catch(() => undefined);
		});
	});
}
