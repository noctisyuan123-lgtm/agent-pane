import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// 不用 StrictMode：dev 下会双跑 effect/setState updater，
// 流式 MessageChunk 叠在 ref 上时容易出「字字重复」。
createRoot(document.getElementById("root")!).render(<App />);
