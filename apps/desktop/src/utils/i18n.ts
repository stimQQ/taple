const preferredLanguage =
	typeof navigator === "undefined"
		? "en"
		: (navigator.languages?.[0] ?? navigator.language ?? "en");

export const isChinese = preferredLanguage.toLowerCase().startsWith("zh");

export const locale = isChinese ? "zh-CN" : "en-US";

export function L(chinese: string, english: string) {
	return isChinese ? chinese : english;
}
