'use strict';

/**
 * Product discovery on the Complete screen ("Explore more tools" /
 * "Explore Our Products"): destination configuration, allowlisting, the
 * secure open path, copy, markup, accessibility attributes, the screen
 * gate, and the renderer's failure handling.
 */

const fs = require('fs');
const path = require('path');
const es = require('../src/main/electron-security');
const config = require('../src/main/config');
const messages = require('../messages');
const sa = require('../screen-actions');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = read('index.html');
const renderer = read('renderer.js');
const shell = read('src/preload/compact-shell.js');
const main = read('main.js');
const preload = read('preload.js');

let failures = 0;
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

console.log('discovery-smoke: destination');
check(config.PRODUCTS_URL === 'https://botify-network.com/', `PRODUCTS_URL is the official Botify Network directory (${config.PRODUCTS_URL})`);
check(es.isAllowedExternalUrl(config.PRODUCTS_URL), 'the destination is on the external-URL allowlist');
check(es.productsPageAvailability(config.PRODUCTS_URL).available === true, 'the configured destination is reported available');
for (const bad of ['', '   ', 'http://botify-network.com/', 'https://evil.example/', 'javascript:alert(1)', 'https://user:pw@botify-network.com/', 'file:///C:/x', 'https://sub.botify-network.com/', 42, null]) {
  const r = es.productsPageAvailability(bad);
  check(r.available === false, `rejected: ${JSON.stringify(bad)} (${r.reason})`);
}

console.log('discovery-smoke: main opens it only through openExternalSafe');
check(/ipcMain\.handle\('products-page-available', \(\) => electronSecurity\.productsPageAvailability\(config\.PRODUCTS_URL\)\)/.test(main), 'availability is answered from config, no renderer input');
const openBlock = main.slice(main.indexOf("ipcMain.handle('open-products-page'"), main.indexOf("ipcMain.handle('open-products-page'") + 700);
check(/openExternalSafe\(shell\.openExternal\.bind\(shell\), config\.PRODUCTS_URL\)/.test(openBlock), 'open-products-page opens config.PRODUCTS_URL via openExternalSafe');
check(/productsPageAvailability\(config\.PRODUCTS_URL\)/.test(openBlock), 'open-products-page re-validates before opening');
check(/catch \(err\)/.test(openBlock) && /success: false/.test(openBlock) && !/showMessageBox|showErrorBox/.test(openBlock), 'a browser failure returns success:false, no dialog');
check(!/handle\('open-products-page', async \(_event, [a-z]/.test(main), 'open-products-page takes no arguments');
check(es.IPC_INVOKE_CHANNELS.includes('open-products-page') && es.IPC_INVOKE_CHANNELS.includes('products-page-available'), 'both channels are allowlisted');
check(preload.includes("ipcRenderer.invoke('open-products-page')") && preload.includes("ipcRenderer.invoke('products-page-available')"), 'preload exposes both channels');
const rendererDiscovery = renderer.slice(renderer.indexOf('function initDiscovery'), renderer.indexOf("productsBtn.addEventListener('click'") + 700);
const sectionMarkup = html.slice(html.indexOf('<section class="discovery"'), html.indexOf('</section>', html.indexOf('<section class="discovery"')));
check(!/https?:\/\//i.test(rendererDiscovery) && !/https?:\/\//i.test(sectionMarkup), 'renderer discovery code and markup carry no URL at all');

console.log('discovery-smoke: copy and markup');
check(messages.DISCOVERY.TITLE === 'Explore more tools', 'heading copy');
check(messages.DISCOVERY.BODY === 'Discover other products and tools designed to make your experience easier.', 'body copy');
check(messages.DISCOVERY.BUTTON === 'Explore Our Products', 'button copy');
check(/couldn’t open that page. Please try again\./.test(messages.DISCOVERY.FAILED), 'failure copy is human-readable');
check(messages.WIZARD.SUCCESS_TITLE === 'Complete' && messages.WIZARD.SUCCESS_SUB === 'Zoom has been fixed and is ready to use.', 'Complete headline and confirmation copy');
check(shell.includes("noticeTitle.textContent = 'Complete'") && shell.includes("'Zoom has been fixed and is ready to use.'"), 'compact shell paints the same Complete copy');
const section = html.slice(html.indexOf('<section class="discovery"'), html.indexOf('</section>', html.indexOf('<section class="discovery"')));
check(section.includes('id="discoverySection"') && section.includes(' hidden'), 'section exists and starts hidden');
check(/aria-labelledby="discoveryTitle"/.test(section) && /<h3[^>]*id="discoveryTitle">Explore more tools<\/h3>/.test(section), 'section is labelled by its heading');
check(/<button[^>]*class="btn discovery-btn"[^>]*id="productsBtn"[^>]*aria-label="Explore Our Products[^"]*"[^>]*>Explore Our Products<\/button>/.test(section), 'button is a secondary .btn with an accessible name');
check(!/btn-primary/.test(section), 'the discovery button is not a primary button (Open Zoom stays primary)');
check(/id="discoveryStatus"[^>]*role="status"[^>]*aria-live="polite"/.test(section), 'failure notice is a polite live region');
check(html.indexOf('<section class="discovery"') > html.indexOf('id="launchBtn"') && html.indexOf('<section class="discovery"') > html.indexOf('id="buttonNote"') && html.indexOf('<section class="discovery"') < html.indexOf('<section class="details-view"'), 'section sits at the end of the action area: after Open Zoom and the secondary row');
check(/\.discovery \{[^}]*border-top: 1px solid var\(--border\)/.test(html), 'a hairline divider separates it from the result');
check(/\.discovery-btn \{[^}]*min-height: 36px/.test(html), 'button meets the target size');
check(/@media \(max-height: 560px\) \{[^}]*\.discovery/.test(html) && /\.discovery-body \{ display: none; \}/.test(html), 'short windows drop the body line to stay unscrolled');
check(!/#productsBtn[^}]*box-shadow: none/.test(html), 'no rule removes the shared focus ring from the button');

console.log('discovery-smoke: only on the verified Complete screen');
check(sa.MANAGED_CONTROLS.includes('productsBtn'), 'productsBtn is a managed control');
check(sa.isAllowed('success', 'productsBtn'), 'allowed on success');
for (const s of sa.SCREENS.filter((x) => x !== 'success' && x !== 'details')) check(!sa.isAllowed(s, 'productsBtn'), `not allowed on ${s}`);
check(sa.SCREEN_CONTROLS.details.indexOf('productsBtn') === -1, 'not added by the Details overlay');
check(shell.includes("if (state !== 'success') setElementHidden(document.getElementById('discoverySection'), true);"), 'shell hides the section on every non-success state');
check(shell.includes("setElementHidden(document.getElementById('discoverySection'), document.body.dataset.productsAvailable !== 'true');"), 'shell shows it on success only when the destination is available');
check(renderer.includes("document.body.dataset.productsAvailable = 'false';") && renderer.includes('api.productsPageAvailable().then'), 'renderer defaults to unavailable and asks main');

console.log('discovery-smoke: renderer behaviour');
const rBlock = renderer.slice(renderer.indexOf("productsBtn.addEventListener('click'"), renderer.indexOf("productsBtn.addEventListener('click'") + 600);
check(/if \(productsOpening\) return;/.test(rBlock), 'a double click opens the browser once');
check(/openProductsPage\(\)/.test(rBlock) && !/openExplore|runFix|launchZoomHelper|quitApp|fixOutcome/.test(rBlock), 'the click only opens the products page (no repair, launch, quit or outcome change)');
check(/discoveryStatus\.textContent = DISCOVERY_COPY\.FAILED/.test(rBlock), 'failure shows the plain-English notice');
check(!/showNoticePane|setActions/.test(rBlock), 'failure leaves the Complete screen as it is');

if (failures) { console.error(`\ndiscovery-smoke: ${failures} FAIL`); process.exit(1); }
console.log('\ndiscovery-smoke: PASS');
