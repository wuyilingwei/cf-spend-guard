import { assertAllowed } from './allowlist.js';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const GRAPHQL_URL = `${API_BASE}/graphql`;
const TIMEOUT_MS = 20_000;

export class CloudflareApi {
  constructor({ token, accountId }) {
    if (!token) throw new Error('missing CF_API_TOKEN');
    if (!accountId) throw new Error('missing CF_ACCOUNT_ID');
    this.token = token;
    this.accountId = accountId;
  }

  async rest(path, { method = 'GET', body, headers } = {}) {
    assertAllowed(method, path);
    const res = await this.#fetch(`${API_BASE}${path}`, {
      method,
      headers: { ...this.#headers(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) {
      throw new Error(`REST ${method} ${path} failed: ${describe(json) || res.status}`);
    }
    return json.result;
  }

  /** 列取分页资源，避免只拿到第一页就当成全量。 */
  async restAll(path, { perPage = 50, max = 1000 } = {}) {
    const out = [];
    for (let page = 1; out.length < max; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const batch = await this.rest(`${path}${sep}page=${page}&per_page=${perPage}`);
      if (!Array.isArray(batch) || batch.length === 0) break;
      out.push(...batch);
      if (batch.length < perPage) break;
    }
    return out;
  }

  async graphql(query, variables) {
    const res = await this.#fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    if (json?.errors?.length) {
      throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    return json?.data?.viewer?.accounts?.[0] ?? {};
  }

  #headers() {
    return {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    };
  }

  async #fetch(url, init) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    return fetch(url, { ...init, signal });
  }
}

function describe(json) {
  const errs = json?.errors;
  if (!Array.isArray(errs) || errs.length === 0) return '';
  return errs.map((e) => e.message ?? JSON.stringify(e)).join('; ');
}
