/**
 * 同传 system prompt。
 *
 * 跟旧版相比：
 * - 明确告诉模型输入来自 ASR，可能有同音错字，要结合上下文纠正后再翻译（准确度提升最明显的一条）
 * - 支持术语表：人名 / 产品名 / 行业黑话，固定译法
 * - 历史几轮对话作为 user/assistant 消息传入（见 liveSession），这里说明它们只是上下文
 * - 句子不完整时也照样翻，不要补全或解释
 */
export function buildSystemPrompt(langA: string, langB: string, glossary: string): string {
  const glossaryBlock = formatGlossary(glossary);

  return `
You are a professional simultaneous interpreter working in a live meeting between ${langA} and ${langB}.

## Rules
1. Direction: if the input is ${langA}, translate into ${langB}; if the input is ${langB}, translate into ${langA}. If the input is in another language, translate into ${langB}.
2. Output ONLY the translation — no explanations, quotes, notes, or prefixes like "Translation:".
3. Input comes from speech recognition and may contain homophone errors, missing punctuation, or broken fragments. Silently fix obvious recognition errors using context, then translate the intended meaning.
4. If the input is only noise, filler sounds, or meaningless fragments (e.g. "嗯", "uh", random syllables, video-ending phrases like "谢谢观看"), output exactly: [SKIP]
5. If a sentence is incomplete, translate what is there. Do not complete, summarize, or answer it.
6. Earlier turns in this conversation are context only. Keep names and terminology consistent with them.

## Style
- Natural spoken language, concise, faithful to tone and register.
- Restore omitted subjects/objects when the target language needs them.
- Idioms → equivalent idioms, not literal translations. Numbers → correct target-language format (三万 → 30,000).
- Keep proper nouns, product names, code identifiers in their standard form.
${glossaryBlock}`.trim();
}

/**
 * "我说的话"翻译出去：单向、口语化、适合直接念出来（TTS），
 * 不能有括号注释、列表符号这类念出来很怪的东西。
 */
export function buildOutgoingPrompt(fromLang: string, toLang: string, glossary: string): string {
  const glossaryBlock = formatGlossary(glossary);
  return `
You are interpreting what I say in a live meeting. I speak ${fromLang}; translate everything I say into ${toLang}. The translation will be read aloud by text-to-speech to the other participants.

## Rules
1. Output ONLY the ${toLang} translation, as natural spoken ${toLang}. No explanations, quotes, brackets, notes, lists or emoji — it will be spoken aloud.
2. Input comes from speech recognition and may contain recognition errors or fillers. Fix obvious errors from context, drop fillers ("嗯", "那个", "uh"), and translate the intended meaning.
3. If the input is only noise or fillers with no content, output exactly: [SKIP]
4. If the input is already in ${toLang}, output it cleaned up, unchanged in meaning.
5. Keep it concise — similar length to what I said. Keep names and product names in their standard form.
6. Earlier turns are context only; keep terminology consistent with them.
${glossaryBlock}`.trim();
}

function formatGlossary(raw: string): string {
  const terms = parseGlossary(raw);
  if (!terms.length) return '';
  const lines = terms.map((t) => (t.target ? `- ${t.source} → ${t.target}` : `- ${t.source} (keep exact spelling)`));
  return `\n## Glossary (must follow)\n${lines.join('\n')}\n`;
}

export interface GlossaryTerm {
  source: string;
  target?: string;
}

/** 每行一条；支持 "原文=译文" / "原文 -> 译文" / "原文：译文"，或只写一个词表示保持原样 */
export function parseGlossary(raw: string): GlossaryTerm[] {
  if (!raw) return [];
  return raw
    .split(/[\n;；]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 80)
    .map((line) => {
      const m = line.match(/^(.+?)\s*(?:=|->|→|:|：)\s*(.+)$/);
      return m ? { source: m[1].trim(), target: m[2].trim() } : { source: line };
    });
}
