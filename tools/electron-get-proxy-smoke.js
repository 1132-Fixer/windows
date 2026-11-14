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
// generated in memory. Private keys never reach disk; a public CA fixture is
// written only inside this run's temporary directory for child-only trust.
// Nothing is installed into Windows or the parent process trust configuration.
// No TLS check, assertion or time limit may be relaxed to make this test pass.
// Source preserved from PR239 head6872f1b4b343c2c9c2d002130a40d1a9a88c18ec,
// blobc280531ddd4dc0ff215ce56cd6b26ca14c744ff6. Harness confinement below
// limits sockets/DNS to this run's loopback fixtures and strips credentials.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
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
const CHILD_CLOSE_TIMEOUT_MS = 5000;
const OUTPUT_LIMIT = 64 * 1024;
const activeChildren = new Set();
let fixtureRoot = null;
let fixturePorts = null;

function confinedChildNetwork(job) {
  const allowedPorts = new Set(Object.values(job.fixturePorts || {}));
  if (allowedPorts.size !== 4 || [...allowedPorts].some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid fixture ports');
  const mirror = new URL(job.mirror);
  if (!['http:', 'https:'].includes(mirror.protocol) || mirror.username || mirror.password || mirror.hash || mirror.pathname !== '/' || mirror.search) throw new Error('Invalid fixture mirror');
  if (['localhost', '127.0.0.1'].includes(mirror.hostname)) {
    const expected = mirror.protocol === 'https:' ? job.fixturePorts.https : job.fixturePorts.http;
    if (Number(mirror.port) !== expected) throw new Error('Mirror escaped fixture port');
  } else if (![NAME, OTHER_NAME, REFUSED_NAME].includes(mirror.hostname) || mirror.port) throw new Error('Mirror escaped fixture names');
  for (const key of ['GLOBAL_AGENT_HTTP_PROXY', 'GLOBAL_AGENT_HTTPS_PROXY']) {
    if (!process.env[key]) continue;
    const proxy = new URL(process.env[key]);
    if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash || ![job.fixturePorts.proxy, job.fixturePorts.closed].includes(Number(proxy.port))) throw new Error('Proxy escaped fixture');
  }
  const cache = fs.realpathSync(job.cacheRoot), root = fs.realpathSync(job.fixtureRoot);
  const relative = path.relative(root, cache);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) || fs.lstatSync(cache).isSymbolicLink()) throw new Error('Cache escaped owned fixture');
  // Guard the actual socket boundary too: a default-mirror fallback or a
  // silently skipped proxy must fail before DNS or a non-loopback connection.
  const socketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = first && typeof first === 'object' ? first : { port:first, host:typeof args[1] === 'string' ? args[1] : 'localhost' };
    const host = String(options.host || options.hostname || 'localhost').toLowerCase();
    if (!['127.0.0.1', '::1', 'localhost'].includes(host) || !allowedPorts.has(Number(options.port)) || options.path) throw Object.assign(new Error('Non-fixture socket refused'), {code:'ERR_FIXTURE_NETWORK'});
    return socketConnect.apply(this, args);
  };
  dns.lookup = (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const complete = typeof callback === 'function' ? callback : () => {};
    queueMicrotask(() => {
      if (String(hostname).toLowerCase() !== 'localhost') return complete(Object.assign(new Error('Non-fixture DNS refused'), {code:'ERR_FIXTURE_NETWORK'}));
      if (options && options.all) complete(null, [{address:'127.0.0.1',family:4}]);
      else complete(null, '127.0.0.1', 4);
    });
  };
}

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
      confinedChildNetwork(job);
      const get = loadElectronGet();
      const file = await get.downloadArtifact({
        version: VERSION,
        artifactName: 'electron',
        platform: 'win32',
        arch: 'x64',
        mirrorOptions: { mirror: job.mirror, customDir: job.dir },
        checksums: { [FILE]: job.sha256 },
        cacheRoot: job.cacheRoot,
        // @electron/get 3.1.0's GotDownloader arms a referenced 30s progress
        // timer when (!quiet || !ELECTRON_GET_NO_PROGRESS). Rejection skips
        // its success-only clearTimeout, so NO_PROGRESS alone kept failed
        // fixture children alive until our deadline. Select the intended
        // noninteractive API mode with BOTH settings, retaining every error
        // assertion and deadline. This does not repair the vendor's default
        // progress/error timer lifecycle. Official source: electron/get
        // v3.1.0 src/GotDownloader.ts, blob d67c3c4c48c5f79c5d6cfb5ffb3d472b3d273031.
        downloadOptions: Object.assign({ quiet: true, retry: 0, timeout: 10000 }, job.ca ? { https: { certificateAuthority: job.ca } } : {})
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

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
});

async function startServers(pki) {
  const seen = [];
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const httpOrigin = http.createServer(origin);
  const httpsOrigin = https.createServer({ cert: pki.leafPem, key: pki.leafKey }, origin);
  httpOrigin.on('connection', track); httpsOrigin.on('connection', track);
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
    track(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  proxy.on('connection', track);
  ports.proxy = await listen(proxy);
  const closed = net.createServer();
  ports.closed = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  return { ports, seen, async close() {
    for (const socket of sockets) socket.destroy();
    let timer;
    try {
      await Promise.race([
        Promise.all([httpOrigin, httpsOrigin, proxy].map(server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Fixture server close unverified')), 2000); })
      ]);
    } finally { clearTimeout(timer); }
  } };
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

// A dependency test child never needs GitHub/cloud credentials, inherited
// proxy settings, Node hooks or a machine-wide trust override.
const CHILD_ENV_KEYS = new Set(['systemroot', 'windir', 'path', 'pathext']);
const EXTRA_ENV_KEYS = new Set(['ELECTRON_GET_USE_PROXY', 'GLOBAL_AGENT_HTTP_PROXY',
  'GLOBAL_AGENT_HTTPS_PROXY', 'GLOBAL_AGENT_NO_PROXY', 'NODE_EXTRA_CA_CERTS']);
function runChild(job, extraEnv) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (CHILD_ENV_KEYS.has(key.toLowerCase())) env[key] = value;
  }
  env.TEMP = fixtureRoot; env.TMP = fixtureRoot;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (!EXTRA_ENV_KEYS.has(key)) throw new Error('Unexpected fixture environment input');
    env[key] = value;
  }
  const cacheRoot = fs.mkdtempSync(path.join(fixtureRoot, 'cache-'));
  Object.assign(env, {
    ELECTRON_GET_NO_PROGRESS: '1',
    L7_PROXY_SMOKE_JOB: JSON.stringify(Object.assign({ sha256:BODY_SHA, dir:'v' + VERSION }, job,
      { cacheRoot, fixtureRoot, fixturePorts }))
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--child'], {
      env, shell:false, windowsHide:true, stdio:['ignore', 'pipe', 'pipe']
    });
    activeChildren.add(child);
    let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0;
    let killed = false, completed = false, closeTimer, inputFailure = null;
    const requestStop = reason => {
      if (killed) return;
      killed = true; inputFailure = reason;
      try { child.kill(); } catch (_) { /* Close still must be observed. */ }
      closeTimer = setTimeout(() => {
        if (!completed) {
          // Keep the child handle and temporary root: an outer owned-process
          // supervisor must reconcile this failed fixture; no PID replay.
          completed = true;
          reject(new Error('Owned fixture child termination is unverified'));
        }
      }, CHILD_CLOSE_TIMEOUT_MS);
    };
    const timer = setTimeout(() => requestStop('fixture child timed out'), CHILD_TIMEOUT_MS);
    child.stdout.on('data', bytes => {
      stdoutBytes += bytes.length;
      if (stdoutBytes > OUTPUT_LIMIT) requestStop('fixture stdout exceeded bound');
      else stdout += bytes.toString('utf8');
    });
    child.stderr.on('data', bytes => {
      stderrBytes += bytes.length;
      if (stderrBytes > OUTPUT_LIMIT) requestStop('fixture stderr exceeded bound');
      else stderr += bytes.toString('utf8');
    });
    child.once('error', () => requestStop('fixture child launch failed'));
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(closeTimer); activeChildren.delete(child);
      if (completed) return;
      completed = true;
      if (inputFailure) return resolve({ok:false, exit:code, error:{code:'ERR_FIXTURE_CHILD', message:inputFailure}});
      try { resolve(Object.assign(JSON.parse(stdout), {exit:code})); }
      catch { resolve({ok:false, exit:code, error:{code:'ERR_FIXTURE_OUTPUT', message:'child output unreadable: ' + stderr.slice(0,200)}}); }
    });
  });
}

const CERT_REJECTIONS = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT']);

(async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), '1132-electron-get-proxy-'));
  const physicalRoot = fs.realpathSync(fixtureRoot);
  if (path.resolve(physicalRoot).toLowerCase() !== path.resolve(fixtureRoot).toLowerCase() || fs.lstatSync(fixtureRoot).isSymbolicLink()) throw new Error('Owned fixture root identity unverified');
  const pki = makePki();
  const s = await startServers(pki);
  fixturePorts = Object.freeze({...s.ports});
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
    const caFile = path.join(fixtureRoot, 'public-ca-fixture.pem');
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
    await s.close();
    if (activeChildren.size) throw new Error('Owned fixture child remains; temporary evidence retained');
    // Resolve the absolute target again before recursive removal; it must be
    // this exact newly created fixture root, with no link substitution.
    if (fs.realpathSync(fixtureRoot) !== physicalRoot || fs.lstatSync(fixtureRoot).isSymbolicLink()) throw new Error('Fixture cleanup target changed');
    fs.rmSync(physicalRoot, {recursive:true, force:false});
  }
  if (failures) { console.error(`\nelectron-get proxy smoke: ${failures} failure(s)`); process.exitCode = 1; }
  else console.log('\nelectron-get proxy smoke: all checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
