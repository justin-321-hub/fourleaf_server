// 說明：Express 後端，提供靜態前端 + API：/api/whisper /api/n8n /api/tts
// 需求：Node 18+ (原生 fetch)、dotenv、express、multer、form-data、cors

require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');        // 處理 multipart/form-data
const FormData = require('form-data');   // 呼叫 OpenAI Whisper API
const cors = require('cors');

const app = express();

// ✅ CORS：允許你的 GitHub Pages 來源呼叫（只需網域，不要帶路徑）
app.use(cors({
  origin: ['https://justin-321-hub.github.io'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));
// 預檢請求
app.options('*', cors());

// JSON 解析（給 /api/n8n、/api/tts 使用）
app.use(express.json({ limit: '1mb' }));

// （可留可不留）提供靜態檔案
app.use(express.static(path.join(__dirname, 'public')));

// 健康檢查（Render/Ping 用）
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Multer：限制錄音檔大小，避免塞爆記憶體（20MB 可自行調整）
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

// --- Whisper 代理：接收前端錄音 Blob，轉送到 OpenAI Whisper ---
app.post('/api/whisper', upload.single('file'), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: '缺少 OPENAI_API_KEY' });
  }
  if (!req.file) {
    return res.status(400).json({ error: '缺少音訊檔 (field: file)' });
  }

  try {
    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: 'audio.webm',
      contentType: req.file.mimetype || 'audio/webm'
    });
    form.append('model', 'whisper-1');
    // form.append('language', 'zh'); // 可選

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
      body: form
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(r.status).json({ error: errText });
    }
    const data = await r.json(); // { text: "..." }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Whisper API error' });
  }
});

// --- n8n 代理：將文字傳給 n8n webhook ---
app.post('/api/n8n', async (req, res) => {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return res.status(500).json({ error: '缺少 N8N_WEBHOOK_URL' });

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    });

    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
      const errText = await r.text();
      return res.status(r.status).json({ error: errText || 'n8n error' });
    }
    if (ct.includes('application/json')) {
      const data = await r.json();
      return res.status(200).json(data);
    } else {
      const text = await r.text();
      return res.status(200).json({ text });
    }
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Proxy error' });
  }
});

// --- OpenAI TTS 代理：將文字轉成語音音檔 ---
app.post('/api/tts', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: '缺少 OPENAI_API_KEY' });
  }

  try {
    const { text, voice = 'alloy', format = 'mp3' } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: '缺少 text 內容' });

    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        input: text,
        voice,   // alloy/onyx/nova/sage/shimmer…
        format   // mp3/opus/aac/flac/wav/pcm
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(r.status).json({ error: errText || 'TTS error' });
    }

    const ab = await r.arrayBuffer();
    const buf = Buffer.from(ab);

    const contentTypes = {
      mp3: 'audio/mpeg',
      opus: 'audio/ogg; codecs=opus', // 更精確
      aac: 'audio/aac',
      flac: 'audio/flac',
      wav: 'audio/wav',
      pcm: 'audio/l16'
    };
    res.setHeader('Content-Type', contentTypes[format] || 'audio/mpeg');
    res.setHeader('Content-Disposition', `inline; filename="speech.${format}"`);
    // 可選：避免快取
    // res.setHeader('Cache-Control', 'no-store');
    return res.status(200).end(buf);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'TTS proxy error' });
  }
});

// 啟動服務
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});
