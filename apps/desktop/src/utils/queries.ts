import { createEventListener } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import { createQuery, queryOptions, useMutation } from "@tanstack/solid-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createMemo } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { useRecordingOptions } from "~/routes/(window-chrome)/OptionsContext";
import { recordingSettingsStore } from "~/store";
import { createQueryInvalidate } from "./events";
import {
	type CameraInfo,
	commands,
	type DeviceOrModelID,
	type ScreenCaptureTarget,
} from "./tauri";

export const listWindows = queryOptions({
	queryKey: ["capture", "windows"] as const,
	queryFn: async () => {
		const w = await commands.listCaptureWindows();

		w.sort(
			(a, b) =>
				a.owner_name.localeCompare(b.owner_name) ||
				a.name.localeCompare(b.name),
		);

		return w;
	},
	reconcile: "id",
	refetchInterval: false,
});

export const listScreens = queryOptions({
	queryKey: ["capture", "displays"] as const,
	queryFn: () => commands.listCaptureDisplays(),
	reconcile: "id",
	refetchInterval: 1000,
});

export const listWindowsWithThumbnails = queryOptions({
	queryKey: ["capture", "windows-thumbnails"] as const,
	queryFn: async () => {
		const w = await commands.listWindowsWithThumbnails();

		w.sort(
			(a, b) =>
				a.owner_name.localeCompare(b.owner_name) ||
				a.name.localeCompare(b.name),
		);

		return w;
	},
	reconcile: "id",
	refetchInterval: false,
});

export const listDisplaysWithThumbnails = queryOptions({
	queryKey: ["capture", "displays-thumbnails"] as const,
	queryFn: () => commands.listDisplaysWithThumbnails(),
	reconcile: "id",
	refetchInterval: 1000,
});

const getCurrentRecording = queryOptions({
	queryKey: ["currentRecording"] as const,
	queryFn: () => commands.getCurrentRecording().then((d) => d[0]),
});

export const listVideoDevices = queryOptions({
	queryKey: ["videoDevices"] as const,
	queryFn: () => commands.listCameras(),
	refetchInterval: 1000,
	initialData: [],
});

export function createVideoDevicesQuery() {
	const query = createQuery(() => listVideoDevices);

	const [videoDevicesStore, setVideoDevices] = createStore<CameraInfo[]>([]);

	createMemo(() => {
		setVideoDevices(reconcile(query.data ?? []));
	});

	return videoDevicesStore;
}

export const listAudioDevices = queryOptions({
	queryKey: ["audioDevices"] as const,
	queryFn: () => commands.listAudioDevices(),
	reconcile: "name",
	refetchInterval: 1000,
	gcTime: 0,
	staleTime: 0,
});

export const getPermissions = queryOptions({
	queryKey: ["permissionsOS"] as const,
	queryFn: () => commands.doPermissionsCheck(true),
	refetchInterval: 1000,
});

export function createOptionsQuery() {
	const PERSIST_KEY = "recording-options-query-2";
	const [_state, _setState] = createStore<{
		captureTarget: ScreenCaptureTarget;
		micName?: string | null;
		captureSystemAudio?: boolean;
		targetMode?: "display" | "window" | "area" | null;
		cameraID?: DeviceOrModelID | null;
		organizationId?: string | null;
		/** @deprecated */
		cameraLabel: string | null;
	}>({
		captureTarget: { variant: "display", id: "0" },
		captureSystemAudio: true,
		cameraLabel: null,
		organizationId: null,
	});

	createEventListener(window, "storage", (e) => {
		if (e.key === PERSIST_KEY) _setState(JSON.parse(e.newValue ?? "{}"));
	});

	createEffect(() => {
		recordingSettingsStore.set({
			target: _state.captureTarget,
			micName: _state.micName ?? null,
			cameraId: _state.cameraID,
			systemAudio: _state.captureSystemAudio,
			organizationId: _state.organizationId,
		});
	});

	const [state, setState] = makePersisted([_state, _setState], {
		name: PERSIST_KEY,
	});

	return { rawOptions: state, setOptions: setState };
}

export function createCurrentRecordingQuery() {
	const currentRecording = createQuery(() => getCurrentRecording);

	createQueryInvalidate(currentRecording, "currentRecordingChanged");

	return currentRecording;
}

export function createCameraMutation() {
	const { setOptions, rawOptions } = useRecordingOptions();

	const rawMutate = async (model: DeviceOrModelID | null) => {
		const before = rawOptions.cameraID ? { ...rawOptions.cameraID } : null;
		setOptions("cameraID", reconcile(model));
		if (model) {
			await commands.showWindow("Camera");
			getCurrentWindow().setFocus();
		}

		await commands.setCameraInput(model).catch(async (e) => {
			if (JSON.stringify(before) === JSON.stringify(model) || !before) {
				setOptions("cameraID", null);
			} else setOptions("cameraID", reconcile(before));

			throw e;
		});
	};

	const setCameraInput = useMutation(() => ({
		mutationFn: rawMutate,
	}));

	return new Proxy(
		setCameraInput as typeof setCameraInput & { rawMutate: typeof rawMutate },
		{
			get(target, key) {
				if (key === "rawMutate") return rawMutate;
				return Reflect.get(target, key);
			},
		},
	);
}
