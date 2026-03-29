import "server-only";

import {
	folders,
	organizations,
	sharedVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { Database, ImageUploads } from "@cap/web-backend";
import type { ImageUpload, Video } from "@cap/web-domain";
import { CurrentUser, Folder } from "@cap/web-domain";
import { and, desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm/sql";
import { Effect } from "effect";

export const getFolderById = Effect.fn(function* (folderId: string) {
	if (!folderId) throw new Error("Folder ID is required");
	const db = yield* Database;

	const [folder] = yield* db.use((db) =>
		db
			.select()
			.from(folders)
			.where(eq(folders.id, Folder.FolderId.make(folderId))),
	);

	if (!folder) throw new Error("Folder not found");

	return folder;
});

export const getFolderBreadcrumb = Effect.fn(function* (
	folderId: Folder.FolderId,
) {
	const breadcrumb: Array<{
		id: Folder.FolderId;
		name: string;
		color: "normal" | "blue" | "red" | "yellow";
	}> = [];
	let currentFolderId = folderId;

	while (currentFolderId) {
		const folder = yield* getFolderById(currentFolderId);
		if (!folder) break;

		breadcrumb.unshift({
			id: folder.id,
			name: folder.name,
			color: folder.color,
		});

		if (!folder.parentId) break;
		currentFolderId = folder.parentId;
	}

	return breadcrumb;
});

export const getVideosByFolderId = Effect.fn(function* (
	folderId: Folder.FolderId,
	root: { variant: "user" },
) {
	if (!folderId) throw new Error("Folder ID is required");
	const db = yield* Database;
	const imageUploads = yield* ImageUploads;

	const videoData = yield* db.use((db) =>
		db
			.select({
				id: videos.id,
				ownerId: videos.ownerId,
				name: videos.name,
				createdAt: videos.createdAt,
				public: videos.public,
				metadata: videos.metadata,
				duration: videos.duration,
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
			})
			.from(videos)
			.leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
			.leftJoin(
				organizations,
				eq(sharedVideos.organizationId, organizations.id),
			)
			.leftJoin(users, eq(videos.ownerId, users.id))
			.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
			.where(eq(videos.folderId, folderId))
			.groupBy(
				videos.id,
				videos.ownerId,
				videos.name,
				videos.createdAt,
				videos.public,
				videos.metadata,
				users.name,
			)
			.orderBy(
				desc(sql`COALESCE(
      JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
      ${videos.createdAt}
    )`),
			),
	);

	// Process the video data to match the expected format
	const processedVideoData = yield* Effect.all(
		videoData.map(
			Effect.fn(function* (video) {
				return {
					id: video.id as Video.VideoId,
					ownerId: video.ownerId,
					name: video.name,
					createdAt: video.createdAt,
					public: video.public,
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
								[key: string]: unknown;
						  }
						| undefined,
					hasActiveUpload: video.hasActiveUpload,
					foldersData: [],
				};
			}),
		),
	);

	return processedVideoData;
});

export const getChildFolders = Effect.fn(function* (
	folderId: Folder.FolderId,
	root: { variant: "user" },
) {
	const db = yield* Database;

	const user = yield* CurrentUser;
	if (!user.activeOrganizationId) throw new Error("No active organization");

	const childFolders = yield* db.use((db) =>
		db
			.select({
				id: folders.id,
				name: folders.name,
				color: folders.color,
				parentId: folders.parentId,
				organizationId: folders.organizationId,
				videoCount: sql<number>`(
        	SELECT COUNT(*) FROM videos WHERE videos.folderId = folders.id
	      )`,
			})
			.from(folders)
			.where(eq(folders.parentId, folderId)),
	);

	return childFolders;
});
