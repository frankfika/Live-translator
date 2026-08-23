
import React, { useEffect, useRef } from 'react';

interface Props {
  stream: MediaStream | null;
  isActive: boolean;
}

const IDLE_BAR_COUNT = 48;

const AudioVisualizer: React.FC<Props> = ({ stream, isActive }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  // Store source + analyser per effect run so cleanup can disconnect them precisely
  const nodeRef = useRef<{ source: MediaStreamAudioSourceNode; analyser: AnalyserNode; ctx: AudioContext } | null>(null);
  // Smoothed values for lerp
  const smoothedRef = useRef<Float32Array | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Stop animation if inactive or no stream
    if (!stream || !isActive) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      // Clear canvas to blank
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      smoothedRef.current = null;
      return;
    }

    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    // Create a fresh AudioContext for this stream
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    // Tauri WKWebView 启动时 AudioContext 可能是 suspended, 显式 resume
    // 否则首帧不画(用户看到 canvas 一直空白)
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => { /* user gesture 没, 下次再 resume */ });
    }
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    nodeRef.current = { source, analyser, ctx: audioCtx };

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    smoothedRef.current = new Float32Array(bufferLength);

    // Scale canvas for HiDPI displays
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx2d.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;

    const LERP = 0.3;
    const RADIUS = 2;

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);

      if (audioCtx.state === 'closed') return;
      analyser.getByteFrequencyData(dataArray);

      const smoothed = smoothedRef.current!;

      ctx2d.clearRect(0, 0, W, H);

      const barWidth = (W / bufferLength) * 2.5;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const raw = dataArray[i] / 2;
        // Time-smooth with lerp
        smoothed[i] = smoothed[i] + LERP * (raw - smoothed[i]);
        const barHeight = smoothed[i];

        // Blue-purple gradient: hue 220 → 260 mapped across frequency bins
        const hue = 220 + 40 * (i / bufferLength);
        const lightness = 45 + 15 * (barHeight / 128);
        ctx2d.fillStyle = `hsl(${hue}, 80%, ${lightness}%)`;

        // Rounded top bars using roundRect
        const bx = x;
        const by = H - barHeight;
        const bw = barWidth;
        const bh = barHeight;
        if (bh > 0) {
          ctx2d.beginPath();
          if (ctx2d.roundRect) {
            ctx2d.roundRect(bx, by, bw, bh, [RADIUS, RADIUS, 0, 0]);
          } else {
            // Fallback for browsers without roundRect
            ctx2d.moveTo(bx + RADIUS, by);
            ctx2d.lineTo(bx + bw - RADIUS, by);
            ctx2d.quadraticCurveTo(bx + bw, by, bx + bw, by + RADIUS);
            ctx2d.lineTo(bx + bw, by + bh);
            ctx2d.lineTo(bx, by + bh);
            ctx2d.lineTo(bx, by + RADIUS);
            ctx2d.quadraticCurveTo(bx, by, bx + RADIUS, by);
          }
          ctx2d.fill();
        }

        x += barWidth + 1;
      }
    };

    draw();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      // Disconnect nodes before closing context to avoid errors
      try { source.disconnect(); } catch { /* ignore */ }
      try { analyser.disconnect(); } catch { /* ignore */ }
      audioCtx.close().catch(() => {});
      nodeRef.current = null;
    };
  }, [stream, isActive]);

  // 未激活时显示静态占位条（CSS 动画），保持视觉存在感
  const showIdle = !stream || !isActive;

  return (
    <div className="relative w-full h-12" role="presentation">
      {showIdle && (
        <>
          <div
            className="absolute inset-0 flex items-end justify-center gap-1 opacity-20"
            aria-hidden="true"
          >
            {Array.from({ length: IDLE_BAR_COUNT }).map((_, i) => (
              <div
                key={i}
                className="w-0.5 md:w-1 rounded-full bg-gradient-to-t from-gray-500/40 to-gray-400/40 idle-bar"
                style={{
                  height: `${20 + Math.sin(i * 0.6) * 12 + 12}px`,
                  animationDelay: `${(i * 70) % 1400}ms`,
                  animationDuration: `${1.4 + (i % 5) * 0.15}s`,
                }}
              />
            ))}
          </div>
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-[10px] text-gray-600 font-medium tracking-wider uppercase">
              {stream ? '准备中' : '等待开始'}
            </span>
          </div>
        </>
      )}
      <canvas
        ref={canvasRef}
        className="relative w-full h-12 rounded opacity-90"
        style={{ display: showIdle ? 'none' : 'block' }}
        aria-label="实时音频电平可视化"
        role="img"
      />
    </div>
  );
};

export default AudioVisualizer;
