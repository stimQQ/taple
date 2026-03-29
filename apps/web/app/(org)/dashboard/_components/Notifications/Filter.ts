import type { NotificationType } from "@/lib/Notification";

export type FilterType = "all" | NotificationType;

export const Filters: Array<FilterType> = ["all", "view", "reaction"];

export const FilterLabels: Record<FilterType, string> = {
	all: "All",
	view: "Views",
	reaction: "Reactions",
};

export const matchNotificationFilter = (
	filter: FilterType,
	type: NotificationType,
): boolean => {
	if (filter === "all") return true;
	return type === filter;
};
