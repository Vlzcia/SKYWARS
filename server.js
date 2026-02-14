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
const REJOIN_GRACE_MS = 90000;

const DB_FILE = path.join(ROOT, 'data', 'online-db.json');
let db = { users:{}, rooms:{} };
try{ db = JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }catch(e){}
function saveDb(){
  try{ fs.mkdirSync(path.dirname(DB_FILE), { recursive:true }); fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); }catch(e){}
}

function sendJson(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  res.end(body);
}
function getRoom(room){
  if(!rooms.has(room)) rooms.set(room, new Map());
  return rooms.get(room);
}
function collectBody(req){
  return new Promise((resolve,reject)=>{
    let b='';
    let tooLarge = false;
    req.on('data',c=>{
      if (tooLarge) return;
      b += c;
      if (b.length > 1e6) tooLarge = true;
    });
    req.on('end',()=>{
      if (tooLarge) {
        const err = new Error('payload_too_large');
        err.code = 413;
        reject(err);
        return;
      }
      resolve(b);
    });
    req.on('error',reject);
  });
}
function sanitizeRoom(v){ return String(v || 'room1').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,32) || 'room1'; }
function sanitizeNick(v){ return String(v || 'Player').replace(/[^\w\- ]/g,'').slice(0,14) || 'Player'; }
function sanitizeChat(v){ return String(v||'').replace(/[\r\n\t]+/g,' ').slice(0,140).trim(); }
function findClientByNick(roomMap, nick){
  for (const [id, c] of roomMap.entries()) if (c.nick===nick) return [id,c];
  return null;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/online/join' && req.method === 'POST') {
    try{
      const body = JSON.parse(await collectBody(req) || '{}');
      const room = sanitizeRoom(body.room);
      const nick = sanitizeNick(body.nick);
      const sid = randomUUID();
      const now = Date.now();
      const r = getRoom(room);
      const sameNick = findClientByNick(r, nick);
      if (sameNick && now - sameNick[1].lastSeen < REJOIN_GRACE_MS) { sendJson(res, 409, { ok:false, error:'nick_in_use' }); return; }
      if(r.size>=2){ sendJson(res, 409, { ok:false, error:'room_full' }); return; }
      r.set(sid, { nick, queue: [], lastSeen: now, lastShotTs:0, lastChatTs:0, lastState:null });
      db.users[nick] = db.users[nick] || { joins:0, wins:0, losses:0, lastRoom:'' };
      db.users[nick].joins += 1; db.users[nick].lastRoom = room;
      db.rooms[room] = db.rooms[room] || { joins:0, matches:0, updatedAt:0 };
      db.rooms[room].joins += 1; db.rooms[room].updatedAt = now;
      saveDb();
      sendJson(res, 200, { ok: true, sid, room, nick, players:r.size });
    }catch(err){
      const code = err && err.code === 413 ? 413 : 400;
      sendJson(res, code, { ok: false, error: code===413 ? 'payload_too_large' : 'bad_request' });
    }
    return;
  }


  if (u.pathname === '/online/rejoin' && req.method === 'POST') {
    try{
      const body = JSON.parse(await collectBody(req) || '{}');
      const room = sanitizeRoom(body.room);
      const nick = sanitizeNick(body.nick);
      const r = getRoom(room);
      const found = findClientByNick(r, nick);
      if (!found) { sendJson(res, 404, { ok:false, error:'session_not_found' }); return; }
      const [sid, c] = found;
      if (Date.now() - c.lastSeen > REJOIN_GRACE_MS) { sendJson(res, 404, { ok:false, error:'session_expired' }); return; }
      c.lastSeen = Date.now();
      sendJson(res, 200, { ok:true, sid, room, nick, players:r.size });
    }catch(err){
      const code = err && err.code === 413 ? 413 : 400;
      sendJson(res, code, { ok:false, error: code===413 ? 'payload_too_large' : 'bad_request' });
    }
    return;
  }

  if (u.pathname === '/online/send' && req.method === 'POST') {
    try{
      const body = JSON.parse(await collectBody(req) || '{}');
      const room = sanitizeRoom(body.room || '');
      const sid = String(body.sid || '');
      let payload = body.payload || {};
      const r = rooms.get(room);
      if(!r || !r.has(sid)){ sendJson(res, 404, { ok:false }); return; }
      const sender = r.get(sid);
      const now = Date.now();
      sender.lastSeen = now;
      if(payload && payload.type==='ping'){ sendJson(res, 200, { ok:true, pongTs:now }); return; }
      if(payload && payload.type==='state'){
        const px = Number(payload.x), py=Number(payload.y);
        if(Number.isFinite(px) && Number.isFinite(py)) sender.lastState={x:px,y:py,ts:now};
      }
      if(payload && payload.type==='shot'){
        const sx=Number(payload.x), sy=Number(payload.y);
        if(!Number.isFinite(sx)||!Number.isFinite(sy)){ sendJson(res, 422, { ok:false, error:'invalid_shot' }); return; }
        if(now - (sender.lastShotTs||0) < 35){ sendJson(res, 429, { ok:false, error:'shot_rate_limited' }); return; }
        if(sender.lastState){
          const dx=sx-sender.lastState.x, dy=sy-sender.lastState.y;
          if(dx*dx+dy*dy > 260*260){ sendJson(res, 422, { ok:false, error:'invalid_shot_origin' }); return; }
        }
        sender.lastShotTs = now;
      }
      if(payload && payload.type==='hit'){
        const targetSid = String(payload.targetId||'');
        if(!targetSid || !r.has(targetSid) || targetSid===sid){ sendJson(res, 422, { ok:false, error:'invalid_hit_target' }); return; }
      }
      if(payload && payload.type==='chat'){
        const txt=sanitizeChat(payload.text);
        if(!txt){ sendJson(res, 422, { ok:false, error:'invalid_chat' }); return; }
        if(now-(sender.lastChatTs||0)<400){ sendJson(res, 429, { ok:false, error:'chat_rate_limited' }); return; }
        sender.lastChatTs=now;
        payload={ type:'chat', text:txt };
      }
      const pkt = Object.assign({}, payload, { nick: sender.nick, sid, serverTs:now });
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
      if(payload && payload.type==='hit_confirm' && payload.toSid && r.has(String(payload.toSid))){
        r.get(String(payload.toSid)).queue.push(pkt);
      } else {
        for (const [id, client] of r.entries()) {
          if (id !== sid) client.queue.push(pkt);
        }
      }
      sendJson(res, 200, { ok: true });
    }catch(err){
      const code = err && err.code === 413 ? 413 : 400;
      sendJson(res, code, { ok: false, error: code===413 ? 'payload_too_large' : 'bad_request' });
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


  if (u.pathname === '/online/health' && req.method === 'GET') {
    sendJson(res, 200, { ok:true, status:'up', uptime:Math.floor(process.uptime()) });
    return;
  }

  if (u.pathname === '/online/status' && req.method === 'GET') {
    const room = sanitizeRoom(u.searchParams.get('room') || '');
    const r = rooms.get(room);
    let staleMs = null;
    if(r && r.size>=1){
      const now = Date.now();
      let maxAge = 0;
      for (const c of r.values()) maxAge = Math.max(maxAge, now - c.lastSeen);
      staleMs = maxAge;
    }
    sendJson(res, 200, { ok:true, players:r?r.size:0, knownUsers:Object.keys(db.users).length, staleMs });
    return;
  }

  // static
  let pathname = decodeURIComponent(u.pathname);
  if (pathname === '/') pathname = '/index.html';
  const rel = pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (file !== ROOT && !file.startsWith(rootPrefix)) { res.writeHead(403); res.end('Forbidden'); return; }
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
