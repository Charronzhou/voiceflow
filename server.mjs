import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BASE = "https://space.ai-builders.com/backend/v1";
const MAX_AUDIO = 20 * 1024 * 1024;
const MAX_BODY = MAX_AUDIO + 128 * 1024;
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

async function readBody(request) {
  if (Number(request.headers["content-length"]) > MAX_BODY) throw new AppError(413, "文件太大，最大支持 20 MB。");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new AppError(413, "文件太大，最大支持 20 MB。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export async function createApp({ token = process.env.AI_BUILDER_TOKEN, fetcher = fetch } = {}) {
  const rules = await readFile(resolve(ROOT, "skills/cleanup.md"), "utf8");
  const contents = Object.fromEntries(await Promise.all(
    Object.entries(assets).map(async ([url, [path, type]]) => [url, { body: await readFile(resolve(ROOT, path)), type }]),
  ));
  const recent = new Map();
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
      if (request.method !== "POST" || path !== "/api/process") return json(404, { error: "页面不存在。" });
      if (!sameOrigin(request)) throw new AppError(403, "请从 VoiceFlow 页面提交录音。");
      const ip = request.headers["x-forwarded-for"]?.split(",")[0].trim() || request.socket.remoteAddress;
      const now = Date.now();
      for (const [key, value] of recent) if (value.reset < now) recent.delete(key);
      const bucket = recent.get(ip) || { count: 0, reset: now + 60_000 };
      if (bucket.count >= 8 || active >= 3) throw new AppError(429, "处理请求较多，请稍等片刻。");
      bucket.count++;
      recent.set(ip, bucket);
      active++;
      try {
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
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createApp();
  server.listen(Number(process.env.PORT || 8000), "0.0.0.0", () => {
    console.log("VoiceFlow is ready.");
  });
}
