// Release-only readiness check. The desktop app never runs this request.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { endpointUrl } = require('../src/main/support-client');

export async function verifySupportEndpoint(value, fetchImpl = fetch) {
  const endpoint = endpointUrl(value);
  if (!endpoint) throw new Error('A valid public HTTPS support endpoint is required.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(new URL('/health', endpoint), {
      signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('The support service is not ready.');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > 16384) { await reader.cancel(); throw new Error('The support response is invalid.'); }
      chunks.push(Buffer.from(chunk));
    }
    const state = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (state.ok !== true || state.service !== '1132-fixer-support' || state.configured !== true ||
        state.capabilities?.feedback !== true || state.capabilities?.statelessFeedback !== true) {
      throw new Error('The verified stateless support service is required.');
    }
  } catch (_) {
    // Do not log URLs, response bodies or connection errors: configuration
    // may contain private data when supplied incorrectly.
    throw new Error('Support readiness verification failed. Check the public endpoint and service configuration.');
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifySupportEndpoint(process.env.FEEDBACK_PROXY_URL).then(() => {
    console.log('[release] Verified stateless support service is ready.');
  }).catch((error) => { console.error('[release] ' + error.message); process.exitCode = 1; });
}
