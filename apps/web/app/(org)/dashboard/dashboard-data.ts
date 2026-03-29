import { db } from "@cap/database";
import type { userSelectProps } from "@cap/database/auth/session";
import {
	notifications,
	organizationInvites,
	organizationMembers,
	organizations,
	users,
	videos,
} from "@cap/database/schema";
import { Database, ImageUploads } from "@cap/web-backend";
import type { ImageUpload } from "@cap/web-domain";
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { runPromise } from "@/lib/server";

export type Organization = {
	organization: Omit<typeof organizations.$inferSelect, "iconUrl"> & {
		iconUrl: ImageUpload.ImageUrl | null;
	};
	members: (typeof organizationMembers.$inferSelect & {
		user: Pick<
			typeof users.$inferSelect,
			"id" | "name" | "email" | "lastName"
		> & { image?: ImageUpload.ImageUrl | null };
	})[];
	invites: (typeof organizationInvites.$inferSelect)[];
	inviteQuota: number;
	totalInvites: number;
};

export type OrganizationSettings = NonNullable<
	(typeof organizations.$inferSelect)["settings"]
>;

export type UserPreferences = (typeof users.$inferSelect)["preferences"];

export async function getDashboardData(user: typeof userSelectProps) {
	try {
		const organizationsWithMembers = await db()
			.select({
				organization: organizations,
				settings: organizations.settings,
				member: organizationMembers,
				iconUrl: organizations.iconUrl,
				user: {
					id: users.id,
					name: users.name,
					lastName: users.lastName,
					email: users.email,
					inviteQuota: users.inviteQuota,
					image: users.image,
					defaultOrgId: users.defaultOrgId,
				},
			})
			.from(organizations)
			.leftJoin(
				organizationMembers,
				eq(organizations.id, organizationMembers.organizationId),
			)
			.leftJoin(users, eq(organizationMembers.userId, users.id))
			.where(
				or(
					eq(organizations.ownerId, user.id),
					eq(organizationMembers.userId, user.id),
				),
			);

		const organizationIds = organizationsWithMembers.map(
			(row) => row.organization.id,
		);

		let organizationInvitesData: (typeof organizationInvites.$inferSelect)[] =
			[];
		if (organizationIds.length > 0) {
			organizationInvitesData = await db()
				.select()
				.from(organizationInvites)
				.where(inArray(organizationInvites.organizationId, organizationIds));
		}

		let anyNewNotifications = false;
		let organizationSettings: OrganizationSettings | null = null;
		let userCapsCount = 0;

		let activeOrganizationId = organizationIds.find(
			(orgId) => orgId === user.activeOrganizationId,
		);

		if (!activeOrganizationId && organizationIds.length > 0) {
			activeOrganizationId = organizationIds[0];
		}

		if (activeOrganizationId) {
			const [notification] = await db()
				.select({ id: notifications.id })
				.from(notifications)
				.where(
					and(
						eq(notifications.recipientId, user.id),
						eq(notifications.orgId, activeOrganizationId),
						isNull(notifications.readAt),
					),
				)
				.limit(1);

			anyNewNotifications = !!notification;

			const [organizationSetting] = await db()
				.select({ settings: organizations.settings })
				.from(organizations)
				.where(eq(organizations.id, activeOrganizationId));
			organizationSettings = organizationSetting?.settings || null;

			const activeOrgInfo = organizationsWithMembers.find(
				(row) => row.organization.id === activeOrganizationId,
			);
			if (activeOrgInfo) {
				const userCapsCountResult = await db()
					.select({
						value: sql<number>`COUNT(DISTINCT ${videos.id})`,
					})
					.from(videos)
					.where(
						and(
							eq(videos.orgId, activeOrgInfo.organization.id),
							eq(videos.ownerId, user.id),
						),
					);

				userCapsCount = userCapsCountResult[0]?.value || 0;
			}
		}

		const [userPreferences] = await db()
			.select({
				preferences: users.preferences,
			})
			.from(users)
			.where(eq(users.id, user.id))
			.limit(1);

		const organizationSelect: Organization[] = await Effect.all(
			organizationsWithMembers
				.reduce((acc: (typeof organizations.$inferSelect)[], row) => {
					const existingOrganization = acc.find(
						(o) => o.id === row.organization.id,
					);
					if (!existingOrganization) {
						acc.push(row.organization);
					}
					return acc;
				}, [])
				.map(
					Effect.fn(function* (organization) {
						const db = yield* Database;
						const iconImages = yield* ImageUploads;

						const allMembers = yield* db.use((db) =>
							db
								.select({
									member: organizationMembers,
									user: {
										id: users.id,
										name: users.name,
										lastName: users.lastName,
										email: users.email,
										image: users.image,
									},
								})
								.from(organizationMembers)
								.leftJoin(users, eq(organizationMembers.userId, users.id))
								.where(eq(organizationMembers.organizationId, organization.id)),
						);

						const owner = yield* db.use((db) =>
							db
								.select({
									inviteQuota: users.inviteQuota,
								})
								.from(users)
								.where(eq(users.id, organization.ownerId))
								.then((result) => result[0]),
						);

						const totalInvitesResult = yield* db.use((db) =>
							db
								.select({
									value: sql<number>`
                ${count(organizationMembers.id)} + ${count(
									organizationInvites.id,
								)}
              `,
								})
								.from(organizations)
								.leftJoin(
									organizationMembers,
									eq(organizations.id, organizationMembers.organizationId),
								)
								.leftJoin(
									organizationInvites,
									eq(organizations.id, organizationInvites.organizationId),
								)
								.where(eq(organizations.ownerId, organization.ownerId)),
						);

						const totalInvites = totalInvitesResult[0]?.value || 0;

						return {
							organization: {
								...organization,
								iconUrl: organization.iconUrl
									? yield* iconImages.resolveImageUrl(organization.iconUrl)
									: null,
							},
							members: yield* Effect.all(
								allMembers.map(
									Effect.fn(function* (m) {
										const imageUploads = yield* ImageUploads;
										return {
											...m.member,
											user: {
												...m.user!,
												image: m.user!.image
													? yield* imageUploads.resolveImageUrl(m.user!.image)
													: null,
											},
										};
									}),
								),
							),
							invites: organizationInvitesData.filter(
								(invite) => invite.organizationId === organization.id,
							),
							inviteQuota: owner?.inviteQuota || 1,
							totalInvites,
						};
					}),
				),
			{ concurrency: 3 },
		).pipe(runPromise);

		return {
			organizationSelect,
			organizationSettings,
			anyNewNotifications,
			userPreferences,
			userCapsCount,
		};
	} catch (error) {
		console.error("Failed to fetch dashboard data", error);
		return {
			organizationSelect: [],
			userCapsCount: null,
			anyNewNotifications: false,
			userPreferences: null,
			organizationSettings: null,
		};
	}
}
