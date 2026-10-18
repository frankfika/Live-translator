import { AudioInputDevice } from '../types';

/**
 * 平台音频采集说明：
 * - macOS WKWebView 不支持 getDisplayMedia，无法直接捕获系统音频。
 *   采集会议软件（Zoom/腾讯会议/Teams 等）输出，需要用户在 macOS 上安装
 *   虚拟声卡（BlackHole / Loopback / Soundflower 等），并把会议软件输出
 *   路由到该虚拟声卡，再在本应用里选择同一虚拟声卡作为输入。
 * - Windows WebView2 支持 getDisplayMedia 勾选"共享音频"，但本文件只处理
 *   麦克风输入路径；屏幕音频捕获走单独的 system-audio 路径（由 App.tsx 决定）。
 *
 * 因此本文件关注的是：
 *   1. 给麦克风/getUserMedia 拼出正确的 MediaTrackConstraints
 *   2. enumerateDevices 列表里把虚拟声卡识别出来（isVirtual）方便 UI 标记
 *   3. macOS 上把 deviceId='default' / 'communications' 也保留下来，否则只有
 *      内建麦的 Mac 用户看到的设备列表会为空（之前 bug：被过滤掉）
 */

export interface MicrophoneConstraintOptions {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

/**
 * 构造麦克风采集约束。
 *
 * 默认值变化说明（行为变更）：
 *   之前 echoCancellation/noiseSuppression/autoGainControl 全部 false，导致
 *   会议场景（尤其桌面有外放/外接麦时）回声啸叫、收音不清。会议同传是核心场景，
 *   现在默认全部开，调用方需要"纯净录音"时再显式关。
 *
 * 兼容旧调用：旧代码只有 buildMicrophoneConstraints(deviceId)，无 opts 时
 *   也走默认开。
 */
export function buildMicrophoneConstraints(
  deviceId?: string,
  opts?: MicrophoneConstraintOptions,
): MediaTrackConstraints {
  return {
    echoCancellation: opts?.echoCancellation ?? true,
    noiseSuppression: opts?.noiseSuppression ?? true,
    autoGainControl: opts?.autoGainControl ?? true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

/**
 * 判断 label 是否像虚拟声卡。
 * 命中关键字：BlackHole、VB-Cable、VB-Audio、Voicemeeter、Soundflower、Loopback、中文"虚拟"。
 * 比较用 toLowerCase，匹配任意子串。
 */
export function isVirtualAudioDevice(label: string): boolean {
  if (!label) return false;
  const lowered = label.toLowerCase();
  const keywords = [
    'blackhole',
    'vb-cable',
    'vb-audio',
    'voicemeeter',
    'soundflower',
    'loopback',
    '虚拟',
  ];
  return keywords.some((kw) => lowered.includes(kw));
}

/**
 * 判断输入设备是否是"系统声音回环"类设备：
 * PulseAudio/PipeWire 的 "Monitor of …"、Windows 的「立体声混音 / Stereo Mix」、
 * VB-Cable 的 "CABLE Output"、BlackHole 等。
 * 这类设备采到的是扬声器里播放的声音，不能开回声消除/降噪（会把人声当回声消掉）。
 */
export function isLoopbackInputDevice(label: string): boolean {
  if (!label) return false;
  const l = label.toLowerCase();
  return [
    'monitor of',
    '.monitor',
    'stereo mix',
    '立体声混音',
    '混音',
    'what u hear',
    'wave out mix',
    'cable output',
    'blackhole',
    'loopback',
    'soundflower',
  ].some((kw) => l.includes(kw));
}

/**
 * 把 navigator.mediaDevices.enumerateDevices() 的结果规整成 UI 直接消费的列表。
 *
 * 关键改动（行为变更）：
 *   - 不再过滤 deviceId === 'default' 或 'communications'。
 *     之前的过滤逻辑会让"只有内建麦的 Mac 用户"看到的设备列表为空，
 *     因为 macOS 上 enumerateDevices 在未授权时只返回 default/communications 两项。
 *     现在保留它们，分别以"系统默认输入设备"和"通讯设备"占位。
 *   - 去重（同 deviceId 只留一次），空 label 自动给"输入设备 N"。
 *   - 每个设备加 isVirtual: boolean（基于 label 启发式识别）。
 *   - 排序：不论 enumerateDevices 怎么给，default 强制排第一，communications 第二，
 *     其他设备保持 enumerateDevices 给的相对顺序。
 */
export function normalizeAudioInputDevices(devices: MediaDeviceInfo[]): AudioInputDevice[] {
  const seen = new Set<string>();
  const result: AudioInputDevice[] = [];
  let unnamedIndex = 1;

  const push = (device: AudioInputDevice) => {
    if (!device.deviceId || seen.has(device.deviceId)) return;
    seen.add(device.deviceId);
    result.push(device);
  };

  for (const device of devices) {
    if (device.kind !== 'audioinput') continue;

    if (!device.deviceId) continue;

    if (device.deviceId === 'default') {
      // 未授权 / 仅内建麦的 Mac：label 给个明确中文名
      push({
        deviceId: 'default',
        label: device.label || '系统默认输入设备',
        isVirtual: false,
      });
      continue;
    }

    if (device.deviceId === 'communications') {
      push({
        deviceId: 'communications',
        label: device.label || '通讯设备',
        isVirtual: false,
      });
      continue;
    }

    push({
      deviceId: device.deviceId,
      label: device.label || `输入设备 ${unnamedIndex++}`,
      isVirtual: isVirtualAudioDevice(device.label),
    });
  }

  // 强制把 default 排第一、communications 排第二（如果存在）。
  // 这样不论 enumerateDevices 怎么给顺序，UI 看到的列表都是稳定的。
  const sortPriority = (id: string) => {
    if (id === 'default') return 0;
    if (id === 'communications') return 1;
    return 2;
  };
  result.sort((a, b) => sortPriority(a.deviceId) - sortPriority(b.deviceId));

  return result;
}

export function formatMediaError(error: unknown, fallback: string): string {
  if (error instanceof Error && /invalid constraint/i.test(error.message)) {
    return '当前系统不支持所选的录音参数，且没有找到可用的麦克风。\n请检查系统是否有输入设备，或在设置里换一个输入设备。';
  }
  if (!(error instanceof DOMException)) {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

  switch (error.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return isTauri
        ? '系统尚未授予本应用麦克风权限。\n请到「系统设置 → 隐私与安全性 → 麦克风」中开启本应用，然后重启 App。'
        : '浏览器尚未获得音频权限，请先允许麦克风访问。';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有检测到可用的音频输入设备。\n如果是虚拟声卡（如 BlackHole），请确认已安装并在系统音频设置中将其设为输出。';
    case 'NotReadableError':
    case 'TrackStartError':
      // On macOS WKWebView this often means mic permission was denied at the OS
      // level — the audio device itself is fine. Surface both possibilities so
      // the user doesn't blindly quit Zoom/etc.
      return isTauri
        ? '无法打开音频设备。\n可能原因：\n1. 系统未授予本应用麦克风权限（设置 → 隐私与安全性 → 麦克风）\n2. 该设备正被其他应用独占占用\n\n请检查后重试。'
        : '音频设备正被其他应用占用，请先关闭占用它的软件后重试。';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return '当前选择的输入设备不可用，请刷新列表后重新选择。\n如果是外接设备，请确认已正确连接。';
    case 'AbortError':
      return '音频采集被中断，请重试。';
    case 'SecurityError':
      return '浏览器安全策略阻止了音频访问。\n如果是 Tauri 桌面应用，请确认麦克风权限已在系统设置中开启。';
    default:
      return error.message || fallback;
  }
}