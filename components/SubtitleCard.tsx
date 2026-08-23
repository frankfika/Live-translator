
import React, { useState, useCallback } from 'react';
import { SubtitleMessage } from '../types';

interface Props {
  message: SubtitleMessage;
  isRecent: boolean;
  onSwitchLanguage?: (lang: string) => void;
}

// Shared pattern — compiled once, not per render
const LANG_TAG_RE = /\s*\[Lang:\s*([^\]]+)\]/;

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const SubtitleCard: React.FC<Props> = React.memo(({ message, isRecent, onSwitchLanguage }) => {
  const [copied, setCopied] = useState(false);

  const langTagMatch = message.translated.match(LANG_TAG_RE);
  const detectedLang = langTagMatch ? langTagMatch[1].trim() : null;
  const displayTranslated = message.translated.replace(LANG_TAG_RE, '').trim();
  const hasContent = displayTranslated.length > 0;

  const cleanOriginal = message.original
    .replace(/<noise>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const showOriginal = cleanOriginal.length > 0;

  const handleCopy = useCallback(() => {
    const parts: string[] = [];
    if (cleanOriginal) parts.push(`原文: ${cleanOriginal}`);
    if (displayTranslated) parts.push(`译文: ${displayTranslated}`);
    const text = parts.join('\n');
    // Tauri webview 的 clipboard API 在某些权限配置下会 silently fail,
    // 加 .catch + fallback 用 document.execCommand 兜底
    const fallbackCopy = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } else {
          setCopied(false);
        }
      } catch {
        setCopied(false);
      }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        },
        () => fallbackCopy(),
      );
    } else {
      fallbackCopy();
    }
  }, [cleanOriginal, displayTranslated]);

  return (
    <div
      className={`group relative transition-all duration-500 ease-out ${
        isRecent
          ? 'opacity-100 scale-100'
          : 'opacity-95 hover:opacity-100'
      }`}
    >
      {/* 实时卡片的高亮光晕背景 */}
      {isRecent && (
        <div className="absolute -inset-x-4 -inset-y-3 rounded-2xl bg-gradient-to-r from-blue-500/5 via-indigo-500/5 to-purple-500/5 border border-blue-500/20 pointer-events-none" />
      )}

      <div className="relative flex flex-col gap-2">

        {/* 时间戳 + 复制按钮 - 仅最终消息。复制按钮永远显示(键盘焦点 / 屏幕阅读器都需要),
             之前用 sm:opacity-0 sm:group-hover:opacity-100 鼠标 hover 才显,键盘用户 Tab 上去视觉外 */}
        {message.isFinal && (
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-[10px] text-gray-600 font-mono tabular-nums">{formatTime(message.timestamp)}</span>
            <button
              onClick={handleCopy}
              aria-label="复制此条翻译"
              title="复制此条翻译"
              className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-200 focus-visible:text-gray-200 transition-colors px-2 py-1 rounded hover:bg-gray-800/60 focus-visible:bg-gray-800/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50"
            >
              {copied ? (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414L8.414 15l-5.121-5.121a1 1 0 011.414-1.414L8.414 12.172l6.879-6.879a1 1 0 011.414 0z" clipRule="evenodd"/>
                  </svg>
                  <span className="text-emerald-400">已复制</span>
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                  <span>复制</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* 原文 */}
        {showOriginal && (
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] uppercase tracking-wider font-bold text-gray-500 bg-gray-800/60 px-2 py-0.5 rounded">
                原文
              </span>
              {isRecent && !message.isFinal && (
                <span className="text-[10px] text-gray-500 italic">识别中</span>
              )}
            </div>
            <div className="text-gray-300 text-base md:text-lg font-medium leading-relaxed pl-3 border-l-2 border-gray-700 break-words whitespace-pre-wrap">
              {cleanOriginal}
            </div>
          </div>
        )}

        {/* 译文 */}
        <div className="mt-1.5">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider font-bold bg-blue-500/15 text-blue-300 px-2 py-0.5 rounded">
              译文
            </span>
            {detectedLang && (
              <div className="flex items-center gap-2 animate-in fade-in slide-in-from-left-2">
                <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold bg-amber-500/15 text-amber-300 px-2 py-0.5 rounded">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                  </svg>
                  检测到 {detectedLang}
                </span>
                {onSwitchLanguage && (
                  <button
                    onClick={() => onSwitchLanguage(detectedLang)}
                    aria-label={`切换目标语言为 ${detectedLang}`}
                    className="text-[10px] text-amber-300/90 hover:text-amber-200 underline underline-offset-2 hover:no-underline transition-colors"
                    title={`切换目标语言为 ${detectedLang}`}
                  >
                    切换 →
                  </button>
                )}
              </div>
            )}
          </div>

          <div className={`font-bold leading-relaxed pl-3 border-l-2 break-words whitespace-pre-wrap transition-all duration-300 ${
            isRecent
              ? 'text-white text-xl md:text-3xl border-blue-400'
              : 'text-gray-200 text-lg md:text-2xl border-blue-500/70'
          }`}>
            {hasContent ? (
              <>
                {displayTranslated}
                {/* 实时打字光标 */}
                {isRecent && <span className="caret-blink text-blue-400" />}
              </>
            ) : isRecent ? (
              <span className="text-gray-500 italic text-base md:text-xl inline-flex items-center gap-2">
                <span className="inline-flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </span>
                <span className="text-sm md:text-base text-gray-400">识别翻译中</span>
              </span>
            ) : (
              <span className="text-gray-600 italic text-base opacity-50">(无翻译内容)</span>
            )}
          </div>
        </div>

      </div>
    </div>
  );
});

SubtitleCard.displayName = 'SubtitleCard';

export default SubtitleCard;
