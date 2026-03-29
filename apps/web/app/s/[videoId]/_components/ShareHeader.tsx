"use client";

import { buildEnv, NODE_ENV } from "@cap/env";
import { Button } from "@cap/ui";
import { faChevronDown } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Check, Copy } from "lucide-react";
import moment from "moment";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { editTitle } from "@/actions/videos/edit-title";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { UpgradeModal } from "@/components/UpgradeModal";
import { usePublicEnv } from "@/utils/public-env";
import type { VideoData } from "../types";

export const ShareHeader = ({
	data,
}: {
	data: VideoData;
}) => {
	const user = useCurrentUser();
	const { push, refresh } = useRouter();
	const [isEditing, setIsEditing] = useState(false);
	const [title, setTitle] = useState(data.name);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
	const [linkCopied, setLinkCopied] = useState(false);

	const isOwner = user && user.id === data.owner.id;

	const { webUrl } = usePublicEnv();

	useEffect(() => {
		setTitle(data.name);
	}, [data.name]);

	const handleBlur = async () => {
		setIsEditing(false);
		const next = title.trim();
		if (next === "" || next === data.name) return;
		try {
			await editTitle(data.id, title);
			toast.success("Video title updated");
			refresh();
		} catch (error) {
			if (error instanceof Error) {
				toast.error(error.message);
			} else {
				toast.error("Failed to update title - please try again.");
			}
		}
	};

	const handleKeyDown = async (event: { key: string }) => {
		if (event.key === "Enter") {
			handleBlur();
		}
	};

	const getVideoLink = () => {
		if (NODE_ENV === "development") {
			return `${webUrl}/s/${data.id}`;
		} else if (buildEnv.NEXT_PUBLIC_IS_CAP) {
			return `https://cap.link/${data.id}`;
		} else {
			return `${webUrl}/s/${data.id}`;
		}
	};

	const getDisplayLink = () => {
		if (NODE_ENV === "development") {
			return `${webUrl}/s/${data.id}`;
		} else if (buildEnv.NEXT_PUBLIC_IS_CAP) {
			return `cap.link/${data.id}`;
		} else {
			return `${webUrl}/s/${data.id}`;
		}
	};

	const renderSharedStatus = () => {
		if (isOwner) {
			const isPublic = data.public;

			if (!isPublic) {
				return (
					<Button
						className="px-3 w-fit pointer-events-none"
						size="xs"
						variant="outline"
					>
						Private
					</Button>
				);
			} else {
				return (
					<Button
						className="px-3 w-fit pointer-events-none"
						size="xs"
						variant="outline"
					>
						Public
					</Button>
				);
			}
		} else {
			return (
				<Button
					className="px-3 pointer-events-none w-fit"
					size="xs"
					variant="outline"
				>
					Shared with you
				</Button>
			);
		}
	};

	const userIsOwnerAndNotPro = user?.id === data.owner.id && !data.owner.isPro;

	return (
		<>
			{userIsOwnerAndNotPro && (
				<div className="flex sticky flex-col sm:flex-row inset-x-0 top-0 z-10 gap-4 justify-center items-center px-3 py-2 mx-auto w-[calc(100%-20px)] max-w-fit rounded-b-xl border bg-gray-4 border-gray-6">
					<p className="text-center text-gray-12">
						Shareable links are limited to 5 mins on the free plan.
					</p>
					<Button
						type="button"
						onClick={() => setUpgradeModalOpen(true)}
						size="sm"
						variant="blue"
					>
						Upgrade To Cap Pro
					</Button>
				</div>
			)}
			<div className="mt-8">
				<div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between lg:gap-0">
					<div className="items-center md:flex md:justify-between md:space-x-6">
						<div className="space-y-3">
							<div className="flex flex-col lg:min-w-[400px]">
								{isEditing ? (
									<input
										value={title}
										onChange={(e) => setTitle(e.target.value)}
										onBlur={handleBlur}
										onKeyDown={handleKeyDown}
										autoFocus
										className="w-full text-xl sm:text-2xl"
									/>
								) : (
									<h1
										className="text-xl sm:text-2xl"
										onClick={() => {
											if (isOwner) {
												setIsEditing(true);
											}
										}}
									>
										{title}
									</h1>
								)}
							</div>
							<div className="flex gap-7 items-center">
								<div className="flex gap-2 items-center">
									{data.name && (
										<SignedImageUrl
											name={data.name}
											image={data.owner.image}
											className="size-8"
											letterClass="text-base"
										/>
									)}
									<div className="flex flex-col text-left">
										<p className="text-sm text-gray-12">{data.owner.name}</p>
										<p className="text-xs text-gray-10">
											{moment(data.createdAt).fromNow()}
										</p>
									</div>
								</div>
								{user && renderSharedStatus()}
							</div>
						</div>
					</div>
					{user !== null && (
						<div className="flex space-x-2">
							<div>
								<div className="flex gap-2 items-center">
									<Button
										variant="white"
										onClick={() => {
											navigator.clipboard.writeText(getVideoLink());
											setLinkCopied(true);
											setTimeout(() => {
												setLinkCopied(false);
											}, 2000);
										}}
									>
										{getDisplayLink()}
										{linkCopied ? (
											<Check className="ml-2 w-4 h-4 svgpathanimation" />
										) : (
											<Copy className="ml-2 w-4 h-4" />
										)}
									</Button>
								</div>
							</div>
							{user !== null && (
								<div className="hidden md:flex">
									<Button
										onClick={() => {
											push("/dashboard/caps?page=1");
										}}
									>
										<span className="hidden text-sm text-white lg:block">
											Go to
										</span>{" "}
										Dashboard
									</Button>
								</div>
							)}
						</div>
					)}
				</div>
			</div>
			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>
		</>
	);
};
