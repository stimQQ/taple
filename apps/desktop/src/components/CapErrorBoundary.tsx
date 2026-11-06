import { Button } from "@cap/ui-solid";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ErrorBoundary, type ParentProps } from "solid-js";
import { L } from "~/utils/i18n";

export function CapErrorBoundary(props: ParentProps) {
	return (
		<ErrorBoundary
			fallback={(e: Error) => {
				console.error(e);
				return (
					<div class="w-full h-full flex flex-col justify-center items-center bg-gray-2 border-gray-3 max-h-screen overflow-hidden transition-[border-radius] duration-200 text-[--text-secondary] gap-y-4 max-sm:gap-y-2 px-8 text-center">
						<IconCapLogo class="max-sm:size-16" />
						<h1 class="text-[--text-primary] text-3xl max-sm:text-xl font-bold">
							{L("发生错误", "An Error Occurred")}
						</h1>
						<p class="mb-2 max-sm:text-sm">
							{L("非常抱歉，程序出了点问题。", "Sorry, something went wrong.")}
						</p>
						<div class="flex flex-row gap-4 max-sm:flex-col max-sm:gap-2">
							<Button
								onClick={() => {
									writeText(`${e.toString()}\n\n${e.stack}`);
								}}
							>
								{L("复制错误信息", "Copy Error")}
							</Button>
							<Button
								onClick={() => {
									location.reload();
								}}
								variant="gray"
							>
								{L("重新加载", "Reload")}
							</Button>
						</div>

						{import.meta.env.DEV && (
							<div class="h-0 text-sm">
								<pre class="text-left mt-8">{`${e.toString()}\n\n${e.stack
									?.toString()
									.split("\n")
									.slice(0, 10)
									.join("\n")}`}</pre>
							</div>
						)}
					</div>
				);
			}}
		>
			{props.children}
		</ErrorBoundary>
	);
}
