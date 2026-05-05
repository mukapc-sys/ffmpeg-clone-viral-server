// =====================================================
// Clone Viral FFmpeg Server
// Endpoint dedicado para extração de cenas + áudio
// usado pelo MATRIZ do Clone Viral.
//
// ISOLADO dos servidores de concatenação/normalização.
// =====================================================

const express = require("express");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs/promises");
const path = require("path");
const fetch = require("node-fetch");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const execAsync = promisify(exec);

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FFMPEG_API_KEY;
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || "3", 10);

if (!API_KEY) {
  console.error("❌ FFMPEG_API_KEY não definida");
  process.exit(1);
}

// -------- R2 client --------
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function uploadToR2(localPath, key, contentType) {
  const data = await fs.readFile(localPath);
  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: data,
      ContentType: contentType,
    })
  );
  // Signed URL de 10min — suficiente pro Lovable AI Gateway processar
  const url = await getSignedUrl(
    r2,
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }),
    { expiresIn: 600 }
  );
  return url;
}

// -------- Concorrência --------
let activeJobs = 0;
const queue = [];

function withConcurrencyLimit(jobId, fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeJobs++;
      console.log(`▶️ [${jobId}] iniciado (active=${activeJobs}/${MAX_CONCURRENT_JOBS})`);
      try {
        const result = await fn();
        resolve(result);
      } catch (e) {
        reject(e);
      } finally {
        activeJobs--;
        console.log(`⏹️ [${jobId}] finalizado (active=${activeJobs}/${MAX_CONCURRENT_JOBS})`);
        const next = queue.shift();
        if (next) next();
      }
    };
    if (activeJobs < MAX_CONCURRENT_JOBS) run();
    else queue.push(run);
  });
}

// -------- Auth --------
function authenticateApiKey(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// -------- Health --------
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server_type: "clone-viral",
    active_jobs: activeJobs,
    max_concurrent: MAX_CONCURRENT_JOBS,
    queue_length: queue.length,
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

// =====================================================
// POST /extract-scenes — extrai frames-chave + áudio
// =====================================================
app.post("/extract-scenes", authenticateApiKey, async (req, res) => {
  const { video_url, job_id } = req.body || {};
  if (!video_url || !job_id) {
    return res.status(400).json({ error: "video_url e job_id são obrigatórios" });
  }

  try {
    const result = await withConcurrencyLimit(job_id, async () => {
      const workDir = `/tmp/clone-viral-${job_id}`;
      await fs.mkdir(workDir, { recursive: true });
      const inPath = path.join(workDir, "in.mp4");
      const audioPath = path.join(workDir, "audio.mp3");

      try {
        // 1. Baixar vídeo
        console.log(`📥 [${job_id}] Baixando vídeo...`);
        const resp = await fetch(video_url);
        if (!resp.ok) throw new Error(`Download falhou: ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        await fs.writeFile(inPath, buf);

        // 2. Probe duração
        const { stdout: durOut } = await execAsync(
          `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${inPath}"`
        );
        const duration = parseFloat(durOut.trim()) || 0;
        console.log(`⏱️ [${job_id}] Duração: ${duration.toFixed(2)}s`);

        // 3. Detectar cenas (até 8 frames-chave, 720p)
        console.log(`🎬 [${job_id}] Detectando cenas...`);
        await execAsync(
          `ffmpeg -y -i "${inPath}" -vf "select='gt(scene,0.3)',scale=720:-1" -vsync vfr -frames:v 8 "${workDir}/scene_%03d.jpg"`
        ).catch((e) => console.warn(`Scene detect warning:`, e.message));

        let frameFiles = (await fs.readdir(workDir))
          .filter((f) => f.startsWith("scene_") && f.endsWith(".jpg"))
          .sort();

        // 4. Fallback temporal se < 2 frames
        if (frameFiles.length < 2 && duration > 0) {
          console.log(`↩️ [${job_id}] Fallback temporal`);
          for (const f of frameFiles) await fs.unlink(path.join(workDir, f));
          const interval = Math.max(1, duration / 6);
          await execAsync(
            `ffmpeg -y -i "${inPath}" -vf "fps=1/${interval.toFixed(2)},scale=720:-1" -frames:v 6 "${workDir}/scene_%03d.jpg"`
          );
          frameFiles = (await fs.readdir(workDir))
            .filter((f) => f.startsWith("scene_") && f.endsWith(".jpg"))
            .sort();
        }

        if (!frameFiles.length) throw new Error("Não foi possível extrair frames");

        // 5. Extrair áudio (mono 16kHz, MP3 ~64kbps — ideal Whisper)
        console.log(`🔊 [${job_id}] Extraindo áudio...`);
        await execAsync(
          `ffmpeg -y -i "${inPath}" -vn -ac 1 -ar 16000 -b:a 64k "${audioPath}"`
        );

        // 6. Upload frames + timestamps proporcionais
        const frames = [];
        for (let i = 0; i < frameFiles.length; i++) {
          const ts = duration > 0 ? (duration / frameFiles.length) * i : i;
          const key = `clone-viral-temp/${job_id}/${frameFiles[i]}`;
          const url = await uploadToR2(
            path.join(workDir, frameFiles[i]),
            key,
            "image/jpeg"
          );
          frames.push({ timestamp_seconds: Number(ts.toFixed(2)), url });
        }

        const audioKey = `clone-viral-temp/${job_id}/audio.mp3`;
        const audioUrl = await uploadToR2(audioPath, audioKey, "audio/mpeg");

        console.log(
          `✅ [${job_id}] ${frames.length} frames + áudio (${duration.toFixed(2)}s)`
        );

        return {
          frames,
          audio: { url: audioUrl, duration_seconds: duration },
          duration_seconds: duration,
        };
      } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    res.json(result);
  } catch (err) {
    console.error(`❌ [${req.body?.job_id}] /extract-scenes erro:`, err);
    res.status(500).json({ error: err.message || "Erro desconhecido" });
  }
});

app.listen(PORT, () => {
  console.log(`🎬 Clone Viral FFmpeg Server rodando na porta ${PORT}`);
  console.log(`   Max concurrent jobs: ${MAX_CONCURRENT_JOBS}`);
});
