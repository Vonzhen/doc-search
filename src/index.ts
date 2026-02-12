import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { checkAuth, handleLogin, AuthLevel, AUTH_COOKIE_NAME } from './auth';
import { html } from './ui';

// 定义绑定变量类型
type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  TEAM_PASSWORD: string;
  ADMIN_PASSWORD: string;
  TG_BOT_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// --------------------------------------------------------------------------
// 1. 页面与基础路由
// --------------------------------------------------------------------------

// 首页：渲染 HTML 界面
app.get('/', (c) => {
  const authLevel = checkAuth(c);
  return c.html(html(authLevel));
});

// 登录接口
app.post('/api/login', handleLogin);

// 注销接口
app.post('/api/logout', (c) => {
  deleteCookie(c, AUTH_COOKIE_NAME);
  return c.json({ success: true });
});

// --------------------------------------------------------------------------
// 2. 核心业务路由
// --------------------------------------------------------------------------

// 搜索接口 (仅限团队成员)
app.get('/api/search', async (c) => {
  if (checkAuth(c) < AuthLevel.TEAM) return c.json({ error: 'Unauthorized' }, 401);

  const query = c.req.query('q') || '';
  const term = `%${query}%`;

  // 联表查询：匹配文件名 或 标签
  const { results } = await c.env.DB.prepare(`
    SELECT DISTINCT f.* FROM files f
    LEFT JOIN file_tags ft ON f.id = ft.file_id
    WHERE f.filename LIKE ? OR ft.tag LIKE ?
    ORDER BY f.created_at DESC
    LIMIT 50
  `).bind(term, term).all();

  return c.json(results);
});

// 下载/预览接口 (集成 Cache API 加速 🔥)
app.get('/api/file/:id', async (c) => {
  const urlToken = c.req.query('token');
  let isAuth = false;

  // 方式 A: 检查 Cookie (网页端)
  if (checkAuth(c) >= AuthLevel.TEAM) {
    isAuth = true;
  } 
  // 方式 B: 检查 URL 参数 (Telegram/外部链接)
  else if (urlToken === c.env.TEAM_PASSWORD) {
    isAuth = true;
  }

  if (!isAuth) return c.text('Unauthorized', 401);

  // --- 🔥 Cache API 逻辑开始 🔥 ---
  // 使用 Cloudflare 默认缓存
  const cache = caches.default;
  // 使用当前请求的完整 URL 作为缓存键
  const cacheKey = c.req.url;

  // 1. 先尝试从缓存获取
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    console.log(`Cache Hit for ${cacheKey}`); // 调试日志：命中缓存
    // 构造新响应以保留原有 Header (有时候 Response body 是一次性的，clone 是个好习惯)
    return new Response(cachedResponse.body, cachedResponse);
  }
  // --- Cache API 逻辑结束 (部分1) ---

  const id = c.req.param('id');
  
  // 2. 查数据库获取 R2 Key
  const file = await c.env.DB.prepare('SELECT r2_key, filename, size FROM files WHERE id = ?').bind(id).first();
  if (!file) return c.notFound();

  // 3. 从 R2 获取文件流
  const object = await c.env.BUCKET.get(file.r2_key as string);
  if (!object) return c.notFound();

  // 4. 构造响应头
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // 使用文件自带的真实 Content-Type，没有则默认为流
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename as string)}"`);
  
  // 🔥 设置缓存规则：
  // public: 允许 Cloudflare CDN 缓存
  // max-age=14400: 缓存 4 小时 (4 * 60 * 60 秒)
  headers.set('Cache-Control', 'public, max-age=14400');

  const response = new Response(object.body, {
    headers,
  });

  // --- 🔥 Cache API 逻辑开始 (部分2) 🔥 ---
  // 5. 将响应写入缓存 (异步执行，不阻塞用户下载)
  // 注意：必须使用 c.executionCtx.waitUntil，否则 Worker 结束时缓存可能还没写完
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  // --- Cache API 逻辑结束 ---

  return response;
});

// 上传接口 (仅限管理员，支持所有文件类型)
app.post('/api/upload', async (c) => {
  if (checkAuth(c) < AuthLevel.ADMIN) return c.json({ error: 'Admin only' }, 403);

  const formData = await c.req.parseBody();
  const file = formData['file'];
  const tagsStr = formData['tags'] as string;

  if (!(file instanceof File)) return c.json({ error: 'Invalid file' }, 400);

  const fileId = crypto.randomUUID();
  // 去掉 .pdf 后缀强制绑定，使用原始文件扩展名或无后缀，完全靠 Content-Type 识别
  // 这里直接用 UUID 作为 R2 Key，避免文件名冲突
  const r2Key = fileId; 

  // A. 写入 R2 (记录真实 Content-Type)
  await c.env.BUCKET.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type }
  });

  // B. 写入 D1
  const tags = tagsStr.split(/\s+/).filter(t => t.length > 0);
  
  const batch = [
    c.env.DB.prepare('INSERT INTO files (id, filename, r2_key, size, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(fileId, file.name, r2Key, file.size, Date.now())
  ];

  for (const tag of tags) {
    batch.push(
      c.env.DB.prepare('INSERT OR IGNORE INTO file_tags (file_id, tag) VALUES (?, ?)')
      .bind(fileId, tag.toLowerCase())
    );
  }

  await c.env.DB.batch(batch);

  return c.json({ success: true });
});

// 删除接口 (仅限管理员，修复了标签残留问题)
app.delete('/api/file/:id', async (c) => {
  if (checkAuth(c) < AuthLevel.ADMIN) return c.json({ error: 'Admin only' }, 403);
  
  const id = c.req.param('id');
  const file = await c.env.DB.prepare('SELECT r2_key FROM files WHERE id = ?').bind(id).first();
  
  if (file) {
    // 1. 删除 R2 对象
    await c.env.BUCKET.delete(file.r2_key as string);
    // 2. 删除关联标签
    await c.env.DB.prepare('DELETE FROM file_tags WHERE file_id = ?').bind(id).run();
    // 3. 删除文件记录
    await c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
  }
  
  return c.json({ success: true });
});

// --------------------------------------------------------------------------
// 3. Telegram 机器人 Webhook
// --------------------------------------------------------------------------

app.post('/api/telegram', async (c) => {
  try {
    const update = await c.req.json();
    const message = update.message;

    // 只处理文本消息
    if (!message || !message.text) return c.json({ ok: true });

    const chatId = message.chat.id;
    const text = message.text.trim();
    
    // 执行搜索
    const term = `%${text}%`;
    const { results } = await c.env.DB.prepare(`
      SELECT DISTINCT f.id, f.filename, f.size FROM files f
      LEFT JOIN file_tags ft ON f.id = ft.file_id
      WHERE f.filename LIKE ? OR ft.tag LIKE ?
      ORDER BY f.created_at DESC
      LIMIT 10
    `).bind(term, term).all();

    // 构造回复
    let replyText = '';
    if (results.length === 0) {
      replyText = `🔍 未找到关于 "<b>${text}</b>" 的文件。`;
    } else {
      replyText = `📂 找到 ${results.length} 个文件：\n\n`;
      const host = new URL(c.req.url).origin;
      
      // @ts-ignore
      for (const file of results) {
        // 生成免登录链接 (带 Token)
        const downloadLink = `${host}/api/file/${file.id}?token=${c.env.TEAM_PASSWORD}`;
        const sizeMB = (file.size / 1024 / 1024).toFixed(2);
        
        replyText += `📄 <b>${file.filename}</b> (${sizeMB} MB)\n`;
        replyText += `🔗 <a href="${downloadLink}">点击查看/下载</a>\n\n`;
      }
    }

    // 调用 Telegram API 发送消息
    await fetch(`https://api.telegram.org/bot${c.env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: replyText,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    return c.json({ ok: true });
  } catch (e) {
    console.error('Telegram Webhook Error:', e);
    return c.json({ ok: false }, 500);
  }
});

// --------------------------------------------------------------------------
// 4. 导出应用 (必须!)
// --------------------------------------------------------------------------
export default app;
