import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";

// 前端崩溃上报到 Rust 终端：透明窗口下 JS 崩了 = 窗口隐形，必须留痕才能排查
const report = (message: string) =>
  invoke("log_frontend_error", { message }).catch(() => {});
window.addEventListener("error", (e) =>
  report(String(e.error?.stack || e.message))
);
window.addEventListener("unhandledrejection", (e) =>
  report(`unhandledrejection: ${String(e.reason?.stack || e.reason)}`)
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
