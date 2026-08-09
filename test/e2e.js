// End-to-end test: loads the unpacked extension into Chromium, points it at a
// page whose images are served cross-origin without CORS headers, and checks
// that every asset type is replaced and that Restore puts each one back.
//
//   node test/e2e.js
//
// Requires the `playwright` package and a Chromium build.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { startImageServer, startPageServer } = require('./fixtures');

const EXT_PATH = path.resolve(__dirname, '..');

/**
 * Extensions need a full Chromium, not the headless shell. Prefer an explicit
 * binary when one is available so the test doesn't depend on the installed
 * Playwright happening to match a downloaded browser revision.
 */
function chromiumPath() {
  const candidates = [process.env.IR_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

const listen = (server, port) =>
  new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));

const isReplacement = (v) => typeof v === 'string' && v.startsWith('data:image/png;base64,');

async function main() {
  const imgServer = await listen(startImageServer(), 8802);
  const imgOrigin = 'http://127.0.0.1:8802';
  const pageServer = await listen(startPageServer(imgOrigin), 8801);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-profile-'));
  const executablePath = chromiumPath();
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });

  try {
    // The service worker registers lazily.
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await page.goto('http://127.0.0.1:8801/', { waitUntil: 'load' });

    // Wait for the dynamically-inserted image and the replacement round-trips.
    await page.waitForSelector('#late', { timeout: 5000 });
    await page.waitForFunction(
      () => {
        const done = (v) => typeof v === 'string' && v.startsWith('data:image/png');
        const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundImage;
        return (
          done(document.querySelector('#plain').src) &&
          done(document.querySelector('#picimg').src) &&
          done(document.querySelector('#srcsetonly').src) &&
          done(document.querySelector('#late').src) &&
          bg('#bg').includes('data:image/png') &&
          bg('#bgmulti').includes('data:image/png')
        );
      },
      { timeout: 20000 },
    );

    console.log('\nreplacement');

    const state = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      return {
        plain: q('#plain').getAttribute('src'),
        picimg: q('#picimg').getAttribute('src'),
        picsrcSrcset: q('#picsrc').getAttribute('srcset'),
        srcsetonly: q('#srcsetonly').getAttribute('src'),
        srcsetonlySrcset: q('#srcsetonly').getAttribute('srcset'),
        inline: q('#inline').getAttribute('src'),
        bg: getComputedStyle(q('#bg')).backgroundImage,
        bgmulti: getComputedStyle(q('#bgmulti')).backgroundImage,
        poster: q('#vid').getAttribute('poster'),
        svgimg: q('#svgimg').getAttribute('href'),
        btn: q('#btn').getAttribute('src'),
        obj: q('#obj').getAttribute('data'),
        shadow: q('#host').shadowRoot.querySelector('img').getAttribute('src'),
        late: q('#late').getAttribute('src'),
        plainNatural: [q('#plain').naturalWidth, q('#plain').naturalHeight],
      };
    });

    check('<img> replaced (cross-origin, no CORS headers)', isReplacement(state.plain));
    check('<img> keeps its intrinsic size', String(state.plainNatural) === '64,48', String(state.plainNatural));
    check('<picture> <img> replaced', isReplacement(state.picimg));
    check('<picture> <source> neutralized', state.picsrcSrcset === null, String(state.picsrcSrcset));
    check('srcset-only <img> replaced', isReplacement(state.srcsetonly));
    check('srcset-only <img> srcset dropped', state.srcsetonlySrcset === null);
    check('data: <img> replaced', isReplacement(state.inline) && state.inline.length > 100);
    check('CSS background replaced', state.bg.includes('data:image/png'));
    check('multi-layer background replaced', state.bgmulti.includes('data:image/png'));
    check('multi-layer background keeps its gradient', /gradient/.test(state.bgmulti), state.bgmulti.slice(0, 80));
    check('<video poster> replaced', isReplacement(state.poster));
    check('SVG <image> replaced', isReplacement(state.svgimg));
    check('<input type=image> replaced', isReplacement(state.btn));
    check('<object> image replaced', isReplacement(state.obj));
    check('shadow DOM <img> replaced', isReplacement(state.shadow));
    check('dynamically added <img> replaced', isReplacement(state.late));

    // ---- restore, driven the way the context menu drives it ----------------
    console.log('\nrestore');

    const fireMenu = async (selector, action) => {
      // Stand in for the real right-click: the content script records the
      // composed path from the contextmenu event, exactly as it would here.
      await page.evaluate((sel) => {
        const el = sel === '#shadowimg'
          ? document.querySelector('#host').shadowRoot.querySelector('img')
          : document.querySelector(sel);
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true }));
      }, selector);
      await worker.evaluate(
        async ({ act }) => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          await chrome.tabs.sendMessage(tab.id, { type: 'ir:menu', action: act });
        },
        { act: action },
      );
      await page.waitForTimeout(150);
    };

    await fireMenu('#plain', 'restore');
    const plainAfter = await page.getAttribute('#plain', 'src');
    check('Restore returns original <img> src', plainAfter === `${imgOrigin}/a.png`, plainAfter);

    await fireMenu('#bg', 'restore');
    const bgAfter = await page.evaluate(
      () => getComputedStyle(document.querySelector('#bg')).backgroundImage,
    );
    check('Restore returns original CSS background', bgAfter.includes('/bg.png'), bgAfter);

    await fireMenu('#picimg', 'restore');
    const picAfter = await page.evaluate(() => ({
      img: document.querySelector('#picimg').getAttribute('src'),
      srcset: document.querySelector('#picsrc').getAttribute('srcset'),
    }));
    check('Restore re-arms <picture> <source>', picAfter.srcset === `${imgOrigin}/b.png`, String(picAfter.srcset));

    await fireMenu('#shadowimg', 'restore');
    const shadowAfter = await page.evaluate(
      () => document.querySelector('#host').shadowRoot.querySelector('img').getAttribute('src'),
    );
    check('Restore works inside shadow DOM', shadowAfter === `${imgOrigin}/shadow.png`, shadowAfter);

    // A restored image must stay restored -- no re-replacement race.
    await page.waitForTimeout(700);
    const stillRestored = await page.getAttribute('#plain', 'src');
    check('restored image is not re-replaced', stillRestored === `${imgOrigin}/a.png`, stillRestored);

    // ---- restore all -------------------------------------------------------
    await fireMenu('#btn', 'restore-all');
    const allRestored = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      return {
        poster: q('#vid').getAttribute('poster'),
        btn: q('#btn').getAttribute('src'),
        svgimg: q('#svgimg').getAttribute('href'),
        obj: q('#obj').getAttribute('data'),
        late: q('#late').getAttribute('src'),
        bgmulti: getComputedStyle(q('#bgmulti')).backgroundImage,
      };
    });
    check('Restore all: poster', allRestored.poster === `${imgOrigin}/poster.png`, allRestored.poster);
    check('Restore all: input image', allRestored.btn === `${imgOrigin}/btn.png`, allRestored.btn);
    check('Restore all: svg image', allRestored.svgimg === `${imgOrigin}/svg.png`, allRestored.svgimg);
    check('Restore all: object', allRestored.obj === `${imgOrigin}/obj.png`, allRestored.obj);
    check('Restore all: late image', allRestored.late === `${imgOrigin}/late.png`, allRestored.late);
    check('Restore all: multi-layer background', allRestored.bgmulti.includes('/bg2.png'), allRestored.bgmulti);

    // ---- replace again -----------------------------------------------------
    console.log('\nreplace again');
    await fireMenu('#plain', 'replace');
    await page
      .waitForFunction(
        () => document.querySelector('#plain').src.startsWith('data:image/png'),
        { timeout: 8000 },
      )
      .catch(() => {});
    const replayed = await page.getAttribute('#plain', 'src');
    check('"Replace again" re-replaces a restored image', isReplacement(replayed));

    // ---- toggle off restores, toggle on replaces --------------------------
    console.log('\ntoggle');
    await worker.evaluate(() => chrome.storage.local.set({ enabled: false }));
    await page.waitForTimeout(400);
    const offState = await page.getAttribute('#picimg', 'src');
    check('disabling restores the page', offState === `${imgOrigin}/c.png`, offState);

    await worker.evaluate(() => chrome.storage.local.set({ enabled: true }));
    await page
      .waitForFunction(
        () => document.querySelector('#picimg').src.startsWith('data:image/png'),
        { timeout: 8000 },
      )
      .catch(() => {});
    const onState = await page.getAttribute('#picimg', 'src');
    check('re-enabling replaces again', isReplacement(onState), onState);

    // ---- unreachable source still gets replaced ---------------------------
    console.log('\nunreachable sources');
    await page.evaluate((origin) => {
      const img = document.createElement('img');
      img.id = 'broken';
      img.src = `${origin}/does-not-exist.png`;
      document.body.appendChild(img);
    }, imgOrigin);
    await page
      .waitForFunction(
        () => document.querySelector('#broken')?.src.startsWith('data:image/png'),
        { timeout: 10000 },
      )
      .catch(() => {});
    const broken = await page.getAttribute('#broken', 'src');
    check('unfetchable image still replaced (synthetic fallback)', isReplacement(broken), String(broken).slice(0, 40));

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await context.close();
    imgServer.close();
    pageServer.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
