// =================================================================================
//  项目: mindvideo-2api (Cloudflare Worker 单文件全功能版)
//  版本: 3.2.0 (代号: Chimera Synthesis - Visual Progress)
//  作者: 首席开发者体验架构师
//  日期: 2025-11-22
//
//  [更新日志 v3.2.0]
//  1. [UI] 新增实时进度条 (Progress Bar) 和状态文本显示。
//  2. [Fix] 修复了 99% 进度卡死的问题，优化了完成状态的判断逻辑。
//  3. [Fix] 错误信息现在会直接显示上游返回的中文提示 (如: 人数过多)。
//  4. [Model] 校准了模型名称显示，支持双图上传 (图生图)。
// =================================================================================

// --- [第一部分: 核心配置] ---
const CONFIG = {
  PROJECT_NAME: "mindvideo-2api",
  PROJECT_VERSION: "3.2.0",
  
  // --- 安全配置 ---
  // ⚠️ 请在 Cloudflare 环境变量中设置 API_MASTER_KEY，或者修改此处
  API_MASTER_KEY: "1", 
  
  // --- MindVideo 凭证 ---
  // 自动填充您提供的最新 Token
  AUTH_TOKENS: [
    "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJodHRwczovL2FwaS5taW5kdmlkZW8uYWkvYXBpL3JlZnJlc2giLCJpYXQiOjE3NjEwMzU1NDcsImV4cCI6MTc2Mzc1NjM2MywibmJmIjoxNzYzNzQ5MTYzLCJqdGkiOiJnNzVTU2ZsMjBURDR0VE9KIiwic3ViIjoiMjcyNjA2IiwicHJ2IjoiMjNiZDVjODk0OWY2MDBhZGIzOWU3MDFjNDAwODcyZGI3YTU5NzZmNyIsInVpZCI6MjcyNjA2LCJlbWFpbCI6InExMzY0NTk0NzQwN0BnbWFpbC5jb20iLCJpc05ldyI6dHJ1ZX0.5mm2xNi2BA98N8nhhbklqoiKveJVmkylZMHRL3o3wjQ"
  ],
  
  // 签名密钥 (固定值)
  SIGN_APP_KEY: "s#c_120*AB",

  // --- 上游配置 ---
  UPSTREAM_API: "https://api.mindvideo.ai/api/v2",
  
  // --- 模型定义 ---
  MODELS: {
    "sora-2-free": { id: 153, type: 1, category: "video", name: "Sora-2 Video (文生视频)" },
    "gemini-3-image": { id: 190, type: 8, category: "image", name: "Gemini-3 Pro (文生图)" },
    "gemini-3-i2i": { id: 191, type: 9, category: "image", name: "Gemini-3 I2I (图生图)" }
  },
  DEFAULT_MODEL: "sora-2-free",
};

// --- [第二部分: Worker 入口] ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;

    // 1. 静态资源与 WebUI
    if (url.pathname === '/') return handleUI(request, apiKey);
    
    // 2. API 接口
    if (url.pathname === '/v1/chat/completions') return handleChatCompletions(request, apiKey, ctx);
    if (url.pathname === '/v1/images/generations') return handleImageGenerations(request, apiKey, ctx);
    if (url.pathname === '/v1/models') return handleModels(request);

    // 3. 辅助接口
    if (url.pathname === '/v1/tasks/query') return handleTaskQuery(request, apiKey);
    if (url.pathname === '/proxy/upload/sign') return handleUploadSign(request, apiKey);
    if (url.pathname === '/proxy/upload/file') return handleUploadFile(request, apiKey);

    // 4. CORS
    if (request.method === 'OPTIONS') return handleCors();

    return createError(404, "Not Found", "path_not_found");
  }
};

// --- [第三部分: 核心业务逻辑] ---

/**
 * 签名生成器 (i-sign)
 */
async function generateSign() {
  const nonce = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
  const timestamp = Date.now();
  const signStr = `nonce=${nonce}&timestamp=${timestamp}&app_key=${CONFIG.SIGN_APP_KEY}`;
  const sign = await md5(signStr);

  return JSON.stringify({
    nonce: nonce,
    timestamp: timestamp,
    sign: sign
  });
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
 * 获取请求头
 */
async function getHeaders(token) {
  return {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "authorization": `Bearer ${token}`,
    "i-lang": "zh-CN",
    "i-sign": await generateSign(),
    "i-version": "1.0.8",
    "origin": "https://www.mindvideo.ai",
    "referer": "https://www.mindvideo.ai/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
  };
}

/**
 * 提交任务
 */
async function submitTask(modelKey, prompt, options = {}) {
  const modelConfig = CONFIG.MODELS[modelKey] || CONFIG.MODELS[CONFIG.DEFAULT_MODEL];
  // 随机选择 Token 实现轮询
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
    throw new Error(`Upstream returned non-JSON: ${text.substring(0, 100)}`);
  }

  if (data.code !== 0 || !data.data?.id) {
    // 捕获 "未授权" 或其他业务错误
    throw new Error(`Upstream Error: ${data.message || JSON.stringify(data)}`);
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
    // 优先从 results 获取，其次从 cover_url
    if (task.results && task.results.length > 0) {
      resultUrl = task.results[0].result_url || task.results[0].cover_url;
    }
    if (!resultUrl && task.cover_url) resultUrl = task.cover_url;
  }

  // 提取具体的错误信息
  let errorMsg = null;
  if (task.task_status === 'failed') {
    errorMsg = task.task_remark || "Unknown error";
    // 尝试提取更友好的错误提示
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
  if (!checkAuth(req, apiKey)) return createError(401, "Unauthorized", "auth_error");
  
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

  // 1. 提交任务
  let taskInfo;
  try {
    taskInfo = await submitTask(model, prompt, options);
  } catch (e) {
    return createError(500, e.message, "upstream_error");
  }

  // 2. WebUI 模式
  if (options.clientPoll) {
    const resp = {
      id: `chatcmpl-${taskInfo.taskId}`,
      object: "chat.completion",
      created: Date.now(),
      model: model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: `[TASK_ID:${taskInfo.taskId}]` },
        finish_reason: "stop"
      }]
    };
    return new Response(JSON.stringify(resp), { headers: corsHeaders() });
  }

  // 3. API 模式 (流式轮询)
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  ctx.waitUntil((async () => {
    try {
      if (stream) await sendSSE(writer, encoder, "🚀 任务已提交，正在处理...");

      const startTime = Date.now();
      while (Date.now() - startTime < 600000) { // 10分钟超时
        const pollRes = await pollTask(taskInfo.taskId, taskInfo.token);
        
        if (pollRes.status === 'completed') {
          const markdown = `\n\n![Generated Content](${pollRes.url})`;
          if (stream) {
            await sendSSE(writer, encoder, markdown);
            await writer.write(encoder.encode("data: [DONE]\n\n"));
          }
          break;
        } else if (pollRes.status === 'failed') {
          throw new Error(pollRes.error);
        } else {
          if (stream) await sendSSE(writer, encoder, `⏳ 进度: ${pollRes.progress}%`);
          await new Promise(r => setTimeout(r, 5000)); // 5秒轮询
        }
      }
    } catch (e) {
      if (stream) {
        await sendSSE(writer, encoder, `\n\n❌ 错误: ${e.message}`);
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      }
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
  const model = CONFIG.MODELS["gemini-3-image"] ? "gemini-3-image" : CONFIG.DEFAULT_MODEL;
  
  try {
    const { taskId, token } = await submitTask(model, body.prompt);
    
    // 阻塞轮询 (仅建议测试用)
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
      created: Date.now(),
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

function handleModels() {
  const data = Object.keys(CONFIG.MODELS).map(id => ({ id, object: "model", name: CONFIG.MODELS[id].name }));
  return new Response(JSON.stringify({ object: "list", data }), { headers: corsHeaders() });
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
                <option value="sora-2-free">🎬 Sora-2 Video (文生视频)</option>
                <option value="gemini-3-image">🎨 Gemini-3 Pro (文生图)</option>
                <option value="gemini-3-i2i">🖼️ Gemini-3 I2I (图生图)</option>
            </select>
            
            <div id="video-opts">
                <label style="font-size:12px">比例</label>
                <select id="ratio">
                    <option value="1280x720">16:9 (横屏)</option>
                    <option value="720x1280">9:16 (竖屏)</option>
                </select>
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
            const mode = document.getElementById('mode-select').value;
            document.getElementById('upload-opts').style.display = mode === 'gemini-3-i2i' ? 'block' : 'none';
            document.getElementById('video-opts').style.display = mode === 'sora-2-free' ? 'block' : 'none';
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
            
            const mode = document.getElementById('mode-select').value;
            const btn = document.getElementById('btn-gen');
            
            const payload = {
                prompt: prompt,
                clientPoll: true,
                size: document.getElementById('ratio').value
            };

            if (mode === 'gemini-3-i2i') {
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

                            const isVideo = mode === 'sora-2-free';
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
    </script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
