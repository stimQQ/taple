import { Button } from "@cap/ui-solid";
import { useNavigate } from "@solidjs/router";
import { getVersion } from "@tauri-apps/api/app";
import * as shell from "@tauri-apps/plugin-shell";
import {
	createSignal,
	For,
	type JSX,
	Match,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { L } from "~/utils/i18n";
import {
	compareVersions,
	isExternalLink,
	RELEASES_PAGE,
	sanitizeReleaseHtml,
} from "~/utils/releaseNotes";
import { commands, type ReleaseNote } from "~/utils/tauri";

const NOTE_STYLES =
	"text-[13px] leading-relaxed text-gray-11 [&_a]:text-blue-11 [&_a]:underline [&_a]:underline-offset-2 [&_code]:px-1 [&_code]:rounded [&_code]:bg-gray-3 [&_code]:text-[12px] [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-sm [&_h1]:font-medium [&_h1]:text-gray-12 [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-medium [&_h2]:text-gray-12 [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-medium [&_h3]:text-gray-12 [&_hr]:my-4 [&_hr]:border-gray-3 [&_li]:my-1 [&_ol]:pl-5 [&_ol]:list-decimal [&_p]:my-2 [&_pre]:my-2 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:bg-gray-3 [&_pre]:overflow-x-auto [&_strong]:text-gray-12 [&_ul]:pl-5 [&_ul]:list-disc [&>*:first-child]:mt-0";

type LoadState =
	| { status: "loading" }
	| { status: "error" }
	| { status: "ready"; notes: ReleaseNote[] };

function formatDate(date: string | null) {
	if (!date) return "";
	return new Date(date).toLocaleDateString(L("zh-CN", "en-US"), {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

function openLink(event: MouseEvent) {
	const anchor = (event.target as HTMLElement).closest("a");
	if (!anchor) return;
	event.preventDefault();
	const href = anchor.getAttribute("href");
	if (isExternalLink(href)) void shell.open(href);
}

function Badge(props: { children: string; tone?: "blue" }) {
	return (
		<span
			class={
				props.tone === "blue"
					? "px-1.5 py-0.5 text-[11px] rounded-md bg-blue-3 text-blue-11"
					: "px-1.5 py-0.5 text-[11px] rounded-md bg-gray-4 text-gray-11"
			}
		>
			{props.children}
		</span>
	);
}

function Notice(props: {
	title: string;
	description: string;
	children?: JSX.Element;
}) {
	return (
		<div class="flex flex-col gap-3 items-start p-4 rounded-xl border border-gray-3 bg-gray-2">
			<div class="space-y-1">
				<p class="text-sm text-gray-12">{props.title}</p>
				<p class="text-xs leading-relaxed text-gray-11">{props.description}</p>
			</div>
			{props.children}
		</div>
	);
}

function ReleaseEntry(props: { note: ReleaseNote; current?: string }) {
	const body = () => sanitizeReleaseHtml(props.note.bodyHtml);
	return (
		<li class="p-4 rounded-xl border border-gray-3 bg-gray-2">
			<div class="flex flex-row flex-wrap gap-2 items-center">
				<span class="text-sm font-medium text-gray-12">
					v{props.note.version}
				</span>
				<Show
					when={
						props.current &&
						compareVersions(props.note.version, props.current) === 0
					}
				>
					<Badge>{L("当前版本", "Current")}</Badge>
				</Show>
				<Show when={props.note.prerelease}>
					<Badge>{L("测试版", "Beta")}</Badge>
				</Show>
				<span class="ml-auto text-xs text-gray-10">
					{formatDate(props.note.publishedAt)}
				</span>
			</div>
			<Show when={props.note.title}>
				<p class="mt-1 text-sm text-gray-12">{props.note.title}</p>
			</Show>
			<Show
				when={body()}
				fallback={
					<p class="mt-3 text-xs text-gray-10">
						{L("这个版本没有写更新说明。", "No notes for this version.")}
					</p>
				}
			>
				<div
					ref={(element) => element.addEventListener("click", openLink)}
					class={`mt-3 ${NOTE_STYLES}`}
					innerHTML={body()}
				/>
			</Show>
		</li>
	);
}

export default function ChangelogSettings() {
	const navigate = useNavigate();
	const [current, setCurrent] = createSignal<string>();
	const [state, setState] = createSignal<LoadState>({ status: "loading" });

	const load = async () => {
		setState({ status: "loading" });
		try {
			setState({ status: "ready", notes: await commands.listReleaseNotes() });
		} catch {
			setState({ status: "error" });
		}
	};

	onMount(() => {
		void getVersion().then(setCurrent);
		void load();
	});

	const notes = () => {
		const value = state();
		return value.status === "ready" ? value.notes : null;
	};

	const update = () => {
		const version = current();
		const latest = notes()?.find((note) => !note.prerelease);
		return version && latest && compareVersions(latest.version, version) > 0
			? latest
			: null;
	};

	return (
		<div class="flex flex-col h-full custom-scroll">
			<div class="p-4 space-y-6">
				<div class="flex flex-row gap-3 justify-between items-center">
					<p class="text-xs text-gray-11">
						<Show when={current()}>
							{(version) =>
								L(`当前版本 v${version()}`, `You have v${version()}`)
							}
						</Show>
					</p>
					<button
						type="button"
						class="flex flex-row gap-1 items-center text-xs transition-colors text-gray-11 hover:text-gray-12"
						onClick={() => shell.open(RELEASES_PAGE)}
					>
						{L("在 GitHub 查看", "View on GitHub")}
						<IconLucideArrowUpRight class="size-3" />
					</button>
				</div>

				<Show when={update()}>
					{(release) => (
						<div class="flex flex-row gap-3 justify-between items-center p-4 rounded-xl border border-blue-6 bg-blue-3">
							<div class="space-y-1">
								<p class="text-sm text-gray-12">
									{L(
										`新版本 v${release().version} 已发布`,
										`Taple v${release().version} is available`,
									)}
								</p>
								<p class="text-xs text-gray-11">
									{L(
										"更新内容见下方，安装后重启 Taple 即可。",
										"See what's new below. Taple restarts after the update.",
									)}
								</p>
							</div>
							<Button
								size="sm"
								variant="blue"
								onClick={() => navigate("/update")}
							>
								{L("立即更新", "Update")}
							</Button>
						</div>
					)}
				</Show>

				<Switch>
					<Match when={state().status === "error"}>
						<Notice
							title={L("暂时无法获取更新日志", "Couldn't load the changelog")}
							description={L(
								"请检查网络后重试，也可以在浏览器里查看。",
								"Check your connection and try again, or open it in your browser.",
							)}
						>
							<div class="flex flex-row gap-2">
								<Button size="sm" variant="gray" onClick={() => load()}>
									{L("重试", "Try Again")}
								</Button>
								<Button
									size="sm"
									variant="gray"
									onClick={() => shell.open(RELEASES_PAGE)}
								>
									{L("在浏览器中打开", "Open in Browser")}
								</Button>
							</div>
						</Notice>
					</Match>
					<Match when={state().status === "loading"}>
						<p class="text-xs text-gray-10">
							{L("正在加载更新日志…", "Loading the changelog…")}
						</p>
					</Match>
					<Match when={notes()?.length === 0}>
						<Notice
							title={L("还没有发布过版本", "No releases yet")}
							description={L(
								"第一个正式版发布后，这里会列出每个版本更新了什么。",
								"Once the first version ships, every release and what changed will be listed here.",
							)}
						/>
					</Match>
					<Match when={notes()}>
						{(list) => (
							<ol class="space-y-3">
								<For each={list()}>
									{(note) => <ReleaseEntry note={note} current={current()} />}
								</For>
							</ol>
						)}
					</Match>
				</Switch>
			</div>
		</div>
	);
}
