"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { folders, videos } from "@cap/database/schema";
import type { Folder, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function moveVideoToFolder({
	videoId,
	folderId,
}: {
	videoId: Video.VideoId;
	folderId: Folder.FolderId | null;
}) {
	const user = await getCurrentUser();
	if (!user || !user.activeOrganizationId)
		throw new Error("Unauthorized or no active organization");

	if (!videoId) throw new Error("Video ID is required");

	const [currentVideo] = await db()
		.select({ folderId: videos.folderId, id: videos.id })
		.from(videos)
		.where(eq(videos.id, videoId));

	const originalFolderId = currentVideo?.folderId;

	if (folderId) {
		const [folder] = await db()
			.select()
			.from(folders)
			.where(
				and(
					eq(folders.id, folderId),
					eq(folders.organizationId, user.activeOrganizationId),
				),
			);

		if (!folder) {
			throw new Error("Folder not found or not accessible");
		}
	}

	await db()
		.update(videos)
		.set({
			folderId: folderId === null ? null : folderId,
		})
		.where(eq(videos.id, videoId));

	revalidatePath(`/dashboard/caps`);

	if (folderId) {
		revalidatePath(`/dashboard/folder/${folderId}`);
	}

	if (originalFolderId) {
		revalidatePath(`/dashboard/folder/${originalFolderId}`);
	}

	if (originalFolderId && folderId && originalFolderId !== folderId) {
		const [originalFolder] = await db()
			.select({ parentId: folders.parentId })
			.from(folders)
			.where(eq(folders.id, originalFolderId));

		if (originalFolder?.parentId) {
			revalidatePath(`/dashboard/folder/${originalFolder.parentId}`);
		}

		const [targetFolder] = await db()
			.select({ parentId: folders.parentId })
			.from(folders)
			.where(eq(folders.id, folderId));

		if (targetFolder?.parentId) {
			revalidatePath(`/dashboard/folder/${targetFolder.parentId}`);
		}
	}
}
