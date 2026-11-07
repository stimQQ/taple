import { Button } from "@cap/ui-solid";
import * as shell from "@tauri-apps/plugin-shell";
import { createSignal, onMount, Show } from "solid-js";
import { L } from "~/utils/i18n";
import {
	commands,
	type FeedbackError,
	type SystemDiagnostics,
} from "~/utils/tauri";
import { Group, ToggleSettingItem } from "./Setting";

const MAX_MESSAGE_LENGTH = 5000;
const CONTACT_EMAIL = "hello@taple.app";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.][^\s@]*\.[^\s@]+$/;

const ERROR_TEXT: Record<FeedbackError, () => string> = {
	invalid: () =>
		L(
			"内容或邮箱格式不对，请检查后再发送。",
			"Please check your message and email address.",
		),
	rateLimited: () =>
		L(
			"发送得太频繁了，请过半分钟再试。",
			"You're sending too quickly. Please wait half a minute.",
		),
	unavailable: () =>
		L(
			`反馈服务暂时不可用，请稍后再试，或直接发邮件到 ${CONTACT_EMAIL}。`,
			`Feedback is temporarily unavailable. Try again later or email ${CONTACT_EMAIL}.`,
		),
	network: () =>
		L(
			"没有连上网络，请检查网络后重试。",
			"Couldn't connect. Check your network and try again.",
		),
};

function errorText(error: unknown) {
	return typeof error === "string" && error in ERROR_TEXT
		? ERROR_TEXT[error as FeedbackError]()
		: ERROR_TEXT.unavailable();
}

function describeSystem(info: SystemDiagnostics) {
	return [
		`Taple ${info.appVersion}`,
		info.osVersion,
		info.chip,
		info.model,
		info.locale,
	].join(" · ");
}

type Status =
	| { kind: "idle" }
	| { kind: "sent"; email: string | null }
	| { kind: "error"; text: string };

export default function FeedbackSettings() {
	const [message, setMessage] = createSignal("");
	const [email, setEmail] = createSignal("");
	const [includeDiagnostics, setIncludeDiagnostics] = createSignal(true);
	const [includeLog, setIncludeLog] = createSignal(false);
	const [sending, setSending] = createSignal(false);
	const [status, setStatus] = createSignal<Status>({ kind: "idle" });
	const [diagnostics, setDiagnostics] = createSignal<SystemDiagnostics>();

	onMount(() => {
		void commands
			.systemDiagnostics()
			.then(setDiagnostics)
			.catch(() => undefined);
	});

	const systemSummary = () => {
		const info = diagnostics();
		return info
			? describeSystem(info)
			: L(
					"Taple 版本、macOS 版本、芯片和机型。",
					"Taple version, macOS version, chip and Mac model.",
				);
	};

	const trimmedEmail = () => email().trim();
	const emailValid = () =>
		trimmedEmail() === "" || EMAIL_PATTERN.test(trimmedEmail());
	const canSend = () =>
		message().trim().length > 0 && emailValid() && !sending();

	const hint = () => {
		const current = status();
		if (current.kind === "error") return { text: current.text, error: true };
		if (current.kind === "sent") {
			return {
				text: current.email
					? L(
							`已发送，回复会发到 ${current.email}。`,
							`Sent. We'll reply to ${current.email}.`,
						)
					: L("已发送，谢谢你的反馈！", "Sent. Thanks for the feedback!"),
				error: false,
			};
		}
		if (!emailValid()) {
			return {
				text: L("邮箱格式不正确。", "This email address looks wrong."),
				error: true,
			};
		}
		return {
			text: L("只用来回复这条反馈。", "Only used to reply to you."),
			error: false,
		};
	};

	const send = async (event: SubmitEvent) => {
		event.preventDefault();
		if (!canSend()) return;
		setSending(true);
		try {
			await commands.sendFeedback({
				message: message().trim(),
				email: trimmedEmail() || null,
				includeDiagnostics: includeDiagnostics(),
				includeLog: includeLog(),
			});
			setMessage("");
			setStatus({ kind: "sent", email: trimmedEmail() || null });
		} catch (error) {
			setStatus({ kind: "error", text: errorText(error) });
		} finally {
			setSending(false);
		}
	};

	return (
		<div class="flex flex-col h-full custom-scroll">
			<form class="p-4 space-y-6" onSubmit={send}>
				<p class="text-xs leading-relaxed text-gray-11">
					{L(
						"遇到问题或有想法，直接写在这里。内容会以邮件发给 Taple 的开发者，留下邮箱的话我们会回复你。",
						"Found a bug or have an idea? Write it here. It goes to the Taple developers by email, and we'll reply if you leave your address.",
					)}
				</p>

				<Group title={L("反馈内容", "Message")}>
					<div class="flex flex-col gap-4 py-3">
						<label class="flex flex-col gap-2">
							<span class="text-sm text-gray-12">
								{L(
									"发生了什么，或者你希望 Taple 怎么改进？",
									"What happened, or what would you like Taple to do better?",
								)}
							</span>
							<textarea
								value={message()}
								onInput={(event) => {
									setMessage(event.currentTarget.value);
									setStatus({ kind: "idle" });
								}}
								maxLength={MAX_MESSAGE_LENGTH}
								rows={7}
								placeholder={L(
									"比如：录外接显示器时，导出 4K 视频卡在 90%。",
									"For example: exporting a 4K video stops at 90% when I record an external display.",
								)}
								class="w-full px-3 py-2 text-sm leading-relaxed rounded-lg border outline-none transition-colors resize-y min-h-32 border-gray-4 bg-gray-1 text-gray-12 placeholder:text-gray-9 focus:border-blue-9"
							/>
							<Show when={message().length > MAX_MESSAGE_LENGTH * 0.8}>
								<span class="self-end text-xs text-gray-10">
									{message().length} / {MAX_MESSAGE_LENGTH}
								</span>
							</Show>
						</label>

						<div class="flex flex-col gap-2">
							<label for="feedback-email" class="text-sm text-gray-12">
								{L("邮箱（选填）", "Email (optional)")}
							</label>
							<div class="flex flex-row gap-2 items-center">
								<input
									id="feedback-email"
									type="email"
									value={email()}
									onInput={(event) => {
										setEmail(event.currentTarget.value);
										setStatus({ kind: "idle" });
									}}
									autocomplete="email"
									spellcheck={false}
									placeholder="you@example.com"
									class="flex-1 min-w-0 h-9 px-3 text-sm rounded-lg border outline-none transition-colors border-gray-4 bg-gray-1 text-gray-12 placeholder:text-gray-9 focus:border-blue-9"
								/>
								<Button
									type="submit"
									size="md"
									variant="dark"
									class="h-9 shrink-0"
									disabled={!canSend()}
								>
									{sending() ? L("发送中…", "Sending…") : L("发送", "Send")}
								</Button>
							</div>
							<p
								aria-live="polite"
								class={
									hint().error
										? "text-xs leading-relaxed text-red-9"
										: "text-xs leading-relaxed text-gray-10"
								}
							>
								{hint().text}
							</p>
						</div>
					</div>
				</Group>

				<Group title={L("附带信息", "Attachments")}>
					<ToggleSettingItem
						label={L("附带系统信息", "Include system info")}
						description={systemSummary()}
						value={includeDiagnostics()}
						onChange={setIncludeDiagnostics}
					/>
					<ToggleSettingItem
						label={L("附带最近的运行日志", "Include recent logs")}
						description={L(
							"帮助排查崩溃、录制或导出失败。日志里的用户目录会替换成 ~。",
							"Helps us find crashes and failed recordings or exports. Your home folder is replaced with ~.",
						)}
						value={includeLog()}
						onChange={setIncludeLog}
					/>
				</Group>

				<p class="text-xs text-gray-10">
					{L("也可以直接发邮件到 ", "You can also email ")}
					<button
						type="button"
						class="underline underline-offset-2 hover:text-gray-12"
						onClick={() => shell.open(`mailto:${CONTACT_EMAIL}`)}
					>
						{CONTACT_EMAIL}
					</button>
				</p>
			</form>
		</div>
	);
}
