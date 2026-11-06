import { Button } from "@cap/ui-solid";
import { createTimer } from "@solid-primitives/timer";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	createEffect,
	createResource,
	createSignal,
	For,
	Show,
	startTransition,
} from "solid-js";
import { generalSettingsStore } from "~/store";
import { L } from "~/utils/i18n";
import {
	commands,
	type OSPermission,
	type OSPermissionStatus,
} from "~/utils/tauri";

function isPermitted(status?: OSPermissionStatus): boolean {
	return status === "granted" || status === "notNeeded";
}

const permissions = [
	{
		name: L("屏幕录制", "Screen Recording"),
		key: "screenRecording" as const,
		description: L(
			"此权限用于录制你的屏幕。",
			"Required to record your screen.",
		),
		canSkip: true,
	},
	{
		name: L("辅助功能", "Accessibility"),
		key: "accessibility" as const,
		description: L(
			"录制期间，Taple 会在本地收集鼠标活动数据以生成自动缩放片段。",
			"During recording, Taple collects mouse activity locally to create automatic zoom segments.",
		),
		canSkip: true,
	},
] as const;

export default function () {
	const [initialCheck, setInitialCheck] = createSignal(true);
	const [check, checkActions] = createResource(() =>
		commands.doPermissionsCheck(initialCheck()),
	);
	const [skippedPermissions, setSkippedPermissions] = createSignal<Set<string>>(
		new Set(),
	);
	const [clickedPermissions, setClickedPermissions] = createSignal<Set<string>>(
		new Set(),
	);

	const isPermissionOk = (key: string, status?: OSPermissionStatus) => {
		return isPermitted(status) || skippedPermissions().has(key);
	};

	const allPermissionsGranted = () =>
		permissions.every((p) => isPermissionOk(p.key, check()?.[p.key]));

	const anyPermissionDenied = () =>
		permissions.some((p) => check()?.[p.key] === "denied");

	createEffect(() => {
		if (!initialCheck()) {
			createTimer(
				() => startTransition(() => checkActions.refetch()),
				250,
				setInterval,
			);
		}
	});

	const requestPermission = (permission: OSPermission) => {
		console.log({ permission });
		try {
			commands.requestPermission(permission);
			setClickedPermissions((prev) => new Set([...prev, permission]));
		} catch (err) {
			console.error(`Error occurred while requesting permission: ${err}`);
		}
		setInitialCheck(false);
	};

	const requestAllPermissions = () => {
		for (const p of permissions) {
			const status = check()?.[p.key];
			if (!isPermitted(status)) {
				if (status === "denied") {
					commands.openPermissionSettings(p.key);
				} else {
					commands.requestPermission(p.key);
				}
				setClickedPermissions((prev) => new Set([...prev, p.key]));
			}
		}
		setInitialCheck(false);
	};

	const openSettings = (permission: OSPermission) => {
		commands.openPermissionSettings(permission);
		setClickedPermissions((prev) => new Set([...prev, permission]));
		setInitialCheck(false);
	};

	const skipPermission = (key: string) => {
		setSkippedPermissions((prev) => new Set([...prev, key]));
	};

	const handleContinue = async () => {
		// Save permission override if user skipped any permissions
		if (skippedPermissions().size > 0) {
			await generalSettingsStore.set({ permissionsGrantedOverride: true });
		}
		// Just proceed to the main window without saving mode to store
		commands.showWindow({ Main: { init_target_mode: null } }).then(() => {
			getCurrentWindow().close();
		});
	};

	return (
		<div class="flex flex-col px-[2rem] text-[0.875rem] font-[400] flex-1 bg-gray-1 justify-evenly items-center">
			<div class="flex flex-col items-center">
				<IconCapLogo class="size-14 mb-3" />
				<h1 class="text-[1.2rem] font-[700] mb-1 text-[--text-primary]">
					{L("需要权限", "Permissions Required")}
				</h1>
				<p class="text-gray-11">
					{L(
						"Taple 需要以下权限才能正常运行。",
						"Taple needs the following permissions to work properly.",
					)}
				</p>
			</div>

			<div class="flex flex-col gap-4 py-8 w-full max-w-md">
				<Show when={!allPermissionsGranted()}>
					<Button class="w-full" size="lg" onClick={requestAllPermissions}>
						{anyPermissionDenied()
							? L("打开设置并授权全部权限", "Open Settings to Grant All")
							: L("一键授权全部权限", "Grant All Permissions")}
					</Button>
				</Show>

				<ul class="flex flex-col gap-4">
					<For each={permissions}>
						{(permission) => {
							const permissionCheck = () => check()?.[permission.key];
							const hasClicked = () => clickedPermissions().has(permission.key);
							const isSkipped = () => skippedPermissions().has(permission.key);
							const isOk = () =>
								isPermissionOk(permission.key, permissionCheck());

							return (
								<Show when={permissionCheck() !== "notNeeded"}>
									<li class="flex flex-col gap-2">
										<div class="flex flex-row items-center gap-4">
											<div class="flex flex-col flex-[2]">
												<div class="flex items-center gap-2">
													<span class="font-[500] text-[0.875rem] text-[--text-primary]">
														{L(`${permission.name}权限`, permission.name)}
													</span>
													<Show when={isOk()}>
														<span class="text-xs text-green-500">&#10003;</span>
													</Show>
												</div>
												<span class="text-[--text-secondary]">
													{permission.description}
												</span>
											</div>
											<div class="flex flex-col gap-2 flex-1 shrink-0">
												<Button
													class="w-full"
													onClick={() =>
														permissionCheck() !== "denied"
															? requestPermission(permission.key)
															: openSettings(permission.key)
													}
													disabled={isOk()}
												>
													{isOk()
														? L("已授权", "Granted")
														: permissionCheck() !== "denied"
															? L("授予权限", "Grant Permission")
															: L("打开设置", "Open Settings")}
												</Button>
												<Show
													when={
														permission.canSkip &&
														hasClicked() &&
														!isPermitted(permissionCheck()) &&
														!isSkipped()
													}
												>
													<button
														class="text-xs text-blue-500 hover:text-blue-400 underline"
														onClick={() => skipPermission(permission.key)}
													>
														{L(
															"已在设置中开启？点此跳过",
															"Already enabled in Settings? Skip",
														)}
													</button>
												</Show>
											</div>
										</div>
										<Show
											when={
												permission.canSkip &&
												hasClicked() &&
												!isPermitted(permissionCheck())
											}
										>
											<p class="text-xs text-gray-10 bg-gray-3 rounded px-2 py-1">
												{L(
													"提示：权限可能需要重启应用后才能生效",
													"Tip: You may need to restart the app for permissions to take effect.",
												)}
											</p>
										</Show>
									</li>
								</Show>
							);
						}}
					</For>
				</ul>
			</div>

			<Button
				class="px-12"
				size="lg"
				disabled={
					permissions.find((p) => !isPermissionOk(p.key, check()?.[p.key])) !==
					undefined
				}
				onClick={handleContinue}
			>
				{L("继续使用 Taple", "Continue to Taple")}
			</Button>
		</div>
	);
}
