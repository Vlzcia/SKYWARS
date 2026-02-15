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
const ONLINE_WORLD_W = 1600;
const ONLINE_WORLD_H = 900;
const CORR_LOG_WINDOW_MS = 1000;
const corrStats = { windowStart: Date.now(), total:0, corrected:0, byRoom:{} };
function noteCorrection(room, corrected){
  const now = Date.now();
  if(now - corrStats.windowStart > CORR_LOG_WINDOW_MS){
    corrStats.windowStart = now; corrStats.total = 0; corrStats.corrected = 0; corrStats.byRoom = {};
  }
  corrStats.total++;
  if(corrected) corrStats.corrected++;
  const r = corrStats.byRoom[room] || (corrStats.byRoom[room]={total:0,corrected:0});
  r.total++; if(corrected) r.corrected++;
}

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
function sampleStateAt(hist, ts){
  if(!hist||!hist.length) return null;
  let prev=hist[0], next=hist[hist.length-1];
  for(let i=0;i<hist.length;i++){
    if(hist[i].ts<=ts) prev=hist[i];
    if(hist[i].ts>=ts){ next=hist[i]; break; }
  }
  const span=Math.max(1,next.ts-prev.ts);
  const t=Math.max(0,Math.min(1,(ts-prev.ts)/span));
  return { x: prev.x + (next.x-prev.x)*t, y: prev.y + (next.y-prev.y)*t, ts };
}

function fileSig(file){
  try{
    const b = fs.readFileSync(file);
    const head = b.slice(0, 4096).toString('utf8');
    const titleMatch = head.match(/<title>([^<]+)<\/title>/i);
    return { ok:true, file, bytes:b.length, mtime:fs.statSync(file).mtimeMs, title:titleMatch?titleMatch[1]:'', sig:require('crypto').createHash('sha1').update(b).digest('hex').slice(0,12) };
  }catch(e){
    return { ok:false, file, error:'not_found' };
  }
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
      r.set(sid, { nick, queue: [], lastSeen: now, lastShotTs:0, lastChatTs:0, lastState:null, stateHist:[] });
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
      let ack = null;
      sender.lastSeen = now;
      if(payload && payload.type==='ping'){ sendJson(res, 200, { ok:true, pongTs:now }); return; }
      if(payload && payload.type==='state'){
        const prev = sender.lastState || { x: ONLINE_WORLD_W*0.5, y: ONLINE_WORLD_H*0.72, ts: now };
        const px = Number(payload.x), py=Number(payload.y);
        const rx = Number.isFinite(px) ? px : prev.x;
        const ry = Number.isFinite(py) ? py : prev.y;
        const sx = Math.max(20, Math.min(ONLINE_WORLD_W-20, rx));
        const sy = Math.max(0, Math.min(ONLINE_WORLD_H + 260, ry));
        const correctionDx = sx - rx;
        const correctionDy = sy - ry;
        const corrected = (correctionDx*correctionDx + correctionDy*correctionDy) > 0.5*0.5;
        noteCorrection(room, corrected);
        sender.lastState={x:sx,y:sy,ts:now};
        sender.stateHist = sender.stateHist || [];
        sender.stateHist.push({x:sx,y:sy,ts:now});
        if(sender.stateHist.length>45) sender.stateHist.splice(0, sender.stateHist.length-45);
        ack = { type:'state_ack', seq:Number(payload.seq||0), x:Math.round(sx*2)/2, y:Math.round(sy*2)/2, serverTs:now, corrected, corrDx:Math.round(correctionDx*10)/10, corrDy:Math.round(correctionDy*10)/10 };
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
        const target = r.get(targetSid);
        const shotTs = Number(payload.shotTs||now);
        const a = sampleStateAt(sender.stateHist, shotTs) || sender.lastState;
        const b = sampleStateAt(target.stateHist, shotTs) || target.lastState;
        if(a && b){
          const dx=a.x-b.x, dy=a.y-b.y;
          const maxD = Number(payload.maxDist||90);
          if(dx*dx+dy*dy > maxD*maxD){ sendJson(res, 422, { ok:false, error:'invalid_hit_distance' }); return; }
        }
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
      sendJson(res, 200, { ok: true, ack });
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

  if (u.pathname === '/online/served-file' && req.method === 'GET') {
    const rootIndex = path.resolve(ROOT, 'index.html');
    const publicIndex = path.resolve(ROOT, 'public', 'index.html');
    const requestedPath = decodeURIComponent(u.searchParams.get('path') || '/index.html');
    const rel = requestedPath.replace(/^\/+/,'');
    const resolved = path.resolve(ROOT, rel);
    sendJson(res, 200, {
      ok:true,
      cwd: process.cwd(),
      root: ROOT,
      resolvedRequest: resolved,
      rootIndex: fileSig(rootIndex),
      publicIndex: fileSig(publicIndex),
      requested: fileSig(resolved)
    });
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
    const corrRoom = corrStats.byRoom[room] || { total:0, corrected:0 };
    sendJson(res, 200, { ok:true, players:r?r.size:0, knownUsers:Object.keys(db.users).length, staleMs, correctionsPerSec:corrRoom.corrected, stateSamplesPerSec:corrRoom.total, correctionRatio:corrRoom.total?Number((corrRoom.corrected/corrRoom.total).toFixed(3)):0 });
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
  const rootIndex = path.resolve(ROOT, 'index.html');
  const f = fileSig(rootIndex);
  console.log('Skywars online server on http://0.0.0.0:' + PORT);
  console.log('Serving / from:', rootIndex, 'sig='+ (f.ok?f.sig:'missing'), 'title='+ (f.ok?f.title:'N/A'));
});
