import { useCallback, useEffect, useRef, useState } from "react";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import PetCanvas from "./pet/PetCanvas";
import { bindDrag, reportHitRect } from "./pet/interactions";
import ChatBubble from "./ui/ChatBubble";
import MicButton from "./ui/MicButton";
import { ChatMessage, streamChat } from "./ai/client";
import { getProvider, resolveBaseUrl, Settings } from "./ai/providers";
import { EMOTION_INSTRUCTION, parseEmotion } from "./ai/emotion";
import { blobToDataUri, speak, stopSpeaking } from "./ai/voice";
import { getSettings } from "./store/settings";

const MAX_HISTORY = 20;
const PET_WIDTH = 240;
const CHAT_WIDTH = 260;
const WIN_HEIGHT = 315;

async function openSettingsWindow() {
  const existing = await WebviewWindow.getByLabel("settings");
  if (existing) {
    await existing.setFocus();
    return;
  }
  new WebviewWindow("settings", {
    url: "/settings.html",
    title: "Sloth Pet 设置",
    width: 640,
    height: 600,
    resizable: false,
  });
}

export default function App() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [hover, setHover] = useState(false);
  // 提醒放大模式：提醒触发时窗口放大 1.5 倍吸引注意，30s 或点击聊天面板后恢复
  const [highlight, setHighlight] = useState(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerHighlight = useCallback(() => {
    setHighlight(true);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlight(false), 30_000);
  }, []);

  const clearHighlight = useCallback(() => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlight(false);
  }, []);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [modelUrl, setModelUrl] = useState("/models/pet.vrm");
  // 模型重载序号：modelUrl 字符串可能没变（替换同名 custom.vrm / 增删动作文件），
  // 用它做 PetCanvas 的 key 强制重建，否则"重新加载/同步动作"是无效操作
  const [modelKey, setModelKey] = useState(0);
  const [emotion, setEmotion] = useState<{ tag: string; key: number } | null>(null);
  const [micEnabled, setMicEnabled] = useState(false);
  const [enabledActions, setEnabledActions] = useState<string[]>([]);
  const [emotionActions, setEmotionActions] = useState<Record<string, string>>({});
  const [motionMeta, setMotionMeta] = useState<
    Record<string, { name?: string; dance?: boolean }>
  >({});
  const settingsRef = useRef<Settings | null>(null);  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);

  /** 解析当前应加载的模型 URL：settings.modelFile 指定模型目录里的 .vrm 文件名；
   *  未设置时回退旧版 custom.vrm 约定，再回退内置模型 */
  const loadModel = useCallback(async (s: Settings) => {
    try {
      if (s.modelFile) {
        const p = await invoke<string | null>("model_file_path", {
          name: s.modelFile,
        });
        setModelUrl(p ? convertFileSrc(p) : "/models/pet.vrm");
        return;
      }
      const legacy = await invoke<string | null>("custom_model_path");
      setModelUrl(legacy ? convertFileSrc(legacy) : "/models/pet.vrm");
    } catch {
      // 解析失败保持当前模型
    }
  }, []);

  // 模型/动作文件变更（设置页「重新加载」「同步动作」）→ 重新解析并强制重建 PetCanvas
  useEffect(() => {
    const p = listen("model-changed", () => {
      getSettings().then((s) => {
        loadModel(s);
        setModelKey((k) => k + 1);
      });
    });
    return () => {
      p.then((fn) => fn());
    };
  }, [loadModel]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const applySettings = (s: Settings) => {
      settingsRef.current = s;
      setMicEnabled(s.voiceInputEnabled);
      setEnabledActions(s.enabledActions);
      setEmotionActions(s.emotionActions ?? {});
      setMotionMeta(s.motionMeta ?? {});
      loadModel(s); // modelFile 未变时 setModelUrl 同值，不触发模型重载
    };
    getSettings().then(applySettings);
    const unlisten = listen("settings-changed", () => {
      getSettings().then(applySettings);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadModel]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const unbindDrag = bindDrag(root);

    const report = () => reportHitRect(root);
    report();
    window.addEventListener("resize", report);

    return () => {
      unbindDrag();
      window.removeEventListener("resize", report);
    };
  }, []);

  /** 跑一段流式对话：剥离情绪标签、驱动角色表情，返回最终正文 */
  const runStream = useCallback(
    async (settings: Settings, model: string, history: ChatMessage[]) => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      let full = "";
      let emotionFired = false;
      const stream = streamChat({
        baseUrl: resolveBaseUrl(settings),
        apiKey: settings.apiKey,
        model,
        messages: [
          { role: "system", content: settings.persona + "\n\n" + EMOTION_INSTRUCTION },
          ...history,
        ],
        signal: abort.signal,
      });
      for await (const delta of stream) {
        full += delta;
        const { tag, text } = parseEmotion(full);
        if (tag && !emotionFired) {
          emotionFired = true;
          setEmotion({ tag, key: Date.now() });
        }
        setStreaming(text);
      }
      return parseEmotion(full).text;
    },
    []
  );

  const pushAssistant = useCallback((content: string) => {
    setMessages((m) => [...m, { role: "assistant", content }]);
  }, []);

  /** AI 回复语音播报（开启语音播报且配置了合成模型时）；失败显示到气泡便于排查 */
  const speakReply = useCallback((text: string) => {
    const s = settingsRef.current;
    if (!s?.voiceOutputEnabled || !s.voiceTtsModel || !text) return;
    speak(s, text).catch((e) => {
      console.error("语音播报失败", e);
      pushAssistant(`语音播报失败：${String(e)}`);
    });
  }, [pushAssistant]);

  /** 语音输入：音频直接进对话请求（input_audio），模型一步完成理解+回复 */
  const handleVoice = useCallback(
    async (audio: Blob) => {
      const settings = settingsRef.current;
      if (!settings) return;
      if (!settings.chatModel) {
        pushAssistant("先在托盘菜单 → 设置里配置模型吧");
        setChatOpen(true);
        return;
      }
      setChatOpen(true);
      setSending(true);
      setStreaming("🎤 聆听中…");
      try {
        const dataUri = await blobToDataUri(audio);
        const userMsg: ChatMessage = {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: dataUri } }],
        };
        const history = [...messagesRef.current, userMsg].slice(-MAX_HISTORY);
        setMessages(history);
        setStreaming("");
        stopSpeaking();
        const reply = await runStream(settings, settings.chatModel, history);
        pushAssistant(reply);
        speakReply(reply);
      } catch (err) {
        pushAssistant(
          `语音消息失败：${String(err)}（语音输入需要对话模型支持音频，如百炼 qwen3-omni-flash）`
        );
      } finally {
        setStreaming(null);
        setSending(false);
      }
    },
    [runStream, pushAssistant, speakReply]
  );

  const send = useCallback(async (text: string) => {
    const settings = settingsRef.current;
    if (!settings) return;
    if (!settings.chatModel) {
      pushAssistant("先在托盘菜单 → 设置里配置模型吧");
      setChatOpen(true);
      return;
    }
    const provider = getProvider(settings);
    if (provider.needsKey && !settings.apiKey) {
      pushAssistant("还没有读到 API Key。去设置里确认 Key 已保存（如果 macOS 弹过钥匙串授权，请点允许）");
      setChatOpen(true);
      return;
    }

    const userMsg: ChatMessage = { role: "user", content: text };
    const history = [...messagesRef.current, userMsg].slice(-MAX_HISTORY);
    setMessages(history);
    setSending(true);
    setStreaming("");
    stopSpeaking(); // 新对话打断正在播的语音

    try {
      const reply = await runStream(settings, settings.chatModel, history);
      pushAssistant(reply);
      speakReply(reply);
    } catch (err) {
      if (!abortRef.current?.signal.aborted) {
        pushAssistant(`出错了：${String(err)}`);
      }
    } finally {
      setStreaming(null);
      setSending(false);
    }
  }, [runStream, pushAssistant, speakReply]);

  /** 截屏分析：截图 → 视觉模型 → 气泡展示。capture 返回 null 表示用户取消 */
  const analyzeCapture = useCallback(
    async (capture: () => Promise<string | null>, hint: string) => {
      const settings = settingsRef.current;
      if (!settings) return;
      setChatOpen(true);
      if (!settings.visionModel) {
        pushAssistant(
          "截屏分析需要视觉模型：去设置页选一个（智谱 glm-4.5v / 百炼 qwen-vl-max / Ollama qwen3-vl 等）"
        );
        return;
      }
      setSending(true);
      setStreaming(hint);
      setEmotion({ tag: "surprised", key: Date.now() });
      try {
        const b64 = await capture();
        if (b64 === null) return; // 用户取消框选
        const userMsg: ChatMessage = {
          role: "user",
          content: [
            {
              type: "text",
              text: "看看我的屏幕，一两句话说说你看到了什么；如果看出我在忙什么或有什么问题，给我一个简短的提醒。",
            },
            { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        };
        const history = [...messagesRef.current, userMsg].slice(-MAX_HISTORY);
        setMessages(history);
        setStreaming("");
        const reply = await runStream(settings, settings.visionModel, history);
        pushAssistant(reply);
        speakReply(reply);
      } catch (err) {
        pushAssistant(`截屏分析失败：${String(err)}`);
      } finally {
        setStreaming(null);
        setSending(false);
      }
    },
    [runStream, pushAssistant, speakReply]
  );

  /** 托盘菜单：全屏截图分析 */
  const analyzeScreen = useCallback(
    () => analyzeCapture(() => invoke<string>("capture_screen"), "正在看屏幕…"),
    [analyzeCapture]
  );

  /** 全局快捷键：框选区域截图分析（macOS 系统十字选框） */
  const analyzeRegion = useCallback(
    () =>
      analyzeCapture(
        () => invoke<string | null>("capture_region"),
        "框选要分析的区域（Esc 取消）…"
      ),
    [analyzeCapture]
  );

  const analyzeRef = useRef(analyzeScreen);
  const regionRef = useRef(analyzeRegion);
  useEffect(() => {
    analyzeRef.current = analyzeScreen;
    regionRef.current = analyzeRegion;
  }, [analyzeScreen, analyzeRegion]);

  // 全局快捷键：启动时注册，设置变更后重新注册
  useEffect(() => {
    let disposed = false;
    const apply = async () => {
      const s = await getSettings();
      if (disposed) return;
      try {
        await unregisterAll();
        if (s.screenshotHotkey) {
          await register(s.screenshotHotkey, (e) => {
            if (e.state === "Pressed") regionRef.current();
          });
        }
      } catch (err) {
        console.error("注册全局快捷键失败", err);
        pushAssistant(`截图快捷键注册失败：${String(err)}（可能被其他应用占用）`);
      }
    };
    apply();
    const unlistenPromise = listen("settings-changed", apply);
    return () => {
      disposed = true;
      unlistenPromise.then((fn) => fn());
      unregisterAll().catch(() => {});
    };
  }, []);

  // 提醒触发：Rust 调度器广播 reminder-fired
  useEffect(() => {
    const p = listen<{ text: string }>("reminder-fired", (e) => {
      setChatOpen(true);
      pushAssistant(`⏰ ${e.payload.text}`);
      setEmotion({ tag: "surprised", key: Date.now() });
      speakReply(`提醒你：${e.payload.text}`);
      triggerHighlight(); // 放大 + 期间持续敲屏
    });
    return () => {
      p.then((fn) => fn());
    };
  }, [pushAssistant, speakReply, triggerHighlight]);

  // 托盘菜单事件
  useEffect(() => {
    const unlisteners = [
      listen("tray-toggle-chat", () => setChatOpen((v) => !v)),
      listen("tray-screenshot", () => analyzeRef.current()),
      listen("tray-open-settings", () => openSettingsWindow()),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);

  // 聊天打开时窗口向右扩展：左宠物右面板；扩出屏幕时窗口左移
  // highlight（提醒放大模式）下整体放大 1.5 倍
  useEffect(() => {
    const win = getCurrentWindow();
    const scale = highlight ? 1.5 : 1;
    const petW = PET_WIDTH * scale;
    const width = chatOpen ? petW + CHAT_WIDTH * scale : petW;
    const height = WIN_HEIGHT * scale;
    (async () => {
      const sf = await win.scaleFactor();
      const physW = width * sf;
      const monitor = await currentMonitor();
      const pos = await win.outerPosition();
      if (monitor && pos.x + physW > monitor.size.width) {
        await win.setPosition(
          new LogicalPosition((monitor.size.width - physW) / sf, pos.y / sf)
        );
      }
      await win.setSize(new LogicalSize(width, height));
    })().catch(() => {});
  }, [chatOpen, highlight]);

  return (
    <div
      ref={rootRef}
      style={{ width: "100vw", height: "100vh" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: PET_WIDTH * (highlight ? 1.5 : 1),
          height: "100%",
        }}
      >
        <PetCanvas
          key={`${modelUrl}:${modelKey}`}
          modelUrl={modelUrl}
          emotion={emotion}
          busy={sending}
          knocking={highlight}
          enabledActions={enabledActions}
          emotionActions={emotionActions}
          motionMeta={motionMeta}
        />
      </div>
      {chatOpen && (
        <ChatBubble
          messages={messages}
          streaming={streaming}
          sending={sending}
          width={CHAT_WIDTH * (highlight ? 1.5 : 1)}
          onSend={send}
          onInteract={clearHighlight}
          onClose={() => setChatOpen(false)}
        />
      )}
      {micEnabled && <MicButton onVoice={handleVoice} onVoiceError={pushAssistant} />}
      {hover && !chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          title="聊天"
          style={{
            position: "fixed",
            right: 10,
            top: 10,
            width: 28,
            height: 28,
            borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(24,24,30,0.7)",
            backdropFilter: "blur(12px)",
            color: "#eee",
            fontSize: 13,
            cursor: "pointer",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
        >
          💬
        </button>
      )}
    </div>
  );
}
