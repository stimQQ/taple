import Tooltip from "~/components/Tooltip";

const Mode = () => {
	return (
		<div class="flex gap-2 relative justify-end items-center p-1.5 rounded-full bg-gray-3 w-fit">
			<Tooltip
				placement="top"
				content="工作室模式"
				openDelay={0}
				closeDelay={0}
			>
				<div
					class="flex justify-center items-center transition-all duration-200 rounded-full size-7 ring-2 ring-offset-1 ring-offset-gray-1 bg-gray-7 ring-blue-500"
				>
					<IconCapFilmCut class="size-3.5 invert dark:invert-0" />
				</div>
			</Tooltip>
		</div>
	);
};

export default Mode;
