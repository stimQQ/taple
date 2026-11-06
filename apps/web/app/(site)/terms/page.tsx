import type { Metadata } from "next";
import { TermsPage } from "@/components/pages/TermsPage";

export const metadata: Metadata = {
	title: "Terms of Service — Taple",
};

export default function App() {
	return <TermsPage />;
}
