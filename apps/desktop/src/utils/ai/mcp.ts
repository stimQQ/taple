import type { ProjectConfiguration } from "~/utils/tauri";
import { EDITING_RULES, TOOL_GUARDRAILS } from "./agent";
import { createRecordingLayout } from "./timebase";
import { createEditorTools, type EditorBridge } from "./tools";

export type McpToolDefinition = {
	name: string;
	description: string;
	inputSchema: unknown;
};

export type McpCatalog = {
	instructions: string;
	tools: McpToolDefinition[];
};

const NO_ARGUMENTS = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

export const MCP_SESSION_TOOLS: McpToolDefinition[] = [
	{
		name: "prepare_audio",
		description:
			"Clean up the microphone audio of the open recording: remove background noise, then set the voice to standard online-video loudness (-16 LUFS). Steps that were already done are skipped, and the user's choice to keep the original audio is respected. Call it once before reading the transcript or editing speech.",
		inputSchema: NO_ARGUMENTS,
	},
	{
		name: "transcribe",
		description:
			"Transcribe the open recording on this Mac with Whisper and store the captions with word timings, so get_transcript can return lines, filler words and retakes. Skips work when captions already exist. The first time, it also downloads the speech model (about 466 MB) once. Long recordings take a while.",
		inputSchema: NO_ARGUMENTS,
	},
	{
		name: "undo",
		description:
			"Undo the last change to the open recording's timeline, captions or audio settings in the Taple editor.",
		inputSchema: NO_ARGUMENTS,
	},
	{
		name: "redo",
		description: "Redo the last change that undo reverted.",
		inputSchema: NO_ARGUMENTS,
	},
];

export const MCP_SESSION_TOOL_NAMES = new Set(
	MCP_SESSION_TOOLS.map((tool) => tool.name),
);

export function mcpInstructions(): string {
	return `Taple is a macOS screen recorder for product demos and tutorials. These tools edit a recording in the Taple editor: the user watches the timeline change live, and every change can be undone with the undo tool.

How to work:
1. Call list_recordings, then open_recording (pass "latest" for the most recent recording). Taple opens it in its editor, and all other tools work on the recording you opened last.
2. Call prepare_audio once. It removes background noise and sets the voice to standard loudness, skipping anything already done.
3. Call get_overview. If it reports no transcript, call transcribe before editing speech.
4. Read get_transcript (lines, word timings, filler words, repeated phrases, retakes), get_activity (clicks and pauses) and get_storyboard (what happens on screen every second, with on-screen text). Use view_frames to look at the screen at specific source times; it returns one contact sheet image.
5. Plan the whole edit, then apply it with fine-grained edits: one cut per filler, retake or idle stretch.
6. Call review_edit, fix every warning it lists and call it again.
7. Tell the user what you changed in a few short bullet points, by content rather than timestamps.

Time base: every time you pass to or read from a tool is in seconds of the ORIGINAL recording ("source time"). Cuts and speed changes never shift source times, so transcript, word, click, pause and storyboard times stay valid. Tool results also show "final" times in the edited video for reference; never pass final times to tools.

${TOOL_GUARDRAILS}

Write every "reason" you pass to an edit tool in the user's language; the user sees them in the editor.

${EDITING_RULES}`;
}

function catalogBridge(): EditorBridge {
	return {
		project: {} as ProjectConfiguration,
		setProject: () => undefined,
		onEdited: () => undefined,
		layout: createRecordingLayout([60]),
		projectPath: "",
		activity: {} as EditorBridge["activity"],
		transcriptHint: "",
		vision: null,
		onHelperCost: () => undefined,
		storyRuns: null,
		storyboardNote: "",
		visual: { source: "clicks", spans: [], note: "" },
	};
}

export function mcpCatalog(): McpCatalog {
	const { tools } = createEditorTools(catalogBridge());
	return {
		instructions: mcpInstructions(),
		tools: [
			...tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: JSON.parse(JSON.stringify(tool.parameters)),
			})),
			...MCP_SESSION_TOOLS,
		],
	};
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("mcp catalog", () => {
		it("has unique tool names and object schemas", () => {
			const { tools } = mcpCatalog();
			const names = tools.map((tool) => tool.name);
			expect(new Set(names).size).toBe(names.length);
			for (const tool of tools) {
				expect(tool.description.length).toBeGreaterThan(20);
				expect((tool.inputSchema as { type?: string }).type).toBe("object");
			}
			expect(names).toContain("cut_range");
			expect(names).toContain("view_frames");
		});

		it("matches the catalog file served by the app", async () => {
			const fs = await import("node:fs");
			const file = new URL(
				"../../../src-tauri/mcp-catalog.json",
				import.meta.url,
			);
			const json = `${JSON.stringify(mcpCatalog(), null, "\t")}\n`;
			if (process.env.UPDATE_MCP_CATALOG) fs.writeFileSync(file, json);
			expect(fs.readFileSync(file, "utf8")).toBe(json);
		});
	});
}
