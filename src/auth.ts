import { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

export const AUTH_COOKIE_NAME = 'doc_auth';

// 权限等级定义
export enum AuthLevel {
  GUEST = 0,
  TEAM = 1,
  ADMIN = 2
}

// 验证当前用户的权限等级
export const checkAuth = (c: Context): AuthLevel => {
  const token = getCookie(c, AUTH_COOKIE_NAME);
  
  // 简单起见，Cookie 直接存明文 hash 或特定字符串
  // 真实生产环境建议加密，但作为内部工具，这样足够且方便
  if (token === c.env.ADMIN_PASSWORD) return AuthLevel.ADMIN;
  if (token === c.env.TEAM_PASSWORD) return AuthLevel.TEAM;
  
  return AuthLevel.GUEST;
};

// 登录处理
export const handleLogin = async (c: Context) => {
  const { password } = await c.req.json();
  
  if (password === c.env.ADMIN_PASSWORD) {
    setCookie(c, AUTH_COOKIE_NAME, c.env.ADMIN_PASSWORD, { path: '/', maxAge: 86400 * 30, httpOnly: true, secure: true });
    return c.json({ success: true, level: 'admin' });
  }
  
  if (password === c.env.TEAM_PASSWORD) {
    setCookie(c, AUTH_COOKIE_NAME, c.env.TEAM_PASSWORD, { path: '/', maxAge: 86400 * 30, httpOnly: true, secure: true });
    return c.json({ success: true, level: 'team' });
  }

  return c.json({ success: false, error: '口令错误' }, 401);
};
