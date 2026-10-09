import { useRef, useState } from "react";
import { pickRecorderMime } from "../ai/voice";

interface Props {
  onVoice: (audio: Blob) => void;
  onVoiceError: (message: string) => void;
  /** 悬停宠物时显示；录音中强制显示（否则会丢失停止入口） */
  visible: boolean;
}

/** 独立悬浮麦克风按钮（角色左上角）：点击开始录音，再点停止并识别发送 */
export default function MicButton({ onVoice, onVoiceError, visible }: Props) {
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const toggle = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickRecorderMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: rec.mimeType });
        if (blob.size > 0) onVoice(blob);
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (err) {
      onVoiceError(`麦克风不可用：${String(err)}`);
    }
  };

  if (!visible && !recording) return null;

  return (
    <button
      onClick={toggle}
      title={recording ? "停止录音并发送" : "语音输入"}
      style={{
        position: "fixed",
        left: 10,
        top: 10,
        width: 28,
        height: 28,
        borderRadius: "50%",
        border: "1px solid rgba(255,255,255,0.15)",
        background: recording ? "rgba(255,95,87,0.9)" : "rgba(24,24,30,0.7)",
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
      {recording ? "⏹" : "🎤"}
    </button>
  );
}
