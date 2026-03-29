import { useNavigate } from "@solidjs/router";
import { onMount } from "solid-js";

export default function () {
	const navigate = useNavigate();
	onMount(() => navigate("/new-main", { replace: true }));
	return null;
}
