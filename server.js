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
BRIEFING TÉCNICO — Matriz do Clone Viral
Contexto: Já temos o frontend MatrizCloneViral.tsx funcionando. Agora precisamos construir o backend completo seguindo a mesma arquitetura do sistema de concatenação de vídeos que já existe no projeto.

O que o sistema precisa fazer, passo a passo:
1. Upload do vídeo (Frontend → Supabase Storage)
Quando o usuário clica em "Gerar JSONs", o frontend faz upload do vídeo para o Supabase Storage no caminho clone-viral-temp/{user_id}/{timestamp}.mp4 e chama a Edge Function analyze-clone-viral passando o path do vídeo + o contexto do usuário (nicho, produto, público, tom, termos, adaptações visuais).

2. Edge Function analyze-clone-viral (orquestradora)
Essa é a função principal. Ela segue exatamente o mesmo padrão das Edge Functions que já existem no projeto. O fluxo interno é:
Passo 2.1 — Validação

Verifica autenticação do usuário (Supabase Auth)
Verifica se o usuário tem uso disponível na tabela user_usage para a feature matriz_clone_viral
Se não tiver, retorna 402

Passo 2.2 — Gera signed URL do vídeo

Gera uma signed URL temporária (10 minutos) do arquivo no Storage para passar ao servidor FFmpeg

Passo 2.3 — Pega servidor FFmpeg disponível

Chama supabase.rpc('get_available_ffmpeg_server', { p_server_type: 'clone-viral' })
Se não houver servidor disponível, retorna 503 com mensagem "Análise de vídeo temporariamente indisponível, tente em instantes"

Passo 2.4 — Chama o servidor FFmpeg

POST para {server_url}/extract-scenes com header x-api-key e body { video_url, job_id }
O servidor retorna { frames: [{timestamp_seconds, url}], audio: { url, duration_seconds }, duration_seconds }
Sempre executa release_ffmpeg_server(server_id, success) no finally

Passo 2.5 — Transcrição com Whisper

Chama a Edge Function existente transcribe-media com { mediaUrl: audio.url, mediaType: 'audio', withTimestamps: true }
Se falhar, continua sem transcrição (degradação suave, não quebra o fluxo)
Retorna { text, segments: [{start, end, text}] }

Passo 2.6 — Monta o prompt e chama Gemini Flash

Modelo: google/gemini-2.5-flash
Usa a mesma integração Lovable AI que já existe no projeto
O array content do message tem:

Até 8 frames como { type: 'image_url', image_url: { url } }
Um bloco de texto com o prompt completo (contexto do usuário + transcrição com timestamps)


Usa tool_call com o schema extrair_cenas (detalhado abaixo)
Se o tool_call retornar inválido, faz 1 retry. Sem fallback para Pro.

Passo 2.7 — Finalização

Incrementa user_usage do usuário
Deleta o vídeo original do Storage
Retorna { cenas: [...] } para o frontend


3. Ajuste na Edge Function transcribe-media (já existente)
Adicionar suporte ao parâmetro opcional withTimestamps: boolean no body. Quando true, usa response_format: verbose_json no Whisper e retorna segments: [{start, end, text}] junto com o text. Comportamento atual preservado quando o parâmetro não for enviado — não quebra nenhum consumidor existente.

4. Servidor FFmpeg — novo endpoint /extract-scenes
Adicionar no repositório dos servidores FFmpeg existentes, seguindo o mesmo padrão dos outros endpoints. Contrato:

Input: { video_url, job_id } + header x-api-key
Pipeline:

Baixa o vídeo da signed URL para /tmp/{job_id}.mp4
Tenta detecção de cena: ffmpeg -i in.mp4 -vf "select='gt(scene,0.3)',scale=720:-1" -vsync vfr -frames:v 8 frame_%03d.png
Fallback se gerar menos de 2 frames: amostragem temporal com máx 6 frames (select='isnan(prev_selected_t)+gte(t-prev_selected_t,duration/6)')
Extrai áudio: ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 -b:a 64k audio.mp3
Sobe frames e áudio para R2 no prefixo clone-viral-temp/{job_id}/ com TTL curto
Retorna URLs assinadas válidas por 10 minutos


Output: { frames: [{timestamp_seconds, url}], audio: { url, duration_seconds }, duration_seconds }
Cleanup: finally apaga /tmp/{job_id}*
Concorrência: MAX_CONCURRENT_JOBS=3, igual aos demais


5. Banco de dados — migration necessária
sql-- Inserir servidor FFmpeg dedicado para clone-viral
-- (inativo até o deploy no Railway estar feito)
INSERT INTO ffmpeg_servers (server_url, api_key, server_type, is_active, max_concurrent_jobs)
VALUES ('https://PLACEHOLDER.railway.app', 'PLACEHOLDER_KEY', 'clone-viral', false, 3);
A função get_available_ffmpeg_server já é genérica e suporta o novo tipo sem alteração.

6. Schema do tool_call extrair_cenas (para o Gemini)
json{
  "name": "extrair_cenas",
  "description": "Extrai e estrutura as cenas do vídeo viral com os JSONs de imagem e animação",
  "parameters": {
    "type": "object",
    "properties": {
      "cenas": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "numero_cena": { "type": "integer" },
            "duracao_segundos": { "type": "number" },
            "descricao": { "type": "string" },
            "gancho": { "type": "string" },
            "fala_original_transcrita": { "type": "string" },
            "json_imagem": {
              "type": "object",
              "properties": {
                "prompt_cena": { "type": "string" }
              },
              "required": ["prompt_cena"]
            },
            "json_animacao": {
              "type": "object",
              "properties": {
                "scene": { "type": "object" },
                "character": { "type": "object" },
                "audio": { "type": "object" },
                "dialogue": { "type": "array" },
                "important_notes": { "type": "array" }
              },
              "required": ["scene", "character", "audio", "dialogue", "important_notes"]
            }
          },
          "required": ["numero_cena", "duracao_segundos", "descricao", "gancho", "fala_original_transcrita", "json_imagem", "json_animacao"]
        }
      }
    },
    "required": ["cenas"]
  }
}

7. Prompt do Gemini (template)
Você é um especialista em análise de vídeos virais brasileiros e criação de conteúdo para redes sociais.

Analise os frames do vídeo e a transcrição abaixo e gere os JSONs de cada cena para clonagem com avatar personalizado.

TRANSCRIÇÃO COM TIMESTAMPS:
{segments.map(s => `[${s.start}s] ${s.text}`).join('\n')}

CONTEXTO DO USUÁRIO:
- Nicho: {nicho}
- Produto/Serviço: {produto}
- Público-alvo: {publico}
- Tom de comunicação: {tom}
- Termos do nicho: {termos}
- Adaptações visuais solicitadas: {adaptacoesVisuais}

INSTRUÇÕES:
1. Identifique cada cena/momento distinto (mínimo 2, máximo 8)
2. Para cada cena gere:

JSON DE IMAGEM (prompt_cena):
- Descrição completa em português, estilo realista viral, como vídeo gravado no celular
- Inclua: enquadramento, ambiente, posição do personagem, expressão facial, roupa, iluminação
- NÃO descreva rosto, cabelo, cor de pele ou traços físicos (a foto de referência cuida disso)
- Aplique adaptações visuais solicitadas (troca de roupa, elementos na cena, cenário)
- Estilo espontâneo do dia a dia, não cinematográfico

JSON DE ANIMAÇÃO:
- scene: type, camera, environment, style, duration_seconds
- character: role, position, style, clothing, accessories (sem traços físicos)
- audio: language "Portuguese (Brazil)", tone, accent "Brazilian", voice_focus "single speaker only", background_noise "none", environment_sound "very low or muted", clarity "high", microphone_style "close voice capture", pause_between_lines "0.5 seconds", no_secondary_voices true
- dialogue: array com line, emotion, timing — ADAPTADOS para o nicho {nicho} mantendo o mesmo gancho emocional do vídeo original
- important_notes: array de strings

Use a ferramenta extrair_cenas para retornar os dados estruturados.

8. Atualizar mensagens de status no frontend
No MatrizCloneViral.tsx, trocar o array LOG_STEPS atual por:
typescriptconst LOG_STEPS = [
  "Enviando vídeo...",
  "Extraindo cenas e áudio...",
  "Transcrevendo fala...",
  "Gerando JSONs com IA...",
  "Pronto!",
];

O que NÃO mexer:

Pipeline de concatenação de vídeos e seus servidores
Edge Functions existentes além das mencionadas
Schema de saída cenas[] — o frontend não muda
Lógica de user_usage — já existe e funciona

app.listen(PORT, () => {
  console.log(`🎬 Clone Viral FFmpeg Server rodando na porta ${PORT}`);
  console.log(`   Max concurrent jobs: ${MAX_CONCURRENT_JOBS}`);
});
