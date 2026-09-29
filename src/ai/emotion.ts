/** AI 回复情绪标签 → VRM 表情驱动 */

/** 情绪标签 → VRM 1.0 预设表情名 */
export const EMOTION_TO_EXPRESSION: Record<string, string> = {
  happy: "happy",
  sad: "sad",
  angry: "angry",
  surprised: "surprised",
  relaxed: "relaxed",
};

export const EMOTION_TAGS = Object.keys(EMOTION_TO_EXPRESSION);

/** 追加到 system prompt 的情绪标签指令（回复以 [tag] 开头） */
export const EMOTION_INSTRUCTION = `【格式要求】每次回复必须以恰好一个情绪标签开头，标签后紧跟正文：
[happy] 开心、夸奖、好消息 / [sad] 难过、遗憾 / [angry] 生气、吐槽 / [surprised] 惊讶、疑问、思考 / [relaxed] 放松、困倦、晚安
正文里不要再出现这些标签。`;

const TAG_RE = new RegExp(`^\\s*\\[(${EMOTION_TAGS.join("|")})\\]\\s*`);

/** 从流式文本中解析情绪标签；返回标签和可展示的正文 */
export function parseEmotion(raw: string): { tag: string | null; text: string } {
  const m = raw.match(TAG_RE);
  if (m) return { tag: m[1], text: raw.slice(m[0].length) };
  // 流式途中标签未闭合（如 "[hap"），展示时先隐藏
  if (/^\s*\[[a-z]*$/.test(raw)) return { tag: null, text: "" };
  return { tag: null, text: raw };
}
