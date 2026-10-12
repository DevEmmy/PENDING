// Minimal Supabase-style gateway: /auth/v1 → GoTrue :9999, /rest/v1 → PostgREST :3000.
import http from 'node:http';

const routes = [
  { prefix: '/auth/v1', port: 9999 },
  { prefix: '/rest/v1', port: 3000 },
];
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, prefer, accept-profile, content-profile, x-supabase-api-version, range',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'access-control-expose-headers': 'content-range, x-total-count',
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const route = routes.find((r) => req.url.startsWith(r.prefix));
  if (!route) { res.writeHead(501, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'Not available in the local stack (storage/realtime/functions)' })); return; }
  const upstream = http.request({ host: '127.0.0.1', port: route.port, path: req.url.slice(route.prefix.length) || '/', method: req.method, headers: { ...req.headers, host: `127.0.0.1:${route.port}` } }, (up) => {
    res.writeHead(up.statusCode ?? 502, { ...up.headers, ...cors });
    up.pipe(res);
  });
  upstream.on('error', (e) => { res.writeHead(502, cors); res.end(String(e)); });
  req.pipe(upstream);
}).listen(54321, '127.0.0.1', () => console.log('gateway on :54321'));
