import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  getProvider,
  getVoiceProvider,
  PERSONA_MODES,
  PROVIDERS,
  Settings,
  VOICE_PROVIDERS,
} from "../ai/providers";
import { getAvailableActions, getMotionInfo, getSettings, MotionInfo, saveSettings } from "../store/settings";
import { ACTION_DEFS } from "../pet/animations";
import ReminderSection from "./ReminderSection";

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#999",
  marginBottom: 4,
  marginTop: 16,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  color: "#eee",
  fontSize: 13,
  padding: "8px 10px",
  outline: "none",
};

/** 把加速器格式（CommandOrControl+Shift+P）转成友好显示（command + shift + p） */
function humanizeHotkey(accel: string): string {
  return accel
    .split("+")
    .map((part) =>
      part === "CommandOrControl" ? "command" : part.toLowerCase()
    )
    .join(" + ");
}

/** 快捷键录制输入：聚焦后按下组合键即记录，Backspace 清除 */
function HotkeyInput({
  value,
  onChange,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  style: React.CSSProperties;
}) {
  const [recording, setRecording] = useState(false);

  const KEY_MAP: Record<string, string> = {
    " ": "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Enter: "Enter",
    Tab: "Tab",
    Escape: "Esc",
  };

  return (
    <input
      style={style}
      readOnly
      value={recording ? "按下快捷键…（Backspace 清除）" : value ? humanizeHotkey(value) : "点击设置快捷键"}
      onFocus={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Backspace" || e.key === "Delete") {
          onChange("");
          setRecording(false);
          e.currentTarget.blur();
          return;
        }
        if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;
        const mods: string[] = [];
        if (e.metaKey || e.ctrlKey) mods.push("CommandOrControl");
        if (e.altKey) mods.push("Alt");
        if (e.shiftKey) mods.push("Shift");
        const key =
          KEY_MAP[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
        onChange([...mods, key].join("+"));
        setRecording(false);
        e.currentTarget.blur();
      }}
    />
  );
}

type Section = "llm" | "persona" | "voice" | "reminder" | "actions" | "app";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "llm", label: "大模型" },
  { id: "persona", label: "性格设定" },
  { id: "voice", label: "语音设置" },
  { id: "reminder", label: "提醒" },
  { id: "actions", label: "模型与动作" },
  { id: "app", label: "软件设置" },
];

const toggleLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
  fontSize: 12,
  color: "#ccc",
  marginTop: 12,
};

/** 动作/模型行内小按钮（试播、删除等） */
const miniBtnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 6,
  color: "#ccc",
  fontSize: 11,
  padding: "3px 8px",
  cursor: "pointer",
  flexShrink: 0,
};

/** 情绪联动下拉的情绪标签 → 中文名 */
const EMOTION_LABELS: Record<string, string> = {
  happy: "开心",
  surprised: "惊讶",
  sad: "难过",
  angry: "生气",
};

/** 设置面板（独立窗口，左侧二级导航） */
export default function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("llm");
  // 当前模型实际支持的动作（null = 尚未同步过，视为全部可用）
  const [availableActions, setAvailableActions] = useState<string[] | null>(null);
  // 模型目录里的 .vrm 文件列表（进入「模型与动作」页时刷新）
  const [modelFiles, setModelFiles] = useState<string[]>([]);
  // 片段时长等元信息（主窗口探测后落库，供展示）
  const [motionInfos, setMotionInfos] = useState<MotionInfo[]>([]);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch((e) => setLoadError(String(e)));
    getAvailableActions().then((ids) => setAvailableActions(ids.length ? ids : null));
    getMotionInfo().then(setMotionInfos);
    const unlisten = listen("actions-synced", () => {
      getAvailableActions().then((ids) => setAvailableActions(ids.length ? ids : null));
      getMotionInfo().then(setMotionInfos);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (section !== "actions") return;
    invoke<string[]>("list_models", { dir: settings?.modelDir || null })
      .then(setModelFiles)
      .catch(() => {});
  }, [section]);

  if (loadError) {
    return (
      <pre style={{ color: "#ff7b72", padding: 20, whiteSpace: "pre-wrap" }}>
        配置加载失败：{loadError}
      </pre>
    );
  }
  if (!settings) {
    return (
      <div style={{ color: "#888", padding: 20, fontFamily: "system-ui" }}>
        加载中…（若超过 3 秒请反馈）
      </div>
    );
  }
  const provider = getProvider(settings);
  const voiceProvider = getVoiceProvider(settings);
  const patch = (p: Partial<Settings>) => {
    setSettings({ ...settings, ...p });
    setSaved(false);
  };

  const save = async () => {
    try {
      await saveSettings(settings);
      await emit("settings-changed");
      setSaved(true);
      setSaveError(null);
      setTimeout(() => getCurrentWindow().close(), 400);
    } catch (err) {
      setSaveError(String(err));
    }
  };

  /** 动作显示名：内置动作用中文名，外部片段优先 motionMeta 自定义名，回退文件名 */
  const actionName = (id: string): string => {
    const def = ACTION_DEFS.find((a) => a.id === id);
    if (def) return def.name;
    if (id.startsWith("clip:")) {
      const stem = id.slice(5);
      return settings.motionMeta[stem]?.name || stem;
    }
    return id;
  };

  /** 片段时长（秒），来自主窗口探测落库的 motionInfo */
  const durationOf = (id: string): number | undefined =>
    motionInfos.find((m) => m.id === id)?.duration;

  /** 试播：广播给主窗口立即演示，无需保存 */
  const preview = (id: string) => emit("preview-action", { id });

  /** 情绪联动的可选项：当前启用的动作 */
  const emotionPool = (availableActions ?? ACTION_DEFS.map((a) => a.id)).filter(
    (id) => settings.enabledActions.includes(id)
  );

  /** 更新外部动作元数据（显示名 / 舞蹈标记） */
  const patchMeta = (stem: string, m: { name?: string; dance?: boolean }) =>
    patch({ motionMeta: { ...settings.motionMeta, [stem]: m } });

  /** 资产目录：设置里配置了自定义目录则用之，否则默认 app data 目录 */
  const assetDir = () => settings.modelDir || null;

  const refreshModels = (dir?: string | null) =>
    invoke<string[]>("list_models", {
      dir: dir === undefined ? assetDir() : dir,
    })
      .then(setModelFiles)
      .catch(() => {});

  /** 选择自定义资产目录（系统目录选择器） */
  const pickModelDir = async () => {
    const dir = await open({ directory: true, title: "选择模型/动作目录" });
    if (typeof dir === "string") {
      patch({ modelDir: dir });
      refreshModels(dir);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "#1a1a20",
        color: "#eee",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
      }}
    >
      <nav
        style={{
          width: 112,
          flexShrink: 0,
          borderRight: "1px solid rgba(255,255,255,0.08)",
          padding: "16px 0",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <div style={{ padding: "0 14px 12px", fontSize: 15, fontWeight: 600 }}>
          设置
        </div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            style={{
              background: section === s.id ? "rgba(74,108,247,0.25)" : "transparent",
              border: "none",
              borderLeft:
                section === s.id ? "2px solid #4a6cf7" : "2px solid transparent",
              color: section === s.id ? "#fff" : "#999",
              textAlign: "left",
              padding: "8px 14px",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 20px 20px" }}>
          {section === "llm" && (
            <>
              <div style={labelStyle}>AI 服务商</div>
              <select
                style={inputStyle}
                value={settings.providerId}
                onChange={(e) => {
                  const p = PROVIDERS.find((x) => x.id === e.target.value)!;
                  patch({
                    providerId: p.id,
                    chatModel: p.chatModels[0] ?? "",
                    visionModel: p.visionModels[0] ?? "",
                  });
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>

              {provider.id === "custom" && (
                <>
                  <div style={labelStyle}>Base URL（OpenAI 兼容端点，如 https://api.example.com/v1）</div>
                  <input
                    style={inputStyle}
                    value={settings.customBaseUrl}
                    onChange={(e) => patch({ customBaseUrl: e.target.value })}
                    placeholder="https://..."
                  />
                </>
              )}

              {(provider.needsKey || provider.id === "custom") && (
                <>
                  <div style={labelStyle}>API Key（仅存系统钥匙串，不落明文文件）</div>
                  <input
                    style={inputStyle}
                    type="password"
                    value={settings.apiKey}
                    onChange={(e) => patch({ apiKey: e.target.value })}
                    placeholder="sk-..."
                  />
                </>
              )}

              <div style={labelStyle}>对话模型</div>
              <input
                style={inputStyle}
                list="chat-models"
                value={settings.chatModel}
                onChange={(e) => patch({ chatModel: e.target.value })}
              />
              <datalist id="chat-models">
                {provider.chatModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>

              <div style={labelStyle}>视觉模型（截屏分析用，当前服务商无视觉能力时需换智谱/通义/Ollama）</div>
              <input
                style={inputStyle}
                list="vision-models"
                value={settings.visionModel}
                onChange={(e) => patch({ visionModel: e.target.value })}
                placeholder={provider.visionModels.length === 0 ? "该服务商暂无视觉模型" : ""}
              />
              <datalist id="vision-models">
                {provider.visionModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </>
          )}

          {section === "persona" && (
            <>
              <div style={labelStyle}>模式</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[...PERSONA_MODES, { id: "custom", name: "自定义", prompt: "" }].map((m) => (
                  <button
                    key={m.id}
                    onClick={() =>
                      patch(
                        m.id === "custom"
                          ? { personaMode: "custom" } // 保留当前文案，自由编辑
                          : { personaMode: m.id, persona: m.prompt }
                      )
                    }
                    style={{
                      background:
                        settings.personaMode === m.id
                          ? "rgba(74,108,247,0.35)"
                          : "rgba(255,255,255,0.06)",
                      border:
                        settings.personaMode === m.id
                          ? "1px solid #4a6cf7"
                          : "1px solid rgba(255,255,255,0.12)",
                      borderRadius: 8,
                      color: "#eee",
                      fontSize: 12,
                      padding: "6px 12px",
                      cursor: "pointer",
                    }}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
              <div style={labelStyle}>性格设定（System Prompt，改动后自动变为自定义）</div>
              <textarea
                style={{ ...inputStyle, minHeight: 260, resize: "vertical", fontFamily: "inherit" }}
                value={settings.persona}
                onChange={(e) => patch({ persona: e.target.value, personaMode: "custom" })}
              />
            </>
          )}

          {section === "voice" && (
            <>
              <label style={toggleLabelStyle}>
                <input
                  type="checkbox"
                  checked={settings.voiceInputEnabled}
                  onChange={(e) => patch({ voiceInputEnabled: e.target.checked })}
                />
                语音输入（麦克风，角色左上角出现 🎤 按钮）
              </label>
              {settings.voiceInputEnabled && (
                <div style={{ fontSize: 12, color: "#888", lineHeight: 1.6, marginTop: 4 }}>
                  语音直接发给对话模型理解并回复，复用对话服务商和主 Key，无需额外配置；
                  需对话模型支持音频输入，如百炼 qwen3-omni-flash、qwen-audio-turbo。
                </div>
              )}

              <label style={toggleLabelStyle}>
                <input
                  type="checkbox"
                  checked={settings.voiceOutputEnabled}
                  onChange={(e) => patch({ voiceOutputEnabled: e.target.checked })}
                />
                语音播报（扬声器朗读 AI 回复和提醒）
              </label>

              {settings.voiceOutputEnabled && (
                <>
                  <div style={labelStyle}>播报服务商</div>
                  <select
                    style={inputStyle}
                    value={settings.voiceProviderId}
                    onChange={(e) => {
                      const p = VOICE_PROVIDERS.find((x) => x.id === e.target.value)!;
                      patch({
                        voiceProviderId: p.id,
                        voiceTtsModel: p.ttsModels[0] ?? "",
                        voiceTtsVoice: p.voices[0] ?? "",
                        voiceBaseUrl: "",
                      });
                    }}
                  >
                    {VOICE_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>

                  <div style={labelStyle}>
                    {voiceProvider.apiStyle === "dashscope-mg"
                      ? `语音播报端点地址（留空用官方地址，自建网关需填到 .../multimodal-generation/generation 完整路径）`
                      : voiceProvider.apiStyle === "dashscope-ws"
                        ? `语音播报端点地址（留空用官方 wss 地址，自建网关填完整 wss 地址，如 wss://.../api-ws/v1/inference）`
                        : `语音播报 Base URL（留空用服务商默认地址${voiceProvider.baseUrl ? `：${voiceProvider.baseUrl}` : "，自定义服务商必填"}）`}
                  </div>
                  <input
                    style={inputStyle}
                    value={settings.voiceBaseUrl}
                    onChange={(e) => patch({ voiceBaseUrl: e.target.value })}
                    placeholder={voiceProvider.baseUrl || "https://..."}
                  />
                  <div style={labelStyle}>语音播报 API Key（留空复用主 Key，仅存钥匙串）</div>
                  <input
                    style={inputStyle}
                    type="password"
                    value={settings.voiceApiKey}
                    onChange={(e) => patch({ voiceApiKey: e.target.value })}
                    placeholder="留空复用主 Key"
                  />
                  <div style={labelStyle}>合成模型</div>
                  <input
                    style={inputStyle}
                    list="tts-models"
                    value={settings.voiceTtsModel}
                    onChange={(e) => patch({ voiceTtsModel: e.target.value })}
                  />
                  <datalist id="tts-models">
                    {voiceProvider.ttsModels.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>

                  <div style={labelStyle}>音色（随服务商而定，不支持可留空）</div>
                  <input
                    style={inputStyle}
                    list="tts-voices"
                    value={settings.voiceTtsVoice}
                    onChange={(e) => patch({ voiceTtsVoice: e.target.value })}
                  />
                  <datalist id="tts-voices">
                    {voiceProvider.voices.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </>
              )}
            </>
          )}

          {section === "reminder" && <ReminderSection />}

          {section === "actions" && (
            <>
              <div style={labelStyle}>
                资产目录（模型 .vrm 放目录根部，动作 .vrma 放 motions/ 子目录）
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  style={{ ...inputStyle, flex: 1, minWidth: 0, color: "#aaa" }}
                  readOnly
                  value={settings.modelDir || "默认目录（应用数据目录/models）"}
                  title={settings.modelDir || "默认目录（应用数据目录/models）"}
                />
                <button
                  style={{ ...miniBtnStyle, padding: "6px 12px", fontSize: 12 }}
                  onClick={pickModelDir}
                >
                  选择目录
                </button>
                {settings.modelDir && (
                  <button
                    style={{ ...miniBtnStyle, padding: "6px 12px", fontSize: 12 }}
                    onClick={() => {
                      patch({ modelDir: "" });
                      refreshModels(null);
                    }}
                  >
                    恢复默认
                  </button>
                )}
              </div>
              <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
                更换目录后点下方「保存」生效；目录里现有文件自动识别
              </div>

              <div style={labelStyle}>模型库（.vrm 文件直接放入资产目录即可，无需重命名）</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ ...toggleLabelStyle, marginTop: 0 }}>
                  <input
                    type="radio"
                    name="model-file"
                    checked={!settings.modelFile}
                    onChange={() => patch({ modelFile: "" })}
                  />
                  内置模型
                </label>
                {modelFiles.map((f) => (
                  <div key={f} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <label
                      style={{
                        ...toggleLabelStyle,
                        marginTop: 0,
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <input
                        type="radio"
                        name="model-file"
                        checked={settings.modelFile === f}
                        onChange={() => patch({ modelFile: f })}
                      />
                      {f}
                    </label>
                    <button
                      style={miniBtnStyle}
                      onClick={async () => {
                        if (!confirm(`删除模型文件 ${f}？`)) return;
                        await invoke("delete_asset", { name: f, kind: "model", dir: assetDir() }).catch(alert);
                        if (settings.modelFile === f) patch({ modelFile: "" });
                        refreshModels();
                        emit("model-changed");
                      }}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  style={{ ...inputStyle, cursor: "pointer", flex: 1 }}
                  onClick={() => invoke("open_model_dir", { dir: assetDir() })}
                >
                  打开模型目录
                </button>
                <button
                  style={{ ...inputStyle, cursor: "pointer", flex: 1 }}
                  onClick={() => {
                    emit("model-changed");
                    refreshModels();
                  }}
                >
                  重新加载
                </button>
              </div>
              <div style={labelStyle}>
                动作（勾选后参与双击随机与自主行为；「试播」立即在主窗口演示，无需保存）
              </div>
              <button
                style={{ ...inputStyle, cursor: "pointer", marginTop: 4 }}
                onClick={() => emit("model-changed")}
              >
                🔄 同步动作（放入/更换模型或动作文件后点击，重新探测）
              </button>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  style={{ ...inputStyle, cursor: "pointer", flex: 1 }}
                  onClick={() =>
                    patch({
                      enabledActions:
                        availableActions ?? ACTION_DEFS.map((a) => a.id),
                    })
                  }
                >
                  全选可用
                </button>
                <button
                  style={{ ...inputStyle, cursor: "pointer", flex: 1 }}
                  onClick={() => patch({ enabledActions: [] })}
                >
                  全不选
                </button>
              </div>
              {ACTION_DEFS.map((a) => {
                const supported = !availableActions || availableActions.includes(a.id);
                const dur = durationOf(a.id);
                return (
                  <div
                    key={a.id}
                    style={{
                      ...toggleLabelStyle,
                      marginTop: 8,
                      opacity: supported ? 1 : 0.4,
                    }}
                  >
                    <input
                      type="checkbox"
                      disabled={!supported}
                      checked={supported && settings.enabledActions.includes(a.id)}
                      onChange={(e) =>
                        patch({
                          enabledActions: e.target.checked
                            ? [...settings.enabledActions, a.id]
                            : settings.enabledActions.filter((id) => id !== a.id),
                        })
                      }
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        cursor: supported ? "pointer" : "not-allowed",
                      }}
                    >
                      {a.name}
                      {dur != null && <span style={{ color: "#666" }}>（{dur}s）</span>}
                      {!supported && "（当前模型不支持）"}
                    </span>
                    <button
                      style={{ ...miniBtnStyle, opacity: supported ? 1 : 0.5 }}
                      disabled={!supported}
                      onClick={() => preview(a.id)}
                    >
                      试播
                    </button>
                  </div>
                );
              })}
              {(availableActions ?? [])
                .filter(
                  (id) =>
                    id.startsWith("clip:") &&
                    !ACTION_DEFS.some((a) => a.id === id)
                )
                .map((id) => {
                  const stem = id.slice(5);
                  const meta = settings.motionMeta[stem] ?? {};
                  const dur = durationOf(id);
                  const dance = meta.dance ?? (dur ?? 0) > 8;
                  return (
                    <div
                      key={id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginTop: 8,
                        fontSize: 12,
                        color: "#ccc",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={settings.enabledActions.includes(id)}
                        onChange={(e) =>
                          patch({
                            enabledActions: e.target.checked
                              ? [...settings.enabledActions, id]
                              : settings.enabledActions.filter((x) => x !== id),
                          })
                        }
                      />
                      <input
                        style={{
                          ...inputStyle,
                          flex: 1,
                          minWidth: 0,
                          padding: "4px 8px",
                          fontSize: 12,
                        }}
                        value={meta.name ?? stem}
                        title={`文件名：${stem}.vrma`}
                        onChange={(e) =>
                          patchMeta(stem, { ...meta, name: e.target.value })
                        }
                      />
                      {dur != null && (
                        <span style={{ fontSize: 11, color: "#666", flexShrink: 0 }}>
                          {dur}s
                        </span>
                      )}
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 3,
                          fontSize: 11,
                          color: "#999",
                          flexShrink: 0,
                          cursor: "pointer",
                        }}
                        title="舞蹈类长动作：完整播放，不参与双击随机与自主行为"
                      >
                        <input
                          type="checkbox"
                          checked={dance}
                          onChange={(e) =>
                            patchMeta(stem, { ...meta, dance: e.target.checked })
                          }
                        />
                        舞蹈
                      </label>
                      <button style={miniBtnStyle} onClick={() => preview(id)}>
                        试播
                      </button>
                      <button
                        style={miniBtnStyle}
                        onClick={async () => {
                          if (!confirm(`删除动作文件 ${stem}.vrma？`)) return;
                          await invoke("delete_asset", {
                            name: `${stem}.vrma`,
                            kind: "motion",
                            dir: assetDir(),
                          }).catch(alert);
                          emit("model-changed");
                        }}
                      >
                        删
                      </button>
                    </div>
                  );
                })}

              <div style={labelStyle}>
                情绪联动（AI 回复带情绪时播放的配套动作，仅列出已启用项）
              </div>
              {Object.entries(EMOTION_LABELS).map(([tag, label]) => {
                const current = settings.emotionActions[tag] ?? "";
                const options =
                  !current || emotionPool.includes(current)
                    ? emotionPool
                    : [...emotionPool, current];
                return (
                  <div
                    key={tag}
                    style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}
                  >
                    <span style={{ width: 36, fontSize: 12, color: "#ccc", flexShrink: 0 }}>
                      {label}
                    </span>
                    <select
                      style={{ ...inputStyle, flex: 1 }}
                      value={current}
                      onChange={(e) =>
                        patch({
                          emotionActions: {
                            ...settings.emotionActions,
                            [tag]: e.target.value,
                          },
                        })
                      }
                    >
                      <option value="">（只做表情，不播动作）</option>
                      {options.map((id) => (
                        <option key={id} value={id}>
                          {actionName(id)}
                        </option>
                      ))}
                    </select>
                    {current && (
                      <button style={miniBtnStyle} onClick={() => preview(current)}>
                        试播
                      </button>
                    )}
                  </div>
                );
              })}
              <div style={{ fontSize: 12, color: "#888", marginTop: 8, lineHeight: 1.6 }}>
                换自定义模型后点上方「同步动作」重新探测；不支持的动作为骨骼或表情缺失。
                时长 &gt;8s 的动作自动标记为舞蹈：完整播放且不进入随机池。
              </div>
            </>
          )}

          {section === "app" && (
            <>
              <div style={labelStyle}>截图快捷键（全局，按下后框选区域分析；Esc 取消）</div>
              <HotkeyInput
                style={inputStyle}
                value={settings.screenshotHotkey}
                onChange={(v) => patch({ screenshotHotkey: v })}
              />
              <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
                托盘菜单的「截屏分析」仍为全屏截图
              </div>
            </>
          )}
        </div>

        <div style={{ padding: "10px 20px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <button
            onClick={save}
            style={{
              width: "100%",
              padding: "10px 0",
              borderRadius: 8,
              border: "none",
              background: saved ? "#3a7d44" : "#4a6cf7",
              color: "#fff",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            {saved ? "已保存 ✓" : "保存"}
          </button>
          {saveError && (
            <div style={{ marginTop: 10, color: "#ff7b72", fontSize: 12 }}>
              保存失败：{saveError}
              （若 macOS 弹出钥匙串授权框请点击允许）
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
