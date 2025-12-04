// server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import fsSync from 'fs';
import dotenv from 'dotenv';
import cors from 'cors';
import multer from 'multer';
import axios from 'axios';
import { ElevenLabsClient, ElevenLabs } from 'elevenlabs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Pastas necessárias
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUDIOS_DIR = path.join(PUBLIC_DIR, 'audios');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Garante que as pastas existam
for (const d of [PUBLIC_DIR, AUDIOS_DIR, UPLOADS_DIR]) {
  if (!fsSync.existsSync(d)) fsSync.mkdirSync(d, { recursive: true });
}

// Serve arquivos estáticos (sua página frontend deve ficar em public/)
app.use(express.static(PUBLIC_DIR));

// Multer para upload de arquivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g,'_'))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });
const apiKey = process.env.ELEVEN_API_KEY; // Substitua pela sua chave da API da Eleven Labs
// Inicializa cliente ElevenLabs se chave fornecida
const ELEVEN_KEY = apiKey || process.env.XI_API_KEY;
let elevenClient = null;
if (ELEVEN_KEY) elevenClient = new ElevenLabsClient({ apiKey: apiKey });

// Util: salvar Buffer em arquivo e retornar caminho público relativo
async function saveBufferToPublic(buffer, filename = 'output.mp3') {
  const outPath = path.join(AUDIOS_DIR, filename);
  await fs.writeFile(outPath, buffer);
  return path.posix.join('audios', filename);
}

// Rota texto -> áudio (JSON)
app.post('/api/generateAudio', async (req, res) => {
  try {
    const { text, voice, stability = 0.5, similarity = 0.5, style = null } = req.body;
    if (!text) return res.status(400).json({ error: 'Texto é obrigatório' });

    // config eleven labs///////
     
    // const url = 'https://api.elevenlabs.io/v1/text-to-speech';
    const client = new ElevenLabsClient({ apiKey: process.env.ELEVEN_API_KEY });
    const voices = await client.voices.getAll();
      console.log(voices);
    // final config eleven labs
    if (!client) return res.status(500).json({ error: 'ElevenLabs API key não configurada' });

    // Ajusta parâmetros para o cliente (valores entre 0 e 1)
    const stabilityNum = Number(stability);
    const similarityNum = Number(similarity);

    const generateOpts = {
      voice: voice || undefined,
      text,
      model_id: 'eleven_multilingual_v2',
      optimize_streaming_latency: ElevenLabs.OptimizeStreamingLatency.Zero,
      output_format: ElevenLabs.OutputFormat.Mp344100128,
      voice_settings: {
        stability: isFinite(stabilityNum) ? stabilityNum : 0.5,
        similarity_boost: isFinite(similarityNum) ? similarityNum : 0.5,
        style: style || undefined
      }
    };

    // Gera áudio (retorna um stream-like)
    const gen = await client.generate(generateOpts);

    // Converte para Buffer e salva
    const chunks = [];
    for await (const ch of gen) chunks.push(ch instanceof Buffer ? ch : Buffer.from(ch));
    const buffer = Buffer.concat(chunks);

    const filename = `tts-${Date.now()}.mp3`;
    const publicPath = await saveBufferToPublic(buffer, filename);

    return res.json({ ok: true, audioUrl: publicPath });
  } catch (err) {
    console.error('generateAudio error', err?.message || err);
    return res.status(500).json({ error: 'Erro ao gerar áudio', details: err?.message });
  }
});

// Rota speech-to-speech: recebe upload de arquivo e faz call para ElevenLabs S2S streaming
app.post('/api/speech-to-speech', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Arquivo de áudio é obrigatório (field: audio)' });
    const { voice } = req.body;
    if (!voice) return res.status(400).json({ error: 'voice é obrigatório' });
    if (!ELEVEN_KEY) return res.status(500).json({ error: 'ElevenLabs API key não configurada' });

    const inputPath = req.file.path;
    // Faz upload do arquivo para a API de S2S via Axios + form-data
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('audio', fsSync.createReadStream(inputPath));

    const headers = { ...form.getHeaders(), 'xi-api-key': ELEVEN_KEY, Accept: 'application/json', model_id: 'eleven_multilingual_v2' };
    const stsUrl = `https://api.elevenlabs.io/v1/speech-to-speech/${voice}/stream`;

    const response = await axios.post(stsUrl, form, { headers, responseType: 'arraybuffer', maxContentLength: Infinity, maxBodyLength: Infinity });

    const outBuffer = Buffer.from(response.data);
    const filename = `s2s-${Date.now()}.mp3`;
    const publicPath = await saveBufferToPublic(outBuffer, filename);

    // Remove arquivo temporário de upload
    try { await fs.unlink(inputPath); } catch (e) {}

    return res.json({ ok: true, audioUrl: publicPath });
  } catch (err) {
    console.error('speech-to-speech error', err?.message || err);
    return res.status(500).json({ error: 'Erro no speech-to-speech', details: err?.message });
  }
});

// Rota simples de upload (frontend "arrasta e solta")
app.post('/api/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo recebido' });
  return res.json({ ok: true, file: req.file.filename, path: req.file.path });
});

// Criar pasta de projeto dentro de public
app.post('/api/createProject', async (req, res) => {
  try {
    const { projectName } = req.body;
    if (!projectName) return res.status(400).json({ error: 'projectName é obrigatório' });
    const projectFolderPath = path.join(PUBLIC_DIR, projectName.replace(/[^a-z0-9-_]/gi, '_'));
    if (fsSync.existsSync(projectFolderPath)) return res.json({ message: 'Projeto já existe.' });
    await fs.mkdir(projectFolderPath, { recursive: true });
    return res.json({ message: `Pasta do projeto '${projectName}' criada com sucesso!` });
  } catch (err) {
    console.error('createProject error', err?.message || err);
    return res.status(500).json({ error: 'Erro ao criar pasta' });
  }
});

app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fsSync.existsSync(indexPath)) return res.sendFile(indexPath);
  return res.status(404).send('Not Found');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));



