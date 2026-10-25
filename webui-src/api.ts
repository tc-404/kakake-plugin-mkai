export type HostFetch = typeof fetch;

export interface ApiResult<T = unknown> {
  code: number;
  data?: T;
  message?: string;
}

export interface MkaiApiClient {
  get: <T = unknown>(path: string, query?: Record<string, string | number | undefined>, init?: RequestInit) => Promise<ApiResult<T>>;
  post: <T = unknown>(path: string, body?: unknown, init?: RequestInit) => Promise<ApiResult<T>>;
  base: string;
}

export function createApi(apiBase: string, hostFetch: HostFetch): MkaiApiClient {
  const base = apiBase.replace(/\/$/, '') + '/mkai';

  async function parse<T>(res: Response): Promise<ApiResult<T>> {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? ` - ${text}` : ''}`);
    }
    return (await res.json()) as ApiResult<T>;
  }

  return {
    base,
    async get(path, query, init) {
      const qs = new URLSearchParams();
      if (query) {
        for (const [k, v] of Object.entries(query)) {
          if (v === undefined || v === '') continue;
          qs.set(k, String(v));
        }
      }
      const q = qs.toString();
      const url = base + path + (q ? `?${q}` : '');
      return parse(await hostFetch(url, { credentials: 'include', ...init }));
    },
    async post(path, body, init) {
      return parse(
        await hostFetch(base + path, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
          body: JSON.stringify(body ?? {}),
          ...init,
        }),
      );
    },
  };
}

/** 侧栏一级导航（无内嵌 Tab）；overview 为默认概览首页 */
export type ViewId = 'overview' | 'model' | 'policy' | 'skills' | 'rotation' | 'blacklist' | 'sessions' | 'switch' | 'voice';
