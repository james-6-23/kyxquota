import type { SessionData } from './types';
import { sessionQueries } from './database';

export function generateSessionId(): string {
    return crypto.randomUUID();
}

export function getCookie(headers: Headers, name: string): string | null {
    const cookies = headers.get('cookie')?.split(';') || [];
    for (const cookie of cookies) {
        const [key, value] = cookie.trim().split('=');
        if (key === name) return value;
    }
    return null;
}

export function setCookie(
    name: string,
    value: string,
    maxAge: number = 86400
): string {
    return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

export async function getSession(sessionId: string): Promise<SessionData | null> {
    if (!sessionId) return null;

    try {
        const result = sessionQueries.get.get(sessionId, Date.now());
        if (!result) return null;

        return JSON.parse(result.data);
    } catch {
        return null;
    }
}

export async function saveSession(
    sessionId: string,
    data: SessionData,
    ttl: number = 86400000
): Promise<void> {
    const expiresAt = Date.now() + ttl;
    sessionQueries.set.run(sessionId, JSON.stringify(data), expiresAt);
}

export async function deleteSession(sessionId: string): Promise<void> {
    sessionQueries.delete.run(sessionId);
}

