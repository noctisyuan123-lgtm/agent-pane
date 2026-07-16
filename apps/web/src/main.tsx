import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// 环境标记：桌面 Tauri vs 浏览器预览（假红绿灯 / 坐标校准）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = typeof window !== "undefined" ? (window as any) : undefined;
const isTauri = !!(
  w?.__TAURI_INTERNALS__ ||
  w?.__TAURI__ ||
  w?.isTauri ||
  // Tauri 2 webview userAgent sometimes only
  (typeof navigator !== "undefined" && /Tauri/i.test(navigator.userAgent))
);
if (isTauri) {
  document.documentElement.classList.add("is-tauri");
} else {
  document.documentElement.classList.add("no-vibrancy");
  document.body.classList.add("web-preview");
}

// 不用 StrictMode：dev 下会双跑 effect/setState updater，
// 流式 MessageChunk 叠在 ref 上时容易出「字字重复」。
createRoot(document.getElementById("root")!).render(<App />);
