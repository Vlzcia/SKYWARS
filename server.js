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

const DB_FILE = path.join(ROOT, 'data', 'online-db.json');
let db = { users:{}, rooms:{} };
try{ db = JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }catch(e){}
function saveDb(){
  try{ fs.mkdirSync(path.dirname(DB_FILE), { recursive:true }); fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); }catch(e){}
}

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
function sanitizeRoom(v){ return String(v || 'room1').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,32) || 'room1'; }
function sanitizeNick(v){ return String(v || 'Player').replace(/[^\w\- ]/g,'').slice(0,14) || 'Player'; }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/online/join' && req.method === 'POST') {
    try{
      const body = JSON.parse(await collectBody(req) || '{}');
      const room = sanitizeRoom(body.room);
      const nick = sanitizeNick(body.nick);
      const sid = randomUUID();
      const r = getRoom(room);
      if(r.size>=2){ sendJson(res, 409, { ok:false, error:'room_full' }); return; }
      r.set(sid, { nick, queue: [], lastSeen: Date.now() });
      db.users[nick] = db.users[nick] || { joins:0, wins:0, losses:0, lastRoom:'' };
      db.users[nick].joins += 1; db.users[nick].lastRoom = room;
      db.rooms[room] = db.rooms[room] || { joins:0, matches:0, updatedAt:0 };
      db.rooms[room].joins += 1; db.rooms[room].updatedAt = Date.now();
      saveDb();
      sendJson(res, 200, { ok: true, sid, room, nick, players:r.size });
    }catch{
      sendJson(res, 400, { ok: false });
    }
    return;
  }

  if (u.pathname === '/online/send' && req.method === 'POST') {
    try{
      const body = JSON.parse(await collectBody(req) || '{}');
      const room = sanitizeRoom(body.room || '');
      const sid = String(body.sid || '');
      const payload = body.payload || {};
      const r = rooms.get(room);
      if(!r || !r.has(sid)){ sendJson(res, 404, { ok:false }); return; }
      const sender = r.get(sid);
      sender.lastSeen = Date.now();
      const pkt = Object.assign({}, payload, { nick: sender.nick, sid, serverTs:Date.now() });
      if(payload && payload.type==='round_win'){
        const roomDb = db.rooms[room] || (db.rooms[room]={ joins:0,matches:0,updatedAt:0 });
        roomDb.matches += 1; roomDb.updatedAt = Date.now();
        const winner = String(payload.winnerSid||'');
        for (const [id, client] of r.entries()) {
          db.users[client.nick] = db.users[client.nick] || { joins:0,wins:0,losses:0,lastRoom:room };
          if(id===winner) db.users[client.nick].wins += 1;
          else db.users[client.nick].losses += 1;
        }
        saveDb();
      }
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
    const room = sanitizeRoom(u.searchParams.get('room') || '');
    const sid = String(u.searchParams.get('sid') || '');
    const r = rooms.get(room);
    if(!r || !r.has(sid)){ sendJson(res, 404, { ok:false, events:[] }); return; }
    const c = r.get(sid);
    c.lastSeen = Date.now();
    const events = c.queue.splice(0, 50);
    sendJson(res, 200, { ok:true, events });
    return;
  }

  if (u.pathname === '/online/status' && req.method === 'GET') {
    const room = sanitizeRoom(u.searchParams.get('room') || '');
    const r = rooms.get(room);
    sendJson(res, 200, { ok:true, players:r?r.size:0, knownUsers:Object.keys(db.users).length });
    return;
  }

  // static
  let pathname = decodeURIComponent(u.pathname);
  if (pathname === '/') pathname = '/public/index.html';
  const rel = pathname.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

setInterval(()=>{
  const now = Date.now();
  for(const [room,r] of rooms.entries()){
    for(const [sid,c] of r.entries()) if(now-c.lastSeen>60000) r.delete(sid);
    if(r.size===0) rooms.delete(room);
  }
},10000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Skywars online server on http://0.0.0.0:' + PORT);
});
