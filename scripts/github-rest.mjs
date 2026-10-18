#!/usr/bin/env node
/** Shared fail-closed GitHub REST and GraphQL transport for release tooling. */

export const GITHUB_API_VERSION = '2026-03-10';
const API_ORIGIN = 'https://api.github.com';
const ALLOWED_HOSTS = new Set(['api.github.com', 'uploads.github.com']);

export class GitHubRestError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GitHubRestError';
    this.code = code;
  }
}

function fail(code) {
  throw new GitHubRestError(code);
}

function endpointUrl(value) {
  let url;
  try {
    url = new URL(value, API_ORIGIN);
  } catch (_) {
    fail('github-endpoint-invalid');
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password) {
    fail('github-endpoint-invalid');
  }
  return url.href;
}

export function nextLink(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 16384) fail('github-pagination-link');
  for (const part of value.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/.exec(part);
    if (!match) fail('github-pagination-link');
    if (match[2].split(/\s+/).includes('next')) return endpointUrl(match[1]);
  }
  return null;
}

export function createGitHubRestClient({ token, userAgent, fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || !token || typeof userAgent !== 'string' || !userAgent ||
      typeof fetchImpl !== 'function') fail('github-client-input');

  const headers = (accept = 'application/vnd.github+json') => ({
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'User-Agent': userAgent,
    'X-GitHub-Api-Version': GITHUB_API_VERSION
  });

  async function request(method, endpoint, options = {}) {
    const body = options.body;
    const requestHeaders = headers(options.accept);
    let requestBody;
    if (body !== undefined && body !== null) {
      if (options.jsonBody === true) {
        requestHeaders['Content-Type'] = 'application/json';
        requestBody = JSON.stringify(body);
      } else {
        requestBody = body;
      }
    }
    const response = await fetchImpl(endpointUrl(endpoint), {
      method,
      headers: requestHeaders,
      body: requestBody,
      redirect: options.followRedirects === true ? 'follow' : 'error'
    });
    if (options.allow404 === true && response.status === 404) return null;
    if (!response.ok) fail(options.errorCode || 'github-api-failed');
    return response;
  }

  async function json(method, endpoint, body, options = {}) {
    const response = await request(method, endpoint, {
      ...options,
      body,
      jsonBody: body !== undefined && body !== null
    });
    if (response === null) return null;
    try {
      return await response.json();
    } catch (_) {
      fail(options.shapeCode || 'github-json-invalid');
    }
  }

  async function bytes(endpoint, options = {}) {
    const maxBytes = Number(options.maxBytes || 0);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('github-byte-limit');
    const response = await request('GET', endpoint, {
      accept: options.accept || 'application/octet-stream',
      errorCode: options.errorCode,
      followRedirects: options.followRedirects === true
    });
    const declared = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > maxBytes) fail(options.sizeCode || 'github-body-too-large');
    const value = Buffer.from(await response.arrayBuffer());
    if (value.length > maxBytes) fail(options.sizeCode || 'github-body-too-large');
    return value;
  }

  async function paginate(endpoint, { itemKey, maxPages = 100 } = {}) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) fail('github-pagination-limit');
    const items = [];
    const visited = new Set();
    let next = endpointUrl(endpoint);
    let pages = 0;
    while (next) {
      if (visited.has(next) || pages >= maxPages) fail('github-pagination-incomplete');
      visited.add(next);
      pages++;
      const response = await request('GET', next);
      let payload;
      try {
        payload = await response.json();
      } catch (_) {
        fail('github-pagination-shape');
      }
      const page = itemKey ? payload && payload[itemKey] : payload;
      if (!Array.isArray(page)) fail('github-pagination-shape');
      items.push(...page);
      next = nextLink(response.headers.get('link'));
    }
    return { items, pages, complete: true };
  }

  async function graphql(query, variables) {
    if (typeof query !== 'string' || !query.trim() || !variables || typeof variables !== 'object') {
      fail('github-graphql-input');
    }
    const payload = await json('POST', '/graphql', { query, variables });
    if (!payload || !payload.data || (Array.isArray(payload.errors) && payload.errors.length)) {
      fail('github-graphql-failed');
    }
    return payload.data;
  }

  return Object.freeze({ request, json, bytes, paginate, graphql });
}
