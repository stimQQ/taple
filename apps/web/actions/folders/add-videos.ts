"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { folders, videos } from "@cap/database/schema";
import type { Folder, Video } from "@cap/web-domain";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function addVideosToFolder(
	folderId: Folder.FolderId,
	videoIds: Video.VideoId[],
) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!folderId || !videoIds || videoIds.length === 0) {
			throw new Error("Missing required data");
		}

		const [folder] = await db()
			.select({ id: folders.id })
			.from(folders)
			.where(eq(folders.id, folderId));

		if (!folder) {
			throw new Error("Folder not found");
		}

		const userVideos = await db()
			.select({ id: videos.id })
			.from(videos)
			.where(and(eq(videos.ownerId, user.id), inArray(videos.id, videoIds)));

		const validVideoIds = userVideos.map((v) => v.id);

		if (validVideoIds.length === 0) {
			throw new Error("No valid videos found");
		}

		await db()
			.update(videos)
			.set({ folderId, updatedAt: new Date() })
			.where(inArray(videos.id, validVideoIds));

		revalidatePath(`/dashboard/caps`);
		revalidatePath(`/dashboard/folder/${folderId}`);

		return {
			success: true,
			message: `${validVideoIds.length} video${validVideoIds.length === 1 ? "" : "s"} added to folder`,
			addedCount: validVideoIds.length,
		};
	} catch (error) {
		console.error("Error adding videos to folder:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to add videos to folder",
		};
	}
}
