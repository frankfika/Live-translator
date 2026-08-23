import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const siliconFlowApiKey = env.SILICONFLOW_API_KEY || process.env.SILICONFLOW_API_KEY || '';
    const defaultApiKey = siliconFlowApiKey;
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        // 端口被占时直接报错而不是静默切到 3001——tauri.conf.json 的 devUrl
        // 写死 localhost:3000，静默切换会导致 Tauri 窗口白屏（加载 3000 无服务）
        strictPort: true,
      },
      plugins: [react()],
      build: {
        rollupOptions: {
          input: {
            main: path.resolve(__dirname, 'index.html'),
            subtitle: path.resolve(__dirname, 'subtitle.html'),
          },
          output: {
            manualChunks: {
              'react-vendor': ['react', 'react-dom'],
              'tauri-api': [
                '@tauri-apps/api',
                '@tauri-apps/plugin-dialog',
                '@tauri-apps/plugin-global-shortcut',
                '@tauri-apps/plugin-shell',
                '@tauri-apps/plugin-store',
              ],
            },
          },
        },
        chunkSizeWarningLimit: 600,
        minify: 'terser',
        terserOptions: {
          compress: {
            drop_console: true,
            drop_debugger: true,
          },
        },
      },
      define: {
        'process.env.API_KEY': JSON.stringify(defaultApiKey),
        'process.env.SILICONFLOW_API_KEY': JSON.stringify(siliconFlowApiKey),
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
