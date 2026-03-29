"use client";

import { buildEnv } from "@cap/env";
import Cookies from "js-cookie";
import { redirect } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { type CurrentUser, useCurrentUser } from "@/app/Layout/AuthContext";
import { UpgradeModal } from "@/components/UpgradeModal";
import type {
	Organization,
	OrganizationSettings,
	UserPreferences,
} from "./dashboard-data";

type SharedContext = {
	organizationData: Organization[] | null;
	activeOrganization: Organization | null;
	organizationSettings: OrganizationSettings | null;
	user: CurrentUser;
	userCapsCount: number | null;
	toggleSidebarCollapsed: () => void;
	anyNewNotifications: boolean;
	userPreferences: UserPreferences;
	sidebarCollapsed: boolean;
	upgradeModalOpen: boolean;
	setUpgradeModalOpen: (open: boolean) => void;
	referClickedState: boolean;
	setReferClickedStateHandler: (referClicked: boolean) => void;
};

type ITheme = "light" | "dark";

const DashboardContext = createContext<SharedContext>({} as SharedContext);

const ThemeContext = createContext<{
	theme: ITheme;
	setThemeHandler: (newTheme: ITheme) => void;
}>({
	theme: "light",
	setThemeHandler: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export const useDashboardContext = () => useContext(DashboardContext);

export function DashboardContexts({
	children,
	organizationData,
	activeOrganization,
	userCapsCount,
	organizationSettings,
	userPreferences,
	anyNewNotifications,
	initialTheme,
	initialSidebarCollapsed,
	referClicked,
}: {
	children: React.ReactNode;
	organizationData: SharedContext["organizationData"];
	activeOrganization: SharedContext["activeOrganization"];
	userCapsCount: SharedContext["userCapsCount"];
	organizationSettings: SharedContext["organizationSettings"];
	userPreferences: SharedContext["userPreferences"];
	anyNewNotifications: boolean;
	initialTheme: ITheme;
	initialSidebarCollapsed: boolean;
	referClicked: boolean;
}) {
	const user = useCurrentUser();
	if (!user) redirect("/login");

	const [theme, setTheme] = useState<ITheme>(initialTheme);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(
		initialSidebarCollapsed,
	);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
	const [referClickedState, setReferClickedState] = useState(referClicked);

	const setThemeHandler = (newTheme: ITheme) => {
		setTheme(newTheme);
		Cookies.set("theme", newTheme, {
			expires: 365,
		});
	};
	useEffect(() => {
		if (Cookies.get("theme")) {
			document.body.className = Cookies.get("theme") as ITheme;
		}
		if (Cookies.get("sidebarCollapsed")) {
			setSidebarCollapsed(Cookies.get("sidebarCollapsed") === "true");
		}
		return () => {
			document.body.className = "light";
		};
	}, [theme]);

	const toggleSidebarCollapsed = () => {
		setSidebarCollapsed(!sidebarCollapsed);
		Cookies.set("sidebarCollapsed", !sidebarCollapsed ? "true" : "false", {
			expires: 365,
		});
	};

	const setReferClickedStateHandler = (referClicked: boolean) => {
		setReferClickedState(referClicked);
		Cookies.set("referClicked", referClicked ? "true" : "false", {
			expires: 365,
		});
	};

	return (
		<ThemeContext.Provider value={{ theme, setThemeHandler }}>
			<DashboardContext.Provider
				value={{
					organizationData,
					activeOrganization,
					userCapsCount,
					anyNewNotifications,
					userPreferences,
					organizationSettings,
					user,
					toggleSidebarCollapsed,
					sidebarCollapsed,
					upgradeModalOpen,
					setUpgradeModalOpen,
					referClickedState,
					setReferClickedStateHandler,
				}}
			>
				{children}

				{/* Global upgrade modal that persists regardless of navigation state */}
				{buildEnv.NEXT_PUBLIC_IS_CAP && (
					<UpgradeModal
						open={upgradeModalOpen}
						onOpenChange={setUpgradeModalOpen}
					/>
				)}
			</DashboardContext.Provider>
		</ThemeContext.Provider>
	);
}
