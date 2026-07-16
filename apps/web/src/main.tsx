import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// 浏览器 dev：实心底 + 假红绿灯（对折叠键高度）
const isTauri =
  typeof window !== "undefined" &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  !!(window as any).__TAURI_INTERNALS__;
if (!isTauri) {
  document.documentElement.classList.add("no-vibrancy");
  document.body.classList.add("web-preview");
}

// 不用 StrictMode：dev 下会双跑 effect/setState updater，
// 流式 MessageChunk 叠在 ref 上时容易出「字字重复」。
createRoot(document.getElementById("root")!).render(<App />);
