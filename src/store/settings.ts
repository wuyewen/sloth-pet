import { load, Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS, Settings } from "../ai/providers";

// 懒加载：顶层 await 一旦失败会让整个模块图加载失败，导致主窗口白屏
let storePromise: Promise<Store> | null = null;

/** 带超时的 Promise 包装：任何挂起都不能让页面永远空白 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} 超时（${ms}ms）`)), ms)
    ),
  ]);
}

function getStore(): Promise<Store> {
  storePromise ??= withTimeout(
    load("settings.json", { autoSave: true }),
    3000,
    "store 加载"
  );
  return storePromise;
}

export async function getSettings(): Promise<Settings> {
  let saved: Partial<Settings> = {};
  try {
    const store = await getStore();
    saved = (await store.get<Partial<Settings>>("settings")) ?? {};
  } catch {
    // store 不可用时退回默认配置
  }
  // API Key 单独从系统钥匙串读取，settings.json 里不落明文。
  // 两个条目：api-key（对话主 Key，语音输入复用它）、voice-api-key（语音播报）
  const readKey = async (account?: string): Promise<string> => {
    try {
      return await withTimeout(
        invoke<string>("get_api_key", account ? { account } : {}),
        3000,
        "读取钥匙串"
      );
    } catch {
      return ""; // 钥匙串读取失败/超时视为未配置
    }
  };
  const [apiKey, voiceApiKey] = await Promise.all([
    readKey(),
    readKey("voice-api-key"),
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...saved, apiKey, voiceApiKey };
  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const { apiKey, voiceApiKey, ...rest } = settings;
  const store = await getStore();
  await store.set("settings", rest);
  await Promise.all([
    invoke("save_api_key", { key: apiKey }),
    invoke("save_api_key", { key: voiceApiKey, account: "voice-api-key" }),
  ]);
}

/** 当前模型实际支持的动作 id 列表（由 PetCanvas 加载模型后探测写入） */
export async function getAvailableActions(): Promise<string[]> {
  try {
    const store = await getStore();
    return (await store.get<string[]>("availableActions")) ?? [];
  } catch {
    return [];
  }
}

export async function saveAvailableActions(ids: string[]): Promise<void> {
  try {
    const store = await getStore();
    await store.set("availableActions", ids);
  } catch {
    // store 不可用时静默失败
  }
}

/** 动作片段元信息：id（含 clip: 前缀）与时长（秒），供设置页展示 */
export interface MotionInfo {
  id: string;
  duration?: number;
}

export async function getMotionInfo(): Promise<MotionInfo[]> {
  try {
    const store = await getStore();
    return (await store.get<MotionInfo[]>("motionInfo")) ?? [];
  } catch {
    return [];
  }
}

export async function saveMotionInfo(infos: MotionInfo[]): Promise<void> {
  try {
    const store = await getStore();
    await store.set("motionInfo", infos);
  } catch {
    // store 不可用时静默失败
  }
}
