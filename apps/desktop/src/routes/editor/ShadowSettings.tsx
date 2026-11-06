import { cx } from "cva";
import { createSignal } from "solid-js";
import { L } from "~/utils/i18n";
import { Field, Slider } from "./ui";

interface Props {
	size: {
		value: number[];
		onChange: (v: number[]) => void;
	};
	opacity: {
		value: number[];
		onChange: (v: number[]) => void;
	};
	blur: {
		value: number[];
		onChange: (v: number[]) => void;
	};
	scrollRef?: HTMLDivElement;
}

const ShadowSettings = (props: Props) => {
	const [isOpen, setIsOpen] = createSignal(false);

	const handleToggle = () => {
		setIsOpen(!isOpen());
		if (props.scrollRef) {
			setTimeout(() => {
				props.scrollRef!.scrollTo({
					top: props.scrollRef!.scrollHeight,
					behavior: "smooth",
				});
			}, 50);
		}
	};

	return (
		<div class="w-full">
			<button
				type="button"
				onClick={handleToggle}
				class="flex gap-1 items-center w-full font-medium text-left transition duration-200 text-gray-12 hover:text-gray-10"
			>
				<span>{L("高级阴影设置", "Advanced Shadow Settings")}</span>
				<IconCapChevronDown
					class={cx(
						"size-5",
						isOpen() ? "transition-transform rotate-180" : "",
					)}
				/>
			</button>

			{isOpen() && (
				<div class="mt-4 space-y-4 font-medium">
					<Field name={L("大小", "Size")} inline>
						<Slider
							value={props.size.value}
							onChange={props.size.onChange}
							minValue={0}
							maxValue={100}
							step={0.1}
						/>
					</Field>
					<Field name={L("不透明度", "Opacity")} inline>
						<Slider
							value={props.opacity.value}
							onChange={props.opacity.onChange}
							minValue={0}
							maxValue={100}
							step={0.1}
						/>
					</Field>
					<Field name={L("模糊", "Blur")} inline>
						<Slider
							value={props.blur.value}
							onChange={props.blur.onChange}
							minValue={0}
							maxValue={100}
							step={0.1}
						/>
					</Field>
				</div>
			)}
		</div>
	);
};

export default ShadowSettings;
