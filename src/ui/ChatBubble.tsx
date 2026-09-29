import { useEffect, useRef, useState } from "react";
import { ChatMessage } from "../ai/client";

interface Props {
  messages: ChatMessage[];
  streaming: string | null;
  sending: boolean;
  /** 面板宽度（提醒放大模式时变大） */
  width?: number;
  onSend: (text: string) => void;
  /** 用户点击面板（提醒放大模式下用于确认并恢复尺寸） */
  onInteract?: () => void;
  onClose: () => void;
}

/** 桌宠对话气泡（右侧面板） */
export default function ChatBubble({
  messages,
  streaming,
  sending,
  width = 252,
  onSend,
  onInteract,
  onClose,
}: Props) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming]);

  const submit = () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    onSend(text);
  };

  const visible = messages.filter((m) => m.role !== "system");

  return (
    <div
      onClick={onInteract}
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width,
        background: "rgba(24, 24, 30, 0.92)",
        backdropFilter: "blur(12px)",
        borderLeft: "1px solid rgba(255,255,255,0.1)",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 8px 4px 12px",
          fontSize: 12,
          color: "#888",
        }}
      >
        对话
        <button
          onClick={onClose}
          title="关闭"
          style={{
            background: "transparent",
            border: "none",
            color: "#888",
            fontSize: 14,
            cursor: "pointer",
            padding: "2px 6px",
          }}
        >
          ✕
        </button>
      </div>
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "4px 12px 10px",
          fontSize: 13,
          color: "#eee",
          lineHeight: 1.5,
        }}
      >
        {visible.length === 0 && !streaming && (
          <div style={{ color: "#888" }}>和我说点什么吧…</div>
        )}
        {visible.map((m, i) => (
          <div
            key={i}
            style={{
              marginBottom: 6,
              color: m.role === "user" ? "#9ecbff" : "#eee",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {typeof m.content === "string" ? (
              m.content
            ) : m.content.some((p) => p.type === "input_audio") ? (
              "🎤 语音消息"
            ) : (
              // 截图消息：直接渲染缩略图，一眼确认识别内容
              m.content
                .filter((p) => p.type === "image_url" && p.image_url?.url)
                .map((p, j) => (
                  <img
                    key={j}
                    src={p.image_url!.url}
                    alt="截图"
                    style={{
                      maxWidth: "100%",
                      maxHeight: 120,
                      borderRadius: 8,
                      marginTop: 2,
                      display: "block",
                    }}
                  />
                ))
            )}
          </div>
        ))}
        {streaming !== null && (
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {streaming || "…"}
          </div>
        )}
      </div>
      <div style={{ display: "flex", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
          placeholder="输入消息，Enter 发送"
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "#eee",
            fontSize: 13,
            padding: "10px 12px",
          }}
        />
      </div>
    </div>
  );
}
