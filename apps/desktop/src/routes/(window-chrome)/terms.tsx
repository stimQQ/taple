import { L } from "~/utils/i18n";

export default function TermsOfService() {
	return (
		<div class="p-6 overflow-y-auto h-full">
			<div class="max-w-2xl mx-auto space-y-6">
				<h1 class="text-2xl font-bold text-gray-12">
					{L("用户协议", "Terms of Service")}
				</h1>
				<p class="text-sm text-gray-10">
					{L("最后更新：2024年12月", "Last updated: December 2024")}
				</p>

				<div class="space-y-4 text-sm text-gray-11">
					<p>
						{L(
							"欢迎使用 Taple。使用本软件即表示您同意以下条款。如果您不同意这些条款，请勿使用本软件。",
							"Welcome to Taple. By using this software, you agree to the following terms. If you do not agree to these terms, do not use this software.",
						)}
					</p>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("1. 服务说明", "1. Description of Service")}
						</h2>
						<p>
							{L(
								"Taple 是一款屏幕录制和视频编辑软件，提供以下功能：",
								"Taple is screen recording and video editing software that provides the following features:",
							)}
						</p>
						<ul class="list-disc list-inside space-y-1 ml-4">
							<li>{L("屏幕录制和窗口录制", "Screen and window recording")}</li>
							<li>{L("摄像头录制", "Camera recording")}</li>
							<li>{L("音频录制", "Audio recording")}</li>
							<li>{L("视频编辑和导出", "Video editing and export")}</li>
						</ul>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("2. 使用许可", "2. License")}
						</h2>
						<p>
							{L(
								"我们授予您非独占、不可转让的许可，允许您在个人设备上使用 Taple。您不得：",
								"We grant you a non-exclusive, non-transferable license to use Taple on your personal devices. You may not:",
							)}
						</p>
						<ul class="list-disc list-inside space-y-1 ml-4">
							<li>
								{L(
									"复制、修改或分发本软件",
									"Copy, modify, or distribute this software",
								)}
							</li>
							<li>
								{L("对本软件进行逆向工程", "Reverse engineer this software")}
							</li>
							<li>{L("移除任何版权声明", "Remove any copyright notices")}</li>
							<li>
								{L(
									"将本软件用于任何非法目的",
									"Use this software for any unlawful purpose",
								)}
							</li>
						</ul>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("3. 用户内容", "3. User Content")}
						</h2>
						<p>
							{L(
								"您对使用 Taple 创建的所有内容拥有完全的所有权。我们不会对您的录制内容主张任何权利。",
								"You retain full ownership of all content you create with Taple. We claim no rights to your recordings.",
							)}
						</p>
						<p>
							{L(
								"您有责任确保您录制的内容：",
								"You are responsible for ensuring that the content you record:",
							)}
						</p>
						<ul class="list-disc list-inside space-y-1 ml-4">
							<li>
								{L(
									"不侵犯他人的知识产权",
									"Does not infringe the intellectual property rights of others",
								)}
							</li>
							<li>
								{L(
									"不包含非法或有害内容",
									"Does not contain unlawful or harmful material",
								)}
							</li>
							<li>
								{L(
									"已获得被录制者的同意（如适用）",
									"Has the consent of the people being recorded (where applicable)",
								)}
							</li>
						</ul>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("4. 知识产权", "4. Intellectual Property")}
						</h2>
						<p>
							{L(
								"Taple 及其所有相关内容、功能和技术均受知识产权法保护。除非获得明确授权，您不得使用我们的商标、标志或其他专有信息。",
								"Taple and all related content, features, and technology are protected by intellectual property laws. You may not use our trademarks, logos, or other proprietary information without explicit permission.",
							)}
						</p>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("5. 免责声明", "5. Disclaimer")}
						</h2>
						<p>
							{L(
								'Taple 按"现状"提供，不提供任何明示或暗示的保证。我们不保证：',
								'Taple is provided "as is" without warranties of any kind, express or implied. We do not guarantee that:',
							)}
						</p>
						<ul class="list-disc list-inside space-y-1 ml-4">
							<li>
								{L(
									"软件将完全无错误或不间断运行",
									"The software will be error-free or run without interruption",
								)}
							</li>
							<li>
								{L(
									"软件将满足您的所有特定需求",
									"The software will meet all of your specific requirements",
								)}
							</li>
							<li>
								{L(
									"录制质量将始终如一",
									"Recording quality will always be consistent",
								)}
							</li>
						</ul>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("6. 责任限制", "6. Limitation of Liability")}
						</h2>
						<p>
							{L(
								"在法律允许的最大范围内，我们不对任何间接、附带、特殊或后果性损害承担责任，包括但不限于数据丢失、利润损失或业务中断。",
								"To the maximum extent permitted by law, we are not liable for any indirect, incidental, special, or consequential damages, including but not limited to loss of data, loss of profits, or business interruption.",
							)}
						</p>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("7. 条款修改", "7. Changes to These Terms")}
						</h2>
						<p>
							{L(
								"我们保留随时修改这些条款的权利。重大更改将通过应用程序更新通知您。继续使用本软件即表示您接受修改后的条款。",
								"We reserve the right to modify these terms at any time. We will notify you of significant changes through app updates. Continued use of this software means you accept the modified terms.",
							)}
						</p>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("8. 终止", "8. Termination")}
						</h2>
						<p>
							{L(
								"如果您违反本协议的任何条款，您使用本软件的权利将自动终止。终止后，您应删除本软件的所有副本。",
								"If you breach any term of this agreement, your right to use this software terminates automatically. Upon termination, you must delete all copies of this software.",
							)}
						</p>
					</section>

					<section class="space-y-2">
						<h2 class="text-lg font-semibold text-gray-12">
							{L("9. 联系方式", "9. Contact")}
						</h2>
						<p>
							{L(
								"如果您对本用户协议有任何疑问，请联系我们：",
								"If you have any questions about these Terms of Service, please contact us:",
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
