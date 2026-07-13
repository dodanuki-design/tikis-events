// E2E local dev server
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.GCAL_ICAL_URL = 'file://' + path.join(__dirname, 'test-fixture.ics');

global.fetch = async (url) => {
  if (url.startsWith('file://')) {
    return { ok: true, status: 200, text: async () => fs.readFileSync(url.replace('file://',''), 'utf-8') };
  }
  throw new Error('unexpected url: ' + url);
};

delete require.cache[require.resolve('./api/events.js')];
const apiHandler = require('./api/events.js');

const server = http.createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`);
  if (req.url === '/api/events') {
    const mockRes = {
      _headers: {},
      setHeader(n, v) { this._headers[n] = v; },
      status(c) { this._status = c; return this; },
      json(o) {
        res.writeHead(this._status || 200, { ...this._headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(o));
      },
    };
    await apiHandler(req, mockRes);
    return;
  }
  const filePath = req.url === '/' ? 'index.html' : req.url.slice(1);
  const fullPath = path.join(__dirname, filePath);
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    const ext = path.extname(fullPath);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
    fs.createReadStream(fullPath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('404');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
