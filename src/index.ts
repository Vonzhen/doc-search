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

app.get('/', (c) => {
  const authLevel = checkAuth(c);
  return c.html(html(authLevel));
});

app.post('/api/login', handleLogin);

app.post('/api/logout', (c) => {
  deleteCookie(c, AUTH_COOKIE_NAME);
  return c.json({ success: true });
});

// --------------------------------------------------------------------------
// 2. 核心业务路由
// --------------------------------------------------------------------------

app.get('/api/search', async (c) => {
  if (checkAuth(c) < AuthLevel.TEAM) return c.json({ error: 'Unauthorized' }, 401);

  const query = c.req.query('q') || '';
  const term = `%${query}%`;

  // [工程修复] 使用子查询聚合标签，确保前端能接收到完整的 tags 数组用于展示和编辑
  const { results } = await c.env.DB.prepare(`
    SELECT 
      f.id, f.filename, f.size, f.created_at,
      (SELECT GROUP_CONCAT(tag) FROM file_tags WHERE file_id = f.id) as tags_str
    FROM files f
    WHERE f.filename LIKE ? OR EXISTS (
      SELECT 1 FROM file_tags WHERE file_id = f.id AND tag LIKE ?
    )
    ORDER BY f.created_at DESC
    LIMIT 50
  `).bind(term, term).all();

  // 格式化输出，将逗号分隔的字符串转为数组
  const formattedResults = results.map(row => ({
    ...row,
    tags: row.tags_str ? (row.tags_str as string).split(',') : []
  }));

  return c.json(formattedResults);
});

app.get('/api/file/:id', async (c) => {
  const urlToken = c.req.query('token');
  let isAuth = false;

  if (checkAuth(c) >= AuthLevel.TEAM) {
    isAuth = true;
  } else if (urlToken === c.env.TEAM_PASSWORD) {
    isAuth = true;
  }

  if (!isAuth) return c.text('Unauthorized', 401);

  const cache = caches.default;
  const cacheKey = c.req.url;

  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    console.log(`Cache Hit for ${cacheKey}`);
    return new Response(cachedResponse.body, cachedResponse);
  }

  const id = c.req.param('id');
  const file = await c.env.DB.prepare('SELECT r2_key, filename, size FROM files WHERE id = ?').bind(id).first();
  if (!file) return c.notFound();

  const object = await c.env.BUCKET.get(file.r2_key as string);
  if (!object) return c.notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename as string)}"`);
  headers.set('Cache-Control', 'public, max-age=14400');

  const response = new Response(object.body, { headers });
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
});

app.post('/api/upload', async (c) => {
  if (checkAuth(c) < AuthLevel.ADMIN) return c.json({ error: 'Admin only' }, 403);

  const formData = await c.req.parseBody();
  const file = formData['file'];
  const tagsStr = formData['tags'] as string;

  if (!(file instanceof File)) return c.json({ error: 'Invalid file' }, 400);

  const fileId = crypto.randomUUID();
  const r2Key = fileId; 

  await c.env.BUCKET.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type }
  });

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

// [新增] 独立更新标签接口 (全量覆盖模式)
app.patch('/api/file/:id/tags', async (c) => {
  if (checkAuth(c) < AuthLevel.ADMIN) return c.json({ error: 'Admin only' }, 403);

  const id = c.req.param('id');
  
  try {
    const body = await c.req.json();
    const tagsArray = body.tags;

    if (!Array.isArray(tagsArray)) {
      return c.json({ error: 'Invalid tags payload' }, 400);
    }

    // 校验文件记录是否存在
    const file = await c.env.DB.prepare('SELECT id FROM files WHERE id = ?').bind(id).first();
    if (!file) return c.json({ error: 'File not found' }, 404);

    // 标准化标签数据
    const sanitizedTags = tagsArray.map(t => String(t).trim().toLowerCase()).filter(t => t.length > 0);

    // 开启事务流：清空旧标签 -> 写入新标签
    const batch = [];
    batch.push(c.env.DB.prepare('DELETE FROM file_tags WHERE file_id = ?').bind(id));

    for (const tag of sanitizedTags) {
      batch.push(
        c.env.DB.prepare('INSERT OR IGNORE INTO file_tags (file_id, tag) VALUES (?, ?)')
        .bind(id, tag)
      );
    }

    await c.env.DB.batch(batch);

    return c.json({ success: true, tags: sanitizedTags });
  } catch (e) {
    console.error('Update tags error:', e);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.delete('/api/file/:id', async (c) => {
  if (checkAuth(c) < AuthLevel.ADMIN) return c.json({ error: 'Admin only' }, 403);
  
  const id = c.req.param('id');
  const file = await c.env.DB.prepare('SELECT r2_key FROM files WHERE id = ?').bind(id).first();
  
  if (file) {
    await c.env.BUCKET.delete(file.r2_key as string);
    await c.env.DB.prepare('DELETE FROM file_tags WHERE file_id = ?').bind(id).run();
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

    if (!message || !message.text) return c.json({ ok: true });

    const chatId = message.chat.id;
    const text = message.text.trim();
    
    const term = `%${text}%`;
    const { results } = await c.env.DB.prepare(`
      SELECT DISTINCT f.id, f.filename, f.size FROM files f
      LEFT JOIN file_tags ft ON f.id = ft.file_id
      WHERE f.filename LIKE ? OR ft.tag LIKE ?
      ORDER BY f.created_at DESC
      LIMIT 10
    `).bind(term, term).all();

    let replyText = '';
    if (results.length === 0) {
      replyText = `🔍 未找到关于 "<b>${text}</b>" 的文件。`;
    } else {
      replyText = `📂 找到 ${results.length} 个文件：\n\n`;
      const host = new URL(c.req.url).origin;
      
      // @ts-ignore
      for (const file of results) {
        const downloadLink = `${host}/api/file/${file.id}?token=${c.env.TEAM_PASSWORD}`;
        const sizeMB = (file.size / 1024 / 1024).toFixed(2);
        
        replyText += `📄 <b>${file.filename}</b> (${sizeMB} MB)\n`;
        replyText += `🔗 <a href="${downloadLink}">点击查看/下载</a>\n\n`;
      }
    }

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

export default app;
