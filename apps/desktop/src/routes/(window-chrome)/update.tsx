import { Button } from "@cap/ui-solid";
import { useNavigate } from "@solidjs/router";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import {
	createResource,
	createSignal,
	Match,
	onMount,
	type ParentProps,
	Switch,
} from "solid-js";

import { L } from "~/utils/i18n";
import { commands } from "~/utils/tauri";

type InstallStatus =
	| { type: "downloading"; progress: number | null }
	| { type: "installing" }
	| { type: "done" }
	| { type: "error"; message: string };

export default function () {
	const navigate = useNavigate();
	const [update, { refetch }] = createResource(() => check());
	const goBack = () => navigate(-1);
	const checking = () =>
		update.state === "pending" ||
		update.state === "refreshing" ||
		update.state === "unresolved";

	return (
		<div class="flex flex-col flex-1 gap-4 justify-center items-center p-4 h-full text-center text-[0.875rem]">
			<Switch>
				<Match when={checking()}>
					<Spinner />
					<p class="text-[--text-tertiary]">
						{L("正在检查更新…", "Checking for updates…")}
					</p>
				</Match>
				<Match when={update.state === "errored"}>
					<Message
						title={L("暂时无法检查更新", "Couldn't check for updates")}
						detail={String(update.error)}
					>
						<Button size="sm" variant="gray" onClick={goBack}>
							{L("返回", "Back")}
						</Button>
						<Button size="sm" variant="blue" onClick={() => refetch()}>
							{L("重试", "Try Again")}
						</Button>
					</Message>
				</Match>
				<Match when={update.state === "ready" && update()} keyed>
					{(available) => (
						<Installer
							update={available}
							onBack={goBack}
							onRetry={() => refetch()}
						/>
					)}
				</Match>
				<Match when={update.state === "ready"}>
					<Message title={L("已是最新版本", "Taple is up to date")}>
						<Button size="sm" variant="gray" onClick={goBack}>
							{L("返回", "Back")}
						</Button>
					</Message>
				</Match>
			</Switch>
		</div>
	);
}

function Installer(props: {
	update: Update;
	onBack: () => void;
	onRetry: () => void;
}) {
	const [status, setStatus] = createSignal<InstallStatus>({
		type: "downloading",
		progress: null,
	});

	onMount(() => {
		let total = 0;
		let received = 0;
		props.update
			.downloadAndInstall((event) => {
				if (event.event === "Started") {
					total = event.data.contentLength ?? 0;
				} else if (event.event === "Progress") {
					received += event.data.chunkLength;
					setStatus({
						type: "downloading",
						progress: total > 0 ? Math.min(received / total, 1) : null,
					});
				} else {
					setStatus({ type: "installing" });
				}
			})
			.then(async () => {
				await commands.saveCurrentVersion().catch(() => undefined);
				setStatus({ type: "done" });
				getCurrentWindow().requestUserAttention(
					UserAttentionType.Informational,
				);
			})
			.catch((error) => setStatus({ type: "error", message: String(error) }));
	});

	const progress = () => {
		const current = status();
		return current.type === "downloading" ? current.progress : null;
	};
	const errorMessage = () => {
		const current = status();
		return current.type === "error" ? current.message : "";
	};

	return (
		<Switch>
			<Match when={status().type === "downloading"}>
				<div class="flex flex-col gap-3 items-center w-full">
					<p class="text-[--text-primary]">
						{L(
							`正在下载 Taple v${props.update.version}`,
							`Downloading Taple v${props.update.version}`,
						)}
					</p>
					<div class="w-full h-2 rounded-full bg-gray-3">
						<div
							class="h-2 rounded-full transition-[width] bg-blue-9"
							style={{ width: `${Math.round((progress() ?? 0) * 100)}%` }}
						/>
					</div>
					<p class="text-xs text-[--text-tertiary]">
						{progress() === null
							? L("正在连接…", "Connecting…")
							: `${Math.round((progress() ?? 0) * 100)}%`}
					</p>
				</div>
			</Match>
			<Match when={status().type === "installing"}>
				<Spinner />
				<p class="text-[--text-tertiary]">
					{L("正在安装更新…", "Installing the update…")}
				</p>
			</Match>
			<Match when={status().type === "done"}>
				<Message
					title={L(
						"更新已安装，重启 Taple 即可使用新版本。",
						"Update installed. Restart Taple to use the new version.",
					)}
				>
					<Button size="sm" variant="blue" onClick={() => relaunch()}>
						{L("立即重启", "Restart Now")}
					</Button>
				</Message>
			</Match>
			<Match when={status().type === "error"}>
				<Message
					title={L("更新失败", "The update failed")}
					detail={errorMessage()}
				>
					<Button size="sm" variant="gray" onClick={() => props.onBack()}>
						{L("返回", "Back")}
					</Button>
					<Button size="sm" variant="blue" onClick={() => props.onRetry()}>
						{L("重试", "Try Again")}
					</Button>
				</Message>
			</Match>
		</Switch>
	);
}

function Message(props: ParentProps<{ title: string; detail?: string }>) {
	return (
		<div class="flex flex-col gap-3 items-center">
			<p class="text-[--text-primary]">{props.title}</p>
			{props.detail && (
				<p class="text-xs break-words text-[--text-tertiary] max-w-full">
					{props.detail}
				</p>
			)}
			<div class="flex flex-row gap-2">{props.children}</div>
		</div>
	);
}

function Spinner() {
	return <IconCapLogo class="animate-spin size-4 text-[--text-primary]" />;
}
