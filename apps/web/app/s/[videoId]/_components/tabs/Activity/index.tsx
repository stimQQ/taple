"use client";

import type { Video } from "@cap/web-domain";
import type React from "react";
import { forwardRef, type JSX, Suspense, useState } from "react";
import { CapCardAnalytics } from "@/app/(org)/dashboard/caps/components/CapCard/CapCardAnalytics";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { AuthOverlay } from "../../AuthOverlay";
import Analytics from "./Analytics";

interface ActivityProps {
	views: MaybePromise<number>;
	onSeek?: (time: number) => void;
	videoId: Video.VideoId;
	isOwnerOrMember: boolean;
}

export const Activity = Object.assign(
	forwardRef<{ scrollToBottom: () => void }, ActivityProps>(
		(
			{
				videoId,
				isOwnerOrMember,
				...props
			},
			ref,
		) => {
			return (
				<Activity.Shell
					analytics={
						<Suspense fallback={<CapCardAnalytics.Skeleton />}>
							<Analytics
								videoId={videoId}
								views={props.views}
								isLoadingAnalytics={false}
							/>
						</Suspense>
					}
					isOwnerOrMember={isOwnerOrMember}
				/>
			);
		},
	),
	{
		Shell: (props: {
			analytics?: JSX.Element;
			isOwnerOrMember: boolean;
			children?: (props: {
				setShowAuthOverlay: (show: boolean) => void;
			}) => JSX.Element;
		}) => {
			const user = useCurrentUser();
			const [showAuthOverlay, setShowAuthOverlay] = useState(false);

			return (
				<div className="flex flex-col h-full">
					{user && props.isOwnerOrMember && (
						<div className="flex flex-row items-center p-4 h-12 border-b border-gray-200">
							{props.analytics}
						</div>
					)}

					{props.children?.({ setShowAuthOverlay })}

					<AuthOverlay
						isOpen={showAuthOverlay}
						onClose={() => setShowAuthOverlay(false)}
					/>
				</div>
			);
		},
		Skeleton: (props: { isOwnerOrMember: boolean }) => (
			<Activity.Shell {...props} analytics={<CapCardAnalytics.Skeleton />} />
		),
	},
);
