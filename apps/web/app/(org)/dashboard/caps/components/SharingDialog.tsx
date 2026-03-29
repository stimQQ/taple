import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Switch,
} from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { faCopy, faShareNodes } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { Globe2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { shareCap } from "@/actions/caps/share";
import { usePublicEnv } from "@/utils/public-env";

interface SharingDialogProps {
	isOpen: boolean;
	onClose: () => void;
	capId: Video.VideoId;
	capName: string;
	isPublic?: boolean;
	onSharingUpdated?: () => void;
}

export const SharingDialog: React.FC<SharingDialogProps> = ({
	isOpen,
	onClose,
	capId,
	capName,
	isPublic = false,
	onSharingUpdated,
}) => {
	const [publicToggle, setPublicToggle] = useState(isPublic);
	const [initialPublicState, setInitialPublicState] = useState(isPublic);
	const tabs = ["Share", "Embed"] as const;
	const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("Share");

	const updateSharing = useMutation({
		mutationFn: async ({
			capId,
			public: isPublic,
		}: {
			capId: Video.VideoId;
			public: boolean;
		}) => {
			const result = await shareCap({ capId, public: isPublic });

			if (!result.success) {
				throw new Error(result.error || "Failed to update sharing settings");
			}
		},
		onSuccess: () => {
			const publicChanged = publicToggle !== initialPublicState;

			if (publicChanged) {
				toast.success(
					publicToggle ? "Video is now public" : "Video is now private",
				);
			} else {
				toast.info("No changes to sharing settings");
			}
			onSharingUpdated?.();
			onClose();
		},
		onError: () => {
			toast.error("Failed to update sharing settings");
		},
	});

	useEffect(() => {
		if (isOpen) {
			setPublicToggle(isPublic);
			setInitialPublicState(isPublic);
			setActiveTab(tabs[0]);
		}
	}, [isOpen, isPublic]);

	const embedCode = useEmbedCode(capId);

	const handleCopyEmbedCode = async () => {
		try {
			await navigator.clipboard.writeText(embedCode);
			toast.success("Embed code copied to clipboard");
		} catch (error) {
			toast.error("Failed to copy embed code");
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faShareNodes} className="size-3.5" />}
					description={
						activeTab === "Share"
							? "Select how you would like to share the cap"
							: "Copy the embed code to share your cap"
					}
				>
					<DialogTitle className="truncate w-full max-w-[320px]">
						{activeTab === "Share" ? `Share ${capName}` : `Embed ${capName}`}
					</DialogTitle>
				</DialogHeader>

				<div className="flex w-full h-12 border-b bg-gray-1 border-gray-4">
					{tabs.map((tab) => (
						<div
							key={tab}
							className={clsx(
								"flex relative flex-1 justify-center items-center w-full min-w-0 text-sm font-medium transition-colors",
								activeTab === tab
									? "cursor-not-allowed bg-gray-3"
									: "cursor-pointer",
							)}
							onClick={() => setActiveTab(tab)}
						>
							<p
								className={clsx(
									activeTab === tab
										? "text-gray-12 font-medium"
										: "text-gray-10",
									"text-sm",
								)}
							>
								{tab}
							</p>
						</div>
					))}
				</div>

				<div className="p-5">
					{activeTab === "Share" ? (
						<div className="flex justify-between items-center p-3 rounded-lg border bg-gray-1 border-gray-4">
							<div className="flex gap-3 items-center">
								<div className="flex justify-center items-center w-8 h-8 rounded-full bg-gray-3">
									<Globe2 className="w-4 h-4 text-gray-11" />
								</div>
								<div>
									<p className="text-sm font-medium text-gray-12">
										Anyone with the link
									</p>
									<p className="text-xs text-gray-10">
										{publicToggle
											? "Anyone on the internet with the link can view"
											: "Only people with access can view"}
									</p>
								</div>
							</div>
							<Switch
								checked={publicToggle}
								onCheckedChange={setPublicToggle}
							/>
						</div>
					) : (
						<div className="space-y-4">
							<div className="p-3 rounded-lg border bg-gray-3 border-gray-4">
								<code className="font-mono text-xs break-all text-gray-11">
									{embedCode}
								</code>
							</div>
							<Button
								className="w-full font-medium"
								variant="dark"
								onClick={handleCopyEmbedCode}
							>
								<FontAwesomeIcon icon={faCopy} className="size-3.5 mr-1" />
								Copy embed code
							</Button>
						</div>
					)}
				</div>

				<DialogFooter className="p-5 border-t border-gray-4">
					{activeTab === "Share" ? (
						<>
							<Button size="sm" variant="gray" onClick={onClose}>
								Cancel
							</Button>
							<Button
								spinner={updateSharing.isPending}
								disabled={updateSharing.isPending}
								size="sm"
								variant="dark"
								onClick={() =>
									updateSharing.mutate({
										capId,
										public: publicToggle,
									})
								}
							>
								{updateSharing.isPending ? "Saving..." : "Save"}
							</Button>
						</>
					) : (
						<Button size="sm" variant="gray" onClick={onClose}>
							Close
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

function useEmbedCode(capId: Video.VideoId) {
	const publicEnv = usePublicEnv();

	return useMemo(
		() =>
			`
	<div style="position: relative; padding-bottom: 56.25%; height: 0;">
			<iframe
			src="${publicEnv.webUrl}/embed/${capId}"
			frameborder="0"
			webkitallowfullscreen
			mozallowfullscreen
			allowfullscreen
			style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"
		></iframe>
	</div>
`
				.trim()
				.replace(/[\n\t]+/g, " ")
				.replace(/>\s+</g, "><")
				.replace(/"\s+>/g, '">'),
		[publicEnv.webUrl, capId],
	);
}
