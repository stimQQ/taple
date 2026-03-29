import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	organizations,
	sharedVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { buildEnv } from "@cap/env";
import { Logo } from "@cap/ui";
import { userIsPro } from "@cap/utils";
import {
	ImageUploads,
	provideOptionalAuth,
	Videos,
} from "@cap/web-backend";
import { VideosPolicy } from "@cap/web-backend/src/Videos/VideosPolicy";
import {
	type ImageUpload,
	type Organisation,
	Policy,
	type Video,
} from "@cap/web-domain";
import { eq, type InferSelectModel, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { generateAiMetadata } from "@/actions/videos/generate-ai-metadata";
import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import type { OrganizationSettings } from "@/app/(org)/dashboard/dashboard-data";
import { createNotification } from "@/lib/Notification";
import * as EffectRuntime from "@/lib/server";
import { runPromise } from "@/lib/server";
import { transcribeVideo } from "@/lib/transcribe";
import { isAiGenerationEnabled } from "@/utils/flags";
import { ShareHeader } from "./_components/ShareHeader";
import { Share } from "./Share";

const ALLOWED_REFERRERS = [
	"x.com",
	"twitter.com",
	"facebook.com",
	"fb.com",
	"slack.com",
	"notion.so",
	"linkedin.com",
];

export async function generateMetadata(
	props: PageProps<"/s/[videoId]">,
): Promise<Metadata> {
	const params = await props.params;
	const videoId = params.videoId as Video.VideoId;

	const referrer = (await headers()).get("x-referrer") || "";
	const isAllowedReferrer = ALLOWED_REFERRERS.some((domain) =>
		referrer.includes(domain),
	);

	return Effect.flatMap(Videos, (v) => v.getByIdForViewing(videoId)).pipe(
		Effect.map(
			Option.match({
				onNone: () => notFound(),
				onSome: ([video]) => ({
					title: video.name + " | Cap Recording",
					description: "Watch this video on SparkVideo",
					openGraph: {
						images: [
							{
								url: new URL(
									`/api/video/og?videoId=${videoId}`,
									buildEnv.NEXT_PUBLIC_WEB_URL,
								).toString(),
								width: 1200,
								height: 630,
							},
						],
						videos: [
							{
								url: new URL(
									`/api/playlist?videoId=${video.id}`,
									buildEnv.NEXT_PUBLIC_WEB_URL,
								).toString(),
								width: 1280,
								height: 720,
								type: "video/mp4",
							},
						],
					},
					twitter: {
						card: "player",
						title: video.name + " | Cap Recording",
						description: "Watch this video on SparkVideo",
						images: [
							new URL(
								`/api/video/og?videoId=${videoId}`,
								buildEnv.NEXT_PUBLIC_WEB_URL,
							).toString(),
						],
						players: {
							playerUrl: new URL(
								`/s/${videoId}`,
								buildEnv.NEXT_PUBLIC_WEB_URL,
							).toString(),
							streamUrl: new URL(
								`/api/playlist?videoId=${video.id}`,
								buildEnv.NEXT_PUBLIC_WEB_URL,
							).toString(),
							width: 1280,
							height: 720,
						},
					},
					robots: isAllowedReferrer ? "index, follow" : "noindex, nofollow",
				}),
			}),
		),
		Effect.catchTags({
			PolicyDenied: () =>
				Effect.succeed({
					title: "Cap: This video is private",
					description: "This video is private and cannot be shared.",
					openGraph: {
						images: [
							{
								url: new URL(
									`/api/video/og?videoId=${videoId}`,
									buildEnv.NEXT_PUBLIC_WEB_URL,
								).toString(),
								width: 1200,
								height: 630,
							},
						],
						videos: [
							{
								url: new URL(
									`/api/playlist?videoId=${videoId}`,
									buildEnv.NEXT_PUBLIC_WEB_URL,
								).toString(),
								width: 1280,
								height: 720,
								type: "video/mp4",
							},
						],
					},
					robots: "noindex, nofollow",
				}),
		}),
		provideOptionalAuth,
		EffectRuntime.runPromise,
	);
}

export default async function ShareVideoPage(props: PageProps<"/s/[videoId]">) {
	const params = await props.params;
	const searchParams = await props.searchParams;
	const videoId = params.videoId as Video.VideoId;

	return Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		const [video] = yield* Effect.promise(() =>
			db()
				.select({
					id: videos.id,
					name: videos.name,
					orgId: videos.orgId,
					createdAt: videos.createdAt,
					updatedAt: videos.updatedAt,
					bucket: videos.bucket,
					metadata: videos.metadata,
					public: videos.public,
					videoStartTime: videos.videoStartTime,
					audioStartTime: videos.audioStartTime,
					awsRegion: videos.awsRegion,
					awsBucket: videos.awsBucket,
					xStreamInfo: videos.xStreamInfo,
					jobId: videos.jobId,
					jobStatus: videos.jobStatus,
					isScreenshot: videos.isScreenshot,
					skipProcessing: videos.skipProcessing,
					transcriptionStatus: videos.transcriptionStatus,
					source: videos.source,
					videoSettings: videos.settings,
					width: videos.width,
					height: videos.height,
					duration: videos.duration,
					fps: videos.fps,
					sharedOrganization: {
						organizationId: sharedVideos.organizationId,
					},
					orgSettings: organizations.settings,
					hasActiveUpload: sql`${videoUploads.videoId} IS NOT NULL`.mapWith(
						Boolean,
					),
					owner: users,
				})
				.from(videos)
				.leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
				.innerJoin(users, eq(videos.ownerId, users.id))
				.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
				.leftJoin(organizations, eq(videos.orgId, organizations.id))
				.where(eq(videos.id, videoId)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));

		return Option.fromNullable(video);
	}).pipe(
		Effect.flatten,
		Effect.map((video) => (
			<div key={videoId} className="flex flex-col min-h-screen bg-gray-2">
				<AuthorizedContent video={video} searchParams={searchParams} />
			</div>
		)),
		Effect.catchTags({
			PolicyDenied: () =>
				Effect.succeed(
					<div
						key={videoId}
						className="flex flex-col justify-center items-center p-4 min-h-screen text-center"
					>
						<Logo className="size-32" />
						<h1 className="mb-2 text-2xl font-semibold">
							This video is private
						</h1>
						<p className="text-gray-400">
							If you own this video, please <Link href="/login">sign in</Link>{" "}
							to manage sharing.
						</p>
					</div>,
				),
			NoSuchElementException: () => Effect.sync(() => notFound()),
		}),
		provideOptionalAuth,
		EffectRuntime.runPromise,
	);
}

async function AuthorizedContent({
	video,
	searchParams,
}: {
	video: Omit<
		InferSelectModel<typeof videos>,
		"folderId" | "settings" | "ownerId"
	> & {
		owner: InferSelectModel<typeof users>;
		sharedOrganization: { organizationId: Organisation.OrganisationId } | null;
		orgSettings?: OrganizationSettings | null;
		videoSettings?: OrganizationSettings | null;
	};
	searchParams: { [key: string]: string | string[] | undefined };
}) {
	// will have already been fetched if auth is required
	const user = await getCurrentUser();
	const videoId = video.id;

	if (user && video && user.id !== video.owner.id) {
		try {
			await createNotification({
				type: "view",
				videoId: video.id,
				authorId: user.id,
			});
		} catch (error) {
			console.warn("Failed to create view notification:", error);
		}
	}

	const userId = user?.id;

	let aiGenerationEnabled = false;
	const videoOwnerQuery = await db()
		.select({
			email: users.email,
			stripeSubscriptionStatus: users.stripeSubscriptionStatus,
		})
		.from(users)
		.where(eq(users.id, video.owner.id))
		.limit(1);

	if (videoOwnerQuery.length > 0 && videoOwnerQuery[0]) {
		const videoOwner = videoOwnerQuery[0];
		aiGenerationEnabled = await isAiGenerationEnabled(videoOwner);
	}

	if (video.sharedOrganization?.organizationId) {
		const organization = await db()
			.select()
			.from(organizations)
			.where(eq(organizations.id, video.sharedOrganization.organizationId))
			.limit(1);

		if (organization[0]?.allowedEmailDomain) {
			if (
				!user?.email ||
				!user.email.endsWith(`@${organization[0].allowedEmailDomain}`)
			) {
				console.log(
					"[ShareVideoPage] Access denied - domain restriction:",
					organization[0].allowedEmailDomain,
				);
				return (
					<div className="flex flex-col justify-center items-center p-4 min-h-screen text-center">
						<h1 className="mb-4 text-2xl font-bold">Access Restricted</h1>
						<p className="mb-2 text-gray-10">
							This video is only accessible to members of this organization.
						</p>
						<p className="text-gray-600">
							Please sign in with your organization email address to access this
							content.
						</p>
					</div>
				);
			}
		}
	}

	if (
		video.transcriptionStatus !== "COMPLETE" &&
		video.transcriptionStatus !== "PROCESSING"
	) {
		console.log("[ShareVideoPage] Starting transcription for video:", videoId);
		await transcribeVideo(videoId, video.owner.id, aiGenerationEnabled);

		const updatedVideoQuery = await db()
			.select({
				id: videos.id,
				name: videos.name,
				createdAt: videos.createdAt,
				updatedAt: videos.updatedAt,
				bucket: videos.bucket,
				metadata: videos.metadata,
				public: videos.public,
				videoStartTime: videos.videoStartTime,
				audioStartTime: videos.audioStartTime,
				xStreamInfo: videos.xStreamInfo,
				jobId: videos.jobId,
				jobStatus: videos.jobStatus,
				isScreenshot: videos.isScreenshot,
				skipProcessing: videos.skipProcessing,
				transcriptionStatus: videos.transcriptionStatus,
				source: videos.source,
				sharedOrganization: {
					organizationId: sharedVideos.organizationId,
				},
				orgSettings: organizations.settings,
				videoSettings: videos.settings,
			})
			.from(videos)
			.leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
			.innerJoin(users, eq(videos.ownerId, users.id))
			.leftJoin(organizations, eq(videos.orgId, organizations.id))
			.where(eq(videos.id, videoId))
			.execute();

		if (updatedVideoQuery[0]) {
			Object.assign(video, updatedVideoQuery[0]);
			console.log(
				"[ShareVideoPage] Updated transcription status:",
				video.transcriptionStatus,
			);
		}
	}

	const currentMetadata = (video.metadata as VideoMetadata) || {};
	const metadata = currentMetadata;
	let initialAiData = null;

	if (metadata.summary || metadata.chapters || metadata.aiTitle) {
		initialAiData = {
			title: metadata.aiTitle || null,
			summary: metadata.summary || null,
			chapters: metadata.chapters || null,
			processing: metadata.aiProcessing || false,
		};
	} else if (metadata.aiProcessing) {
		initialAiData = {
			title: null,
			summary: null,
			chapters: null,
			processing: true,
		};
	}

	if (
		video.transcriptionStatus === "COMPLETE" &&
		!currentMetadata.aiProcessing &&
		!currentMetadata.summary &&
		!currentMetadata.chapters &&
		// !currentMetadata.generationError &&
		aiGenerationEnabled
	) {
		try {
			generateAiMetadata(videoId, video.owner.id).catch((error) => {
				console.error(
					`[ShareVideoPage] Error generating AI metadata for video ${videoId}:`,
					error,
				);
			});
		} catch (error) {
			console.error(
				`[ShareVideoPage] Error starting AI metadata generation for video ${videoId}:`,
				error,
			);
		}
	}

	const sharedOrganizationsPromise = db()
		.select({ id: sharedVideos.organizationId, name: organizations.name })
		.from(sharedVideos)
		.innerJoin(organizations, eq(sharedVideos.organizationId, organizations.id))
		.where(eq(sharedVideos.videoId, videoId));

	const userOrganizationsPromise = (async () => {
		if (!userId) return [];

		const [ownedOrganizations, memberOrganizations] = await Promise.all([
			db()
				.select({ id: organizations.id, name: organizations.name })
				.from(organizations)
				.where(eq(organizations.ownerId, userId)),
			db()
				.select({ id: organizations.id, name: organizations.name })
				.from(organizations)
				.innerJoin(
					organizationMembers,
					eq(organizations.id, organizationMembers.organizationId),
				)
				.where(eq(organizationMembers.userId, userId)),
		]);

		const allOrganizations = [...ownedOrganizations, ...memberOrganizations];
		const uniqueOrganizationIds = new Set();

		return allOrganizations.filter((organization) => {
			if (uniqueOrganizationIds.has(organization.id)) return false;
			uniqueOrganizationIds.add(organization.id);
			return true;
		});
	})();

	const membersListPromise = video.sharedOrganization?.organizationId
		? db()
				.select({ userId: organizationMembers.userId })
				.from(organizationMembers)
				.where(
					eq(
						organizationMembers.organizationId,
						video.sharedOrganization.organizationId,
					),
				)
		: Promise.resolve([]);

	const viewsPromise = getVideoAnalytics(videoId).then((v) => v.count);

	const [membersList, userOrganizations, sharedOrganizations] =
		await Promise.all([
			membersListPromise,
			userOrganizationsPromise,
			sharedOrganizationsPromise,
		]);

	const videoWithOrganizationInfo = await Effect.gen(function* () {
		const imageUploads = yield* ImageUploads;

		return {
			...video,
			owner: {
				id: video.owner.id,
				name: video.owner.name,
				isPro: userIsPro(video.owner),
				image: video.owner.image
					? yield* imageUploads.resolveImageUrl(video.owner.image)
					: null,
			},
			organization: {
				organizationMembers: membersList.map((member) => member.userId),
				organizationId: video.sharedOrganization?.organizationId ?? undefined,
			},
			sharedOrganizations: sharedOrganizations,
			folderId: null,
			orgSettings: video.orgSettings || null,
			settings: video.videoSettings || null,
		};
	}).pipe(runPromise);

	return (
		<>
			<div className="container flex-1 px-4 mx-auto">
				<ShareHeader
					data={{
						...videoWithOrganizationInfo,
						createdAt: video.metadata?.customCreatedAt
							? new Date(video.metadata.customCreatedAt)
							: video.createdAt,
					}}
				/>

				<Share
					data={videoWithOrganizationInfo}
					videoSettings={videoWithOrganizationInfo.settings}
					views={viewsPromise}
					initialAiData={initialAiData}
					aiGenerationEnabled={aiGenerationEnabled}
				/>
			</div>
			<div className="py-4 mt-auto">
				<a
					target="_blank"
					href={`/?ref=video_${video.id}`}
					className="flex justify-center items-center px-4 py-2 mx-auto mb-2 space-x-2 bg-white rounded-full border border-gray-5 w-fit"
				>
					<span className="text-sm">Recorded with</span>
					<Logo className="w-14 h-auto" />
				</a>
			</div>
		</>
	);
}
