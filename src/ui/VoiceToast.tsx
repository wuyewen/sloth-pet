interface Props {
  text: string;
  onOpen: () => void;
}

/** 语音交互的临时轻气泡：语音问答时不强弹聊天面板，在宠物旁展示当前一问一答，
 *  延时自动消失；点击打开完整聊天面板 */
export default function VoiceToast({ text, onOpen }: Props) {
  return (
    <div
      onClick={onOpen}
      title="点击查看完整对话"
      style={{
        position: "fixed",
        left: 10,
        top: 46,
        width: 220,
        maxHeight: 160,
        overflowY: "auto",
        background: "rgba(24,24,30,0.85)",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(255,255,255,0.15)",
        borderRadius: 12,
        padding: "8px 10px",
        color: "#eee",
        fontSize: 12,
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        cursor: "pointer",
        zIndex: 50,
      }}
    >
      {text}
    </div>
  );
}
