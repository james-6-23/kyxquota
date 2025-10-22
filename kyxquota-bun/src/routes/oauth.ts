import { Hono } from 'hono';
import { CONFIG } from '../config';
import { generateSessionId, saveSession, setCookie } from '../utils';

const app = new Hono();

/**
 * 交换 OAuth2 code 获取 token
 */
async function exchangeCodeForToken(code: string): Promise<any> {
    console.log('[OAuth] Exchanging code for token...');
    const response = await fetch(CONFIG.LINUX_DO_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: CONFIG.LINUX_DO_CLIENT_ID,
            client_secret: CONFIG.LINUX_DO_CLIENT_SECRET,
            code: code,
            redirect_uri: CONFIG.LINUX_DO_REDIRECT_URI,
            grant_type: 'authorization_code',
        }),
    });

    const data = await response.json();
    console.log('[OAuth] Token response:', {
        status: response.status,
        hasToken: !!data.access_token,
    });

    if (!response.ok || !data.access_token) {
        console.error('[OAuth] Token error:', data);
        throw new Error(
            `Token exchange failed: ${data.error || data.error_description || 'Unknown error'}`
        );
    }

    return data;
}

/**
 * 获取 Linux Do 用户信息
 */
async function getLinuxDoUserInfo(accessToken: string): Promise<any> {
    console.log('[OAuth] Fetching user info...');
    const response = await fetch(CONFIG.LINUX_DO_USER_INFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = await response.json();
    console.log('[OAuth] User info response:', {
        status: response.status,
        hasId: !!data.id,
    });

    if (!response.ok || !data.id) {
        console.error('[OAuth] User info error:', data);
        throw new Error('Failed to fetch user info');
    }

    return data;
}

/**
 * OAuth2 回调处理
 */
app.get('/callback', async (c) => {
    const code = c.req.query('code');
    const error = c.req.query('error');

    if (error) {
        console.error('[OAuth] Error from provider:', error);
        return c.html(
            `
      <!DOCTYPE html>
      <html><body>
        <h1>登录失败</h1>
        <p>OAuth 认证失败: ${error}</p>
        <a href="/">返回首页</a>
      </body></html>
      `,
            400
        );
    }

    if (!code) {
        return c.text('Missing code', 400);
    }

    try {
        console.log('[OAuth] Starting callback process...');
        const tokenData = await exchangeCodeForToken(code);
        const userInfo = await getLinuxDoUserInfo(tokenData.access_token);

        console.log('[OAuth] User authenticated:', userInfo.username);

        const sessionId = generateSessionId();
        await saveSession(sessionId, {
            linux_do_id: userInfo.id.toString(),
            username: userInfo.username,
            avatar_url: userInfo.avatar_template?.replace('{size}', '120') || '',
            name: userInfo.name || userInfo.username,
        });

        // 重定向到首页，并设置 Cookie
        return c.redirect('/', 302, {
            'Set-Cookie': setCookie('session_id', sessionId),
        });
    } catch (e: any) {
        console.error('[OAuth] Callback failed:', e);
        return c.html(
            `
      <!DOCTYPE html>
      <html><body>
        <h1>登录失败</h1>
        <p>错误详情: ${e.message}</p>
        <p>请检查环境变量配置是否正确</p>
        <ul>
          <li>LINUX_DO_CLIENT_ID</li>
          <li>LINUX_DO_CLIENT_SECRET</li>
          <li>LINUX_DO_REDIRECT_URI</li>
        </ul>
        <a href="/">返回首页</a>
      </body></html>
      `,
            500
        );
    }
});

export default app;

