const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGE_LENGTH = 10000;
const MAX_LOG_LENGTH = 600 * 1024;
const MAX_EMAIL_LENGTH = 254;
const COOLDOWN_SECONDS = 30;
const DEFAULT_FROM = "Taple Feedback <feedback@taple.app>";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.][^\s@]*\.[^\s@]+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const DIAGNOSTIC_FIELDS = [
	["osVersion", "系统"],
	["chip", "芯片"],
	["model", "机型"],
	["locale", "语言"],
];

const json = (body, status) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	});

const singleLine = (text, maxLength) =>
	text.replace(/\s+/g, " ").trim().slice(0, maxLength);

function parseFeedback(payload) {
	if (!payload || typeof payload !== "object") return null;

	const message =
		typeof payload.message === "string" ? payload.message.trim() : "";
	if (!message || message.length > MAX_MESSAGE_LENGTH) return null;

	const email =
		typeof payload.email === "string" && payload.email.trim()
			? payload.email.trim()
			: null;
	if (email && (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)))
		return null;

	const log =
		typeof payload.log === "string" && payload.log.trim() ? payload.log : null;
	if (log && log.length > MAX_LOG_LENGTH) return null;

	const source =
		payload.diagnostics && typeof payload.diagnostics === "object"
			? payload.diagnostics
			: {};
	const diagnostics = DIAGNOSTIC_FIELDS.flatMap(([key, label]) =>
		typeof source[key] === "string" && source[key].trim()
			? [[label, singleLine(source[key], 120)]]
			: [],
	);

	return { message, email, log, diagnostics };
}

function composeEmail(feedback, version) {
	const lines = [
		feedback.message,
		"",
		"——",
		`回复地址：${feedback.email ?? "未填写"}`,
		`Taple：${version}`,
		...feedback.diagnostics.map(([label, value]) => `${label}：${value}`),
	];
	if (feedback.log) lines.push("运行日志：见附件 taple.log");

	return {
		subject: `Taple 反馈 · v${version} · ${singleLine(feedback.message, 60)}`,
		text: lines.join("\n"),
	};
}

function toBase64(text) {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (let start = 0; start < bytes.length; start += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
	}
	return btoa(binary);
}

function cooldownKey(request) {
	const ip = request.headers.get("CF-Connecting-IP");
	if (!ip) return null;
	return new Request(
		new URL(`/api/feedback/cooldown/${encodeURIComponent(ip)}`, request.url),
	);
}

export async function onRequestPost({ request, env }) {
	if (!env.RESEND_API_KEY || !env.FEEDBACK_TO) {
		return json({ error: "unavailable" }, 503);
	}

	const version = request.headers.get("X-Taple-Version") ?? "";
	const userAgent = request.headers.get("User-Agent") ?? "";
	if (!VERSION_PATTERN.test(version) || !userAgent.startsWith("Taple/")) {
		return json({ error: "invalid" }, 400);
	}

	const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
	if (declaredLength > MAX_BODY_BYTES) return json({ error: "invalid" }, 413);

	const body = await request.text();
	if (body.length > MAX_BODY_BYTES) return json({ error: "invalid" }, 413);

	let payload;
	try {
		payload = JSON.parse(body);
	} catch {
		return json({ error: "invalid" }, 400);
	}

	const feedback = parseFeedback(payload);
	if (!feedback) return json({ error: "invalid" }, 400);

	const key = cooldownKey(request);
	if (key && (await caches.default.match(key))) {
		return json({ error: "rate_limited" }, 429);
	}

	const { subject, text } = composeEmail(feedback, version);
	const response = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from: env.FEEDBACK_FROM || DEFAULT_FROM,
			to: env.FEEDBACK_TO.split(",")
				.map((address) => address.trim())
				.filter(Boolean),
			subject,
			text,
			...(feedback.email ? { reply_to: feedback.email } : {}),
			...(feedback.log
				? {
						attachments: [
							{ filename: "taple.log", content: toBase64(feedback.log) },
						],
					}
				: {}),
		}),
	});

	if (!response.ok) {
		console.error(
			`Resend answered ${response.status}: ${(await response.text()).slice(0, 500)}`,
		);
		return json({ error: "unavailable" }, 502);
	}

	if (key) {
		await caches.default.put(
			key,
			new Response("1", {
				headers: { "Cache-Control": `max-age=${COOLDOWN_SECONDS}` },
			}),
		);
	}

	return json({ ok: true }, 200);
}
