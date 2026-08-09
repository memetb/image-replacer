// Minimal PNG encoder + the two servers the e2e test runs against.
//
// Images are served from a *different* port than the page and with no
// Access-Control-Allow-Origin header. That is the case a page-context fetch
// cannot read, and the reason replacement happens in the service worker.

const http = require('http');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Solid-ish RGBA PNG with a little variation so palette extraction has input. */
function makePng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[p++] = (r + x * 3) % 256;
      raw[p++] = (g + y * 3) % 256;
      raw[p++] = (b + ((x + y) * 2)) % 256;
      raw[p++] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TINY_PNG_DATA_URL =
  'data:image/png;base64,' + makePng(8, 8, [200, 40, 40]).toString('base64');

function startImageServer() {
  const server = http.createServer((req, res) => {
    const name = req.url.split('?')[0];
    const sizes = {
      '/a.png': [64, 48, [220, 30, 30]],
      '/b.png': [96, 72, [30, 200, 60]],
      '/c.png': [48, 48, [40, 60, 220]],
      '/wide.png': [200, 50, [240, 190, 20]],
      '/poster.png': [160, 90, [120, 20, 180]],
      '/bg.png': [100, 100, [20, 180, 190]],
      '/bg2.png': [60, 60, [180, 90, 20]],
      '/svg.png': [70, 70, [90, 90, 90]],
      '/btn.png': [40, 40, [10, 10, 10]],
      '/shadow.png': [50, 50, [200, 120, 200]],
      '/late.png': [80, 80, [60, 160, 90]],
      '/obj.png': [55, 55, [160, 160, 30]],
      '/slow.png': [120, 80, [200, 60, 140]],
      '/slow-nodim.png': [140, 70, [60, 200, 140]],
    };
    const spec = sizes[name];
    if (!spec) {
      res.writeHead(404).end();
      return;
    }
    const png = makePng(spec[0], spec[1], spec[2]);
    // Deliberately NO Access-Control-Allow-Origin.
    const send = () => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      res.end(png);
    };
    // `?ms=` holds the response open so the test can observe the fast pass
    // before the slow pass has anything to apply.
    const delay = Number(new URL(req.url, 'http://x').searchParams.get('ms')) || 0;
    if (delay) setTimeout(send, delay);
    else send();
  });
  return server;
}

function pageHtml(imgOrigin) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  #bg      { width: 100px; height: 100px; background-image: url(${imgOrigin}/bg.png); }
  #bgmulti { width: 100px; height: 100px;
             background-image: url(${imgOrigin}/bg2.png), linear-gradient(red, blue); }
  div { outline: 1px solid #eee; }
</style></head>
<body>
  <img id="plain" src="${imgOrigin}/a.png">

  <picture id="pic">
    <source id="picsrc" srcset="${imgOrigin}/b.png">
    <img id="picimg" src="${imgOrigin}/c.png">
  </picture>

  <img id="srcsetonly" srcset="${imgOrigin}/wide.png 200w" sizes="200px">

  <img id="inline" src="${TINY_PNG_DATA_URL}">

  <div id="bg"></div>
  <div id="bgmulti"></div>

  <video id="vid" poster="${imgOrigin}/poster.png" width="160" height="90"></video>

  <svg id="svg" width="70" height="70"><image id="svgimg" href="${imgOrigin}/svg.png" width="70" height="70"/></svg>

  <input id="btn" type="image" src="${imgOrigin}/btn.png">

  <object id="obj" type="image/png" data="${imgOrigin}/obj.png" width="55" height="55"></object>

  <!-- Held open server-side so the fast pass is observable before the mosaic. -->
  <img id="slowimg" width="120" height="80" src="${imgOrigin}/slow.png?ms=2500">
  <img id="slownodim" src="${imgOrigin}/slow-nodim.png?ms=2500">
  <img id="slowrestore" width="90" height="60" src="${imgOrigin}/slow.png?ms=6000">

  <!-- Carries nothing replaceable, for the menu-state checks. -->
  <div id="plainbox">no image here</div>

  <div id="host"></div>
  <div id="later"></div>

  <script>
    const host = document.getElementById('host').attachShadow({ mode: 'open' });
    host.innerHTML = '<img id="shadowimg" src="${imgOrigin}/shadow.png">';

    // Added after load, to exercise the MutationObserver path.
    setTimeout(() => {
      const img = document.createElement('img');
      img.id = 'late';
      img.src = '${imgOrigin}/late.png';
      document.getElementById('later').appendChild(img);
    }, 300);
  </script>
</body></html>`;
}

function startPageServer(imgOrigin) {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml(imgOrigin));
  });
}

module.exports = { makePng, startImageServer, startPageServer, TINY_PNG_DATA_URL };
