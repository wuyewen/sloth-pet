import { invoke } from "@tauri-apps/api/core";
import { getVoiceProvider, resolveVoiceBaseUrl, Settings } from "./providers";
import { buildVisemeTrack, visemeAt, VisemeEvent, VisemeTrack } from "./lipsync";

/** 录音 Blob → data URI，作为 input_audio 直接发给支持音频的对话模型 */
export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function ttsHeaders(s: Settings): Record<string, string> {
  const key = s.voiceApiKey || s.apiKey;
  return {
    "Content-Type": "application/json",
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}

async function readError(resp: Response): Promise<string> {
  return `TTS ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
}

/** OpenAI /audio/speech 兼容：直接返回音频流 */
async function synthesizeOpenAI(s: Settings, text: string): Promise<Blob> {
  const resp = await fetch(`${resolveVoiceBaseUrl(s)}/audio/speech`, {
    method: "POST",
    headers: ttsHeaders(s),
    body: JSON.stringify({
      model: s.voiceTtsModel,
      input: text,
      // 音色留空则不传：部分服务商/模型不支持 voice 参数，传了反而报错
      ...(s.voiceTtsVoice.trim() ? { voice: s.voiceTtsVoice.trim() } : {}),
      response_format: "mp3",
    }),
  });
  if (!resp.ok) throw new Error(await readError(resp));
  return resp.blob();
}

/** 百炼原生 multimodal-generation：无 CORS 头，必须走 Rust 侧请求（dashscope_tts）。
 *  voiceBaseUrl 填了视为完整端点地址，否则用预设地址拼接官方路径 */
async function synthesizeDashscope(s: Settings, text: string): Promise<Blob> {
  const custom = s.voiceBaseUrl.trim();
  const endpoint =
    custom ||
    `${getVoiceProvider(s).baseUrl.replace(/\/+$/, "")}/api/v1/services/aigc/multimodal-generation/generation`;
  const bytes = await invoke<number[]>("dashscope_tts", {
    endpoint,
    apiKey: s.voiceApiKey || s.apiKey,
    model: s.voiceTtsModel,
    text,
    voice: s.voiceTtsVoice.trim() || null,
  });
  return new Blob([new Uint8Array(bytes)]);
}

/** DashScope WebSocket 实时合成（tts_v2 SpeechSynthesizer）：浏览器 WS 握手带不了
 *  Authorization 头，走 Rust 侧（dashscope_ws_tts）。voiceBaseUrl 填了视为完整 wss 端点 */
async function synthesizeDashscopeWs(s: Settings, text: string): Promise<Blob> {
  const endpoint = s.voiceBaseUrl.trim() || getVoiceProvider(s).baseUrl;
  const bytes = await invoke<number[]>("dashscope_ws_tts", {
    endpoint,
    apiKey: s.voiceApiKey || s.apiKey,
    model: s.voiceTtsModel,
    text,
    voice: s.voiceTtsVoice.trim() || null,
  });
  return new Blob([new Uint8Array(bytes)]);
}

let audioCtx: AudioContext | null = null;
let playingSource: AudioBufferSourceNode | null = null;
let analyser: AnalyserNode | null = null;
let analyserBuf: Uint8Array<ArrayBuffer> | null = null;
let analyserFreqBuf: Uint8Array<ArrayBuffer> | null = null;
let smoothedLevel = 0;
let visemeTrack: VisemeTrack | null = null;
/** 当前播报在音频时钟上的起点（audioCtx.currentTime） */
let playStartAt = 0;

/** 当前播报音量（0..1，快攻慢放平滑），未在播报时返回 0；供口型同步每帧轮询 */
export function getSpeechLevel(): number {
  if (!playingSource || !analyser || !analyserBuf) {
    smoothedLevel = 0;
    return 0;
  }
  analyser.getByteTimeDomainData(analyserBuf);
  let sum = 0;
  for (let i = 0; i < analyserBuf.length; i++) {
    const v = (analyserBuf[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / analyserBuf.length);
  const target = Math.min(1, rms * 2.5);
  smoothedLevel = Math.max(target, smoothedLevel * 0.85);
  return smoothedLevel;
}

/** 简易共振峰元音分类：按 F1/F2 频段能量占比猜当前发音的口型。
 *  ou/oh 低频集中，aa 中频为主，ih/ee 高 F2 显著。返回 null 表示未在播报 */
export function getSpeechVowel(): "aa" | "ih" | "ou" | null {
  if (!playingSource || !analyser || !analyserFreqBuf || !audioCtx) return null;
  analyser.getByteFrequencyData(analyserFreqBuf);
  const binHz = audioCtx.sampleRate / analyser.fftSize;
  const band = (lo: number, hi: number): number => {
    const i0 = Math.max(1, Math.floor(lo / binHz));
    const i1 = Math.min(analyserFreqBuf!.length - 1, Math.ceil(hi / binHz));
    let e = 0;
    for (let i = i0; i <= i1; i++) e += analyserFreqBuf![i];
    return e / (i1 - i0 + 1) / 255;
  };
  const low = band(200, 600); // F1 低区：ou/oh
  const mid = band(600, 1200); // F1 高区：aa
  const high = band(1800, 3200); // F2 高区：ih/ee
  const total = low + mid + high;
  if (total < 0.03) return null;
  if (high / total > 0.32) return "ih";
  if (low / total > 0.52) return "ou";
  return "aa";
}

/** 当前时刻应显示的口型（按音频时钟查文本 viseme 时间轴）；
 *  无时间轴（非 speak 播放/已结束）返回 null，调用方退 DSP 分类 */
export function getCurrentViseme(): VisemeEvent | null {
  if (!playingSource || !visemeTrack || !audioCtx) return null;
  return visemeAt(visemeTrack, audioCtx.currentTime - playStartAt);
}

/** 打断当前播报 */
export function stopSpeaking() {
  try {
    playingSource?.stop();
  } catch {
    // 已结束的 source 重复 stop 会抛错，忽略
  }
  playingSource = null;
  visemeTrack = null;
}

/** 语音合成并播放（按播报服务商的接口格式分发）；新播报会打断旧的。
 *  播放走 Web Audio：WKWebView 的 Audio 元素播 blob: URL 会抛 NotSupportedError；
 *  链路中挂 AnalyserNode，供 getSpeechLevel 做口型同步 */
export async function speak(s: Settings, text: string): Promise<void> {
  stopSpeaking();
  const style = getVoiceProvider(s).apiStyle;
  const blob =
    style === "dashscope-mg"
      ? await synthesizeDashscope(s, text)
      : style === "dashscope-ws"
        ? await synthesizeDashscopeWs(s, text)
        : await synthesizeOpenAI(s, text);
  const raw = await blob.arrayBuffer();
  audioCtx ??= new AudioContext();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const decoded = await audioCtx.decodeAudioData(raw);
  const source = audioCtx.createBufferSource();
  source.buffer = decoded;
  // 文本 viseme 时间轴：原文 + 音频真实时长，播放期间供口型精确查询
  visemeTrack = buildVisemeTrack(text, decoded.duration);
  playStartAt = audioCtx.currentTime;
  analyser ??= audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyserBuf ??= new Uint8Array(analyser.fftSize);
  analyserFreqBuf ??= new Uint8Array(analyser.frequencyBinCount);
  source.connect(analyser);
  analyser.connect(audioCtx.destination);
  playingSource = source;
  source.onended = () => {
    if (playingSource === source) {
      playingSource = null;
      visemeTrack = null;
    }
  };
  source.start();
}

/** 挑一个当前 WebView 支持的录音格式（WKWebView 通常是 audio/mp4） */
export function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of ["audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}
