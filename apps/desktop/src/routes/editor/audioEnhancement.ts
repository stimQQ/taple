import { createResource } from "solid-js";
import { createStore, type SetStoreFunction } from "solid-js/store";
import { L } from "~/utils/i18n";
import { commands, events, type ProjectConfiguration } from "~/utils/tauri";

export type AudioEnhanceStep = "denoise" | "restore" | "level";

export type LevelResult = { volumeDb: number; loudnessLufs: number };

export type AudioPrepareOutcome = {
	denoise: "done" | "already" | "kept-original" | "unavailable" | "failed";
	level: LevelResult | "already" | "unavailable" | "failed";
	errors: string[];
};

const errorText = (error: unknown) =>
	typeof error === "string" ? error : String(error);

export function createAudioEnhancement(deps: {
	projectPath: string;
	hasMicrophone: () => boolean;
	project: ProjectConfiguration;
	setProject: SetStoreFunction<ProjectConfiguration>;
	pausePlayback: () => Promise<void>;
	refetchMicWaveforms: () => unknown;
}) {
	const [state, setState] = createStore({
		running: false,
		step: null as AudioEnhanceStep | null,
		progress: 0,
		status: "",
	});

	const [denoised, { refetch: refetchDenoised }] = createResource(
		() => deps.projectPath,
		(path) => commands.hasOriginalAudio(path).catch(() => false),
	);

	let tail: Promise<unknown> = Promise.resolve();

	const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
		const run = tail.then(async () => {
			setState({ running: true, progress: 0, status: "" });
			try {
				return await task();
			} finally {
				setState({ running: false, step: null, progress: 0, status: "" });
			}
		});
		tail = run.catch(() => undefined);
		return run;
	};

	const denoise = async () => {
		setState({
			step: "denoise",
			progress: 0,
			status: L("正在准备降噪...", "Preparing noise reduction..."),
		});
		const unlisten = await events.denoiseProgress.listen((event) => {
			setState({
				progress: event.payload.progress,
				status: event.payload.status,
			});
		});
		try {
			await deps.pausePlayback();
			await commands.denoiseRecordingAudio(deps.projectPath);
			deps.refetchMicWaveforms();
			await refetchDenoised();
		} finally {
			unlisten();
		}
	};

	const level = async (): Promise<LevelResult | null> => {
		setState({
			step: "level",
			progress: 0,
			status: L("正在测量人声音量...", "Measuring voice loudness..."),
		});
		const result = await commands.analyzeMicLevel(deps.projectPath);
		if (!result) return null;
		deps.setProject("audio", "micVolumeDb", result.recommendedVolumeDb);
		deps.setProject("audio", "autoLevelDb", result.recommendedVolumeDb);
		return {
			volumeDb: result.recommendedVolumeDb,
			loudnessLufs: result.loudnessLufs,
		};
	};

	return {
		state,
		denoised,
		runDenoise: () =>
			exclusive(async () => {
				deps.setProject("audio", "keepOriginalAudio", false);
				await denoise();
			}),
		restoreOriginal: () =>
			exclusive(async () => {
				setState({
					step: "restore",
					status: L("正在恢复原声...", "Restoring the original audio..."),
				});
				await deps.pausePlayback();
				await commands.restoreOriginalAudio(deps.projectPath);
				deps.setProject("audio", "keepOriginalAudio", true);
				deps.refetchMicWaveforms();
				await refetchDenoised();
			}),
		autoLevel: () => exclusive(level),
		prepare: () =>
			exclusive(async (): Promise<AudioPrepareOutcome> => {
				const outcome: AudioPrepareOutcome = {
					denoise: "unavailable",
					level: "unavailable",
					errors: [],
				};
				if (!deps.hasMicrophone()) return outcome;

				if (deps.project.audio.keepOriginalAudio) {
					outcome.denoise = "kept-original";
				} else if (
					await commands.hasOriginalAudio(deps.projectPath).catch(() => false)
				) {
					outcome.denoise = "already";
				} else {
					try {
						await denoise();
						outcome.denoise = "done";
					} catch (error) {
						outcome.denoise = "failed";
						outcome.errors.push(errorText(error));
					}
				}

				if (deps.project.audio.autoLevelDb != null) {
					outcome.level = "already";
				} else {
					try {
						outcome.level = (await level()) ?? "unavailable";
					} catch (error) {
						outcome.level = "failed";
						outcome.errors.push(errorText(error));
					}
				}

				return outcome;
			}),
	};
}

export type AudioEnhancement = ReturnType<typeof createAudioEnhancement>;

export function formatVolumeDb(value: number) {
	return `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`;
}
