/**
 * ASR / LLM 输出清洗。
 *
 * 噪音场景的主要问题不在 VAD 本身，而在 ASR 对"非人声"片段的幻觉输出：
 * - SenseVoice 会输出 <|zh|><|NEUTRAL|><|Speech|><|woitn|> 这类标签和 🎼😊 这类事件 emoji
 * - Whisper 系模型对静音/音乐会幻觉出"谢谢观看""字幕由 xxx 提供""Thank you for watching"
 * - 键盘声、咳嗽经常被识别成单个"嗯""啊""Yeah"
 * 这些都不该进翻译，更不该上屏。
 */

// SenseVoice 风格的 <|xxx|> 标签
const SPECIAL_TAG_RE = /<\|[^|>]*\|>/g;
// 其他尖括号事件标签：<noise> <music> <laughter> 等
const ANGLE_TAG_RE = /<\/?(noise|music|laughter|applause|silence|unk|breath|cough)[^>]*>/gi;
// 方括号/圆括号事件标注：[音乐] (笑声) [BLANK_AUDIO] (Applause)
const BRACKET_EVENT_RE =
  /[[(（【]\s*(音乐|笑声|掌声|噪音|杂音|静音|咳嗽|music|laughter|laughs|applause|noise|silence|blank_audio|inaudible|no speech|背景音乐)\s*[\])）】]/gi;
// emoji / 事件符号（SenseVoice 用 🎼👏😀😭🤧 表示事件和情绪）
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

/** 常见幻觉句：整句命中（去标点、小写后）就丢弃 */
const HALLUCINATIONS = [
  '谢谢观看', '感谢观看', '谢谢大家观看', '谢谢收看', '感谢收看',
  '请不吝点赞订阅转发打赏支持明镜与点点栏目', '请不吝点赞', '点赞订阅', '订阅我的频道',
  '字幕由amaraorg社区提供', '字幕志愿者', '中文字幕', '本字幕由',
  'thankyouforwatching', 'thanksforwatching', 'pleasesubscribe', 'likeandsubscribe',
  'subtitlesbytheamaraorgcommunity',
  'ご視聴ありがとうございました',
  '시청해주셔서감사합니다',
];
const HALLUCINATION_SET = new Set(HALLUCINATIONS);
/** 前缀命中也丢（"字幕由 xxx 提供"之类后面会跟变化的名字） */
const HALLUCINATION_PREFIXES = ['字幕由', '字幕提供', 'subtitlesby', 'captionsby', '请不吝点赞'];

/** 纯语气词：整句只有这些就不翻译 */
const FILLERS = new Set([
  '嗯', '啊', '哦', '噢', '呃', '额', '唉', '哎', '诶', '欸', '嗯嗯', '啊啊', '哦哦', '嗯哼', '呵', '哈', '哈哈', '嘿',
  'um', 'uh', 'uhm', 'umm', 'hmm', 'hm', 'mm', 'mhm', 'ah', 'oh', 'eh', 'er', 'erm', 'huh', 'yeah', 'ok', 'okay', 'yep', 'uhhuh',
  'えー', 'あの', 'うん', 'はい', '음', '어', '네',
]);

/** 去掉标点、空白、大小写，用于比对 */
export function compactText(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 清理 ASR 输出里的标签/emoji/事件标注，返回干净文本（可能为空串） */
export function cleanTranscript(raw: string): string {
  if (!raw) return '';
  let t = raw
    .replace(SPECIAL_TAG_RE, ' ')
    .replace(ANGLE_TAG_RE, ' ')
    .replace(BRACKET_EVENT_RE, ' ')
    .replace(EMOJI_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 连续重复（"好的好的好的好的好的"、"the the the the"）是 ASR 在噪音上卡住的典型表现，压到最多 2 次
  t = t.replace(/(.{1,12}?)(?:[\s,，、]*\1){3,}/gu, '$1 $1');
  return t;
}

export type TranscriptVerdict = { keep: true; text: string } | { keep: false; reason: string };

/**
 * 判定一段 ASR 文本是否值得翻译。
 * 返回 keep=false 时附带原因，方便调试。
 */
export function judgeTranscript(raw: string): TranscriptVerdict {
  const text = cleanTranscript(raw);
  const compact = compactText(text);
  if (!compact) return { keep: false, reason: 'empty' };
  if (HALLUCINATION_SET.has(compact)) return { keep: false, reason: 'hallucination' };
  if (HALLUCINATION_PREFIXES.some((p) => compact.startsWith(p))) return { keep: false, reason: 'hallucination' };
  if (FILLERS.has(compact)) return { keep: false, reason: 'filler' };
  // 单个字符（CJK 单字 / 单个字母）几乎都是噪音误识别
  if ([...compact].length <= 1) return { keep: false, reason: 'too-short' };
  // 全是数字/符号的短串（"1" "2 3"）
  if (/^\d{1,3}$/.test(compact)) return { keep: false, reason: 'too-short' };
  return { keep: true, text };
}

/**
 * 清理 LLM 翻译输出：
 * - Qwen3 / DeepSeek-R1 这类推理模型可能输出 <think>…</think>
 * - 模型偶尔不听话加 "Translation:" / "译文：" 前缀或整句加引号
 * 流式场景下 <think> 可能还没闭合，此时把 <think> 之后的内容都视为思考。
 */
export function cleanTranslation(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = t.search(/<think>/i);
  if (open >= 0) t = t.slice(0, open);
  t = t.trim();
  t = t.replace(/^(translation|译文|翻译|interpretation|output|输出)\s*[:：]\s*/i, '');
  // 整句被一对引号包起来
  const m = t.match(/^["“「『'](.*)["”」』']$/s);
  if (m) t = m[1].trim();
  return t;
}

/** 翻译结果是否表示"跳过"（模型认为是噪音） */
export function isSkipOutput(s: string): boolean {
  const c = s.trim().toUpperCase();
  return c === '' || c === '[SKIP]' || c === 'SKIP' || c.startsWith('[SKIP]');
}

/** 流式过程中，是否可能是 [SKIP] 的前缀 —— 是的话先别上屏，避免闪一下 "[SK" */
export function mightBeSkipPrefix(s: string): boolean {
  const c = s.trim().toUpperCase();
  return c.length > 0 && '[SKIP]'.startsWith(c);
}
