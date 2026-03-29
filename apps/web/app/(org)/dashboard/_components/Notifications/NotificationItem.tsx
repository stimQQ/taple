import type { Notification as APINotification } from "@cap/web-api-contract";
import type { ImageUpload } from "@cap/web-domain";
import { faEye, faSmile } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import moment from "moment";
import Link from "next/link";
import { markAsRead } from "@/actions/notifications/mark-as-read";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import type { NotificationType } from "@/lib/Notification";

type NotificationItemProps = {
	notification: APINotification;
	className?: string;
};

const descriptionMap: Record<NotificationType, string> = {
	view: `viewed your video`,
	reaction: `reacted to your video`,
};

export const NotificationItem = ({
	notification,
	className,
}: NotificationItemProps) => {
	const link = `/s/${notification.videoId}`;

	const markAsReadHandler = async () => {
		try {
			await markAsRead(notification.id);
		} catch (error) {
			console.error("Error marking notification as read:", error);
		}
	};

	return (
		<Link
			href={link}
			onClick={markAsReadHandler}
			className={clsx(
				"flex gap-3 p-4 transition-colors cursor-pointer min-h-fit border-gray-3 hover:bg-gray-2",
				className,
			)}
		>
			<div className="relative flex-shrink-0">
				<SignedImageUrl
					image={notification.author.avatar as ImageUpload.ImageUrl | null}
					name={notification.author.name}
					className="relative flex-shrink-0 size-7"
					letterClass="text-sm"
				/>
				{notification.readAt === null && (
					<div className="absolute top-0 right-0 size-2.5 rounded-full bg-red-500 border-2 border-gray-1"></div>
				)}
			</div>

			<div className="flex flex-col flex-1 justify-center">
				<div className="flex gap-1 items-center">
					<span className="font-medium text-gray-12 text-[13px]">
						{notification.author.name}
					</span>
					<span className="text-gray-10 text-[13px]">
						{descriptionMap[notification.type]}
					</span>
				</div>
				<p className="text-xs text-gray-10">
					{moment(notification.createdAt).fromNow()}
				</p>
			</div>

			<div className="flex flex-shrink-0 items-center mt-1">
				{notification.type === "view" && (
					<FontAwesomeIcon icon={faEye} className="text-gray-10 size-4" />
				)}
				{notification.type === "reaction" && (
					<FontAwesomeIcon icon={faSmile} className="text-gray-10 size-4" />
				)}
			</div>
		</Link>
	);
};
