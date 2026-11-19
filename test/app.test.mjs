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
});
