#!/usr/bin/env node

/**
 * SiliconFlow API 连接测试脚本
 *
 * 用途：验证 API Key 配置和 API 连通性
 * 使用：npm run test:api
 */

import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const API_BASE = 'https://api.siliconflow.cn/v1';
const ASR_MODEL = 'FunAudioLLM/SenseVoiceSmall';
const LLM_MODEL = 'Qwen/Qwen3-32B'; // 跟 siliconflow.ts defaultLlmModel 对齐

async function testAPI() {
  console.log('🔍 SiliconFlow API 连接测试\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 1. 检查 API Key
  const apiKey = process.env.SILICONFLOW_API_KEY;

  if (!apiKey) {
    console.error('❌ 错误: 未找到 SILICONFLOW_API_KEY');
    console.log('\n请按以下步骤配置：');
    console.log('1. 访问 https://cloud.siliconflow.cn/account/ak 获取 API Key');
    console.log('2. 复制 .env.example 为 .env');
    console.log('3. 在 .env 中设置 SILICONFLOW_API_KEY');
    console.log('4. 重新运行此脚本\n');
    process.exit(1);
  }

  if (apiKey === 'your_siliconflow_api_key_here' || apiKey === 'test_key_placeholder') {
    console.error('❌ 错误: API Key 未配置（仍是占位符）');
    console.log('\n请到 https://cloud.siliconflow.cn/account/ak 获取真实的 API Key\n');
    process.exit(1);
  }

  console.log('✅ API Key 已配置');
  console.log(`   长度: ${apiKey.length} 字符`);
  console.log(`   前缀: ${apiKey.substring(0, 10)}...`);
  console.log(`   ASR 模型: ${ASR_MODEL}`);
  console.log(`   LLM 模型: ${LLM_MODEL}\n`);

  // 2. 测试 LLM API
  console.log('🔌 测试 LLM API（翻译）...\n');

  try {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: 'You are a translator. Translate to Chinese.' },
          { role: 'user', content: 'Hello, how are you?' },
        ],
        temperature: 0.3,
        max_tokens: 100,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    const translation = result.choices?.[0]?.message?.content || '';

    console.log('   请求: "Hello, how are you?"');
    console.log('   译文:', translation);
    console.log('\n✅ LLM API 测试成功！\n');
  } catch (error) {
    console.error('\n❌ LLM API 测试失败');
    console.error('错误信息:', error.message);

    if (error.message.includes('401') || error.message.includes('Unauthorized')) {
      console.log('\n可能原因: API Key 无效');
      console.log('解决方法: 访问 https://cloud.siliconflow.cn/account/ak 检查 Key');
    } else if (error.message.includes('429')) {
      console.log('\n可能原因: 请求频率过高');
      console.log('解决方法: 稍后重试');
    } else if (error.message.includes('insufficient') || error.message.includes('balance')) {
      console.log('\n可能原因: 余额不足');
      console.log('解决方法: 充值或使用其他模型');
    }

    process.exit(1);
  }

  // 3. 测试 ASR API（验证模型可用性）
  console.log('🔌 测试 ASR API（语音识别端点）...\n');

  try {
    // 创建一个最小的 WAV 文件用于测试连通性
    const sampleRate = 16000;
    const duration = 0.5; // 0.5 秒
    const numSamples = sampleRate * duration;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    // 写入静音样本
    for (let i = 0; i < numSamples; i++) {
      view.setInt16(44 + i * 2, 0, true);
    }

    const blob = new Blob([buffer], { type: 'audio/wav' });
    const formData = new FormData();
    formData.append('file', blob, 'test.wav');
    formData.append('model', ASR_MODEL);

    const response = await fetch(`${API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    console.log('   响应:', JSON.stringify(result));
    console.log('\n✅ ASR API 测试成功！\n');
  } catch (error) {
    console.error('\n⚠️  ASR API 测试失败（不影响应用启动）');
    console.error('错误信息:', error.message);
    console.log('\n注意: ASR 需要真实音频，0.5 秒静音可能被拒绝是正常的\n');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('🎉 配置验证通过！');
  console.log('\n你可以运行以下命令启动应用：');
  console.log('   npm run dev\n');
}

testAPI().catch(error => {
  console.error('未预期的错误:', error);
  process.exit(1);
});
