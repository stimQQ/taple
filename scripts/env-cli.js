import * as fs from "node:fs/promises";
import { intro, log, outro } from "@clack/prompts";

async function main() {
	intro("Taple env setup");

	const envs = {
		NODE_ENV: "development",
		RUST_BACKTRACE: "1",
	};

	await fs.writeFile(
		".env",
		`${Object.entries(envs)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n")}\n`,
	);

	log.info(`Written ${Object.keys(envs).length} envs to .env`);
	outro("Run 'pnpm dev:desktop' to start the desktop app");
}

await main();
