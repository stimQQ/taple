import type { Metadata } from "next";
import { Settings } from "./Settings";

export const metadata: Metadata = {
	title: "Settings — Taple",
};

export default async function SettingsPage() {
	return <Settings />;
}
