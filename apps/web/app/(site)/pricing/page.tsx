import type { Metadata } from "next";
import { PricingPage } from "@/components/pages/PricingPage";

export const metadata: Metadata = {
	title: "Early Adopter Pricing — Taple",
};

export default function App() {
	return <PricingPage />;
}
