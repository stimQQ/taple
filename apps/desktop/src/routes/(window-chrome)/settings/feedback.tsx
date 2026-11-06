import { Button } from "@cap/ui-solid";
import { action, useAction, useSubmission } from "@solidjs/router";
import { getVersion } from "@tauri-apps/api/app";
import { type as ostype } from "@tauri-apps/plugin-os";
import { createSignal } from "solid-js";
import toast from "solid-toast";

import { L } from "~/utils/i18n";
import { commands } from "~/utils/tauri";
import { apiClient, protectedHeaders } from "~/utils/web-api";

const sendFeedbackAction = action(async (feedback: string) => {
	const response = await apiClient.desktop.submitFeedback({
		body: { feedback, os: ostype() as any, version: await getVersion() },
		headers: await protectedHeaders(),
	});

	if (response.status !== 200) throw new Error("Failed to submit feedback");
	return response.body;
});

export default function FeedbackTab() {
	const [feedback, setFeedback] = createSignal("");
	const [uploadingLogs, setUploadingLogs] = createSignal(false);

	const submission = useSubmission(sendFeedbackAction);
	const sendFeedback = useAction(sendFeedbackAction);

	const handleUploadLogs = async () => {
		setUploadingLogs(true);
		try {
			await commands.uploadLogs();
			toast.success(L("日志上传成功", "Logs uploaded"));
		} catch (error) {
			toast.error(L("日志上传失败", "Failed to upload logs"));
			console.error("Failed to upload logs:", error);
		} finally {
			setUploadingLogs(false);
		}
	};

	return (
		<div class="flex flex-col w-full h-full">
			<div class="flex-1 custom-scroll">
				<div class="p-4 space-y-4">
					<div class="flex flex-col pb-4 border-b border-gray-2">
						<h2 class="text-lg font-medium text-gray-12">
							{L("发送反馈", "Send Feedback")}
						</h2>
						<p class="text-sm text-gray-10">
							{L(
								"提交反馈或报告问题，帮助我们改进 Taple。我们会尽快处理。",
								"Share feedback or report an issue to help us improve Taple. We'll get back to you soon.",
							)}
						</p>
					</div>
					<form
						class="space-y-4"
						onSubmit={(e) => {
							e.preventDefault();
							sendFeedback(feedback());
						}}
					>
						<fieldset disabled={submission.pending}>
							<div>
								<textarea
									value={feedback()}
									onInput={(e) => setFeedback(e.currentTarget.value)}
									placeholder={L(
										"告诉我们你对 Taple 的想法...",
										"Tell us what you think about Taple...",
									)}
									required
									minLength={10}
									class="p-2 w-full h-32 text-[13px] rounded-md border transition-colors duration-200 resize-none bg-gray-2 placeholder:text-gray-10 border-gray-3 text-primary focus:outline-none focus:ring-1 focus:ring-gray-8 hover:border-gray-6"
								/>
							</div>

							{submission.error && (
								<p class="mt-2 text-sm text-red-400">
									{submission.error.toString()}
								</p>
							)}

							{submission.result?.success && (
								<p class="text-sm text-primary">
									{L("感谢你的反馈！", "Thanks for your feedback!")}
								</p>
							)}

							<Button
								type="submit"
								size="md"
								variant="dark"
								disabled={feedback().trim().length < 4}
								class="mt-2"
							>
								{submission.pending
									? L("提交中...", "Submitting...")
									: L("提交反馈", "Submit Feedback")}
							</Button>
						</fieldset>
					</form>

					<div class="pt-6 border-t border-gray-2">
						<h3 class="text-sm font-medium text-gray-12 mb-2">
							{L("调试信息", "Debug Information")}
						</h3>
						<p class="text-sm text-gray-10 mb-3">
							{L(
								"上传日志帮助我们诊断 Taple 的问题。不包含任何个人信息。",
								"Upload logs to help us diagnose issues with Taple. No personal information is included.",
							)}
						</p>
						<Button
							onClick={handleUploadLogs}
							size="md"
							variant="gray"
							disabled={uploadingLogs()}
						>
							{uploadingLogs()
								? L("上传中...", "Uploading...")
								: L("上传日志", "Upload Logs")}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
