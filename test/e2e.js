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

// The fast pass's fallback placeholder is itself a data:image/png URL, so
// "starts with data:image/png" does NOT mean the mosaic has landed. Read the
// constant out of the source so the two passes can be told apart for real.
const BLANK_PIXEL = fs
  .readFileSync(path.join(__dirname, '..', 'src', 'content', 'blank.js'), 'utf8')
  .match(/'(data:image\/png;base64,[^']+)'/)[1];

const isMosaic = (v) =>
  typeof v === 'string' && v.startsWith('data:image/png;base64,') && v !== BLANK_PIXEL;

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

    // ---- default off -------------------------------------------------------
    // Nothing is replaced until a site is opted in, so this has to be checked
    // before anything switches the test site on.
    console.log('\ndefault off');

    const cold = await context.newPage();
    await cold.goto('http://127.0.0.1:8801/', { waitUntil: 'load' });
    await cold.waitForTimeout(1200);

    const untouched = await cold.evaluate(() => ({
      plain: document.querySelector('#plain').getAttribute('src'),
      bg: getComputedStyle(document.querySelector('#bg')).backgroundImage,
    }));
    check('images are untouched on a site that is not opted in', untouched.plain === `${imgOrigin}/a.png`, untouched.plain);
    check('backgrounds are untouched too', untouched.bg.includes('/bg.png'), untouched.bg.slice(0, 60));

    const coldBadge = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.action.getBadgeText({ tabId: tab.id });
    });
    check('toolbar badge is empty when off', coldBadge === '', `"${coldBadge}"`);

    // Switching on via the real context-menu handler. A menu item can't be
    // clicked programmatically, so this calls the handler Chrome would call.
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await globalThis.ImageReplacerBackground.handleMenuClick(
        { menuItemId: globalThis.ImageReplacerMenus.ID.site },
        tab,
      );
    });

    await cold
      .waitForFunction(
        (pixel) => {
          const v = document.querySelector('#plain').src;
          return v.startsWith('data:image/') && v !== pixel;
        },
        BLANK_PIXEL,
        { timeout: 10000 },
      )
      .catch(() => {});
    const afterOptIn = await cold.getAttribute('#plain', 'src');
    check(
      '"Always Replace Images from this site" switches the site on',
      afterOptIn !== `${imgOrigin}/a.png` && afterOptIn.startsWith('data:image/'),
      afterOptIn.slice(0, 40),
    );

    const storedSites = await worker.evaluate(() => globalThis.ImageReplacerSites.allowedSites());
    check('the site is remembered by hostname', storedSites['127.0.0.1'] === true, JSON.stringify(storedSites));

    const warmBadge = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return {
        badge: await chrome.action.getBadgeText({ tabId: tab.id }),
        title: await chrome.action.getTitle({ tabId: tab.id }),
      };
    });
    check('toolbar badge marks the tab as active', warmBadge.badge === 'ON', `"${warmBadge.badge}"`);
    check('toolbar title names the site', warmBadge.title.includes('127.0.0.1'), warmBadge.title);

    const menuState = await worker.evaluate(() => globalThis.ImageReplacerMenus.state());
    check('site menu item is checked once opted in', menuState.siteChecked === true, JSON.stringify(menuState));

    await cold.close();

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    // Only the page's own network shows up here -- the background context's
    // fetches do not -- so this tells us whether the page ever loaded an
    // original.
    const pageRequests = [];
    page.on('request', (r) => pageRequests.push(r.url()));

    await page.goto('http://127.0.0.1:8801/', { waitUntil: 'load' });

    // ---- fast pass ---------------------------------------------------------
    // Read before the slow images finish; their responses are held open
    // server-side so the blank is still in place.
    console.log('\nfast pass');

    const fast = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      return {
        slow: q('#slowimg').getAttribute('src'),
        slowNatural: [q('#slowimg').naturalWidth, q('#slowimg').naturalHeight],
        slowBox: [Math.round(q('#slowimg').getBoundingClientRect().width),
                  Math.round(q('#slowimg').getBoundingClientRect().height)],
        nodim: q('#slownodim').getAttribute('src'),
        nodimNatural: [q('#slownodim').naturalWidth, q('#slownodim').naturalHeight],
      };
    });

    check('fast pass replaces before any mosaic exists', fast.slow.startsWith('data:image/svg+xml'), fast.slow.slice(0, 48));
    check(
      'blank declares the original size',
      decodeURIComponent(fast.slow).includes('width="120"') &&
        decodeURIComponent(fast.slow).includes('height="80"'),
      decodeURIComponent(fast.slow),
    );
    check('blank has the original intrinsic size', String(fast.slowNatural) === '120,80', String(fast.slowNatural));
    check('blank preserves the layout box', String(fast.slowBox) === '120,80', String(fast.slowBox));
    check(
      'undimensioned image falls back to a 1x1 pixel',
      fast.nodim.startsWith('data:image/png') && fast.nodim.length < 200,
      `${fast.nodim.slice(0, 32)} (len ${fast.nodim.length})`,
    );

    const maxAlpha = await page.evaluate(async () => {
      const img = document.querySelector('#slowimg');
      await img.decode().catch(() => {});
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 16, 16);
      ctx.drawImage(img, 0, 0, 16, 16);
      const { data } = ctx.getImageData(0, 0, 16, 16);
      let max = 0;
      for (let i = 3; i < data.length; i += 4) max = Math.max(max, data[i]);
      return max;
    });
    check('blank is fully transparent', maxAlpha === 0, `max alpha ${maxAlpha}`);

    // The browser's preload scanner starts fetching images while the HTML is
    // still being parsed -- before the element is in the DOM, so before any
    // content script can see it. The request going out is therefore expected;
    // what the fast pass guarantees is that the response is never displayed.
    // #slownodim's original is 140x70, so an intrinsic 1x1 proves the element
    // is showing the placeholder and not the original.
    check(
      'blanked original is never displayed',
      String(fast.nodimNatural) === '1,1',
      `intrinsic ${fast.nodimNatural} (original is 140x70)`,
    );
    if (pageRequests.some((u) => u.includes('/slow.png'))) {
      console.log('  note the preload scanner did request the original, as expected');
    }

    // Restore has a snapshot from before the fast pass, so it works even though
    // no mosaic has been produced for this element yet.
    await page.evaluate(() =>
      document
        .querySelector('#slowrestore')
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true })),
    );
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(tab.id, { type: 'ir:menu', action: 'restore' });
    });
    await page.waitForTimeout(150);
    const restoredWhileBlank = await page.getAttribute('#slowrestore', 'src');
    check(
      'Restore works during the blank, before any mosaic',
      restoredWhileBlank === `${imgOrigin}/slow.png?ms=6000`,
      restoredWhileBlank,
    );

    // Wait for the dynamically-inserted image and the replacement round-trips.
    await page.waitForSelector('#late', { timeout: 5000 });
    await page.waitForFunction(
      (pixel) => {
        const done = (v) =>
          typeof v === 'string' && v.startsWith('data:image/png;base64,') && v !== pixel;
        const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundImage;
        const bgDone = (sel) => bg(sel).includes('data:image/png') && !bg(sel).includes(pixel);
        return (
          done(document.querySelector('#plain').src) &&
          done(document.querySelector('#picimg').src) &&
          done(document.querySelector('#srcsetonly').src) &&
          done(document.querySelector('#late').src) &&
          bgDone('#bg') &&
          bgDone('#bgmulti')
        );
      },
      BLANK_PIXEL,
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

    check('<img> replaced (cross-origin, no CORS headers)', isMosaic(state.plain));
    check('<img> keeps its intrinsic size', String(state.plainNatural) === '64,48', String(state.plainNatural));
    check('<picture> <img> replaced', isMosaic(state.picimg));
    check('<picture> <source> neutralized', state.picsrcSrcset === null, String(state.picsrcSrcset));
    check('srcset-only <img> replaced', isMosaic(state.srcsetonly));
    check('srcset-only <img> srcset dropped', state.srcsetonlySrcset === null);
    check('data: <img> replaced', isMosaic(state.inline));
    check('CSS background replaced', state.bg.includes('data:image/png') && !state.bg.includes(BLANK_PIXEL), state.bg.slice(0, 60));
    check('multi-layer background replaced', state.bgmulti.includes('data:image/png') && !state.bgmulti.includes(BLANK_PIXEL));
    check('multi-layer background keeps its gradient', /gradient/.test(state.bgmulti), state.bgmulti.slice(0, 80));
    check('<video poster> replaced', isMosaic(state.poster));
    check('SVG <image> replaced', isMosaic(state.svgimg));
    check('<input type=image> replaced', isMosaic(state.btn));
    check('<object> image replaced', isMosaic(state.obj));
    check('shadow DOM <img> replaced', isMosaic(state.shadow));
    check('dynamically added <img> replaced', isMosaic(state.late));

    // ---- slow pass upgrades the blank -------------------------------------
    console.log('\nslow pass');

    await page.waitForFunction(
      (pixel) => {
        const done = (v) => v.startsWith('data:image/png;base64,') && v !== pixel;
        return done(document.querySelector('#slowimg').src) &&
          done(document.querySelector('#slownodim').src);
      },
      BLANK_PIXEL,
      { timeout: 20000 },
    );

    const upgraded = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      return {
        slow: q('#slowimg').getAttribute('src'),
        slowNatural: [q('#slowimg').naturalWidth, q('#slowimg').naturalHeight],
        nodimNatural: [q('#slownodim').naturalWidth, q('#slownodim').naturalHeight],
      };
    });

    check('slow pass upgrades the blank to a mosaic', isMosaic(upgraded.slow));
    check('mosaic keeps the intrinsic size', String(upgraded.slowNatural) === '120,80', String(upgraded.slowNatural));
    check(
      'mosaic corrects the size the blank could not know',
      String(upgraded.nodimNatural) === '140,70',
      String(upgraded.nodimNatural),
    );
    check(
      'a restored asset is not upgraded by an in-flight slow pass',
      (await page.getAttribute('#slowrestore', 'src')) === `${imgOrigin}/slow.png?ms=6000`,
      await page.getAttribute('#slowrestore', 'src'),
    );

    // ---- menu item state follows the pointer -------------------------------
    console.log('\nmenu state');

    const hover = async (selector) => {
      await page.evaluate((sel) => {
        document
          .querySelector(sel)
          .dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
      }, selector);
      await page.waitForTimeout(150);
      return worker.evaluate(() => globalThis.ImageReplacerMenus.state());
    };

    const overImage = await hover('#plain');
    check('Restore is enabled over a replaced image', overImage.restore === true, JSON.stringify(overImage));

    const overNothing = await hover('#plainbox');
    check('Restore is disabled over a plain element', overNothing.restore === false, JSON.stringify(overNothing));
    check(
      'Restore all stays enabled while the page has replacements',
      overNothing.restoreAll === true,
      JSON.stringify(overNothing),
    );

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
        (pixel) => {
          const v = document.querySelector('#plain').src;
          return v.startsWith('data:image/png;base64,') && v !== pixel;
        },
        BLANK_PIXEL,
        { timeout: 8000 },
      )
      .catch(() => {});
    const replayed = await page.getAttribute('#plain', 'src');
    check('"Replace again" re-replaces a restored image', isMosaic(replayed));

    // ---- switching the site off restores, back on replaces -----------------
    console.log('\nsite toggle');
    await worker.evaluate(() =>
      globalThis.ImageReplacerSites.setAllowed('127.0.0.1', false),
    );
    await page.waitForTimeout(400);
    const offState = await page.getAttribute('#picimg', 'src');
    check('switching the site off restores the page', offState === `${imgOrigin}/c.png`, offState);

    const offBadge = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.action.getBadgeText({ tabId: tab.id });
    });
    check('badge clears when the site is switched off', offBadge === '', `"${offBadge}"`);

    await worker.evaluate(() => globalThis.ImageReplacerSites.setAllowed('127.0.0.1', true));
    await page
      .waitForFunction(
        (pixel) => {
          const v = document.querySelector('#picimg').src;
          return v.startsWith('data:image/png;base64,') && v !== pixel;
        },
        BLANK_PIXEL,
        { timeout: 8000 },
      )
      .catch(() => {});
    const onState = await page.getAttribute('#picimg', 'src');
    check('switching it back on replaces again', isMosaic(onState), onState);

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
        (pixel) => {
          const v = document.querySelector('#broken')?.src || '';
          return v.startsWith('data:image/png;base64,') && v !== pixel;
        },
        BLANK_PIXEL,
        { timeout: 10000 },
      )
      .catch(() => {});
    const broken = await page.getAttribute('#broken', 'src');
    check('unfetchable image still replaced (synthetic fallback)', isMosaic(broken), String(broken).slice(0, 40));

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
