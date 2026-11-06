// @refresh reload
import { mount, StartClient } from "@solidjs/start/client";
import { type } from "@tauri-apps/plugin-os";
import { locale } from "~/utils/i18n";

document.documentElement.classList.add(`platform-${type()}`);
document.documentElement.lang = locale;
mount(() => <StartClient />, document.getElementById("app")!);
