import http from 'node:http';
import { readFile } from 'node:fs/promises';
const page = new URL('./index.html', import.meta.url);
http.createServer(async (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(await readFile(page));
}).listen(4317, '127.0.0.1', () => console.log('Prototype: http://127.0.0.1:4317/?variant=A'));
