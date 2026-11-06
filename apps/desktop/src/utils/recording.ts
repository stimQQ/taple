import * as dialog from "@tauri-apps/plugin-dialog";
import { L } from "./i18n";
import type { RecordingAction } from "./tauri";

export function handleRecordingResult(result: Promise<RecordingAction>) {
	return result
		.then(async (result) => {
			if (result === "Started") return;
			await dialog.message(L(`错误：${result}`, `Error: ${result}`), {
				title: L("启动录制失败", "Error starting recording"),
			});
		})
		.catch((err) =>
			dialog.message(err, {
				title: L("启动录制失败", "Error starting recording"),
				kind: "error",
			}),
		);
}
