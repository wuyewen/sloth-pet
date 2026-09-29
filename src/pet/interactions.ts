import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

const appWindow = getCurrentWindow();

/** 左键按住即可拖动窗口 */
export function bindDrag(el: HTMLElement) {
  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) appWindow.startDragging();
  };
  el.addEventListener("mousedown", onMouseDown);
  return () => el.removeEventListener("mousedown", onMouseDown);
}

/** 把元素的可交互区域（物理像素）上报给 Rust 点击穿透轮询 */
export async function reportHitRect(el: HTMLElement) {
  const sf = await appWindow.scaleFactor();
  const r = el.getBoundingClientRect();
  await invoke("set_hit_rect", {
    x: r.x * sf,
    y: r.y * sf,
    w: r.width * sf,
    h: r.height * sf,
  });
}
