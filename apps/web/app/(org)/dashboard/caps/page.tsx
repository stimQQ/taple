import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	folders,
	organizations,
	sharedVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { ImageUploads } from "@cap/web-backend";
import { type ImageUpload, Video } from "@cap/web-domain";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { runPromise } from "@/lib/server";
import { Caps } from "./Caps";

export const metadata: Metadata = {
	title: "My Caps — SparkVideo",
};

export default async function CapsPage(props: PageProps<"/dashboard/caps">) {
	const searchParams = await props.searchParams;
	const user = await getCurrentUser();

	if (!user || !user.id) {
		redirect("/login");
	}

	const page = Number(searchParams.page) || 1;
	const limit = Number(searchParams.limit) || 15;

	const userId = user.id;
	const offset = (page - 1) * limit;

	const totalCountResult = await db()
		.select({ count: count() })
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(
			and(
				eq(videos.ownerId, userId),
				eq(organizations.id, user.activeOrganizationId),
			),
		);

	const totalCount = totalCountResult[0]?.count || 0;

	const videoData = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			createdAt: videos.createdAt,
			metadata: videos.metadata,
			duration: videos.duration,
			public: videos.public,
			sharedOrganizations: sql<
				{
					id: string;
					name: string;
					iconUrl: ImageUpload.ImageUrlOrKey | null;
				}[]
			>`
        COALESCE(
          JSON_ARRAYAGG(
            JSON_OBJECT(
              'id', ${organizations.id},
              'name', ${organizations.name},
              'iconUrl', ${organizations.iconUrl}
            )
          ),
          JSON_ARRAY()
        )
      `,
			ownerName: users.name,
			effectiveDate: sql<string>`
        COALESCE(
          JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
          ${videos.createdAt}
        )
      `,
			hasActiveUpload: sql`${videoUploads.videoId} IS NOT NULL`.mapWith(
				Boolean,
			),
			settings: videos.settings,
		})
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.leftJoin(users, eq(videos.ownerId, users.id))
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(
			and(
				eq(videos.ownerId, userId),
				eq(videos.orgId, user.activeOrganizationId),
				isNull(videos.folderId),
			),
		)
		.groupBy(
			videos.id,
			videos.ownerId,
			videos.name,
			videos.createdAt,
			videos.metadata,
			videos.orgId,
			users.name,
		)
		.orderBy(
			desc(sql`COALESCE(
      JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
      ${videos.createdAt}
    )`),
		)
		.limit(limit)
		.offset(offset);

	const foldersData = await db()
		.select({
			id: folders.id,
			name: folders.name,
			color: folders.color,
			parentId: folders.parentId,
			videoCount: sql<number>`(
        SELECT COUNT(*) FROM videos WHERE videos.folderId = folders.id
      )`,
		})
		.from(folders)
		.where(
			and(
				eq(folders.organizationId, user.activeOrganizationId),
				eq(folders.createdById, user.id),
				isNull(folders.parentId),
			),
		);

	const processedVideoData = await Effect.all(
		videoData.map(
			Effect.fn(function* (video) {
				const imageUploads = yield* ImageUploads;

				const { effectiveDate, ...videoWithoutEffectiveDate } = video;

				return {
					...videoWithoutEffectiveDate,
					id: Video.VideoId.make(video.id),
					foldersData,
					settings: video.settings,
					sharedOrganizations: yield* Effect.all(
						(video.sharedOrganizations ?? [])
							.filter((organization) => organization.id !== null)
							.map(
								Effect.fn(function* (org) {
									return {
										...org,
										iconUrl: org.iconUrl
											? yield* imageUploads.resolveImageUrl(org.iconUrl)
											: null,
									};
								}),
							),
					),
					ownerName: video.ownerName ?? "",
					metadata: video.metadata as
						| {
								customCreatedAt?: string;
								[key: string]: any;
						  }
						| undefined,
				};
			}),
		),
	).pipe(runPromise);

	return (
		<Caps
			data={processedVideoData}
			folders={foldersData}
			count={totalCount}
			dubApiKeyEnabled={!!serverEnv().DUB_API_KEY}
		/>
	);
}
