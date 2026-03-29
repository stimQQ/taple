import * as dialog from "@tauri-apps/plugin-dialog";
import { commands, type RecordingAction } from "./tauri";

export function handleRecordingResult(result: Promise<RecordingAction>) {
	return result
		.then(async (result) => {
			if (result === "Started") return;
			if (result === "UpgradeRequired") commands.showWindow("Upgrade");
			else
				await dialog.message(`Error: ${result}`, {
					title: "Error starting recording",
				});
		})
		.catch((err) =>
			dialog.message(err, {
				title: "Error starting recording",
				kind: "error",
			}),
		);
}
