import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createApp, processAudio, AppError } from "../server.mjs";

const token = "server-test-placeholder";
const rules = "保留原意，按用户名单整理。";
const names = "人物甲：项目负责人";
const audio = () => new File(["synthetic audio"], "sample.wav", { type: "audio/wav" });
function mockProvider(calls) {
  return async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/audio/transcriptions")) return Response.json({ text: "嗯，今天的事情定了。" });
    return Response.json({ choices: [{ message: { content: "今天的事情定了。" } }] });
  };
}

test("recognition and cleanup receive user vocabulary and the token only upstream", async () => {
  const calls = [];
  const result = await processAudio(audio(), names, { token, rules, fetcher: mockProvider(calls) });
  assert.deepEqual(result, { raw: "嗯，今天的事情定了。", original: "今天的事情定了。" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.body.get("terms"), "人物甲");
  assert.equal(calls[0].options.headers.Authorization, "Bearer " + token);
  assert.equal(calls[1].options.headers.Authorization, "Bearer " + token);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.messages.map(message => message.role), ["system", "user"]);
  assert(body.messages[0].content.includes(names));
  assert.equal(body.messages[1].content, result.raw);
  assert(!JSON.stringify(result).includes(token));
});

test("invalid audio and missing server configuration fail before any upstream request", async () => {
  const fetcher = () => assert.fail("should not call provider");
  for (const [file, key, code] of [
    [new File([], "empty.wav"), token, 400],
    [new File(["content"], "bad.txt"), token, 400],
    [audio(), "", 503],
  ]) {
    await assert.rejects(processAudio(file, "", { token: key, rules, fetcher }), error => error.status === code);
  }
});

test("upstream errors never expose response bodies or server credentials", async () => {
  const fetcher = async () => new Response("secret details " + token, { status: 500 });
  await assert.rejects(processAudio(audio(), "", { token, rules, fetcher }),
    error => error instanceof AppError && !error.message.includes(token) && error.status === 502);
});

test("HTTP surface exposes only static assets and safe processing results", async t => {
  const calls = [];
  const server = await createApp({ token, fetcher: mockProvider(calls) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  for (const path of ["/", "/app.js", "/style.css"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert(!((await response.text()).includes(token)));
    assert(response.headers.get("content-security-policy").includes("connect-src 'self'"));
  }
  for (const path of ["/.env", "/server.mjs", "/skills/cleanup.md", "/names.md"]) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  const form = new FormData();
  form.append("audio", audio());
  form.append("names", names);
  const response = await fetch(base + "/api/process", { method: "POST", body: form, headers: { Origin: base } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).original, "今天的事情定了。");
  const blocked = await fetch(base + "/api/process", {
    method: "POST", body: new FormData(), headers: { Origin: "https://unrelated.example" },
  });
  assert.equal(blocked.status, 403);
  const wrongProtocol = await fetch(base + "/api/process", {
    method: "POST", body: new FormData(), headers: { Origin: base.replace("http:", "https:") },
  });
  assert.equal(wrongProtocol.status, 403);
});

test("configured public origin survives proxy host rewriting and rejects forwarded origin spoofing", async t => {
  const calls = [];
  const publicOrigin = "https://voiceflow.ai-builders.space";
  const server = await createApp({ token, fetcher: mockProvider(calls), publicOrigin });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const form = new FormData();
  form.append("audio", audio());
  const response = await fetch(base + "/api/process", {
    method: "POST", body: form,
    headers: { Origin: publicOrigin, Host: "voiceflow.internal:8000" },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).original, "今天的事情定了。");
  assert.equal(calls.length, 2);
  for (const origin of ["https://unrelated.example", base, publicOrigin + "/path", "null"]) {
    const blocked = await fetch(base + "/api/process", {
      method: "POST", body: new FormData(),
      headers: { Origin: origin, Host: "voiceflow.internal:8000", "X-Forwarded-Host": new URL(base).host },
    });
    assert.equal(blocked.status, 403);
  }
  assert.equal(calls.length, 2);
});

test("invalid public origin configuration fails before starting the server", async () => {
  for (const publicOrigin of ["not-a-url", "https://user:secret@example.com", "https://example.com/path", "file:///tmp"]) {
    await assert.rejects(createApp({ token, publicOrigin }));
  }
});

test("chunked uploads are bounded, ordered, authorized and cleared after processing", async t => {
  const calls = [];
  const server = await createApp({ token, fetcher: mockProvider(calls) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const size = 1206560;
  const metadata = { name: "synthetic.wav", size, type: "audio/wav", names };
  const create = (data = metadata, origin = base) => fetch(base + "/api/uploads", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  assert.equal((await create(metadata, "https://unrelated.example")).status, 403);
  assert.equal((await create({ ...metadata, size: 20 * 1024 * 1024 + 1 })).status, 400);
  const upload = await (await create()).json();
  assert.equal(upload.chunkSize, 512 * 1024);
  const path = base + "/api/uploads/" + upload.id;
  const headers = { Origin: base, "X-Upload-Token": upload.token };
  assert.equal((await create()).status, 429);
  assert.equal((await fetch(path + "/0", { method: "PUT", body: "x" })).status, 404);
  assert.equal((await fetch(path + "/complete", { method: "POST", headers })).status, 409);
  const content = new Uint8Array(size).fill(42);
  for (let offset = 0, index = 0; offset < size; offset += upload.chunkSize, index++) {
    const body = content.slice(offset, offset + upload.chunkSize);
    const options = { method: "PUT", headers, body };
    assert.equal((await fetch(path + "/" + index, options)).status, 200);
    if (index === 0) assert.equal((await fetch(path + "/0", options)).status, 409);
  }
  const result = await fetch(path + "/complete", { method: "POST", headers });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).original, "今天的事情定了。");
  assert.deepEqual(new Uint8Array(await calls[0].options.body.get("audio_file").arrayBuffer()), content);
  assert.equal((await fetch(path + "/complete", { method: "POST", headers })).status, 404);

  const maximum = await create({ ...metadata, size: 20 * 1024 * 1024 });
  assert.equal(maximum.status, 201);
  const reserved = await maximum.json();
  const reservedPath = base + "/api/uploads/" + reserved.id;
  const reservedHeaders = { Origin: base, "X-Upload-Token": reserved.token };
  const oversized = await fetch(reservedPath + "/0", {
    method: "PUT", headers: reservedHeaders, body: new Uint8Array(512 * 1024 + 1),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await fetch(reservedPath, { method: "DELETE", headers: reservedHeaders })).status, 404);
  const again = await (await create()).json();
  assert.equal((await fetch(base + "/api/uploads/" + again.id, {
    method: "DELETE", headers: { Origin: base, "X-Upload-Token": again.token },
  })).status, 200);

  const expired = await (await create()).json();
  const originalNow = Date.now;
  Date.now = () => originalNow() + 5 * 60_000 + 1;
  try {
    assert.equal((await fetch(base + "/api/uploads/" + expired.id + "/0", {
      method: "PUT", body: new Uint8Array(512 * 1024),
      headers: { Origin: base, "X-Upload-Token": expired.token },
    })).status, 404);
  } finally {
    Date.now = originalNow;
  }
  const failed = await (await create()).json();
  const failedPath = base + "/api/uploads/" + failed.id;
  const failedHeaders = { Origin: base, "X-Upload-Token": failed.token };
  assert.equal((await fetch(failedPath + "/0", { method: "PUT", headers: failedHeaders, body: "too short" })).status, 400);
  assert.equal((await fetch(failedPath, { method: "DELETE", headers: failedHeaders })).status, 404);
});

test("chunked completion releases the session when the speech provider fails", async t => {
  const server = await createApp({ token, fetcher: async () => new Response("upstream failure", { status: 500 }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const create = () => fetch(base + "/api/uploads", {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "test.wav", size: 3, type: "audio/wav", names: "" }),
  });
  const upload = await (await create()).json();
  const path = base + "/api/uploads/" + upload.id;
  const headers = { Origin: base, "X-Upload-Token": upload.token };
  assert.equal((await fetch(path + "/0", { method: "PUT", headers, body: "abc" })).status, 200);
  assert.equal((await fetch(path + "/complete", { method: "POST", headers })).status, 502);
  assert.equal((await fetch(path + "/complete", { method: "POST", headers })).status, 404);
  assert.equal((await create()).status, 201);
});

test("browser recording start/stop uploads audio and releases the microphone", async () => {
  const { readFile } = await import("node:fs/promises");
  const vm = await import("node:vm");
  const code = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: "", checked: false, disabled: false, hidden: false, textContent: "",
      classList: { add() {}, remove() {} }, addEventListener() {}, replaceChildren() {},
    });
    return elements.get(id);
  };
  let released = false;
  let sent = null;
  class Recorder {
    static isTypeSupported(type) { return type.includes("webm"); }
    constructor(stream, options) { this.state = "inactive"; this.mimeType = options.mimeType; }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable({ data: new Blob(["synthetic microphone data"], { type: this.mimeType }) });
      this.onstop();
    }
  }
  const context = {
    document: { getElementById: element },
    window: { MediaRecorder: Recorder, addEventListener() {} },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { released = true; } }] }) } },
    MediaRecorder: Recorder, Blob, File, FormData, URL, AbortSignal, crypto, TextEncoder, Date, Array, Promise,
    localStorage: { getItem() { return null; } },
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 2; }, clearTimeout() {},
    fetch: async (url, options) => {
      sent = options.body;
      return Response.json({ raw: "录音原文", original: "录音整理结果" });
    },
  };
  vm.runInNewContext(code, context);
  await element("record").onclick();
  assert.equal(element("record-label").textContent, "停止并整理");
  await element("record").onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element("output").value, "录音整理结果");
  assert.equal(element("status").textContent, "整理完成，可以直接编辑");
  assert(sent.get("audio").name.endsWith(".webm"));
  assert(released);

  context.navigator.mediaDevices.getUserMedia = async () => {
    const error = new Error("denied"); error.name = "NotAllowedError"; throw error;
  };
  await element("record").onclick();
  assert.equal(element("status").textContent, "麦克风权限未开启，可以上传已有录音。");

  for (const [httpStatus, message] of [
    [413, "上传被服务器限制，请选择更小的录音后重试。"],
    [504, "语音服务响应超时或暂时不可用，请稍后重试。"],
    [200, "服务器返回了无效响应（HTTP 200），请稍后重试。"],
  ]) {
    context.fetch = async () => new Response("<html><h1>upstream error</h1></html>", { status: httpStatus });
    await element("file").onchange({ target: { files: [audio()], value: "sample.wav" } });
    assert.equal(element("status").textContent, message);
    assert.equal(element("copy").disabled, true);
    assert.equal(element("file").disabled, false);
  }

  const chunkCalls = [];
  context.fetch = async (url, options) => {
    chunkCalls.push({ url, options });
    if (url === "/api/uploads") return Response.json({ id: "test-upload", token: "test-upload-token", chunkSize: 512 * 1024 });
    if (url.endsWith("/complete")) return Response.json({ raw: "原文", original: "分块上传结果" });
    return Response.json({ received: 1 });
  };
  const larger = new File([new Uint8Array(1206560)], "large.wav", { type: "audio/wav" });
  await element("file").onchange({ target: { files: [larger], value: "large.wav" } });
  assert.equal(element("output").value, "分块上传结果");
  assert.deepEqual(chunkCalls.map(call => call.options.method), ["POST", "PUT", "PUT", "PUT", "POST"]);
  assert.deepEqual(chunkCalls.slice(1, 4).map(call => call.options.body.size), [524288, 524288, 157984]);
  assert(chunkCalls.slice(1).every(call => call.options.headers["X-Upload-Token"] === "test-upload-token"));

  const failedCalls = [];
  context.fetch = async (url, options) => {
    failedCalls.push(options.method);
    if (url === "/api/uploads") return Response.json({ id: "test-upload", token: "test-upload-token", chunkSize: 512 * 1024 });
    if (options.method === "DELETE") return Response.json({ deleted: true });
    return new Response("<html>bad gateway</html>", { status: 502 });
  };
  await element("file").onchange({ target: { files: [larger], value: "large.wav" } });
  assert.deepEqual(failedCalls, ["POST", "PUT", "DELETE"]);
  assert.equal(element("status").textContent, "语音服务响应超时或暂时不可用，请稍后重试。");
});
