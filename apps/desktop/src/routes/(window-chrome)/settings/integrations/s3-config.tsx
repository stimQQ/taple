import { Button } from "@cap/ui-solid";
import { createEventBus } from "@solid-primitives/event-bus";
import { createWritableMemo } from "@solid-primitives/memo";
import { useMutation } from "@tanstack/solid-query";
import { createResource, Suspense } from "solid-js";
import { Input } from "~/routes/editor/ui";
import { L } from "~/utils/i18n";
import { commands } from "~/utils/tauri";
import { apiClient, protectedHeaders } from "~/utils/web-api";

interface S3Config {
	provider: string;
	accessKeyId: string;
	secretAccessKey: string;
	endpoint: string;
	bucketName: string;
	region: string;
}

const DEFAULT_CONFIG = {
	provider: "aws",
	accessKeyId: "",
	secretAccessKey: "",
	endpoint: "https://s3.amazonaws.com",
	bucketName: "",
	region: "us-east-1",
};

export default function S3ConfigPage() {
	const [_s3Config, { refetch }] = createResource(async () => {
		const response = await apiClient.desktop.getS3Config({
			headers: await protectedHeaders(),
		});

		if (response.status !== 200) throw new Error("Failed to fetch S3 config");

		return response.body.config;
	});

	const hasConfig = () => !!_s3Config()?.accessKeyId;

	const saveConfig = useMutation(() => ({
		mutationFn: async (config: S3Config) => {
			const response = await apiClient.desktop.setS3Config({
				body: config,
				headers: await protectedHeaders(),
			});

			if (response.status !== 200) throw new Error("Failed to save S3 config");
			return response;
		},
		onSuccess: async () => {
			await refetch();
			await commands.globalMessageDialog(
				L("S3 配置保存成功", "S3 configuration saved"),
			);
		},
	}));

	const deleteConfig = useMutation(() => ({
		mutationFn: async () => {
			const response = await apiClient.desktop.deleteS3Config({
				headers: await protectedHeaders(),
			});

			if (response.status !== 200)
				throw new Error("Failed to delete S3 config");
			return response;
		},
		onSuccess: async () => {
			await refetch();
			await commands.globalMessageDialog(
				L("S3 配置已删除", "S3 configuration deleted"),
			);
		},
	}));

	const testConfig = useMutation(() => ({
		mutationFn: async (config: S3Config) => {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 5500); // 5.5s timeout (slightly longer than backend)

			try {
				const response = await apiClient.desktop.testS3Config({
					body: config,
					headers: await protectedHeaders(),
					fetchOptions: { signal: controller.signal },
				});

				clearTimeout(timeoutId);

				if (response.status !== 200)
					throw new Error(
						L(
							"S3 连接测试失败。请检查你的配置和网络连接。",
							"S3 connection test failed. Check your configuration and network connection.",
						),
					);

				return response;
			} catch (error) {
				clearTimeout(timeoutId);

				if (error instanceof Error) {
					if (error.name === "AbortError")
						throw new Error(
							L(
								"连接测试超时（5秒）。请检查你的端点 URL 和网络连接。",
								"Connection test timed out (5s). Check your endpoint URL and network connection.",
							),
						);
				}

				throw error;
			}
		},
		onSuccess: async () => {
			await commands.globalMessageDialog(
				L(
					"S3 配置测试成功！连接正常。",
					"S3 configuration test passed. Connection is working.",
				),
			);
		},
	}));

	const events = createEventBus<"save" | "test">();

	return (
		<div class="flex flex-col p-4 h-full">
			<div class="rounded-xl border bg-gray-2 border-gray-4 custom-scroll">
				<div class="flex-1">
					<Suspense
						fallback={
							<div class="flex justify-center items-center w-full h-screen">
								<IconCapLogo class="animate-spin size-16" />
							</div>
						}
					>
						{(() => {
							const [s3Config, setS3Config] = createWritableMemo(
								() => _s3Config.latest ?? DEFAULT_CONFIG,
							);

							const renderInput = (
								label: string,
								key: keyof ReturnType<typeof s3Config>,
								placeholder: string,
								type: "text" | "password" = "text",
							) => (
								<div class="space-y-2">
									<label class="text-[13px] text-gray-12">{label}</label>
									<Input
										class="!bg-gray-3"
										type={type}
										value={s3Config()[key] ?? ""}
										onInput={(
											e: InputEvent & { currentTarget: HTMLInputElement },
										) =>
											setS3Config({
												...s3Config(),
												[key]: e.currentTarget.value,
											})
										}
										placeholder={placeholder}
										autocomplete="off"
										autocapitalize="off"
										autocorrect="off"
										spellcheck={false}
									/>
								</div>
							);

							events.listen((v) => {
								if (v === "save") saveConfig.mutate(s3Config());
								else if (v === "test") testConfig.mutate(s3Config());
							});

							return (
								<div class="p-4 space-y-4 animate-in fade-in">
									<div class="pb-4 border-b border-gray-3">
										<p class="text-sm text-gray-11">
											{L(
												"设置并连接你的存储桶到 Taple 只需不到 10 分钟。查看",
												"Setting up and connecting your storage bucket to Taple takes under 10 minutes. See the",
											)}{" "}
											<a
												href="https://taple.app/docs/s3-config"
												target="_blank"
												class="underline text-gray-12"
												rel="noopener"
											>
												{L("存储配置指南", "Storage Config Guide")}
											</a>{" "}
											{L("开始使用。", "to get started.")}
										</p>
									</div>

									<div class="space-y-2">
										<label class="text-[13px] text-gray-12">
											{L("存储提供商", "Storage Provider")}
										</label>
										<div class="relative">
											<select
												value={s3Config().provider}
												onChange={(e) =>
													setS3Config((c) => ({
														...c,
														provider: e.currentTarget.value,
													}))
												}
												class="px-3 py-2 pr-10 w-full rounded-lg border border-transparent transition-all duration-200 appearance-none outline-none bg-gray-3 focus:border-gray-8"
											>
												<option value="aws">AWS S3</option>
												<option value="cloudflare">Cloudflare R2</option>
												<option value="supabase">Supabase</option>
												<option value="minio">MinIO</option>
												<option value="other">
													{L("其他 S3 兼容服务", "Other S3-Compatible")}
												</option>
											</select>
											<div class="flex absolute inset-y-0 right-0 items-center px-2 pointer-events-none">
												<svg
													class="w-4 h-4 text-gray-11"
													xmlns="http://www.w3.org/2000/svg"
													viewBox="0 0 20 20"
													fill="currentColor"
												>
													<path
														fill-rule="evenodd"
														d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
														clip-rule="evenodd"
													/>
												</svg>
											</div>
										</div>
									</div>

									{renderInput(
										L("访问密钥 ID", "Access Key ID"),
										"accessKeyId",
										"PL31OADSQNK",
										"password",
									)}
									{renderInput(
										L("访问密钥", "Secret Access Key"),
										"secretAccessKey",
										"PL31OADSQNK",
										"password",
									)}
									{renderInput(
										L("端点", "Endpoint"),
										"endpoint",
										"https://s3.amazonaws.com",
									)}
									{renderInput(
										L("存储桶名称", "Bucket Name"),
										"bucketName",
										"my-bucket",
									)}
									{renderInput(L("区域", "Region"), "region", "us-east-1")}
								</div>
							);
						})()}
					</Suspense>
				</div>
			</div>
			<div class="flex-shrink-0 mt-5">
				<fieldset
					class="flex justify-between items-center"
					disabled={
						_s3Config.loading ||
						saveConfig.isPending ||
						deleteConfig.isPending ||
						testConfig.isPending
					}
				>
					<div class="flex gap-2">
						{!_s3Config.loading && hasConfig() && (
							<Button
								variant="destructive"
								onClick={() => deleteConfig.mutate()}
							>
								{deleteConfig.isPending
									? L("删除中...", "Deleting...")
									: L("删除配置", "Delete Config")}
							</Button>
						)}
						<Button variant="gray" onClick={() => events.emit("test")}>
							{testConfig.isPending
								? L("测试中...", "Testing...")
								: L("测试连接", "Test Connection")}
						</Button>
					</div>
					<Button
						class="min-w-[72px]"
						variant="primary"
						onClick={() => events.emit("save")}
					>
						{saveConfig.isPending
							? L("保存中...", "Saving...")
							: L("保存", "Save")}
					</Button>
				</fieldset>
			</div>
		</div>
	);
}
