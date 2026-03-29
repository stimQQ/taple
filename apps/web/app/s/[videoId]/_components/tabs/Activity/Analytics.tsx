"use client";

import { use, useEffect, useState } from "react";
import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import { CapCardAnalytics } from "@/app/(org)/dashboard/caps/components/CapCard/CapCardAnalytics";

const Analytics = (props: {
	videoId: string;
	views: MaybePromise<number>;
	isLoadingAnalytics: boolean;
}) => {
	const [views, setViews] = useState(
		props.views instanceof Promise ? use(props.views) : props.views,
	);

	useEffect(() => {
		const fetchAnalytics = async () => {
			try {
				const result = await getVideoAnalytics(props.videoId);

				setViews(result.count);
			} catch (error) {
				console.error("Error fetching analytics:", error);
			}
		};

		fetchAnalytics();
	}, [props.videoId]);

	return (
		<CapCardAnalytics
			isLoadingAnalytics={props.isLoadingAnalytics}
			capId={props.videoId}
			displayCount={views}
		/>
	);
};

export default Analytics;
