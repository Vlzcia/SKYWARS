const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 4176;
const ROOT = process.cwd();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const rooms = new Map(); // room -> Map(sid -> {nick,queue:[]})

function sendJson(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function getRoom(room){
  if(!rooms.has(room)) rooms.set(room, new Map());
  return rooms.get(room);
}
function collectBody(req){
  return new Promise((resolve,reject)=>{
    let b='';
    req.on('data',c=>{ b+=c; if(b.length>1e6) req.destroy(); });
    req.on('end',()=>resolve(b));
    req.on('error',reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/online/join' && req.method === 'POST') {
    try{
      const body = JSON.parse(await collectBody(req) || '{}');
      const room = String(body.room || 'room1').slice(0, 30);
      const nick = String(body.nick || 'Player').slice(0, 14);
      const sid = randomUUID();
      const r = getRoom(room);
      if(r.size>=2){ sendJson(res, 409, { ok:false, error:'room_full' }); return; }
      r.set(sid, { nick, queue: [] });
      sendJson(res, 200, { ok: true, sid, room, nick, players:r.size });
    }catch{
      sendJson(res, 400, { ok: false });
    }
    return;
  }

  if (u.pathname === '/online/send' && req.method === 'POST') {
    try{
      const body = JSON.parse(await collectBody(req) || '{}');
      const room = String(body.room || '').slice(0, 30);
      const sid = String(body.sid || '');
      const payload = body.payload || {};
      const r = rooms.get(room);
      if(!r || !r.has(sid)){ sendJson(res, 404, { ok:false }); return; }
      const sender = r.get(sid);
      const pkt = Object.assign({}, payload, { nick: sender.nick, sid });
      for (const [id, client] of r.entries()) {
        if (id !== sid) client.queue.push(pkt);
      }
      sendJson(res, 200, { ok: true });
    }catch{
      sendJson(res, 400, { ok: false });
    }
    return;
  }

  if (u.pathname === '/online/poll' && req.method === 'GET') {
    const room = String(u.searchParams.get('room') || '').slice(0, 30);
    const sid = String(u.searchParams.get('sid') || '');
    const r = rooms.get(room);
    if(!r || !r.has(sid)){ sendJson(res, 404, { ok:false, events:[] }); return; }
    const c = r.get(sid);
    const events = c.queue.splice(0, 40);
    sendJson(res, 200, { ok:true, events });
    return;
  }


  if (u.pathname === '/online/status' && req.method === 'GET') {
    const room = String(u.searchParams.get('room') || '').slice(0, 30);
    const r = rooms.get(room);
    sendJson(res, 200, { ok:true, players:r?r.size:0 });
    return;
  }

  // static
  let pathname = decodeURIComponent(u.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.join(ROOT, pathname.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Skywars relay server on http://0.0.0.0:' + PORT);
});
