// ============================================================================
// Clone Viral Server — FFmpeg dedicado pra Matriz do Clone Viral
// Endpoints:
//   GET  /health           → healthcheck (usado pelo monitoring do app)
//   POST /extract-scenes   → extrai frames-chave + áudio mp3 e devolve URLs R2
//
// Variáveis de ambiente esperadas no Railway:
//   PORT                   (Railway injeta automaticamente)
//   R2_ACCOUNT_ID          (Cloudflare R2)
//   R2_ACCESS_KEY_ID
//   R2_SECRET_ACCESS_KEY
//   R2_BUCKET              (mesmo bucket usado pelo restante do app — prefixo "clone-viral-temp/" isola)
// ============================================================================

const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const fetch = require("node-fetch");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.warn("[boot] R2_* não configurados — /extract-scenes vai falhar até as envs serem setadas");
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || "",
    secretAccessKey: R2_SECRET_ACCESS_KEY || "",
  },
});

// ----------------------------------------------------------------------------
// Concorrência limitada (mesma regra dos outros servers FFmpeg do projeto)
// ----------------------------------------------------------------------------
const MAX_CONCURRENT_JOBS = 3;
let activeJobs = 0;

// ----------------------------------------------------------------------------
// Utils
// ----------------------------------------------------------------------------
function runCmd(cmd, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${cmd} timeout após ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} saiu com código ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function downloadVideo(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Falha ao baixar vídeo: HTTP ${res.status}`);
  const fileStream = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

async function probeDuration(filePath) {
  // ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 <file>
  const { stdout } = await runCmd(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      filePath,
    ],
    { timeoutMs: 30_000 }
  );
  const d = parseFloat(stdout.trim());
  return Number.isFinite(d) ? d : 0;
}

async function extractScenesFFmpeg(videoPath, outDir) {
  // Tenta detecção de cenas. Limita a 8 frames, scale 720 width keep aspect.
  // -vf "select='gt(scene,0.3)',scale=720:-2"  -vsync vfr
  await runCmd(
    "ffmpeg",
    [
      "-y",
      "-i", videoPath,
      "-vf", "select='gt(scene,0.3)',scale=720:-2",
      "-vsync", "vfr",
      "-frames:v", "8",
      "-q:v", "3",
      path.join(outDir, "scene_%03d.jpg"),
    ],
    { timeoutMs: 180_000 }
  );

  const files = (await fsp.readdir(outDir))
    .filter((f) => f.startsWith("scene_") && f.endsWith(".jpg"))
    .sort();
  return files.map((f) => path.join(outDir, f));
}

async function extractFramesFallback(videoPath, outDir, durationSec) {
  // Fallback: amostra 6 frames distribuídos uniformemente.
  const n = 6;
  const dur = Math.max(durationSec, 1);
  const step = dur / (n + 1);
  const timestamps = Array.from({ length: n }, (_, i) => +(step * (i + 1)).toFixed(2));

  const out = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const dest = path.join(outDir, `fallback_${String(i + 1).padStart(3, "0")}.jpg`);
    await runCmd(
      "ffmpeg",
      [
        "-y",
        "-ss", String(ts),
        "-i", videoPath,
        "-frames:v", "1",
        "-vf", "scale=720:-2",
        "-q:v", "3",
        dest,
      ],
      { timeoutMs: 30_000 }
    );
    out.push(dest);
  }
  return { files: out, timestamps };
}

async function extractAudio(videoPath, outDir) {
  const dest = path.join(outDir, "audio.mp3");
  await runCmd(
    "ffmpeg",
    [
      "-y",
      "-i", videoPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "64k",
      dest,
    ],
    { timeoutMs: 120_000 }
  );
  return dest;
}

async function uploadToR2(localPath, key, contentType) {
  const body = await fsp.readFile(localPath);
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  // Signed URL válida por 10min — tempo suficiente pro Gemini consumir
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    { expiresIn: 600 }
  );
  return url;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "clone-viral-server",
    activeJobs,
    maxConcurrent: MAX_CONCURRENT_JOBS,
    timestamp: new Date().toISOString(),
  });
});

app.post("/extract-scenes", async (req, res) => {
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return res.status(503).json({ error: "Servidor ocupado, tente novamente em instantes" });
  }

  const { video_url, job_id } = req.body || {};
  if (!video_url || typeof video_url !== "string") {
    return res.status(400).json({ error: "video_url é obrigatório" });
  }

  activeJobs++;
  const jobId = (job_id && String(job_id)) || crypto.randomUUID();
  const work = path.join(os.tmpdir(), `clone-viral-${jobId}-${Date.now()}`);
  await fsp.mkdir(work, { recursive: true });

  console.log(`[${jobId}] start (active=${activeJobs}/${MAX_CONCURRENT_JOBS})`);

  try {
    // 1. Download
    const videoPath = path.join(work, "input.mp4");
    await downloadVideo(video_url, videoPath);
    const stats = await fsp.stat(videoPath);
    console.log(`[${jobId}] downloaded ${(stats.size / 1024 / 1024).toFixed(2)}MB`);

    // 2. Duração
    const duration = await probeDuration(videoPath);
    console.log(`[${jobId}] duration ${duration.toFixed(2)}s`);

    // 3. Extrai cenas
    const sceneDir = path.join(work, "scenes");
    await fsp.mkdir(sceneDir, { recursive: true });

    let frameFiles = [];
    let frameTimestamps = []; // só preenche no fallback; no scene-detect é estimado

    try {
      frameFiles = await extractScenesFFmpeg(videoPath, sceneDir);
    } catch (e) {
      console.warn(`[${jobId}] scene-detect falhou: ${e.message}`);
    }

    if (frameFiles.length < 2) {
      console.log(`[${jobId}] usando fallback (apenas ${frameFiles.length} cenas detectadas)`);
      const fb = await extractFramesFallback(videoPath, sceneDir, duration);
      frameFiles = fb.files;
      frameTimestamps = fb.timestamps;
    } else {
      // Estima timestamps distribuindo uniformemente — suficiente pro contexto do Gemini
      const step = duration / (frameFiles.length + 1);
      frameTimestamps = frameFiles.map((_, i) => +(step * (i + 1)).toFixed(2));
    }

    // 4. Áudio
    const audioPath = await extractAudio(videoPath, work);

    // 5. Upload R2 (frames + áudio) — prefixo dedicado isola do resto do bucket
    const baseKey = `clone-viral-temp/${jobId}`;
    const frames = [];
    for (let i = 0; i < frameFiles.length; i++) {
      const key = `${baseKey}/frame_${String(i + 1).padStart(3, "0")}.jpg`;
      const url = await uploadToR2(frameFiles[i], key, "image/jpeg");
      frames.push({ timestamp_seconds: frameTimestamps[i] ?? 0, url });
    }
    const audioKey = `${baseKey}/audio.mp3`;
    const audioUrl = await uploadToR2(audioPath, audioKey, "audio/mpeg");

    console.log(`[${jobId}] done ${frames.length} frames + audio`);

    res.json({
      frames,
      audio: { url: audioUrl, duration_seconds: duration },
      duration_seconds: duration,
    });
  } catch (err) {
    console.error(`[${jobId}] erro:`, err);
    res.status(500).json({ error: err.message || "Erro interno" });
  } finally {
    activeJobs--;
    // Cleanup local
    fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`[boot] clone-viral-server escutando na porta ${PORT}`);
});
