import { readFileSync } from 'node:fs';
import sharp from 'sharp';

export async function openaiResponse({ apiKey, model = 'gpt-6-luna', effort = 'low', instructions, prompt, images = [], signal, request = fetch }) {
  if (!apiKey) throw Error('尚未配置 OPENAI_API_KEY');
  signal?.throwIfAborted();
  const pictures = await Promise.all(images.map(async file => {
    const bytes = await sharp(readFileSync(file)).jpeg({ quality: 90 }).toBuffer();
    return { type: 'input_image', image_url: `data:image/jpeg;base64,${bytes.toString('base64')}`, detail: 'high' };
  }));
  const signals = [AbortSignal.timeout(120000)]; if (signal) signals.push(signal);
  const response = await request('https://api.openai.com/v1/responses', {
    method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.any(signals),
    body: JSON.stringify({ model, instructions, reasoning: { effort }, store: false, max_output_tokens: 12000,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, ...pictures] }] }),
  });
  if (!response.ok) throw Error(`OpenAI API 返回 ${response.status}，请检查密钥、余额、模型权限或网络`);
  const data = await response.json();
  if (data.status !== 'completed') throw Error(`OpenAI 未完整完成回答（${data.status || 'unknown'}），请缩小问题范围后重试`);
  const text = (data.output || []).filter(x => x.type === 'message' && x.role === 'assistant')
    .flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text || '').join('\n').trim();
  if (!text) throw Error('OpenAI 未返回答案文字');
  return text;
}
