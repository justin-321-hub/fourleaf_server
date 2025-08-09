// 說明：Express 後端，提供靜態前端 + 兩個 API：/api/whisper、/api/n8n
// - /api/whisper：接收前端上傳的音訊檔案，轉送 OpenAI Whisper 做語音轉文字
// - /api/n8n：將文字轉發至 n8n Webhook，回傳其結果
// 需求：Node 18+ (使用原生 fetch)、dotenv、express、multer、form-data

require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');       // 處理 multipart/form-data
const FormData = require('form-data');  // 用於呼叫 OpenAI Whisper API

const app = express();
const upload = multer(); // 使用記憶體儲存；上傳檔案會放在 req.file.buffer

// 解析 JSON（給 /api/n8n 使用）
app.use(express.json({ limit: '1mb' }));

// 提供靜態檔案
app.use(express.static(path.join(__dirname, 'public')));

// --- Whisper 代理：接收前端錄音 Blob，轉送到 OpenAI Whisper ---
app.post('/api/whisper', upload.single('file'), async (req, res) => {
  // 檢查設定
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: '缺少 OPENAI_API_KEY' });
  }
  if (!req.file) {
    return res.status(400).json({ error: '缺少音訊檔 (field: file)' });
  }

  try {
    // 用 form-data 打包送至 OpenAI /v1/audio/transcriptions
    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: 'audio.webm',
      contentType: req.file.mimetype || 'audio/webm'
    });
    form.append('model', 'whisper-1');  // Whisper 模型
    // form.append('language', 'zh');   // 可選：指定語言可提升準確度
    // form.append('response_format', 'json'); // 預設即為 json

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...form.getHeaders()
      },
      body: form
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(r.status).json({ error: errText });
    }

    const data = await r.json(); // 預期 { text: "..." }
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
    // 解析前端送來的 JSON：{ text, voice?, format? }
    const { text, voice = 'alloy', format = 'mp3' } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: '缺少 text 內容' });

    // 呼叫 OpenAI TTS 端點
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        input: text,
        voice,   // 可選：alloy/onyx/nova/sage/shimmer…（可換）
        format   // 可選：mp3/opus/aac/flac/wav/pcm
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
      opus: 'audio/ogg',
      aac: 'audio/aac',
      flac: 'audio/flac',
      wav: 'audio/wav',
      pcm: 'audio/l16'
    };
    res.setHeader('Content-Type', contentTypes[format] || 'audio/mpeg');
    res.setHeader('Content-Disposition', `inline; filename="speech.${format}"`);
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
