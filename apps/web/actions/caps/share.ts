"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

interface ShareCapParams {
	capId: Video.VideoId;
	public?: boolean;
}

export async function shareCap({ capId, public: isPublic }: ShareCapParams) {
	try {
		const user = await getCurrentUser();
		if (!user) {
			return { success: false, error: "Unauthorized" };
		}

		const [cap] = await db().select().from(videos).where(eq(videos.id, capId));
		if (!cap || cap.ownerId !== user.id) {
			return { success: false, error: "Unauthorized" };
		}

		if (typeof isPublic === "boolean") {
			await db()
				.update(videos)
				.set({ public: isPublic })
				.where(eq(videos.id, capId));
		}

		revalidatePath("/dashboard/caps");
		revalidatePath(`/dashboard/caps/${capId}`);
		return { success: true };
	} catch (error) {
		console.error("Error sharing cap:", error);
		return { success: false, error: "Failed to update sharing settings" };
	}
}
