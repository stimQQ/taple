import { L } from "~/utils/i18n";
import InfoPill from "./InfoPill";

export default function TargetSelectInfoPill<T>(props: {
	value: T | null;
	permissionGranted: boolean;
	requestPermission: () => void;
	onClick: (e: MouseEvent) => void;
}) {
	return (
		<InfoPill
			variant={props.value !== null && props.permissionGranted ? "blue" : "red"}
			onPointerDown={(e) => {
				if (!props.permissionGranted || props.value === null) return;

				e.stopPropagation();
			}}
			onClick={(e) => {
				if (!props.permissionGranted) {
					props.requestPermission();
					return;
				}

				props.onClick(e);
			}}
		>
			{!props.permissionGranted
				? L("请求权限", "Request Permission")
				: props.value !== null
					? L("开", "On")
					: L("关", "Off")}
		</InfoPill>
	);
}
