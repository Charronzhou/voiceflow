const $ = id => document.getElementById(id);
const PREF = "voiceflow.save";
const NAMES = "voiceflow.names";
const DATABASE = "voiceflow-copy-records";
let names = "";
let recorder = null;
let stream = null;
let chunks = [];
let started = 0;
let ticker = null;
let cutoff = null;
let previewUrl = null;
let job = null;
let busy = false;
let leaving = false;

function status(text, type = "") {
  $("status").textContent = text;
  $("status").className = "status " + type;
}
function buttons() {
  $("record").disabled = busy;
  $("file").disabled = busy || recorder?.state === "recording";
  $("copy").disabled = busy || !job || !$("output").value.trim();
}
function updateCount() {
  $("word-count").textContent = Array.from($("output").value).length + " 字符";
  $("copy-status").textContent = "";
  buttons();
}

function dbOperation(mode, operation) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("pairs", { keyPath: "id" });
    request.onerror = () => reject(new Error("无法使用本机存储"));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("pairs", mode);
      let work;
      try {
        work = operation(tx.objectStore("pairs"));
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      tx.oncomplete = () => { const result = work?.result; db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(new Error("本机记录保存失败")); };
      tx.onabort = () => { db.close(); reject(new Error("本机存储操作中断")); };
    };
  });
}

async function history() {
  if (!$("save-enabled").checked) {
    $("history").hidden = true;
    $("history-list").replaceChildren();
    return;
  }
  const records = await dbOperation("readonly", store => store.getAll());
  records.sort((a, b) => b.created_at.localeCompare(a.created_at));
  $("history").hidden = records.length === 0;
  $("history-summary").textContent = "本机复制记录 · " + records.length + " 组";
  const nodes = records.slice(0, 20).map(record => {
    const article = document.createElement("article");
    article.className = "history-item";
    const time = document.createElement("time");
    time.textContent = new Date(record.created_at).toLocaleString();
    const pair = document.createElement("div");
    pair.className = "history-pair";
    for (const [label, value] of [["模型原始输出", record.original], ["编辑后的版本", record.edited]]) {
      const column = document.createElement("div");
      const heading = document.createElement("h3");
      const text = document.createElement("p");
      heading.textContent = label;
      text.textContent = value;
      column.append(heading, text);
      pair.append(column);
    }
    article.append(time, pair);
    return article;
  });
  $("history-list").replaceChildren(...nodes);
}

function privacyNote() {
  $("storage-note").textContent = $("save-enabled").checked
    ? "复制时自动保存文字对；关闭此选项会清除已有本机记录。"
    : "当前关闭保存，内容仅保留在本次页面中。";
}

async function clearSaved() {
  localStorage.removeItem(NAMES);
  localStorage.removeItem(PREF);
  await dbOperation("readwrite", store => store.clear());
  $("history-list").replaceChildren();
  $("history").hidden = true;
}

$("save-enabled").addEventListener("change", async () => {
  try {
    if ($("save-enabled").checked) {
      localStorage.setItem(PREF, "true");
      localStorage.setItem(NAMES, names);
      await history();
    } else {
      await clearSaved();
    }
  } catch {
    $("save-enabled").checked = false;
    $("copy-status").textContent = "本机存储不可用，请检查浏览器隐私设置。";
  }
  privacyNote();
});

$("settings-open").onclick = () => {
  $("names").value = names;
  $("settings-status").textContent = "";
  $("settings").showModal();
};
$("settings-save").onclick = () => {
  names = $("names").value.trim();
  if ($("save-enabled").checked) {
    try {
      localStorage.setItem(NAMES, names);
    } catch {
      $("settings-status").textContent = "名单仅在本次页面生效，本机存储不可用。";
      return;
    }
  }
  $("settings").close();
};
$("clear").onclick = async () => {
  try {
    await clearSaved();
    $("save-enabled").checked = false;
    privacyNote();
    $("settings-status").textContent = "已清空本机记录和已保存名单。";
  } catch {
    $("settings-status").textContent = "无法清空，请检查浏览器存储权限。";
  }
};

async function requestJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(240_000) });
  if (response.status === 413) throw new Error("上传被服务器限制，请选择更小的录音后重试。");
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(response.status === 502 || response.status === 504
      ? "语音服务响应超时或暂时不可用，请稍后重试。"
      : `服务器返回了无效响应（HTTP ${response.status}），请稍后重试。`);
  }
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "处理失败，请稍后重试。");
  return result;
}

async function submitAudio(audio) {
  if (audio.size <= 512 * 1024) {
    const form = new FormData();
    form.append("audio", audio);
    form.append("names", names);
    return requestJson("/api/process", { method: "POST", body: form });
  }
  const upload = await requestJson("/api/uploads", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: audio.name, size: audio.size, type: audio.type, names }),
  });
  if (typeof upload?.id !== "string" || typeof upload.token !== "string" || upload.chunkSize !== 512 * 1024) {
    throw new Error("服务器返回了无效上传信息，请重试。");
  }
  const path = "/api/uploads/" + encodeURIComponent(upload.id);
  const headers = { "X-Upload-Token": upload.token };
  try {
    for (let offset = 0, index = 0; offset < audio.size; offset += upload.chunkSize, index++) {
      status(`正在上传录音… ${Math.floor(offset / audio.size * 100)}%`, "busy");
      await requestJson(path + "/" + index, {
        method: "PUT", headers, body: audio.slice(offset, offset + upload.chunkSize),
      });
    }
    status("正在识别并整理录音…", "busy");
    return await requestJson(path + "/complete", { method: "POST", headers });
  } catch (error) {
    await fetch(path, { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) }).catch(() => {});
    throw error;
  }
}

async function process(audio) {
  if (!audio.size || audio.size > 20 * 1024 * 1024) {
    status(audio.size ? "文件超过 20 MB，请选择较短的录音。" : "这段录音是空的，请重新录制。", "error");
    return;
  }
  busy = true;
  job = null;
  $("output").value = "";
  $("copy-status").textContent = "";
  $("raw-details").hidden = true;
  updateCount();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(audio);
  $("preview").src = previewUrl;
  $("filename").textContent = audio.name;
  $("selected").hidden = false;
  status("正在识别并整理录音…", "busy");
  try {
    const result = await submitAudio(audio);
    if (typeof result?.original !== "string" || typeof result?.raw !== "string") throw new Error("结果格式无效，请重试。");
    job = { id: crypto.randomUUID(), original: result.original, raw: result.raw };
    $("output").value = job.original;
    $("raw-text").textContent = job.raw;
    $("raw-details").hidden = false;
    status("整理完成，可以直接编辑");
  } catch (error) {
    status(error.name === "TimeoutError" ? "处理超时，请稍后再试。" : error.message, "error");
  } finally {
    busy = false;
    updateCount();
  }
}

$("file").onchange = async event => {
  const file = event.target.files[0];
  if (file) await process(file);
  event.target.value = "";
};

function updateTimer() {
  const seconds = Math.floor((Date.now() - started) / 1000);
  $("timer").textContent = String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
}

function releaseMicrophone() {
  clearInterval(ticker);
  clearTimeout(cutoff);
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  $("record").classList.remove("recording");
  $("wave").classList.remove("recording");
  $("record-label").textContent = "开始录音";
}

$("record").onclick = async () => {
  if (recorder?.state === "recording") {
    recorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    status("当前浏览器无法录音，请上传录音文件，或用新版浏览器打开此页面。", "error");
    return;
  }
  $("record").disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const supported = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"]
      .find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, supported ? { mimeType: supported } : {});
    chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      const type = recorder.mimeType;
      releaseMicrophone();
      const blob = new Blob(chunks, { type });
      const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      if (!leaving) await process(new File([blob], "录音." + extension, { type }));
    };
    recorder.onerror = () => {
      leaving = true;
      releaseMicrophone();
      status("录音中断，请上传文件或重新打开页面再试。", "error");
      buttons();
    };
    recorder.start(1000);
    started = Date.now();
    updateTimer();
    ticker = setInterval(updateTimer, 250);
    cutoff = setTimeout(() => { if (recorder?.state === "recording") recorder.stop(); }, 120_000);
    $("record").classList.add("recording");
    $("wave").classList.add("recording");
    $("record-label").textContent = "停止并整理";
    status("正在录音，请自然说话");
  } catch (error) {
    releaseMicrophone();
    status(error.name === "NotAllowedError" ? "麦克风权限未开启，可以上传已有录音。" : "无法开始录音，请检查麦克风后重试。", "error");
  } finally {
    buttons();
  }
};

$("output").oninput = updateCount;
$("copy").onclick = async () => {
  if (!job || busy) return;
  const current = job;
  const edited = $("output").value;
  const save = $("save-enabled").checked;
  $("copy").disabled = true;
  try {
    await navigator.clipboard.writeText(edited);
  } catch {
    $("copy-status").textContent = "复制失败，请选中文字手动复制后重试。";
    buttons();
    return;
  }
  try {
    if (save && $("save-enabled").checked) {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(edited));
      const key = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join("");
      if ($("save-enabled").checked) {
        await dbOperation("readwrite", store => store.put({
          id: current.id + ":" + key, raw: current.raw, original: current.original, edited, created_at: new Date().toISOString(),
        }));
        // Turning privacy off during a transaction must also erase that transaction.
        if (!$("save-enabled").checked) await clearSaved();
        else await history();
      }
      $("copy-status").textContent = $("save-enabled").checked ? "已复制，并保存文字对" : "已复制";
    } else {
      $("copy-status").textContent = "已复制，本次未保存";
    }
  } catch {
    $("copy-status").textContent = "已复制，但本机保存失败，请重试复制。";
  } finally {
    buttons();
  }
};

window.addEventListener("pagehide", () => {
  leaving = true;
  if (recorder?.state === "recording") recorder.stop();
  releaseMicrophone();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
});

try {
  $("save-enabled").checked = localStorage.getItem(PREF) === "true";
  if ($("save-enabled").checked) {
    names = localStorage.getItem(NAMES) || "";
    history().catch(() => { $("copy-status").textContent = "无法读取本机记录。"; });
  }
} catch {
  $("save-enabled").checked = false;
}
privacyNote();
buttons();
