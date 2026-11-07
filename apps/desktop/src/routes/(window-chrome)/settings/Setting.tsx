import { cx } from "cva";
import type { ParentProps } from "solid-js";
import { Toggle } from "~/components/Toggle";

export function SettingItem(props: {
	pro?: boolean;
	label: string;
	description?: string;
	children: any;
}) {
	return (
		<div class="flex flex-row gap-2 justify-between items-center py-3 text-sm">
			<div class="flex flex-col justify-between items-start space-y-1">
				<div class="flex gap-2 items-center">
					<p class="text-gray-12">{props.label}</p>
				</div>
				{props.description && (
					<p class="text-xs text-gray-11">{props.description}</p>
				)}
			</div>
			{props.children}
		</div>
	);
}

export function ToggleSettingItem(props: {
	pro?: boolean;
	label: string;
	description?: string;
	value: boolean;
	onChange(v: boolean): void;
}) {
	return (
		<SettingItem {...props}>
			<Toggle
				size="sm"
				checked={props.value}
				onChange={(v) => props.onChange(v)}
			/>
		</SettingItem>
	);
}

export function Group(
	props: ParentProps<{
		title: string;
		id?: string;
		highlighted?: boolean;
		ref?: (element: HTMLDivElement) => void;
	}>,
) {
	return (
		<div ref={props.ref} id={props.id} class="scroll-mt-4">
			<h3 class="mb-3 text-sm text-gray-12 w-fit">{props.title}</h3>
			<div
				class={cx(
					"px-3 rounded-xl border divide-y divide-gray-3 bg-gray-2 transition-[box-shadow,border-color] duration-500",
					props.highlighted
						? "border-blue-9 ring-2 ring-blue-9/40"
						: "border-gray-3",
				)}
			>
				{props.children}
			</div>
		</div>
	);
}
