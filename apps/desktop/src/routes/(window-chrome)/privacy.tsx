import { L } from "~/utils/i18n";

export default function PrivacyPolicy() {
	return (
		<div class="p-6 overflow-y-auto h-full">
			<div class="max-w-2xl mx-auto space-y-6">
				<h1 class="text-2xl font-bold text-gray-12">
					{L("隐私政策", "Privacy Policy")}
				</h1>
				<p class="text-sm text-gray-10">
					{L("最后更新：2024年12月", "Last updated: December 2024")}
				</p>

				<div class="space-y-4 text-sm text-gray-11">
					<p>
						{L(
							'Taple（以下简称"我们"）致力于保护您的隐私和个人信息安全。本隐私政策说明了我们如何收集、使用和保护您的信息。',
							'Taple ("we" or "us") is committed to protecting your privacy and the security of your personal information. This Privacy Policy explains how we collect, use, and protect your information.',
						)}
					</p>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("1. 信息收集", "1. Information Collection")}
						</h2>
						<p>{L("在纯本地模式下，Taple：", "In local-only mode, Taple:")}</p>
						<ul class="list-disc list-inside space-y-1 ml-4">
							<li>
								{L(
									"不收集任何个人身份信息",
									"Does not collect any personally identifiable information",
								)}
							</li>
							<li>
								{L(
									"不上传您的录制内容到任何服务器",
									"Does not upload your recordings to any server",
								)}
							</li>
							<li>
								{L(
									"所有数据都存储在您的本地设备上",
									"Stores all data locally on your device",
								)}
							</li>
							<li>
								{L(
									"不使用任何第三方分析服务",
									"Does not use any third-party analytics services",
								)}
							</li>
						</ul>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("2. 本地数据存储", "2. Local Data Storage")}
						</h2>
						<p>
							{L(
								"Taple 会在您的设备上存储以下数据：",
								"Taple stores the following data on your device:",
							)}
						</p>
						<ul class="list-disc list-inside space-y-1 ml-4">
							<li>
								{L(
									"录制的视频和截图文件",
									"Recorded videos and screenshot files",
								)}
							</li>
							<li>{L("应用程序设置和偏好", "App settings and preferences")}</li>
							<li>{L("编辑项目文件", "Editor project files")}</li>
						</ul>
						<p>
							{L(
								"这些数据完全由您控制，您可以随时删除。",
								"This data is fully under your control, and you can delete it at any time.",
							)}
						</p>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("3. 系统权限", "3. System Permissions")}
						</h2>
						<p>
							{L(
								"为了正常运行，Taple 需要以下系统权限：",
								"To work properly, Taple needs the following system permissions:",
							)}
						</p>
						<ul class="list-disc list-inside space-y-1 ml-4">
							<li>
								<strong>{L("屏幕录制：", "Screen Recording: ")}</strong>
								{L("用于捕获屏幕内容", "To capture screen content")}
							</li>
							<li>
								<strong>{L("摄像头：", "Camera: ")}</strong>
								{L(
									"用于录制摄像头画面（可选）",
									"To record camera footage (optional)",
								)}
							</li>
							<li>
								<strong>{L("麦克风：", "Microphone: ")}</strong>
								{L("用于录制音频（可选）", "To record audio (optional)")}
							</li>
							<li>
								<strong>{L("辅助功能：", "Accessibility: ")}</strong>
								{L("用于控制录制操作", "To control recording actions")}
							</li>
						</ul>
						<p>
							{L(
								"这些权限仅用于应用的核心功能，不会被用于其他目的。",
								"These permissions are used only for the app's core features and never for any other purpose.",
							)}
						</p>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("4. 数据安全", "4. Data Security")}
						</h2>
						<p>
							{L(
								"由于所有数据都存储在您的本地设备上，数据安全取决于您设备的安全措施。我们建议您：",
								"Because all data is stored locally on your device, its security depends on your device's security measures. We recommend that you:",
							)}
						</p>
						<ul class="list-disc list-inside space-y-1 ml-4">
							<li>
								{L(
									"定期备份重要的录制文件",
									"Regularly back up important recordings",
								)}
							</li>
							<li>
								{L(
									"使用设备的加密功能保护敏感内容",
									"Use your device's encryption to protect sensitive content",
								)}
							</li>
							<li>
								{L(
									"不要与不信任的人共享录制文件",
									"Avoid sharing recordings with people you don't trust",
								)}
							</li>
						</ul>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("5. 儿童隐私", "5. Children's Privacy")}
						</h2>
						<p>
							{L(
								"Taple 不面向 13 岁以下的儿童。我们不会故意收集儿童的个人信息。",
								"Taple is not intended for children under 13. We do not knowingly collect personal information from children.",
							)}
						</p>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("6. 政策更新", "6. Policy Updates")}
						</h2>
						<p>
							{L(
								"我们可能会不时更新本隐私政策。任何更改都将在应用程序更新时通知您。",
								"We may update this Privacy Policy from time to time. We will notify you of any changes through app updates.",
							)}
						</p>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("7. 联系我们", "7. Contact Us")}
						</h2>
						<p>
							{L(
								"如果您对本隐私政策有任何疑问，请通过以下方式联系我们：",
								"If you have any questions about this Privacy Policy, please contact us at:",
							)}
						</p>
						<p class="text-gray-12">
							{L("邮箱：support@taple.app", "Email: support@taple.app")}
						</p>
					</section>
				</div>
			</div>
		</div>
	);
}
