'use strict';

// Behaviour test for the optional build-time proxy path of electron-builder's
// Electron download: app-builder-lib -> @electron/get 3 -> global-agent.
// @electron/get calls global-agent bootstrap() when ELECTRON_GET_USE_PROXY is
// set, and silently skips the proxy if global-agent fails to load. This test
// runs the real @electron/get in child processes (bootstrap is process-global)
// against loopback servers only:
//   - proxy disabled leaves the Node globals alone and goes direct
//   - HTTP through the proxy, redirects, NO_PROXY, error propagation
//   - checksum rejection
//   - HTTPS CONNECT with a trusted per-request CA, an untrusted chain and a
//     wrong host name
// The HTTPS origin uses a non-localhost name that only the proxy resolves.
// Node checks an unnamed TLS socket against "localhost", so a localhost-only
// origin could pass the identity check by accident. The CA and server keys are
// generated in memory for this run and never written to disk. No TLS check,
// assertion or time limit may be relaxed to make this test pass.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NAME = 'mirror.l7.test';
const OTHER_NAME = 'other.l7.test';
const REFUSED_NAME = 'refused.l7.test';
// @electron/get validates checksums only for Electron >= 1.3.2.
const VERSION = '30.0.0';
// The default artifact name: @electron/get keys the checksum by it.
const FILE = `electron-v${VERSION}-win32-x64.zip`;
const CHILD_TIMEOUT_MS = 30000;

function loadElectronGet() {
  const builder = path.dirname(require.resolve('app-builder-lib/package.json', { paths: [ROOT] }));
  return require(require.resolve('@electron/get', { paths: [builder] }));
}

// ---- child: one download in a fresh process --------------------------------
if (process.argv[2] === '--child') {
  const job = JSON.parse(process.env.L7_PROXY_SMOKE_JOB);
  const out = { ok: false };
  (async () => {
    try {
      const get = loadElectronGet();
      const file = await get.downloadArtifact({
        version: VERSION,
        artifactName: 'electron',
        platform: 'win32',
        arch: 'x64',
        mirrorOptions: { mirror: job.mirror, customDir: job.dir },
        checksums: { [FILE]: job.sha256 },
        cacheRoot: job.cacheRoot,
        downloadOptions: Object.assign({ retry: 0, timeout: 10000 }, job.ca ? { https: { certificateAuthority: job.ca } } : {})
      });
      out.ok = true;
      out.sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch (error) {
      out.error = { name: error && error.name, code: error && error.code, message: String(error && error.message).slice(0, 240) };
    }
    out.globalAgent = typeof global.GLOBAL_AGENT;
    out.httpAgent = http.globalAgent.constructor.name;
    out.httpsAgent = https.globalAgent.constructor.name;
    process.stdout.write(JSON.stringify(out));
  })();
  return;
}

// ---- minimal DER / X.509 for a throwaway CA and server certificate ---------
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const ctx = (n, body) => tlv(0xa0 + n, body);
const octet = (body) => tlv(0x04, body);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
function int(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from([buf]);
  return tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}
function oid(text) {
  const p = text.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const chunk = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift(0x80 | (x & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
const utcTime = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const name = (cn) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octet(value));

function certificate({ subject, issuer, publicKey, signingKey, serial, extensions }) {
  const now = Date.now();
  const tbs = seq(
    ctx(0, int(2)), int(serial), ECDSA_SHA256, name(issuer),
    seq(utcTime(new Date(now - 3600e3)), utcTime(new Date(now + 3600e3))),
    name(subject), publicKey.export({ type: 'spki', format: 'der' }),
    ctx(3, seq(...extensions))
  );
  const signature = crypto.sign('sha256', tbs, signingKey);
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

function makePki() {
  const caKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const leafKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const caPem = certificate({
    subject: 'L7 proxy smoke CA', issuer: 'L7 proxy smoke CA', publicKey: caKeys.publicKey,
    signingKey: caKeys.privateKey, serial: crypto.randomBytes(8),
    extensions: [
      ext('2.5.29.19', true, seq(bool(true))),
      ext('2.5.29.15', true, tlv(0x03, Buffer.from([0x01, 0x06])))
    ]
  });
  const san = seq(tlv(0x82, Buffer.from(NAME)), tlv(0x82, Buffer.from('localhost')));
  const leafPem = certificate({
    subject: NAME, issuer: 'L7 proxy smoke CA', publicKey: leafKeys.publicKey,
    signingKey: caKeys.privateKey, serial: crypto.randomBytes(8),
    extensions: [
      ext('2.5.29.19', true, seq()),
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      ext('2.5.29.17', false, san)
    ]
  });
  return { caPem, leafPem, leafKey: leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

// ---- loopback servers --------------------------------------------------------
const BODY = crypto.randomBytes(4096);
const BODY_SHA = crypto.createHash('sha256').update(BODY).digest('hex');

function origin(req, res) {
  const url = new URL(req.url, 'http://origin');
  if (url.pathname === `/v${VERSION}/${FILE}`) { res.writeHead(200, { 'content-length': BODY.length }); res.end(BODY); return; }
  if (url.pathname === `/redirect/${FILE}`) { res.writeHead(302, { location: `/v${VERSION}/${FILE}` }); res.end(); return; }
  res.writeHead(404); res.end('missing');
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function startServers(pki) {
  const seen = [];
  const httpOrigin = http.createServer(origin);
  const httpsOrigin = https.createServer({ cert: pki.leafPem, key: pki.leafKey }, origin);
  const ports = { http: await listen(httpOrigin), https: await listen(httpsOrigin) };
  const proxy = http.createServer((req, res) => {
    seen.push({ method: req.method, target: req.url });
    const target = new URL(req.url);
    if (target.hostname !== NAME) { res.writeHead(502); res.end(); return; }
    const upstream = http.request({ host: '127.0.0.1', port: ports.http, path: target.pathname, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  proxy.on('connect', (req, socket, head) => {
    seen.push({ method: 'CONNECT', target: req.url });
    const host = req.url.split(':')[0];
    if (host === REFUSED_NAME || (host !== NAME && host !== OTHER_NAME)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = net.connect(ports.https, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  ports.proxy = await listen(proxy);
  const closed = net.createServer();
  ports.closed = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  return { ports, seen, close: () => Promise.all([httpOrigin, httpsOrigin, proxy].map((s) => new Promise((r) => { s.closeAllConnections && s.closeAllConnections(); s.close(r); }))) };
}

// ---- runner ------------------------------------------------------------------
let failures = 0;
function check(cond, label, detail) {
  if (cond) { console.log(`  ok  ${label}`); }
  else {
    console.error(`FAIL  ${label}${detail ? ` :: ${JSON.stringify(detail)}` : ''}`);
    failures++;
    // Set now: if the event loop drains before the summary, Node must still exit non-zero.
    process.exitCode = 1;
  }
}

const PROXY_ENV = ['ELECTRON_GET_USE_PROXY', 'GLOBAL_AGENT_HTTP_PROXY', 'GLOBAL_AGENT_HTTPS_PROXY', 'GLOBAL_AGENT_NO_PROXY',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'ELECTRON_MIRROR', 'ELECTRON_CUSTOM_DIR', 'ELECTRON_CUSTOM_FILENAME'];

function runChild(job, extraEnv) {
  const env = Object.assign({}, process.env);
  for (const key of PROXY_ENV) delete env[key];
  for (const key of Object.keys(env)) if (/^(npm_config_|ELECTRON_)/i.test(key)) delete env[key];
  Object.assign(env, extraEnv, {
    ELECTRON_GET_NO_PROGRESS: '1',
    L7_PROXY_SMOKE_JOB: JSON.stringify(Object.assign({ sha256: BODY_SHA, dir: `v${VERSION}` }, job, { cacheRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'l7-proxy-smoke-')) }))
  });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, '--child'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { resolve(Object.assign(JSON.parse(stdout), { exit: code })); }
      catch { resolve({ ok: false, exit: code, error: { message: `child output unreadable: ${stderr.slice(0, 200)}` } }); }
    });
  });
}

const CERT_REJECTIONS = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT']);

(async () => {
  const pki = makePki();
  const s = await startServers(pki);
  const proxyUrl = `http://127.0.0.1:${s.ports.proxy}`;
  const viaProxy = (before) => s.seen.slice(before);
  const useHttpProxy = { ELECTRON_GET_USE_PROXY: '1', GLOBAL_AGENT_HTTP_PROXY: proxyUrl };
  const useHttpsProxy = { ELECTRON_GET_USE_PROXY: '1', GLOBAL_AGENT_HTTPS_PROXY: proxyUrl };
  try {
    const ga = require(require.resolve('global-agent/package.json', { paths: [path.dirname(require.resolve('app-builder-lib/package.json', { paths: [ROOT] }))] }));
    console.log(`electron-get proxy smoke: global-agent ${ga.version}, node ${process.version}`);

    let n = s.seen.length;
    let r = await runChild({ mirror: `http://127.0.0.1:${s.ports.http}/` }, { GLOBAL_AGENT_HTTP_PROXY: proxyUrl });
    check(r.ok && r.sha256 === BODY_SHA, 'proxy disabled: direct download succeeds', r);
    check(r.globalAgent === 'undefined' && r.httpAgent === 'Agent' && r.httpsAgent === 'Agent', 'proxy disabled: Node globals untouched', r);
    check(viaProxy(n).length === 0, 'proxy disabled: proxy never contacted', viaProxy(n));

    n = s.seen.length;
    r = await runChild({ mirror: `http://${NAME}/` }, useHttpProxy);
    check(r.ok && r.sha256 === BODY_SHA, 'HTTP via proxy: download succeeds with matching bytes', r);
    check(r.globalAgent === 'object', 'HTTP via proxy: global-agent bootstrapped (not silently skipped)', r);
    check(viaProxy(n).some((x) => x.method === 'GET' && x.target === `http://${NAME}/v${VERSION}/${FILE}`), 'HTTP via proxy: proxy saw the absolute request URL', viaProxy(n));

    n = s.seen.length;
    r = await runChild({ mirror: `http://${NAME}/`, dir: 'redirect' }, useHttpProxy);
    check(r.ok && r.sha256 === BODY_SHA, 'HTTP via proxy: redirect followed', r);
    check(viaProxy(n).filter((x) => x.method === 'GET').length === 2, 'HTTP via proxy: both redirect hops used the proxy', viaProxy(n));

    n = s.seen.length;
    r = await runChild({ mirror: `http://localhost:${s.ports.http}/` }, Object.assign({ GLOBAL_AGENT_NO_PROXY: 'localhost' }, useHttpProxy));
    check(r.ok && r.sha256 === BODY_SHA, 'NO_PROXY: matching host downloads directly', r);
    check(viaProxy(n).length === 0, 'NO_PROXY: proxy never contacted', viaProxy(n));

    r = await runChild({ mirror: `http://${NAME}/`, dir: 'missing' }, useHttpProxy);
    check(!r.ok && r.error && r.error.name === 'HTTPError' && /404/.test(r.error.message), 'error propagation: origin 404 rejects', r);

    r = await runChild({ mirror: `http://${NAME}/` }, { ELECTRON_GET_USE_PROXY: '1', GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${s.ports.closed}` });
    check(!r.ok && r.error && r.error.code === 'ECONNREFUSED', 'error propagation: unreachable proxy rejects', r);

    r = await runChild({ mirror: `http://${NAME}/`, sha256: 'f'.repeat(64) }, useHttpProxy);
    check(!r.ok && r.error && /checksum/i.test(r.error.message), 'checksum: mismatched bytes are rejected', r);

    r = await runChild({ mirror: `https://localhost:${s.ports.https}/`, ca: pki.caPem }, {});
    check(r.ok && r.sha256 === BODY_SHA, 'HTTPS direct (control): trusted per-request CA succeeds', r);

    n = s.seen.length;
    r = await runChild({ mirror: `https://${NAME}/`, ca: pki.caPem }, useHttpsProxy);
    check(r.ok && r.sha256 === BODY_SHA, 'HTTPS CONNECT: trusted per-request CA and exact host name succeed', r);
    check(viaProxy(n).some((x) => x.method === 'CONNECT' && x.target === `${NAME}:443`), 'HTTPS CONNECT: proxy saw the tunnel request', viaProxy(n));

    r = await runChild({ mirror: `https://${NAME}/` }, useHttpsProxy);
    check(!r.ok && r.error && CERT_REJECTIONS.has(r.error.code), 'HTTPS CONNECT: untrusted chain is rejected', r);

    r = await runChild({ mirror: `https://${OTHER_NAME}/`, ca: pki.caPem }, useHttpsProxy);
    check(!r.ok && r.error && r.error.code === 'ERR_TLS_CERT_ALTNAME_INVALID', 'HTTPS CONNECT: wrong host name is rejected', r);

    // Process-wide trust isolates host-name verification from per-request CA handling.
    const caFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l7-proxy-smoke-ca-')), 'ca.pem');
    fs.writeFileSync(caFile, pki.caPem);
    const globalTrust = { NODE_EXTRA_CA_CERTS: caFile };
    r = await runChild({ mirror: `https://${NAME}/` }, Object.assign({}, useHttpsProxy, globalTrust));
    check(r.ok && r.sha256 === BODY_SHA, 'HTTPS CONNECT + process trust: exact host name succeeds', r);
    r = await runChild({ mirror: `https://${OTHER_NAME}/` }, Object.assign({}, useHttpsProxy, globalTrust));
    check(!r.ok && r.error && r.error.code === 'ERR_TLS_CERT_ALTNAME_INVALID', 'HTTPS CONNECT + process trust: wrong host name is rejected', r);

    // global-agent 3 starts TLS over the refusal and fails closed with a reset; 4 reports the
    // status line. Either is a rejection; a download must never succeed.
    r = await runChild({ mirror: `https://${REFUSED_NAME}/`, ca: pki.caPem }, useHttpsProxy);
    check(!r.ok && r.error && (/refused|403/i.test(r.error.message) || r.error.code === 'ECONNRESET'), 'HTTPS CONNECT: proxy refusal rejects', r);
  } finally {
    await Promise.race([s.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  if (failures) { console.error(`\nelectron-get proxy smoke: ${failures} failure(s)`); process.exit(1); }
  console.log('\nelectron-get proxy smoke: all checks passed');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
