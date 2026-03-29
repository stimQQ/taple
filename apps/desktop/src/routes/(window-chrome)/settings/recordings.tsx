import { ProgressCircle } from "@cap/ui-solid";
import Tooltip from "@corvu/tooltip";
import {
	createQuery,
	queryOptions,
	useQueryClient,
} from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ask, confirm, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { remove } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import * as shell from "@tauri-apps/plugin-shell";
import { cx } from "cva";
import {
	createMemo,
	createSignal,
	For,
	type ParentProps,
	Show,
} from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import CapTooltip from "~/components/Tooltip";
import { trackEvent } from "~/utils/analytics";
import { createTauriEventListener } from "~/utils/createEventListener";
import {
	commands,
	events,
	type RecordingMetaWithMetadata,
	type UploadProgress,
} from "~/utils/tauri";

type Recording = {
	meta: RecordingMetaWithMetadata;
	path: string;
	prettyName: string;
	thumbnailPath: string;
};


const recordingsQuery = queryOptions({
	queryKey: ["recordings"],
	queryFn: async () => {
		const result = await commands.listRecordings().catch(() => [] as const);

		const recordings = await Promise.all(
			result.map(async (file) => {
				const [path, meta] = file;
				const thumbnailPath = `${path}/screenshots/display.jpg`;

				return {
					meta,
					path,
					prettyName: meta.pretty_name,
					thumbnailPath,
				};
			}),
		);
		return recordings;
	},
	reconcile: (old, n) => reconcile(n)(old),
	// This will ensure any changes to the upload status in the project meta are reflected.
	refetchInterval: 2000,
});

export default function Recordings() {
	const [uploadProgress, setUploadProgress] = createStore<
		Record</* video_id */ string, number>
	>({});
	const [isImporting, setIsImporting] = createSignal(false);
	const recordings = createQuery(() => recordingsQuery);
	const queryClient = useQueryClient();

	createTauriEventListener(events.uploadProgressEvent, (e) => {
		setUploadProgress(e.video_id, (Number(e.uploaded) / Number(e.total)) * 100);
		if (e.uploaded === e.total)
			setUploadProgress(
				produce((s) => {
					delete s[e.video_id];
				}),
			);
	});

	createTauriEventListener(events.recordingDeleted, () => recordings.refetch());

	const filteredRecordings = createMemo(() => {
		if (!recordings.data) {
			return [];
		}
		return recordings.data;
	});

	const handleRecordingClick = (recording: Recording) => {
		trackEvent("recording_view_clicked");
		events.newStudioRecordingAdded.emit({ path: recording.path });
	};

	const handleOpenFolder = (path: string) => {
		trackEvent("recording_folder_clicked");
		commands.openFilePath(path);
	};

	const handleCopyVideoToClipboard = (path: string) => {
		trackEvent("recording_copy_clicked");
		commands.copyVideoToClipboard(path);
	};

	const handleOpenEditor = (path: string) => {
		trackEvent("recording_editor_clicked");
		commands.showWindow({
			Editor: { project_path: path },
		});
	};

	const handleImportVideo = async () => {
		try {
			setIsImporting(true);
			trackEvent("video_import_clicked");

			const filePath = await openFileDialog({
				title: "选择要导入的视频文件",
				filters: [
					{
						name: "视频文件",
						extensions: ["mp4", "mov", "avi", "mkv", "webm", "m4v"],
					},
				],
				multiple: false,
			});

			if (filePath && typeof filePath === "string") {
				const projectPath = await commands.importVideoFile(filePath);
				trackEvent("video_import_success");
				await queryClient.refetchQueries(recordingsQuery);
				handleOpenEditor(projectPath);
			}
		} catch (error) {
			console.error("Failed to import video:", error);
			trackEvent("video_import_failed");
		} finally {
			setIsImporting(false);
		}
	};

	return (
		<div class="flex relative flex-col w-full h-full">
			<div class="flex justify-end p-2 border-b border-gray-3">
				<button
					type="button"
					onClick={handleImportVideo}
					disabled={isImporting()}
					class="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-12 bg-gray-3 hover:bg-gray-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					<IconLucideImport class="size-4" />
					{isImporting() ? "导入中..." : "导入视频"}
				</button>
			</div>
			<Show
				when={recordings.data && recordings.data.length > 0}
				fallback={
					<div class="flex flex-col items-center justify-center w-full h-full gap-4">
						<p class="text-center text-[--text-tertiary]">
							未找到录制
						</p>
						<button
							type="button"
							onClick={handleImportVideo}
							disabled={isImporting()}
							class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-12 bg-gray-3 hover:bg-gray-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							<IconLucideImport class="size-4" />
							{isImporting() ? "导入中..." : "导入视频文件"}
						</button>
					</div>
				}
			>
				<div class="flex relative flex-col flex-1 custom-scroll overflow-y-auto">
					<Show when={filteredRecordings().length === 0}>
						<p class="text-center text-[--text-tertiary] absolute flex items-center justify-center w-full h-full">
							暂无录制
						</p>
					</Show>
					<ul class="flex flex-col w-full text-[--text-primary]">
						<For each={filteredRecordings()}>
							{(recording) => (
								<RecordingItem
									recording={recording}
									onClick={() => handleRecordingClick(recording)}
									onOpenFolder={() => handleOpenFolder(recording.path)}
									onOpenEditor={() => handleOpenEditor(recording.path)}
									onCopyVideoToClipboard={() =>
										handleCopyVideoToClipboard(recording.path)
									}
									uploadProgress={
										recording.meta.upload &&
										recording.meta.upload.state === "SinglePartUpload"
											? uploadProgress[recording.meta.upload.video_id]
											: undefined
									}
								/>
							)}
						</For>
					</ul>
				</div>
			</Show>
		</div>
	);
}

function RecordingItem(props: {
	recording: Recording;
	onClick: () => void;
	onOpenFolder: () => void;
	onOpenEditor: () => void;
	onCopyVideoToClipboard: () => void;
	uploadProgress: number | undefined;
}) {
	const [imageExists, setImageExists] = createSignal(true);

	const queryClient = useQueryClient();
	const isComplete = () =>
		props.recording.meta.status.status === "Complete";

	return (
		<li
			onClick={() => {
				if (isComplete()) {
					props.onOpenEditor();
				}
			}}
			class={cx(
				"flex flex-row justify-between p-3 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-gray-3 items-center w-full  transition-colors duration-200",
				isComplete()
					? "cursor-pointer hover:bg-gray-3"
					: "cursor-default",
			)}
		>
			<div class="flex gap-5 items-center">
				<Show
					when={imageExists()}
					fallback={<div class="mr-4 rounded bg-gray-10 size-11" />}
				>
					<img
						class="object-cover rounded size-12"
						alt="录制缩略图"
						src={`${convertFileSrc(
							props.recording.thumbnailPath,
						)}?t=${Date.now()}`}
						onError={() => setImageExists(false)}
					/>
				</Show>
				<div class="flex flex-col gap-2">
					<span>{props.recording.prettyName}</span>
					<div class="flex space-x-1">
						<Show when={props.recording.meta.status.status === "InProgress"}>
							<div
								class={cx(
									"px-2 py-0.5 flex items-center gap-1.5 font-medium text-[11px] text-gray-1 dark:text-gray-1 rounded-full w-fit bg-blue-500 leading-none text-center",
								)}
							>
								<IconPhRecordFill class="size-2.5" />
								<p>录制进行中</p>
							</div>
						</Show>

						<Show when={props.recording.meta.status.status === "Failed"}>
							<CapTooltip
								content={
									<span>
										{props.recording.meta.status.status === "Failed"
											? props.recording.meta.status.error
											: ""}
									</span>
								}
							>
								<div
									class={cx(
										"px-2 py-0.5 flex items-center gap-1.5 font-medium text-[11px] text-gray-12 rounded-full w-fit bg-red-9 leading-none text-center",
									)}
								>
									<IconPhWarningBold class="invert size-2.5 dark:invert-0" />
									<p>录制失败</p>
								</div>
							</CapTooltip>
						</Show>
					</div>
				</div>
			</div>
			<div class="flex gap-2 items-center">
				<Show when={props.uploadProgress}>
					<CapTooltip content={`${(props.uploadProgress || 0).toFixed(2)}%`}>
						<ProgressCircle
							variant="primary"
							progress={props.uploadProgress || 0}
							size="sm"
						/>
					</CapTooltip>
				</Show>
				<Show when={props.recording.meta.sharing}>
					{(sharing) => (
						<TooltipIconButton
							tooltipText="打开链接"
							onClick={() => shell.open(sharing().link)}
						>
							<IconCapLink class="size-4" />
						</TooltipIconButton>
					)}
				</Show>
				<TooltipIconButton
					tooltipText="编辑"
					onClick={async () => {
						if (
							props.recording.meta.status.status === "Failed" &&
							!(await confirm(
								"录制失败，此文件在编辑器中可能存在问题！如果恢复文件时遇到问题，请联系支持团队！",
								{
									title: "录制文件可能已损坏",
									kind: "warning",
								},
							))
						)
							return;
						props.onOpenEditor();
					}}
					disabled={props.recording.meta.status.status === "InProgress"}
				>
					<IconLucideEdit class="size-4" />
				</TooltipIconButton>
				<TooltipIconButton
					tooltipText="打开录制文件夹"
					onClick={() => revealItemInDir(`${props.recording.path}/`)}
				>
					<IconLucideFolder class="size-4" />
				</TooltipIconButton>
				<TooltipIconButton
					tooltipText="删除"
					onClick={async () => {
						if (!(await ask("确定要删除此录制吗？")))
							return;
						await remove(props.recording.path, { recursive: true });

						queryClient.refetchQueries(recordingsQuery);
					}}
				>
					<IconCapTrash class="size-4" />
				</TooltipIconButton>
			</div>
		</li>
	);
}

function TooltipIconButton(
	props: ParentProps<{
		onClick: () => void;
		tooltipText: string;
		disabled?: boolean;
	}>,
) {
	return (
		<Tooltip>
			<Tooltip.Trigger
				onClick={(e: MouseEvent) => {
					e.stopPropagation();
					props.onClick();
				}}
				disabled={props.disabled}
				class="p-2.5 opacity-70 will-change-transform hover:opacity-100 rounded-full transition-all duration-200 hover:bg-gray-3 dark:hover:bg-gray-5 disabled:pointer-events-none disabled:opacity-45 disabled:hover:opacity-45"
			>
				{props.children}
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content class="py-2 px-3 font-medium bg-gray-2 text-gray-12 border border-gray-3 text-xs rounded-lg animate-in fade-in slide-in-from-top-0.5">
					{props.tooltipText}
				</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip>
	);
}
