import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BASE = "https://space.ai-builders.com/backend/v1";
const MAX_AUDIO = 20 * 1024 * 1024;
const MAX_BODY = MAX_AUDIO + 128 * 1024;
const CHUNK_SIZE = 512 * 1024;
const UPLOAD_TTL = 5 * 60_000;
const EXTENSIONS = new Set(["aac", "aiff", "flac", "m4a", "mp3", "mp4", "oga", "ogg", "opus", "wav", "webm"]);
const assets = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["public/style.css", "text/css; charset=utf-8"],
};

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function termsFrom(names) {
  return names.split("\n")
    .map(line => line.trim().replace(/^[-*]\s*/, "").split(/[（(:：]/)[0].trim())
    .filter(line => line && !line.startsWith("#")).slice(0, 100).join(",");
}

async function upstream(fetcher, path, options) {
  let response;
  try {
    response = await fetcher(BASE + path, { ...options, signal: AbortSignal.timeout(180_000) });
  } catch {
    throw new AppError(504, "处理超时，请稍后重试。");
  }
  if (!response.ok) {
    throw new AppError(response.status === 429 ? 429 : 502,
      response.status === 429 ? "服务繁忙，请稍后再试。" : "语音服务暂时不可用，请稍后重试。");
  }
  try {
    return await response.json();
  } catch {
    throw new AppError(502, "语音服务返回了无效结果，请重试。");
  }
}

export async function processAudio(audio, names, { token, fetcher = fetch, rules }) {
  if (!token) throw new AppError(503, "服务端尚未配置识别接口，请联系应用维护者。");
  if (!audio || typeof audio.arrayBuffer !== "function" || audio.size === 0) {
    throw new AppError(400, "请选择一段非空录音。");
  }
  const extension = String(audio.name ?? "").split(".").pop().toLowerCase();
  if (!EXTENSIONS.has(extension)) throw new AppError(400, "不支持此文件格式，请使用常见音频文件。");
  if (audio.size > MAX_AUDIO) throw new AppError(413, "录音不能超过 20 MB。");
  if (typeof names !== "string" || names.length > 20_000) throw new AppError(400, "名单内容过长。");

  const form = new FormData();
  form.append("audio_file", audio, "recording." + extension);
  const terms = termsFrom(names);
  if (terms) form.append("terms", terms);
  const auth = { Authorization: "Bearer " + token };
  const recognized = await upstream(fetcher, "/audio/transcriptions", {
    method: "POST", headers: auth, body: form,
  });
  if (typeof recognized.text !== "string" || !recognized.text.trim()) {
    throw new AppError(502, "没有识别到文字，请确认录音中有清晰人声。");
  }
  const raw = recognized.text.trim();
  const corrected = await upstream(fetcher, "/chat/completions", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash", temperature: 0,
      messages: [
        { role: "system", content: rules + "\n\n使用者提供的 names.md（词表）\n" + names },
        { role: "user", content: raw },
      ],
    }),
  });
  const cleaned = corrected.choices?.[0]?.message?.content;
  if (typeof cleaned !== "string" || !cleaned.trim()) {
    throw new AppError(502, "整理服务没有返回文字，请重试。");
  }
  return { raw, original: cleaned.trim() };
}

async function readBody(request, maximum = MAX_BODY) {
  if (Number(request.headers["content-length"]) > maximum) throw new AppError(413, "上传内容过大，请重新选择录音。");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new AppError(413, "上传内容过大，请重新选择录音。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sameOrigin(request, publicOrigin) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const protocol = request.socket.encrypted ? "https" : "http";
    const expected = publicOrigin || `${protocol}://${request.headers.host}`;
    return new URL(origin).origin === origin && origin === expected;
  } catch {
    return false;
  }
}

export async function createApp({
  token = process.env.AI_BUILDER_TOKEN, fetcher = fetch, publicOrigin = process.env.PUBLIC_ORIGIN,
} = {}) {
  if (publicOrigin) {
    const configured = new URL(publicOrigin);
    if (!["https:", "http:"].includes(configured.protocol) || configured.username || configured.password
      || configured.pathname !== "/" || configured.search || configured.hash) {
      throw new Error("PUBLIC_ORIGIN must be an HTTP or HTTPS origin.");
    }
    publicOrigin = configured.origin;
  }
  const rules = await readFile(resolve(ROOT, "skills/cleanup.md"), "utf8");
  const contents = Object.fromEntries(await Promise.all(
    Object.entries(assets).map(async ([url, [path, type]]) => [url, { body: await readFile(resolve(ROOT, path)), type }]),
  ));
  const recent = new Map();
  const uploads = new Map();
  const expireUploads = () => {
    for (const [id, upload] of uploads) if (upload.expires < Date.now()) uploads.delete(id);
  };
  const expiryTimer = setInterval(expireUploads, 30_000);
  expiryTimer.unref();
  let active = 0;
  const server = http.createServer(async (request, response) => {
    const headers = {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Cache-Control": "no-store",
      "Permissions-Policy": "microphone=(self)",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    };
    const json = (status, data) => {
      response.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(data));
    };
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      if (request.method === "GET" && path === "/healthz") return json(200, { status: "ok" });
      if (request.method === "GET" && contents[path]) {
        response.writeHead(200, { ...headers, "Content-Type": contents[path].type });
        return response.end(contents[path].body);
      }
      const uploadRoute = /^\/api\/uploads\/([0-9a-f-]+)(?:\/(\d+|complete))?$/.exec(path);
      const createUpload = request.method === "POST" && path === "/api/uploads";
      const directUpload = request.method === "POST" && path === "/api/process";
      const chunkUpload = request.method === "PUT" && uploadRoute?.[2] && uploadRoute[2] !== "complete";
      const completeUpload = request.method === "POST" && uploadRoute?.[2] === "complete";
      const deleteUpload = request.method === "DELETE" && uploadRoute && !uploadRoute[2];
      if (!createUpload && !directUpload && !chunkUpload && !completeUpload && !deleteUpload) {
        return json(404, { error: "页面不存在。" });
      }
      if (!sameOrigin(request, publicOrigin)) throw new AppError(403, "请从 VoiceFlow 页面提交录音。");
      expireUploads();
      let upload;
      if (uploadRoute) {
        upload = uploads.get(uploadRoute[1]);
        if (!upload || request.headers["x-upload-token"] !== upload.token) {
          throw new AppError(404, "上传已过期，请重新选择录音。");
        }
        if (deleteUpload) {
          uploads.delete(uploadRoute[1]);
          return json(200, { deleted: true });
        }
        if (chunkUpload) {
          const index = Number(uploadRoute[2]);
          if (upload.receiving || index !== upload.chunks.length || index >= Math.ceil(upload.size / CHUNK_SIZE)) {
            throw new AppError(409, "录音上传顺序有误，请重新上传。");
          }
          upload.receiving = true;
          try {
            const chunk = await readBody(request, CHUNK_SIZE);
            const expected = Math.min(CHUNK_SIZE, upload.size - index * CHUNK_SIZE);
            if (chunk.length !== expected || uploads.get(uploadRoute[1]) !== upload) {
              throw new AppError(400, "录音上传不完整，请重新上传。");
            }
            upload.chunks.push(chunk);
            upload.expires = Date.now() + UPLOAD_TTL;
            return json(200, { received: index + 1 });
          } catch (error) {
            uploads.delete(uploadRoute[1]);
            throw error;
          } finally {
            upload.receiving = false;
          }
        }
        if (upload.receiving || upload.chunks.length !== Math.ceil(upload.size / CHUNK_SIZE)) {
          throw new AppError(409, "录音上传不完整，请重新上传。");
        }
      }
      const ip = request.headers["x-forwarded-for"]?.split(",")[0].trim() || request.socket.remoteAddress;
      const now = Date.now();
      for (const [key, value] of recent) if (value.reset < now) recent.delete(key);
      const bucket = recent.get(ip) || { count: 0, reset: now + 60_000 };
      if (active >= 1 || ((createUpload || directUpload) && (bucket.count >= 8 || uploads.size >= 1))) {
        throw new AppError(429, "正在处理另一段录音，请稍等片刻。");
      }
      if (createUpload || directUpload) {
        bucket.count++;
        recent.set(ip, bucket);
      }
      if (createUpload) {
        if (!token) throw new AppError(503, "服务端尚未配置识别接口，请联系应用维护者。");
        let metadata;
        try {
          metadata = JSON.parse((await readBody(request, 128 * 1024)).toString("utf8"));
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(400, "录音信息格式无效。");
        }
        if (!metadata || typeof metadata !== "object" || !Number.isSafeInteger(metadata.size)
          || metadata.size <= 0 || metadata.size > MAX_AUDIO
          || typeof metadata.name !== "string" || metadata.name.length > 512
          || !EXTENSIONS.has(metadata.name.split(".").pop().toLowerCase())
          || typeof metadata.type !== "string" || metadata.type.length > 200
          || typeof metadata.names !== "string" || metadata.names.length > 20_000) {
          throw new AppError(400, "录音信息无效，文件最大支持 20 MB。");
        }
        // Recheck after reading the body so concurrent requests share one slot.
        if (uploads.size || active) throw new AppError(429, "正在处理另一段录音，请稍等片刻。");
        const id = randomUUID();
        const uploadToken = randomBytes(32).toString("hex");
        uploads.set(id, { ...metadata, token: uploadToken, chunks: [], receiving: false, expires: Date.now() + UPLOAD_TTL });
        return json(201, { id, token: uploadToken, chunkSize: CHUNK_SIZE });
      }
      active++;
      try {
        if (completeUpload) {
          uploads.delete(uploadRoute[1]);
          const buffer = Buffer.concat(upload.chunks, upload.size);
          upload.chunks = [];
          const audio = new File([buffer], upload.name, { type: upload.type });
          return json(200, await processAudio(audio, upload.names, { token, fetcher, rules }));
        }
        if (!request.headers["content-type"]?.startsWith("multipart/form-data;")) {
          throw new AppError(400, "请选择录音文件。");
        }
        const body = await readBody(request);
        let form;
        try {
          form = await new Request("http://localhost/api/process", {
            method: "POST", headers: { "Content-Type": request.headers["content-type"] }, body,
          }).formData();
        } catch {
          throw new AppError(400, "录音上传格式无效。");
        }
        const result = await processAudio(form.get("audio"), form.get("names") ?? "", { token, fetcher, rules });
        json(200, result);
      } finally {
        active--;
      }
    } catch (error) {
      json(error instanceof AppError ? error.status : 500, {
        error: error instanceof AppError ? error.message : "处理暂时失败，请重试。",
      });
    }
  });
  server.requestTimeout = 240_000;
  server.on("close", () => clearInterval(expiryTimer));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createApp();
  server.listen(Number(process.env.PORT || 8000), "0.0.0.0", () => {
    console.log("VoiceFlow is ready.");
  });
}
