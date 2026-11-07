import { Select as KSelect } from "@kobalte/core/select";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
	createEffect,
	createMemo,
	createResource,
	onCleanup,
	Show,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import toast from "solid-toast";
import { L } from "~/utils/i18n";
import {
	type CaptionFont,
	commands,
	events,
	type FontCategory,
} from "~/utils/tauri";
import {
	MenuItem,
	MenuItemList,
	PopperContent,
	topLeftAnimateClasses,
} from "./ui";

type FontOption = {
	value: string;
	label: string;
	font?: CaptionFont;
};

type FontGroup = {
	label: string;
	options: FontOption[];
};

const SYSTEM_OPTIONS: FontOption[] = [
	{ value: "System Sans-Serif", label: L("系统无衬线", "System Sans-Serif") },
	{ value: "System Serif", label: L("系统衬线", "System Serif") },
	{ value: "System Monospace", label: L("系统等宽", "System Monospace") },
];

const CATEGORY_ORDER: FontCategory[] = [
	"sans",
	"display",
	"handwriting",
	"serif",
	"mono",
];

const CATEGORY_LABELS: Record<FontCategory, string> = {
	sans: L("无衬线", "Sans-serif"),
	display: L("标题展示", "Display"),
	handwriting: L("手写与书法", "Handwriting"),
	serif: L("衬线", "Serif"),
	mono: L("等宽", "Monospace"),
};

const loadedPreviews = new Set<string>();

function previewFamily(font: CaptionFont) {
	return `taple-preview-${font.id}`;
}

async function loadPreview(font: CaptionFont) {
	const file = font.files[0];
	if (!font.downloaded || !file || loadedPreviews.has(font.id)) return;
	loadedPreviews.add(font.id);
	try {
		const face = new FontFace(
			previewFamily(font),
			`url("${convertFileSrc(file)}")`,
		);
		await face.load();
		document.fonts.add(face);
	} catch {
		loadedPreviews.delete(font.id);
	}
}

function formatSize(bytes: number) {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function CaptionFontPicker(props: {
	value: string;
	onChange: (family: string) => void;
}) {
	const [fonts, { mutate }] = createResource(
		() => commands.listCaptionFonts(),
		{ initialValue: [] },
	);
	const [downloads, setDownloads] = createStore<Record<string, number>>({});

	const unlisten = events.captionFontDownloadProgress.listen((event) => {
		if (downloads[event.payload.fontId] === undefined) return;
		setDownloads(event.payload.fontId, event.payload.progress);
	});
	onCleanup(() => {
		unlisten.then((stop) => stop());
	});

	const groups = createMemo<FontGroup[]>(() => [
		{ label: L("系统字体", "System"), options: SYSTEM_OPTIONS },
		...CATEGORY_ORDER.map((category) => ({
			label: CATEGORY_LABELS[category],
			options: fonts()
				.filter((font) => font.category === category)
				.map((font) => ({ value: font.family, label: font.name, font })),
		})).filter((group) => group.options.length > 0),
	]);

	const options = createMemo(() => groups().flatMap((group) => group.options));

	const selected = createMemo(
		() =>
			options().find((option) => option.value === props.value) ??
			SYSTEM_OPTIONS[0],
	);

	const activeDownload = createMemo(() => {
		const id = Object.keys(downloads)[0];
		if (!id) return undefined;
		const font = fonts().find((f) => f.id === id);
		return font ? { font, progress: downloads[id] } : undefined;
	});

	createEffect(() => {
		const font = selected().font;
		if (font) void loadPreview(font);
	});

	const download = async (font: CaptionFont) => {
		if (downloads[font.id] !== undefined) return;
		setDownloads(font.id, 0);
		try {
			const updated = await commands.downloadCaptionFont(font.id);
			mutate((list) => list.map((f) => (f.id === updated.id ? updated : f)));
			await loadPreview(updated);
			props.onChange(updated.family);
		} catch (error) {
			toast.error(String(error));
		} finally {
			setDownloads(
				produce((state) => {
					delete state[font.id];
				}),
			);
		}
	};

	const choose = (option: FontOption | null) => {
		if (!option) return;
		if (option.font && !option.font.downloaded) {
			void download(option.font);
			return;
		}
		props.onChange(option.value);
	};

	const fontStyle = (font?: CaptionFont) =>
		font?.downloaded
			? { "font-family": `"${previewFamily(font)}", system-ui, sans-serif` }
			: undefined;

	return (
		<div class="flex flex-col items-end gap-1">
			<KSelect<FontOption, FontGroup>
				options={groups()}
				optionValue="value"
				optionTextValue="label"
				optionGroupChildren="options"
				value={selected()}
				onChange={choose}
				onOpenChange={(open) => {
					if (open) for (const font of fonts()) void loadPreview(font);
				}}
				sectionComponent={(sectionProps) => (
					<KSelect.Section class="px-[0.675rem] pt-2 pb-0.5 text-[11px] font-medium text-gray-9">
						{sectionProps.section.rawValue.label}
					</KSelect.Section>
				)}
				itemComponent={(itemProps) => {
					const option = () => itemProps.item.rawValue;
					return (
						<MenuItem<typeof KSelect.Item>
							as={KSelect.Item}
							item={itemProps.item}
						>
							<KSelect.ItemLabel
								class="flex-1 truncate"
								style={fontStyle(option().font)}
							>
								{option().label}
							</KSelect.ItemLabel>
							<Show when={option().font?.downloaded === false && option().font}>
								{(font) => (
									<Show
										when={downloads[font().id] !== undefined}
										fallback={
											<span class="flex gap-1 items-center text-[10px] text-gray-9 shrink-0">
												<IconLucideDownload class="size-3" />
												{formatSize(font().sizeBytes)}
											</span>
										}
									>
										<span class="text-[10px] text-blue-11 shrink-0">
											{Math.round((downloads[font().id] ?? 0) * 100)}%
										</span>
									</Show>
								)}
							</Show>
						</MenuItem>
					);
				}}
			>
				<KSelect.Trigger class="flex flex-row items-center h-8 px-2 gap-1 border rounded-lg border-gray-200 w-[160px] text-gray-700 text-xs">
					<KSelect.Value<FontOption>
						class="flex-1 text-left truncate"
						style={fontStyle(selected().font)}
					>
						{(state) => state.selectedOption()?.label ?? selected().label}
					</KSelect.Value>
					<KSelect.Icon>
						<IconCapChevronDown class="size-3 shrink-0" />
					</KSelect.Icon>
				</KSelect.Trigger>
				<KSelect.Portal>
					<PopperContent<typeof KSelect.Content>
						as={KSelect.Content}
						class={topLeftAnimateClasses}
					>
						<MenuItemList<typeof KSelect.Listbox>
							class="max-h-72 overflow-y-auto"
							as={KSelect.Listbox}
						/>
					</PopperContent>
				</KSelect.Portal>
			</KSelect>
			<Show when={activeDownload()}>
				{(active) => (
					<span class="text-[10px] text-gray-10">
						{L("正在下载", "Downloading")} {active().font.name}{" "}
						{Math.round(active().progress * 100)}%
					</span>
				)}
			</Show>
		</div>
	);
}
