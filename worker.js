// =================================================================================
//  项目: mindvideo-2api (Cloudflare Worker 单文件全功能版)
//  版本: 3.3.3 (代号: Ultimate Stealth & Full UI)
//  作者: 首席开发者体验架构师
//  日期: 2026-05-15
//
//  [更新日志 v3.3.3]
//  1. [Core] 新增 uuidv4() 生成器，对齐官方 x-request-id 请求头。
//  2. [Core] 更新 User-Agent 和 Accept-Encoding 匹配最新 HAR 包，降低风控。
//  3. [Fix] 增强错误捕获，直接透传官方的 401/403 错误信息，避免模糊的 500 报错。
//  4. [Fix] 修复跨域预检请求 (OPTIONS) 被拦截的问题。
//  5. [Fix] 修复标准 API 模式下非流式请求提前返回空内容的问题。
//  6. [UI] 完整保留所有动态 UI 控制逻辑与前端交互代码。
// =================================================================================

// --- [第一部分: 核心配置] ---
const CONFIG = {
  PROJECT_NAME: "mindvideo-2api",
  PROJECT_VERSION: "3.3.3",
  
  // --- 安全配置 ---
  API_MASTER_KEY: "1", 
  
  // --- MindVideo 凭证 ---
  // ⚠️⚠️⚠️ 必须替换为您最新抓包的 Token ⚠️⚠️⚠️
  AUTH_TOKENS: [
    "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJodHRwczovL2FwaS1hcHAubWluZHZpZGVvLmFpL2FwaS9yZWZyZXNoIiwiaWF0IjoxNzc2NDg3OTYzLCJleHAiOjE3Nzg4NDcxNDgsIm5iZiI6MTc3ODgzOTk0OCwianRpIjoiYUdRY1pKclo5aEZxWXRyWSIsInN1YiI6IjI3MjYwNiIsInBydiI6IjIzYmQ1Yzg5NDlmNjAwYWRiMzllNzAxYzQwMDg3MmRiN2E1OTc2ZjciLCJ1aWQiOjI3MjYwNiwiZW1haWwiOiJxMTM2NDU5NDc0MDdAZ21haWwuY29tIiwiaXNOZXciOmZhbHNlfQ.Q9oDlSaS6Z-0A8T8zHshT19h_FUEz9e6Bjks6o9BFgM"
  ],
  
  // 签名密钥 (固定值)
  SIGN_APP_KEY: "s#c_120*AB",

  // --- 上游配置 ---
  UPSTREAM_API: "https://api-app.mindvideo.ai/api",
  
  // --- 模型定义 ---
  MODELS: {
    "sora-2-free": { id: 153, type: 1, category: "video", name: "Sora-2 Video (文生视频)" },
    "gemini-3-image": { id: 190, type: 8, category: "image", name: "Gemini-3 Pro (文生图)" },
    "gemini-3-i2i": { id: 191, type: 9, category: "image", name: "Gemini-3 I2I (图生图)" },
    "gpt-image-2-free": { id: 292, type: 8, category: "image", name: "GPT Image 2 Free (文生图)" }
  },
  DEFAULT_MODEL: "gpt-image-2-free",

  // --- 自动发现配置 ---
  DISCOVERY: {
    SCAN_START: 1,
    SCAN_END: 300,
    CONCURRENCY: 5,
    SCAN_DELAY: 100,
    CACHE_TTL: 1000 * 60 * 60 * 24 // 24小时缓存
  },
};

// --- [第二部分: Worker 入口] ---
export default {
  async fetch(request, env, ctx) {
    // 0. 优先处理跨域 OPTIONS 请求，避免触发鉴权拦截
    if (request.method === 'OPTIONS') return handleCors();

    const url = new URL(request.url);
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;

    // 1. 静态资源与 WebUI
    if (url.pathname === '/') return handleUI(request, apiKey);
    
    // 2. API 接口
    if (url.pathname === '/v1/chat/completions') return handleChatCompletions(request, apiKey, ctx);
    if (url.pathname === '/v1/images/generations') return handleImageGenerations(request, apiKey, ctx);
    if (url.pathname === '/v1/models') return handleModels(request);
    if (url.pathname === '/v1/models/discover') return handleDiscoverModels(request);

    // 3. 辅助接口
    if (url.pathname === '/v1/tasks/query') return handleTaskQuery(request, apiKey);
    if (url.pathname === '/proxy/upload/sign') return handleUploadSign(request, apiKey);
    if (url.pathname === '/proxy/upload/file') return handleUploadFile(request, apiKey);

    return createError(404, "Not Found", "path_not_found");
  }
};

// --- [第三部分: 核心业务逻辑] ---

/**
 * 动态生成 UUID 对齐 HAR 包中的 x-request-id
 */
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * 签名生成器 (i-sign)
 */
async function generateSign() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  const rnd = new Uint8Array(16);
  crypto.getRandomValues(rnd);
  for (let i = 0; i < 16; i++) nonce += chars[rnd[i] % chars.length];

  const timestamp = Date.now(); // 毫秒
  const signStr = `nonce=${nonce}&timestamp=${timestamp}&app_key=${CONFIG.SIGN_APP_KEY}`;
  const sign = await md5(signStr);

  const signObj = { nonce, timestamp, sign };
  return btoa(JSON.stringify(signObj));
}

/**
 * MD5 实现
 */
async function md5(message) {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('MD5', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 完美克隆自 HAR 包的请求头
 */
async function getHeaders(token) {
  return {
    "accept": "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9",
    "content-type": "application/json",
    "authorization": `Bearer ${token}`,
    "i-lang": "zh-CN",
    "i-sign": await generateSign(),
    "i-version": "1.0.8",
    "origin": "https://www.mindvideo.ai",
    "referer": "https://www.mindvideo.ai/",
    "x-request-id": uuidv4(),
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
  };
}

/**
 * 查找模型配置
 */
function findModelConfig(modelKey) {
  if (CONFIG.MODELS[modelKey]) return { config: CONFIG.MODELS[modelKey], source: 'config' };

  if (modelsCache) {
    const cached = modelsCache.find(m => m.id === modelKey || m.name === modelKey);
    if (cached) {
      return {
        config: {
          id: parseInt(cached.id),
          type: cached.type ?? 8,
          category: cached.category || "image",
          name: cached.name
        },
        source: 'discovered'
      };
    }
  }
  return null;
}

/**
 * 提交任务
 */
async function submitTask(modelKey, prompt, options = {}) {
  const lookup = findModelConfig(modelKey) || { config: CONFIG.MODELS[CONFIG.DEFAULT_MODEL], source: 'config' };
  const modelConfig = lookup.config;
  const token = CONFIG.AUTH_TOKENS[Math.floor(Math.random() * CONFIG.AUTH_TOKENS.length)];

  const payload = {
    type: modelConfig.type,
    bot_id: modelConfig.id,
    options: {
      prompt: prompt,
      history_images: []
    }
  };

  if (modelConfig.category === 'video') {
    payload.options.size = options.size || "1280x720";
    payload.options.seconds = 15;
    payload.is_public = true;
    payload.copy_protection = false;
  } else if (modelConfig.category === 'image') {
    payload.options.size = options.size || "auto";
    if (options.image) payload.options.image = options.image;
    if (options.image_1) payload.options.image_1 = options.image_1;
  }

  const res = await fetch(`${CONFIG.UPSTREAM_API}/v2/creations`, {
    method: 'POST',
    headers: await getHeaders(token),
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Upstream Error: 返回了非 JSON 数据 (${res.status})`);
  }

  // 精准抛出上游的错误原因
  if (data.code !== 0 || !data.data?.id) {
    const errorMsg = data.message || JSON.stringify(data);
    if (errorMsg.includes('过期') || res.status === 401 || data.code === 401) {
      throw new Error(`[核心错误] 官方账号 Token 已过期或无效，请抓包替换 AUTH_TOKENS!`);
    }
    throw new Error(`Upstream Error: ${errorMsg}`);
  }

  return { taskId: data.data.id, token };
}

/**
 * 轮询任务状态
 */
async function pollTask(taskId, token) {
  const res = await fetch(`${CONFIG.UPSTREAM_API}/v2/creations/task_progress?ids[]=${taskId}`, {
    method: 'GET',
    headers: await getHeaders(token)
  });
  
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Poll Error: Upstream returned non-JSON`);
  }

  if (data.code !== 0) {
    throw new Error(`Poll Error: ${data.message}`);
  }
  
  if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
    return { status: 'pending', progress: 0, remark: 'Initializing...' };
  }

  const task = data.data[0];
  let resultUrl = null;
  
  if (task.task_status === 'completed') {
    if (task.results && task.results.length > 0) {
      resultUrl = task.results[0].result_url || task.results[0].cover_url;
    }
    if (!resultUrl && task.cover_url) resultUrl = task.cover_url;
  }

  let errorMsg = null;
  if (task.task_status === 'failed') {
    errorMsg = task.task_remark || "Unknown error";
    if (errorMsg.includes("人数过多")) errorMsg = "此功能使用人数过多，请稍后再试。";
  }

  return {
    status: task.task_status,
    progress: parseInt(task.task_progress || 0),
    url: resultUrl,
    error: errorMsg
  };
}

// --- [API 处理器] ---

async function handleChatCompletions(req, apiKey, ctx) {
  if (!checkAuth(req, apiKey)) return createError(401, "API Key Unauthorized", "auth_error");
  
  let body;
  try { body = await req.json(); } catch(e) { return createError(400, "Invalid JSON"); }

  const { messages, model = CONFIG.DEFAULT_MODEL, stream = false } = body;
  const lastMsg = messages[messages.length - 1].content;
  
  let prompt = lastMsg;
  let options = {};
  try {
    if (lastMsg.trim().startsWith('{')) {
      const parsed = JSON.parse(lastMsg);
      prompt = parsed.prompt;
      options = parsed;
    }
  } catch(e) {}

  let taskInfo;
  try {
    taskInfo = await submitTask(model, prompt, options);
  } catch (e) {
    return createError(500, e.message, "upstream_error");
  }

  if (options.clientPoll) {
    const resp = {
      id: `chatcmpl-${taskInfo.taskId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: `[TASK_ID:${taskInfo.taskId}]` },
        finish_reason: "stop"
      }]
    };
    return new Response(JSON.stringify(resp), { headers: corsHeaders() });
  }

  if (!stream) {
    try {
      const startTime = Date.now();
      while (Date.now() - startTime < 600000) { 
        const pollRes = await pollTask(taskInfo.taskId, taskInfo.token);
        
        if (pollRes.status === 'completed') {
          const markdown = `![Generated Content](${pollRes.url})`;
          const resp = {
            id: `chatcmpl-${taskInfo.taskId}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: markdown },
              finish_reason: "stop"
            }]
          };
          return new Response(JSON.stringify(resp), { headers: corsHeaders() });
        } else if (pollRes.status === 'failed') {
          return createError(500, pollRes.error || "Task failed", "upstream_error");
        } else {
          await new Promise(r => setTimeout(r, 5000)); 
        }
      }
      return createError(504, "Generation timeout", "timeout");
    } catch (e) {
      return createError(500, e.message, "upstream_error");
    }
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  ctx.waitUntil((async () => {
    try {
      await sendSSE(writer, encoder, "🚀 任务已提交，正在处理...");

      const startTime = Date.now();
      let lastProgress = -1;

      while (Date.now() - startTime < 600000) { 
        const pollRes = await pollTask(taskInfo.taskId, taskInfo.token);
        
        if (pollRes.status === 'completed') {
          const markdown = `\n\n![Generated Content](${pollRes.url})`;
          await sendSSE(writer, encoder, markdown);
          await writer.write(encoder.encode("data: [DONE]\n\n"));
          break;
        } else if (pollRes.status === 'failed') {
          throw new Error(pollRes.error);
        } else {
          if (pollRes.progress !== lastProgress) {
            await sendSSE(writer, encoder, `\n⏳ 进度: ${pollRes.progress}%`);
            lastProgress = pollRes.progress;
          }
          await new Promise(r => setTimeout(r, 5000)); 
        }
      }
    } catch (e) {
      await sendSSE(writer, encoder, `\n\n❌ 错误: ${e.message}`);
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } finally {
      await writer.close();
    }
  })());

  return new Response(readable, {
    headers: { ...corsHeaders(), 'Content-Type': 'text/event-stream' }
  });
}

async function handleImageGenerations(req, apiKey, ctx) {
  if (!checkAuth(req, apiKey)) return createError(401, "Unauthorized");
  const body = await req.json();
  const model = body.model || (CONFIG.MODELS["gemini-3-image"] ? "gemini-3-image" : CONFIG.DEFAULT_MODEL);
  
  try {
    const { taskId, token } = await submitTask(model, body.prompt);
    
    let resultUrl = null;
    const startTime = Date.now();
    while (Date.now() - startTime < 120000) {
      await new Promise(r => setTimeout(r, 3000));
      const poll = await pollTask(taskId, token);
      if (poll.status === 'completed') {
        resultUrl = poll.url;
        break;
      }
      if (poll.status === 'failed') throw new Error(poll.error);
    }

    if (!resultUrl) throw new Error("Timeout");

    return new Response(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{ url: resultUrl }]
    }), { headers: corsHeaders() });

  } catch (e) {
    return createError(500, e.message);
  }
}

// --- [WebUI 辅助接口] ---

async function handleUploadSign(req, apiKey) {
  if (!checkAuth(req, apiKey)) return createError(401, "Unauthorized");
  const url = new URL(req.url);
  const filename = url.searchParams.get('filename') || `upload_${Date.now()}.png`;
  const token = CONFIG.AUTH_TOKENS[0];

  const res = await fetch(`${CONFIG.UPSTREAM_API}/images/signed-url?type=image&filename=${filename}&path=user-0`, {
    method: 'POST',
    headers: await getHeaders(token)
  });
  
  const data = await res.json();
  return new Response(JSON.stringify(data), { headers: corsHeaders() });
}

async function handleUploadFile(req, apiKey) {
  if (!checkAuth(req, apiKey)) return createError(401, "Unauthorized");
  const targetUrl = req.headers.get('X-Upload-Url');
  if (!targetUrl) return createError(400, "Missing X-Upload-Url");

  const response = await fetch(targetUrl, {
    method: 'PUT',
    body: req.body,
    headers: { 'Content-Type': req.headers.get('Content-Type') || 'image/png' }
  });

  return new Response(JSON.stringify({ success: response.ok }), { headers: corsHeaders() });
}

async function handleTaskQuery(req, apiKey) {
  if (!checkAuth(req, apiKey)) return createError(401, "Unauthorized");
  const url = new URL(req.url);
  const taskId = url.searchParams.get('taskId');
  const token = CONFIG.AUTH_TOKENS[0]; 

  try {
    const status = await pollTask(taskId, token);
    return new Response(JSON.stringify(status), { headers: corsHeaders() });
  } catch (e) {
    return createError(500, e.message);
  }
}

// --- [工具函数] ---

async function sendSSE(writer, encoder, content) {
  const msg = JSON.stringify({ choices: [{ delta: { content: content } }] });
  await writer.write(encoder.encode(`data: ${msg}\n\n`));
}

function checkAuth(req, validKey) {
  if (validKey === "1") return true;
  const auth = req.headers.get('Authorization');
  return auth && auth === `Bearer ${validKey}`;
}

function createError(status, msg, code = "error") {
  return new Response(JSON.stringify({ error: { message: msg, code } }), {
    status, headers: corsHeaders()
  });
}

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "*"
  };
}

function handleCors() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function getMergedModels() {
  const configModels = Object.keys(CONFIG.MODELS).map(id => ({
    id,
    object: "model",
    name: CONFIG.MODELS[id].name,
    type: CONFIG.MODELS[id].type,
    category: CONFIG.MODELS[id].category,
    source: 'config'
  }));

  if (modelsCache && modelsCache.length > 0) {
    const discoveredModels = modelsCache.map(m => ({
      ...m,
      source: 'discovered'
    }));
    const all = [...configModels];
    for (const d of discoveredModels) {
      const existing = all.findIndex(m => m.id === d.id);
      if (existing >= 0) {
        all[existing] = d; 
      } else {
        all.push(d);
      }
    }
    return all;
  }

  return configModels;
}

function handleModels() {
  const data = getMergedModels();
  return new Response(JSON.stringify({ object: "list", data }), { headers: corsHeaders() });
}

// --- [模型自动发现系统] ---

let modelsCache = null;
let cacheTime = 0;
let isScanning = false;

async function getFreeModels() {
  const now = Date.now();
  if (modelsCache && (now - cacheTime < CONFIG.DISCOVERY.CACHE_TTL)) {
    return modelsCache;
  }

  const discovered = await discoverFreeModels();
  if (discovered.length > 0) {
    modelsCache = discovered;
    cacheTime = now;
  } else {
    modelsCache = Object.keys(CONFIG.MODELS).map(id => ({
      id,
      object: "model",
      name: CONFIG.MODELS[id].name,
      type: CONFIG.MODELS[id].type,
      category: CONFIG.MODELS[id].category,
      free: true 
    }));
  }

  return modelsCache;
}

async function discoverFreeModels() {
  if (isScanning) {
    throw new Error("Scan already in progress");
  }
  isScanning = true;

  try {
    const freeModels = [];
    const { SCAN_START, SCAN_END, CONCURRENCY, SCAN_DELAY } = CONFIG.DISCOVERY;

    for (let start = SCAN_START; start <= SCAN_END; start += CONCURRENCY) {
      const end = Math.min(start + CONCURRENCY - 1, SCAN_END);
      const promises = [];

      for (let botId = start; botId <= end; botId++) {
        promises.push(testBot(botId));
      }

      const results = await Promise.allSettled(promises);

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const botId = start + i;
        if (result.status === 'fulfilled' && result.value) {
          freeModels.push(result.value);
        }
      }

      await new Promise(resolve => setTimeout(resolve, SCAN_DELAY));
    }

    const unique = [];
    const seen = new Set();
    for (const m of freeModels) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        unique.push(m);
      }
    }

    console.log(`Discovery found ${unique.length} free models:`, unique.map(m => m.name).join(', '));
    return unique;

  } finally {
    isScanning = false;
  }
}

async function testBot(botId) {
  const token = CONFIG.AUTH_TOKENS[Math.floor(Math.random() * CONFIG.AUTH_TOKENS.length)];

  const payload = {
    type: 8,
    bot_id: botId,
    options: {
      prompt: "test",
      history_images: []
    }
  };

  try {
    const res = await fetch(`${CONFIG.UPSTREAM_API}/v2/creations`, {
      method: 'POST',
      headers: await getHeaders(token),
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { return null; }

    if (data.code === 0 && data.data) {
      const bot = data.bot || data.data.bot;
      if (bot && bot.base_credits === 0) {
        return {
          id: String(bot.id || botId),
          object: "model",
          name: bot.name || `Bot-${botId}`,
          type: bot.type ?? 8,
          category: bot.category || "image",
          free: true
        };
      }
    }
  } catch (e) {
    
  }

  return null;
}

async function handleDiscoverModels(request) {
  if (request.method !== 'POST') {
    return createError(405, "Method Not Allowed");
  }

  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${CONFIG.API_MASTER_KEY}`) {
    return createError(401, "Unauthorized");
  }

  (async () => {
    try {
      const result = await discoverFreeModels();
      console.log(`Auto-discovery completed. Found ${result.length} free models.`);
      modelsCache = result;
      cacheTime = Date.now();
    } catch (e) {
      console.error("Auto-discovery failed:", e);
    }
  })();

  return new Response(JSON.stringify({
    status: "scanning",
    message: "Model discovery started in background",
    cached_count: modelsCache ? modelsCache.length : 0
  }), { headers: corsHeaders() });
}

// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 驾驶舱</title>
    <style>
        :root { --bg: #0f172a; --panel: #1e293b; --text: #e2e8f0; --accent: #38bdf8; --border: #334155; --success: #22c55e; --error: #ef4444; }
        body { margin: 0; font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); display: flex; height: 100vh; overflow: hidden; }
        .sidebar { width: 340px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; gap: 20px; overflow-y: auto; }
        .main { flex: 1; display: flex; flex-direction: column; padding: 20px; gap: 20px; }
        .card { background: #0f172a; border: 1px solid var(--border); border-radius: 8px; padding: 15px; }
        .title { font-size: 14px; color: #94a3b8; margin-bottom: 10px; font-weight: bold; text-transform: uppercase; }
        input, select, textarea { width: 100%; background: #1e293b; border: 1px solid var(--border); color: white; padding: 8px; border-radius: 4px; box-sizing: border-box; margin-bottom: 10px; font-family: monospace; }
        input:focus, textarea:focus { outline: none; border-color: var(--accent); }
        button { width: 100%; background: var(--accent); color: #0f172a; border: none; padding: 10px; border-radius: 4px; font-weight: bold; cursor: pointer; transition: 0.2s; }
        button:hover { opacity: 0.9; }
        button:disabled { background: #475569; cursor: not-allowed; }
        .upload-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .upload-box { border: 2px dashed var(--border); border-radius: 4px; height: 80px; display: flex; align-items: center; justify-content: center; cursor: pointer; background-size: cover; background-position: center; position: relative; }
        .upload-box:hover { border-color: var(--accent); }
        .upload-box span { font-size: 12px; color: #64748b; pointer-events: none; }
        .terminal { flex: 1; background: #000; border-radius: 8px; border: 1px solid var(--border); padding: 20px; overflow-y: auto; font-family: monospace; white-space: pre-wrap; }
        .msg { margin-bottom: 15px; line-height: 1.5; }
        .msg.user { color: var(--accent); }
        .msg.ai { color: #a5b4fc; }
        .msg.system { color: #94a3b8; font-size: 12px; }
        .msg.error { color: var(--error); border: 1px solid var(--error); padding: 10px; border-radius: 4px; background: rgba(239, 68, 68, 0.1); }
        .msg img, .msg video { max-width: 100%; max-height: 400px; border-radius: 4px; margin-top: 10px; border: 1px solid var(--border); }
        
        /* 进度条样式 */
        .progress-container { margin-top: 8px; background: #334155; height: 6px; border-radius: 3px; overflow: hidden; width: 100%; max-width: 300px; }
        .progress-bar { height: 100%; background: var(--accent); width: 0%; transition: width 0.5s ease; }
        .status-text { font-size: 12px; color: #94a3b8; margin-top: 4px; display: flex; justify-content: space-between; }
    </style>
</head>
<body>
    <div class="sidebar">
        <div>
            <h2 style="margin:0">🧠 MindVideo-2API</h2>
            <div style="font-size:12px; color:#64748b">v${CONFIG.PROJECT_VERSION} | Cloudflare Worker</div>
        </div>

        <div class="card">
            <div class="title">接口信息</div>
            <label style="font-size:12px">API 接口地址 (Endpoint)</label>
            <input type="text" value="${origin}/v1" readonly onclick="this.select()">
            
            <label style="font-size:12px">API Key</label>
            <input type="password" id="api-key" value="${apiKey}" readonly onclick="this.select()">
        </div>

        <div class="card">
            <div class="title">生成配置</div>
            <label style="font-size:12px">模式 (Mode)</label>
            <select id="mode-select" onchange="toggleUploads()">
                ${Object.entries(CONFIG.MODELS).map(([key, m]) =>
    `<option value="${key}"${key === CONFIG.DEFAULT_MODEL ? ' selected' : ''} data-category="${m.category}" data-type="${m.type}">${m.name}</option>`
).join('')}
            </select>

            <div id="video-opts">
                <label style="font-size:12px">比例</label>
                <select id="ratio"></select>
            </div>

            <div id="upload-opts" style="display:none">
                <label style="font-size:12px">参考图 (最多2张)</label>
                <div class="upload-grid">
                    <div class="upload-box" id="box1" onclick="triggerUpload(1)"><span>上传图1</span></div>
                    <div class="upload-box" id="box2" onclick="triggerUpload(2)"><span>上传图2</span></div>
                </div>
                <input type="file" id="file1" hidden onchange="handleFile(this, 1)">
                <input type="file" id="file2" hidden onchange="handleFile(this, 2)">
            </div>
        </div>

        <div class="card">
            <div class="title">输入</div>
            <textarea id="prompt" rows="5" placeholder="描述你的创意..."></textarea>
            <button id="btn-gen" onclick="startGeneration()">🚀 开始生成</button>
        </div>
    </div>

    <div class="main">
        <div class="terminal" id="log">
            <div style="color:#64748b">系统就绪。请在左侧配置并生成...</div>
        </div>
    </div>

    <script>
        const API_KEY = document.getElementById('api-key').value;
        let uploadedImages = { 1: null, 2: null };

        function log(role, text, mediaUrl = null, isVideo = false) {
            const div = document.createElement('div');
            div.className = 'msg ' + role;
            
            let content = \`<div><strong>\${role.toUpperCase()}:</strong> \${text}</div>\`;
            
            // 如果是 AI 回复且没有媒体URL，添加进度条容器
            if (role === 'ai' && !mediaUrl) {
                content += \`
                    <div class="progress-container" id="current-progress-container">
                        <div class="progress-bar" id="current-progress-bar"></div>
                    </div>
                    <div class="status-text" id="current-status-text">
                        <span>准备中...</span>
                        <span id="current-percent">0%</span>
                    </div>
                \`;
            }

            if (mediaUrl) {
                if (isVideo) {
                    content += \`<video src="\${mediaUrl}" controls autoplay loop></video>\`;
                } else {
                    content += \`<img src="\${mediaUrl}" onclick="window.open(this.src)">\`;
                }
            }
            
            div.innerHTML = content;
            document.getElementById('log').appendChild(div);
            document.getElementById('log').scrollTop = document.getElementById('log').scrollHeight;
            return div;
        }

        function updateProgress(percent, status) {
            const bar = document.getElementById('current-progress-bar');
            const text = document.getElementById('current-status-text').querySelector('span:first-child');
            const percentText = document.getElementById('current-percent');
            
            if (bar) bar.style.width = \`\${percent}%\`;
            if (text) text.textContent = status;
            if (percentText) percentText.textContent = \`\${percent}%\`;
        }

        function toggleUploads() {
            const modeSelect = document.getElementById('mode-select');
            const selectedOption = modeSelect.options[modeSelect.selectedIndex];
            const modelType = selectedOption.dataset.type;
            const modelCategory = selectedOption.dataset.category;

            const uploadOpts = document.getElementById('upload-opts');
            const videoOpts = document.getElementById('video-opts');

            if (modelType === '9') {
                uploadOpts.style.display = 'block';
                videoOpts.style.display = 'none';
            } else {
                uploadOpts.style.display = 'none';
                videoOpts.style.display = 'block';
            }

            // 动态更新比例选项
            const ratioSelect = document.getElementById('ratio');
            if (modelCategory === 'video') {
                ratioSelect.innerHTML = '<option value="1280x720">16:9 (横屏)</option><option value="720x1280">9:16 (竖屏)</option>';
            } else {
                ratioSelect.innerHTML = [
                    { value: 'auto', label: 'Auto' },
                    { value: '16:9', label: '16:9' },
                    { value: '9:16', label: '9:16' },
                    { value: '1:1', label: '1:1' },
                    { value: '3:2', label: '3:2' },
                    { value: '2:3', label: '2:3' },
                    { value: '3:4', label: '3:4' }
                ].map(function (o) { return '<option value="' + o.value + '">' + o.label + '</option>'; }).join('');
            }
        }

        function triggerUpload(idx) { document.getElementById('file'+idx).click(); }

        async function handleFile(input, idx) {
            const file = input.files[0];
            if (!file) return;
            const box = document.getElementById('box'+idx);
            box.innerHTML = '<span>上传中...</span>';
            
            try {
                const signRes = await fetch(\`/proxy/upload/sign?filename=\${file.name}\`, {
                    headers: { 'Authorization': 'Bearer ' + API_KEY }
                });
                const signData = await signRes.json();
                if (signData.code !== 0) throw new Error(signData.message || "获取签名失败");
                
                const uploadRes = await fetch('/proxy/upload/file', {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + API_KEY,
                        'X-Upload-Url': signData.data.upload_url,
                        'Content-Type': file.type
                    },
                    body: file
                });
                
                if (!uploadRes.ok) throw new Error("上传失败");

                uploadedImages[idx] = signData.data.public_url;
                box.style.backgroundImage = \`url(\${signData.data.public_url})\`;
                box.innerHTML = '';
                log('system', \`图片 \${idx} 上传成功\`);
            } catch (e) {
                box.innerHTML = '<span style="color:red">失败</span>';
                alert('上传失败: ' + e.message);
            }
        }

        async function startGeneration() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt) return alert("请输入提示词");
            
            const modeSelect = document.getElementById('mode-select');
            const mode = modeSelect.value;
            const modelOption = modeSelect.options[modeSelect.selectedIndex];
            const btn = document.getElementById('btn-gen');

            const payload = {
                prompt: prompt,
                clientPoll: true,
                size: document.getElementById('ratio').value
            };

            if (modelOption.dataset.type === '9') {
                if (uploadedImages[1]) payload.image = uploadedImages[1];
                if (uploadedImages[2]) payload.image_1 = uploadedImages[2];
                if (!payload.image) return alert("图生图模式至少需要上传一张图片");
            }

            btn.disabled = true;
            btn.innerText = "提交中...";
            log('user', prompt);

            try {
                const res = await fetch('/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: mode,
                        messages: [{ role: 'user', content: JSON.stringify(payload) }]
                    })
                });

                const data = await res.json();
                if (data.error) throw new Error(data.error.message);

                const content = data.choices[0].message.content;
                const taskIdMatch = content.match(/\\[TASK_ID:(.*?)\\]/);
                
                if (!taskIdMatch) throw new Error("未获取到任务ID");
                const taskId = taskIdMatch[1];
                
                log('ai', '任务已提交，正在生成...');
                
                const pollInterval = setInterval(async () => {
                    try {
                        const pollRes = await fetch(\`/v1/tasks/query?taskId=\${taskId}\`, {
                            headers: { 'Authorization': 'Bearer ' + API_KEY }
                        });
                        const statusData = await pollRes.json();
                        
                        if (statusData.error) {
                             clearInterval(pollInterval);
                             btn.disabled = false;
                             btn.innerText = "🚀 开始生成";
                             // 移除进度条，显示错误
                             const container = document.getElementById('current-progress-container');
                             if(container) container.style.display = 'none';
                             log('error', \`生成失败: \${statusData.error}\`);
                             return;
                        }

                        // 更新进度条
                        let progress = statusData.progress;
                        let statusText = "生成中...";
                        
                        if (statusData.status === 'pending') {
                            progress = 0;
                            statusText = "排队中...";
                        } else if (progress === 99 && statusData.status !== 'completed') {
                            statusText = "处理中 (请稍候)...";
                        }

                        updateProgress(progress, statusText);
                        btn.innerText = \`生成中 \${progress}%\`;
                        
                        if (statusData.status === 'completed') {
                            clearInterval(pollInterval);
                            btn.disabled = false;
                            btn.innerText = "🚀 开始生成";
                            updateProgress(100, "完成");
                            
                            // 移除旧的进度条ID，防止冲突
                            const oldBar = document.getElementById('current-progress-bar');
                            if(oldBar) oldBar.id = '';
                            const oldContainer = document.getElementById('current-progress-container');
                            if(oldContainer) oldContainer.id = '';
                            const oldText = document.getElementById('current-status-text');
                            if(oldText) oldText.id = '';

                            const isVideo = modelOption.dataset.category === 'video';
                            log('ai', '生成完成！', statusData.url, isVideo);
                        }
                    } catch (e) {
                        console.error("Poll error", e);
                    }
                }, 3000);

            } catch (e) {
                btn.disabled = false;
                btn.innerText = "🚀 开始生成";
                log('error', \`错误: \${e.message}\`);
            }
        }

        document.addEventListener('DOMContentLoaded', function () {
            toggleUploads();
        });
    </script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
