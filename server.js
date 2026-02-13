const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
let Server = null;
try{ ({ Server } = require('socket.io')); }catch(e){ Server = null; }

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

const relayRooms = new Map(); // legacy relay/co-op fallback room -> Map(sid -> {nick,queue:[]})
const pvpRooms = new Map(); // socket.io pvp room -> { players: Map(socketId -> playerState) }

function sendJson(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function getRelayRoom(room){
  if(!relayRooms.has(room)) relayRooms.set(room, new Map());
  return relayRooms.get(room);
}
function getPvpRoom(room){
  if(!pvpRooms.has(room)) pvpRooms.set(room, { players:new Map() });
  return pvpRooms.get(room);
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

  // legacy relay endpoints (kept for coop/fallback)
  if (u.pathname === '/online/join' && req.method === 'POST') {
    try{
      const body = JSON.parse(await collectBody(req) || '{}');
      const room = sanitizeRoom(body.room);
      const nick = sanitizeNick(body.nick);
      const sid = randomUUID();
      const r = getRelayRoom(room);
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
      const room = sanitizeRoom(body.room || '');
      const sid = String(body.sid || '');
      const payload = body.payload || {};
      const r = relayRooms.get(room);
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
    const room = sanitizeRoom(u.searchParams.get('room') || '');
    const sid = String(u.searchParams.get('sid') || '');
    const r = relayRooms.get(room);
    if(!r || !r.has(sid)){ sendJson(res, 404, { ok:false, events:[] }); return; }
    const c = r.get(sid);
    const events = c.queue.splice(0, 40);
    sendJson(res, 200, { ok:true, events });
    return;
  }

  if (u.pathname === '/online/status' && req.method === 'GET') {
    const room = sanitizeRoom(u.searchParams.get('room') || '');
    const relay = relayRooms.get(room);
    const pvp = pvpRooms.get(room);
    sendJson(res, 200, { ok:true, players:(relay?relay.size:0), pvpPlayers:(pvp?pvp.players.size:0) });
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

const io = Server ? new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
}) : null;

function toPlayersObject(map){
  const obj = {};
  for(const [id,p] of map.entries()) obj[id]={nick:p.nick,x:p.x,y:p.y,hp:p.hp,score:p.score,dead:!!p.dead};
  return obj;
}

if(io){
io.on('connection', (socket) => {
  let room = '';

  socket.on('pvp_join', (msg = {}) => {
    room = sanitizeRoom(msg.room);
    const nick = sanitizeNick(msg.nick);
    const pr = getPvpRoom(room);
    if (!pr.players.has(socket.id) && pr.players.size >= 5) {
      socket.emit('pvp_full', { room, max:5 });
      return;
    }

    socket.join(room);
    if(!pr.players.has(socket.id)){
      pr.players.set(socket.id, { nick, x:0, y:0, hp:120, score:0, dead:false, last:Date.now() });
    } else {
      const cur = pr.players.get(socket.id);
      cur.nick = nick;
    }

    socket.emit('pvp_joined', { id: socket.id, room, players: toPlayersObject(pr.players) });
    socket.to(room).emit('pvp_state', { id: socket.id, nick, x:0, y:0, hp:120, score:0, dead:false });
  });

  socket.on('pvp_state', (msg = {}) => {
    if(!room) return;
    const pr = pvpRooms.get(room);
    if(!pr || !pr.players.has(socket.id)) return;
    const p = pr.players.get(socket.id);
    if(typeof msg.x==='number') p.x = Math.round(msg.x);
    if(typeof msg.y==='number') p.y = Math.round(msg.y);
    if(typeof msg.hp==='number') p.hp = Math.max(0, Math.min(120, Math.round(msg.hp)));
    if(typeof msg.score==='number') p.score = Math.max(0, Math.min(99, Math.round(msg.score)));
    if(typeof msg.dead==='boolean') p.dead = msg.dead;
    p.last = Date.now();
    socket.to(room).emit('pvp_state', { id: socket.id, nick:p.nick, x:p.x, y:p.y, hp:p.hp, score:p.score, dead:p.dead });
  });

  socket.on('pvp_hit', (msg = {}) => {
    if(!room) return;
    const pr = pvpRooms.get(room);
    if(!pr || !pr.players.has(socket.id)) return;
    const targetId = String(msg.targetId || '');
    if(!targetId || !pr.players.has(targetId) || targetId === socket.id) return;

    const attacker = pr.players.get(socket.id);
    const target = pr.players.get(targetId);
    const dmg = Math.max(1, Math.min(35, Number(msg.dmg) || 12));
    target.hp -= dmg;

    if(target.hp <= 0){
      attacker.score += 1;
      const winnerId = attacker.score >= 5 ? socket.id : '';
      target.hp = 120;
      target.dead = false;
      io.to(room).emit('pvp_score', {
        killerId: socket.id,
        victimId: targetId,
        killerScore: attacker.score,
        winnerId,
        targetKills: 5
      });
      if(winnerId){
        // reset scores for next match in same room
        for(const p of pr.players.values()) p.score = 0;
      }
    } else {
      io.to(targetId).emit('pvp_state', { id: targetId, nick:target.nick, x:target.x, y:target.y, hp:target.hp, score:target.score, dead:false });
      io.to(room).emit('pvp_hitfx', { from: socket.id, to: targetId, hp:target.hp });
    }
  });

  socket.on('disconnect', () => {
    if(!room) return;
    const pr = pvpRooms.get(room);
    if(!pr) return;
    pr.players.delete(socket.id);
    socket.to(room).emit('pvp_leave', { id: socket.id });
    if(pr.players.size===0) pvpRooms.delete(room);
  });
});

}
else{
  console.warn('[skywars] socket.io no instalado: PvP online socket deshabilitado. Ejecuta `npm install` para habilitarlo.');
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('Skywars server on http://0.0.0.0:' + PORT);
});
