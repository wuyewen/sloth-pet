/** 文本驱动 viseme 时间轴：已知 TTS 朗读的原文与音频总时长，
 *  用拼音/字母规则估算每个音节的发音时刻与口型，整体归一化到真实音频时长。
 *  比纯音量驱动自然（元音对得上、标点处闭嘴），比实时 DSP 稳定（不抖） */

import { pinyin } from "pinyin-pro";

export interface VisemeEvent {
  /** 距音频起点的秒数 */
  t: number;
  /** VRM 1.0 预设口型；sil = 闭嘴（标点、字间空隙） */
  vowel: "aa" | "ih" | "ou" | "ee" | "oh" | "sil";
  /** 张口权重（0~1），与实时音量相乘 */
  weight: number;
}

export interface VisemeTrack {
  duration: number;
  events: VisemeEvent[];
}

/** 韵母 → 口型。圆唇归 ou/oh，开口归 aa，齐齿归 ih/ee */
const FINAL_TO_VISEME: Record<string, VisemeEvent["vowel"]> = {
  a: "aa", ai: "aa", ao: "aa", an: "aa", ang: "aa",
  o: "oh", ou: "oh", ong: "oh",
  e: "ee", en: "ee", eng: "ee", er: "ee", ei: "ee",
  i: "ih", ia: "ih", ie: "ih", iao: "aa", iu: "ou", ian: "ih", in: "ih",
  iang: "aa", ing: "ih", iong: "ou",
  u: "ou", ua: "aa", uo: "oh", uai: "aa", ui: "ee", uan: "aa", un: "ee",
  uang: "aa", ueng: "ee",
  v: "ou", ve: "ih", van: "aa", vn: "ee",
};

/** 汉字 → 口型：剥掉声母取韵母查表；剥离失败按 aa 处理 */
function hanVowel(ch: string): VisemeEvent["vowel"] {
  const py = pinyin(ch, { toneType: "none" }).trim();
  const m = py.match(/^(?:zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])(.+)$/);
  const final = (m ? m[1] : py).replace("ü", "v");
  return FINAL_TO_VISEME[final] ?? "aa";
}

const LATIN_VOWEL: Record<string, VisemeEvent["vowel"]> = {
  a: "aa", e: "ee", i: "ih", o: "oh", u: "ou",
};

interface Unit {
  vowel: VisemeEvent["vowel"];
  /** 估算相对时长（音节 ≈ 1） */
  dur: number;
  /** 闭唇类（sil）不产生口型事件，只占时长 */
  sil?: boolean;
}

/** 文本 → 发音单元序列（含标点停顿） */
function tokenize(text: string): Unit[] {
  const units: Unit[] = [];
  for (const ch of text) {
    if (/[一-鿿]/.test(ch)) {
      units.push({ vowel: hanVowel(ch), dur: 1 });
    } else if (/[a-zA-Z]/.test(ch)) {
      const v = LATIN_VOWEL[ch.toLowerCase()];
      // 元音字母按半个音节，辅音只贡献短暂闭唇
      units.push(v ? { vowel: v, dur: 0.5 } : { vowel: "sil", dur: 0.25, sil: true });
    } else if (/[0-9]/.test(ch)) {
      units.push({ vowel: "aa", dur: 0.8 });
    } else if (/[，、；：]/.test(ch)) {
      units.push({ vowel: "sil", dur: 1.2, sil: true });
    } else if (/[。！？…!?]/.test(ch)) {
      units.push({ vowel: "sil", dur: 2, sil: true });
    } else if (/\s/.test(ch)) {
      units.push({ vowel: "sil", dur: 0.5, sil: true });
    }
    // 其余符号（括号、引号等）忽略，不占时长
  }
  return units;
}

/** 由原文与音频时长生成 viseme 时间轴。音节间插入短闭嘴空隙，避免嘴巴全程张开 */
export function buildVisemeTrack(text: string, duration: number): VisemeTrack | null {
  const units = tokenize(text);
  if (units.length === 0 || duration <= 0) return null;
  const totalEst = units.reduce((s, u) => s + u.dur, 0);
  if (totalEst <= 0) return null;
  const scale = duration / totalEst;

  const events: VisemeEvent[] = [];
  let t = 0;
  for (const u of units) {
    const dur = u.dur * scale;
    if (!u.sil) {
      // 音节尾部留 15% 闭嘴，形成"一个一个蹦字"的咬合感
      const open = dur * 0.85;
      events.push({ t, vowel: u.vowel, weight: 0.75 + Math.random() * 0.25 });
      events.push({ t: t + open, vowel: "sil", weight: 0 });
    }
    t += dur;
  }
  events.push({ t: duration, vowel: "sil", weight: 0 });
  return { duration, events };
}

/** 查询 playbackTime 时刻的口型（events 按 t 升序，二分最后一个 t <= playbackTime） */
export function visemeAt(track: VisemeTrack, playbackTime: number): VisemeEvent | null {
  const { events } = track;
  if (events.length === 0 || playbackTime < 0 || playbackTime > track.duration) return null;
  let lo = 0, hi = events.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= playbackTime) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return events[ans];
}
