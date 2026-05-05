# Clone Viral FFmpeg Server

Servidor **dedicado e isolado** que processa vídeos para o **MATRIZ do Clone Viral**:
extrai frames-chave (detecção de cena) + áudio MP3 e faz upload para Cloudflare R2.

> ⚠️ **Não misturar** com os servidores de `concatenate` / `normalize`. Este server tem
> seu próprio repo, seu próprio deploy Railway, e seu próprio `server_type='clone-viral'`
> no banco. Se travar, **não afeta produção** de concatenação.

## Stack

- Node 20 + Express
- FFmpeg + ffprobe (instalados no Dockerfile)
- AWS SDK v3 (compatível com Cloudflare R2)

## Endpoints

### `GET /health`
Sem auth. Retorna status, jobs ativos e versão.

### `POST /extract-scenes`
Auth: `Authorization: Bearer <FFMPEG_API_KEY>`

**Body:**
```json
{
  "video_url": "https://...signed-url...",
  "job_id": "uuid-do-projeto"
}
```

**Resposta:**
```json
{
  "frames": [
    { "timestamp_seconds": 0.0, "url": "https://...signed..." },
    { "timestamp_seconds": 3.75, "url": "https://...signed..." }
  ],
  "audio": { "url": "https://...signed...", "duration_seconds": 30.5 },
  "duration_seconds": 30.5
}
```

## Variáveis de ambiente

Veja `.env.example`. Obrigatórias:

| Var | Descrição |
|-----|-----------|
| `FFMPEG_API_KEY` | Chave Bearer (gere com `openssl rand -hex 32`) |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret |
| `R2_BUCKET` | Nome do bucket (mesmo dos demais servers) |
| `MAX_CONCURRENT_JOBS` | Default `3` |
| `PORT` | Default `3000` (Railway injeta) |

## Deploy no Railway

1. Crie um **novo repositório no GitHub** com este conteúdo.
2. No Railway, **New Project → Deploy from GitHub** → selecione esse repo.
3. Configure as variáveis acima em **Variables**.
4. Railway detecta o `Dockerfile` e builda automaticamente.
5. Em **Settings → Networking → Generate Domain** para ter URL pública.
6. Health check: `GET https://<seu-domain>/health` → deve retornar `status: ok`.

### Resource recomendado
- 2 vCPU / 2GB RAM por instância (vídeos do Clone Viral são curtos, ~30s)
- Pode escalar horizontalmente: cada instância vira um novo registro `clone-viral` no banco.

## R2 Lifecycle

Configure regra no bucket R2 para deletar arquivos sob o prefixo `clone-viral-temp/`
após **1 hora**. O Lovable processa em segundos, 1h é margem segura.

## Após o deploy

Mande no chat do Lovable:
1. **URL pública** (ex: `https://clone-viral-server-01.up.railway.app`)
2. A **API key** (`FFMPEG_API_KEY`) que você definiu

O Lovable atualiza o registro `Clone Viral Server 01` no banco e ativa
(`is_active=true`).

## Versão
1.0.0
