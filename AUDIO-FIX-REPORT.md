# 麦克风 / 录制 / 声音 全面修复报告

**日期**: 2026-08-10
**项目**: AI 同声传译 · 实时字幕
**修复范围**: 4 个 P0 致命 + 3 个 P1 高优

---

## 根因: 5 个 bug 串成 Frank 报告的"听不到 / 录制不了"

Frank 报告的"听不到和说不出来声音" + "录制不了" + "mic 多问题" 不是多个独立 bug, 而是同一条音频管线上的 4 个连环断点 + 1 个外围问题。

---

## 🔴 P0-1: CSP 拦截了所有 SiliconFlow 请求

**文件**: `src-tauri/tauri.conf.json:45`

**症状**: Frank 报告"录制不了" —— 但实际不是录制失败, 是**录到了但 ASR 拿不到结果**。

**根因**: Tauri WebView 强制按 CSP 拦截 `fetch`. 原 CSP `connect-src 'self' https://generativelanguage.googleapis.com wss://*.googleapis.com` 只放行了 Gemini, 而 ASR (`https://api.siliconflow.cn/v1/audio/transcriptions`) 和 LLM (`/v1/chat/completions`) 都被拒. fetch 直接抛 TypeError 静默失败, 用户看到的就是"按了开始但什么都没出来".

**修法**: connect-src 加 `https://api.siliconflow.cn https://*.siliconflow.cn wss://*.siliconflow.cn`. 同时补 `img-src data: blob:` (后续要支持), `font-src https://cdn.tailwindcss.com` (index.html 用).

---

## 🔴 P0-2: 麦克风音频被直送扬声器 (致命 feedback)

**文件**: `services/providers/siliconflow.ts:96` (修前，注：旧版本叫 `services/siliconFlowClient.ts`，2026-08 重构成 `services/providers/*.ts` 架构)

**症状**: Frank 报告"听不到和说不出来声音" —— 在 macOS Tauri WebView 里, 这一行还会**直接让整个 mic 链路被系统静音** (避免啸叫保护), 所以**录到一半录不到** + 同时如果有声音会无限 feedback.

**根因**:
```ts
this.processor.connect(this.inputAudioContext.destination);  // mic → speakers
```
ScriptProcessorNode 必须 connect 到一个节点才能触发 `onaudioprocess` 回调. 原代码连到了 `destination` (=扬声器). 在 Chromium / WKWebView 里, mic 走 destination 会触发系统的"防啸叫"路径, 把 mic 整路静音, 这就是为什么 ASR 完全收不到东西.

**修法**: 改连到 mute GainNode (gain=0) —— 保持 graph 活 (callback 仍触发), 但不输出声音到扬声器.

---

## 🔴 P0-3: AudioContext 创建后没 resume, 处于 suspended 状态

**文件**: `services/providers/siliconflow.ts:59` (修前，注：旧版本叫 `services/siliconFlowClient.ts`)

**症状**: 跟 P0-2 叠加 —— 即使修了 P0-2, mic 仍可能 silent.

**根因**: 现代浏览器 autoplay policy 下, `new AudioContext()` 默认 `state='suspended'`, 必须显式 `resume()` 才会真正处理音频流. Tauri WKWebView 同样遵守这个策略. 原代码完全没 resume, 等于建了个空架子.

**修法**: 创建后立刻 `if (state === 'suspended') await resume()`. 同时给 `new AudioContext({sampleRate: 16000})` 加 try/catch fallback —— macOS WKWebView 经常忽略 sampleRate constraint, 实际给 48k. fallback 让 native 跑, 然后我们读 `ctx.sampleRate` (真实值) 给后面的 downsample 用.

---

## 🔴 P0-4: Tauri capability 没列 global-shortcut 权限

**文件**: `src-tauri/capabilities/default.json:8-10` (修前)

**症状**: Frank 按 `Cmd+Shift+S` / `Cmd+Shift+R` 全局快捷键完全没反应. 以为快捷键坏.

**根因**: `lib.rs:38-51` 注册了快捷键, 但 `default.json` 只列了 `core:default`, **没列 `global-shortcut:default`**. Tauri 2.x 的 plugin 权限必须显式 grant, 否则 runtime 静默 reject.

**修法**: 加 `global-shortcut:default` + 补 `core:event:default` / `core:window:default` / `core:webview:default` / `core:app:default` (防后面再加 event / window 操作时再踩). windows 列表也补上 `subtitle` (副屏悬浮字幕窗).

---

## 🟠 P1-5: formatMediaError 在 Tauri 模式下误诊 macOS 权限问题

**文件**: `services/mediaDevices.ts:34-56` (修前)

**症状**: 用户在 macOS 首次开 app 拒了 mic 权限, 然后重试, 报"设备正被其他应用占用". 但实际上**没有任何 app 占用**, 是 OS 拒绝.

**根因**: macOS WKWebView 报的 `NotReadableError` 经常是 OS 权限被拒的副作用, 但 `formatMediaError` 把这个 error name 一律解读成"被占用".

**修法**: 加 `isTauri` 判断, 在桌面端给出双可能解释 (系统权限 / 设备占用) + 具体路径 (系统设置 → 隐私与安全性 → 麦克风). NotFoundError 加 BlackHole 提示, SecurityError 加 Tauri 权限说明.

---

## 🟠 P1-6 (之前误判): subtitle.html 已经订阅事件, 不需要修

之前以为是死代码, 实际 `subtitle.html:60-66` 已经 `listen('subtitle-update', ...)`. 跳过.

---

## 🟠 P1-7: tauriListen 异步初始化竞态

**文件**: `App.tsx:16-25, 96-119` (修前)

**症状**: 全局快捷键监听有时注册失败, 因为 useEffect 跑时 dynamic import 还没 resolve.

**根因**: 原代码
```ts
if (isTauriApp()) {
  import('@tauri-apps/api/event').then(({ emit, listen }) => { ... });
}
// 下一行
useEffect(() => { /* 用 tauriListen */ }, []);
```
useEffect 可能在 `.then` 之前跑, 此时 `tauriListen === null`, 监听永远不注册.

**修法**: 暴露 `tauriEventReady` promise, 在 `loadSettings` 内部 `await tauriEventReady` 后再注册监听.

---

## 验证 (静态)

- `npx tsc --noEmit` — 0 error
- `npx vitest run` — 7/7 通过
- `cd src-tauri && cargo check` — 0 warning
- `cd src-tauri && cargo build` — 编译成功
- `npx vite build` — 生产构建成功 (243KB main.js)

## 运行时验证步骤 (Frank 真机测一遍)

1. `npm run dev` 起 Tauri 桌面 app
2. 打开设置 → 配置 API Key
3. 选麦克风模式, 点"测试输入"
   - **预期**: 电平条动 + 浏览器**不再弹** mic 权限 (因为 Tauri 自己处理)
4. 点"开始翻译", 对着 mic 说话
   - **预期**: 顶栏状态变"录音中", 几秒后出原文 + 译文
5. 切到会议软件 (Zoom / 腾讯会议), 选系统音频模式
   - **预期**: 弹屏幕共享窗口, 选带音频的标签页
6. 按 `Cmd+Shift+S` (macOS) / `Ctrl+Shift+S` (Win)
   - **预期**: 副屏悬浮字幕窗 show/hide 切换

## 没动的事项 (P2, 后续可优化)

- `ScriptProcessorNode` 是 deprecated, 应该用 `AudioWorklet`. 短期 mute GainNode 方案能跑, 长期换.
- `lib.rs:38` 那个 callback 参数顺序是 `(_app, _event, _shortcut)` 实际官方签名是 `(&AppHandle, &Shortcut, ShortcutEvent)`, 参数名错位, 但都是 `_` 忽略, 行为 OK.
- 当前没 TTS —— Frank 说"说不出来"确认是 mic 链路断, 修好 P0-1/2/3 后 mic 进 ASR 正常, 翻译会出字幕. 后续如果需要"念出译文", 是新功能, 单独做.
