import { Hono } from 'hono';
import { checkAuth, handleLogin, AuthLevel } from './auth';
import { html } from './ui';

type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  TEAM_PASSWORD: string;
  ADMIN_PASSWORD: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// 1. 首页 (渲染 UI)
app.get('/', (c) => {
  const authLevel = checkAuth(c);
  // 将权限等级注入到前端 HTML 中，控制 UI 显示
  return c.html(html(authLevel));
});

// 2. 登录接口
app.post('/api/login', handleLogin);

// 3. 搜索接口 (需 Team 权限)
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

// 4. 下载/预览文件 (需 Team 权限)
app.get('/api/file/:id', async (c) => {
  if (checkAuth(c) < AuthLevel.TEAM) return c.text('Unauthorized', 401);

  const id = c.req.param('id');
  const file = await c.env.DB.prepare('SELECT r2_key, filename, size FROM files WHERE id = ?').bind(id).first();

  if (!file) return c.notFound();

  const object = await c.env.BUCKET.get(file.r2_key as string);
  if (!object) return c.notFound();

  // 设置 header 以便浏览器直接预览 PDF
  c.header('Content-Type', 'application/pdf');
  c.header('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename as string)}"`);

  return c.body(object.body);
});

// 5. 上传文件 (需 Admin 权限)
app.post('/api/upload', async (c) => {
  if (checkAuth(c) < AuthLevel.ADMIN) return c.json({ error: 'Admin only' }, 403);

  const formData = await c.req.parseBody();
  const file = formData['file'];
  const tagsStr = formData['tags'] as string;

  if (!(file instanceof File)) return c.json({ error: 'Invalid file' }, 400);

  const fileId = crypto.randomUUID();
  const r2Key = `${fileId}.pdf`;

  // A. 写入 R2
  await c.env.BUCKET.put(r2Key, file.stream(), {
    httpMetadata: { contentType: 'application/pdf' }
  });

  // B. 写入 D1
  const tags = tagsStr.split(/\s+/).filter(t => t.length > 0); // 按空格分割标签
  
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

// 6. 删除文件 (需 Admin 权限)
app.delete('/api/file/:id', async (c) => {
  if (checkAuth(c) < AuthLevel.ADMIN) return c.json({ error: 'Admin only' }, 403);
  
  const id = c.req.param('id');
  const file = await c.env.DB.prepare('SELECT r2_key FROM files WHERE id = ?').bind(id).first();
  
  if (file) {
    // 删除 R2 对象
    await c.env.BUCKET.delete(file.r2_key as string);
    // 级联删除 D1 (file_tags 会自动删除)
    await c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
  }
  
  return c.json({ success: true });
});

export default app;
