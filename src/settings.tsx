import React from "react";
import ReactDOM from "react-dom/client";
import SettingsPanel from "./ui/SettingsPanel";

// 诊断：任何未捕获错误直接渲染到页面，避免"纯空白"无法排查
window.onerror = (msg, src, line, col) => {
  const el = document.createElement("pre");
  el.style.cssText =
    "color:#ff7b72;background:#1a1a20;padding:16px;font-size:12px;white-space:pre-wrap;margin:0";
  el.textContent = `页面错误:\n${msg}\n${src}:${line}:${col}`;
  document.body.prepend(el);
};
window.onunhandledrejection = (e) => {
  const el = document.createElement("pre");
  el.style.cssText =
    "color:#ff7b72;background:#1a1a20;padding:16px;font-size:12px;white-space:pre-wrap;margin:0";
  el.textContent = `未处理的 Promise 拒绝:\n${e.reason}`;
  document.body.prepend(el);
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsPanel />
  </React.StrictMode>
);
