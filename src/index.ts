import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie'; // <--- 新增导入
import { checkAuth, handleLogin, AuthLevel, AUTH_COOKIE_NAME } from './auth'; // <--- 新增导入 AUTH_COOKIE_NAME
import { html } from './ui';

type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  TEAM_PASSWORD: string;
  ADMIN_PASSWORD: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// 1. 首页
app.get('/', (c) => {
  const authLevel = checkAuth(c);
  return c.html(html(authLevel));
});

// 2. 登录
app.post('/api/login', handleLogin);

// NEW: 3. 注销 (新增接口)
app.post('/api/logout', (c) => {
  deleteCookie(c, AUTH_COOKIE_NAME);
  return c.json({ success: true });
});

// 4. 搜索
app.get('/api/search', async (c) => {
  if (checkAuth(c) < AuthLevel.TEAM) return c.json({ error: 'Unauthorized' }, 401);

  const query = c.req.query('q') || '';
  const term = `%${query}%`;

  const { results } = await c.env.DB.prepare(`
    SELECT DISTINCT f.* FROM files f
    LEFT JOIN file_tags ft ON f.id = ft.file_id
    WHERE f.filename LIKE ? OR ft.tag LIKE ?
    ORDER BY f.created_at DESC
    LIMIT 50
  `).bind(term, term).all();

  return c.json(results);
});

// 5. 下载/预览
app.get('/api/file/:id', async (c) => {
  if (checkAuth(c) < AuthLevel.TEAM) return c.text('Unauthorized', 401);

  const id = c.req.param('id');
  const file = await c.env.DB.prepare('SELECT r2_key, filename, size FROM files WHERE id = ?').bind(id).first();

  if (!file) return c.notFound();

  const object = await c.env.BUCKET.get(file.r2_key as string);
  if (!object) return c.notFound();

  c.header('Content-Type', 'application/pdf');
  c.header('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename as string)}"`);

  return c.body(object.body);
});

// 6. 上传
app.post('/api/upload', async (c) => {
  if (checkAuth(c) < AuthLevel.ADMIN) return c.json({ error: 'Admin only' }, 403);

  const formData = await c.req.parseBody();
  const file = formData['file'];
  const tagsStr = formData['tags'] as string;

  if (!(file instanceof File)) return c.json({ error: 'Invalid file' }, 400);

  const fileId = crypto.randomUUID();
  const r2Key = `${fileId}.pdf`;

  await c.env.BUCKET.put(r2Key, file.stream(), {
    httpMetadata: { contentType: 'application/pdf' }
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

// 7. 删除
app.delete('/api/file/:id', async (c) => {
  if (checkAuth(c) < AuthLevel.ADMIN) return c.json({ error: 'Admin only' }, 403);
  
  const id = c.req.param('id');
  const file = await c.env.DB.prepare('SELECT r2_key FROM files WHERE id = ?').bind(id).first();
  
  if (file) {
    await c.env.BUCKET.delete(file.r2_key as string);
    await c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
  }
  
  return c.json({ success: true });
});

export default app;
