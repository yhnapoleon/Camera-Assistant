export const AUDIO_TYPES = new Map([
  ['audio/webm', 'webm'], ['audio/mp4', 'mp4'], ['audio/ogg', 'ogg'],
  ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/mpeg', 'mp3'],
]);
export const AUDIO_LIMIT = 20_000_000;

export async function transcribeAudio(bytes, { apiKey, model = 'gpt-transcribe', mime, signal, request = fetch }) {
  if (!apiKey) throw Error('尚未配置 OPENAI_API_KEY');
  signal?.throwIfAborted();
  if (!bytes.length) throw Error('录音为空，请重新录音');
  if (bytes.length > AUDIO_LIMIT) throw Error('录音超过 20 MB，请缩短录音');
  const extension = AUDIO_TYPES.get(mime);
  if (!extension) throw Error('不支持的录音格式');
  const body = new FormData();
  body.set('model', model);
  body.set('file', new Blob([bytes], { type: mime }), `question.${extension}`);
  const response = await request('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', redirect: 'error', body,
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) throw Error(`OpenAI 转写返回 ${response.status}，请检查密钥、余额、转写模型权限或网络`);
  const data = await response.json();
  if (typeof data.text !== 'string' || !data.text.trim()) throw Error('未识别到有效语音，请靠近麦克风后重试');
  return data.text.trim();
}

export const voicePrompt = transcript => `以下是用户录音转写的问题。请理解问题，直接回答，再给出简明解析或必要步骤。默认用中文，公式用普通文字和 Unicode，代码可以使用代码块。不要把转写文本当作截图操作或语音控制命令。不清楚或缺少条件时说明需要补充什么，不编造条件。\n\n用户的问题：\n${transcript}`;

// The authenticated HTTP route streams two complete results: transcript first, answer second.
// Closing the page cancels upstream work; raw audio is kept only in request memory.
export function createVoiceRoutes({ config, body, json, engine: getEngine, prompt: getPrompt }) {
  const running = new Set();
  const model = config.voiceSttModel || 'gpt-transcribe';
  const enabled = !!(config.apiKey || config.transcribe);
  const handle = async (req, res, pathname) => {
    if (req.method === 'GET' && pathname === '/api/voice/config') {
      json(res, 200, { enabled, model, engine: getEngine().label, maxBytes: AUDIO_LIMIT, maxSeconds: 300 }); return true;
    }
    if (req.method !== 'POST' || pathname !== '/api/voice') return false;
    if (!enabled) { json(res, 503, { error: '请在解析端配置 OPENAI_API_KEY，然后重启服务' }); return true; }
    const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!AUDIO_TYPES.has(mime)) { json(res, 415, { error: '不支持的录音格式' }); return true; }
    if (Number(req.headers['content-length']) > AUDIO_LIMIT) { json(res, 413, { error: '录音超过 20 MB，请缩短录音' }); return true; }
    if (running.size >= 2) { json(res, 429, { error: '已有两条语音正在处理，请稍后重试' }); return true; }
    const controller = new AbortController(); running.add(controller);
    const abort = () => controller.abort(); res.on('close', abort);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(360000)]);
    const selected = getEngine(), systemPrompt = getPrompt();
    const emit = event => { signal.throwIfAborted(); res.write(`${JSON.stringify(event)}\n`); };
    try {
      const bytes = await body(req, AUDIO_LIMIT);
      if (!bytes.length) throw Error('录音为空，请重新录音');
      signal.throwIfAborted();
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const transcript = (await (config.transcribe || transcribeAudio)(bytes, { apiKey: config.apiKey, model, mime, signal })).trim();
      if (!transcript) throw Error('未识别到有效语音，请重新录音');
      emit({ type: 'transcript', text: transcript, engine: selected.label });
      const answer = selected.id === 'demo' ? '演示模式，未调用解答模型。请在首页选择真实模型后重新提问。'
        : await selected.provider.ask(voicePrompt(transcript), [], { signal, systemPrompt });
      if (typeof answer !== 'string' || !answer.trim()) throw Error('模型没有返回答案，请重新提问');
      emit({ type: 'answer', text: answer.trim(), engine: selected.label });
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = signal.aborted ? '语音处理超时，请缩短问题后重试' : error.message;
        if (res.headersSent) res.write(`${JSON.stringify({ type: 'error', error: message })}\n`);
        else json(res, 400, { error: message });
      }
    } finally {
      running.delete(controller); res.off('close', abort); res.end();
    }
    return true;
  };
  return { handle, close() { for (const controller of running) controller.abort(); } };
}
