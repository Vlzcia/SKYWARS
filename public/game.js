(function(){
  const cvs = document.getElementById('game');
  const ctx = cvs.getContext('2d');
  const statusEl = document.getElementById('status');
  const scoreEl = document.getElementById('score');
  const overlay = document.getElementById('overlay');
  const nickEl = document.getElementById('nick');
  const roomEl = document.getElementById('room');
  const connectBtn = document.getElementById('connect');

  const api = {
    sid:'', room:'', nick:'', connected:false,
    pollBusy:false, enemySid:'', lastRx:0
  };

  const me = {x:180,y:280,vx:0,vy:0,r:16,hp:100,alive:true};
  const enemy = {x:800,y:280,r:16,hp:100,name:'Rival',alive:true};
  const keys = {};
  const shots = [];
  const enemyShots = [];
  const match = {round:1,maxRounds:5,my:0,op:0,live:false,resolved:0};

  function setStatus(t){ statusEl.textContent = t; }
  function setScore(){ scoreEl.textContent = `Ronda ${match.round}/${match.maxRounds} · Tú ${match.my} - ${match.op} Rival`; }
  function clamp(v,a,b){ return v<a?a:v>b?b:v; }
  function dist(ax,ay,bx,by){ return Math.hypot(ax-bx, ay-by); }

  function resetRoundPositions(){
    me.x=180; me.y=280; me.hp=100; me.alive=true;
    enemy.x=800; enemy.y=280; enemy.hp=100; enemy.alive=true;
    shots.length=0; enemyShots.length=0;
  }

  function startRound(){
    resetRoundPositions();
    match.live=true;
    overlay.classList.add('hide');
    setStatus(`Ronda ${match.round} activa`);
  }

  function resolveRound(winnerSid, round){
    if(round <= match.resolved) return;
    match.resolved = round;
    match.live = false;
    if(winnerSid === api.sid) match.my++; else match.op++;
    setScore();

    const need = 3;
    if(match.my>=need || match.op>=need || match.round>=match.maxRounds){
      overlay.textContent = match.my>match.op ? 'VICTORIA' : 'DERROTA';
      overlay.classList.remove('hide');
      setStatus(match.my>match.op ? 'Ganaste la serie BO5' : 'Perdiste la serie BO5');
      return;
    }

    match.round++;
    setScore();
    overlay.textContent = `Siguiente ronda ${match.round}...`;
    overlay.classList.remove('hide');
    setTimeout(startRound, 900);
  }

  async function joinRoom(room, nick){
    const r = await fetch('/online/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({room,nick})});
    const j = await r.json();
    if(!r.ok) throw j;
    return j;
  }

  function send(payload){
    if(!api.connected || !api.sid) return;
    fetch('/online/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({room:api.room,sid:api.sid,payload})}).catch(()=>{});
  }

  async function poll(){
    if(!api.connected || api.pollBusy) return;
    api.pollBusy = true;
    try{
      const r = await fetch(`/online/poll?room=${encodeURIComponent(api.room)}&sid=${encodeURIComponent(api.sid)}`);
      const j = r.ok ? await r.json() : {events:[]};
      for(const ev of (j.events||[])) onPacket(ev);
    }catch{}
    api.pollBusy = false;
  }

  function onPacket(d){
    if(!d) return;
    if(d.sid === api.sid) return;
    api.lastRx = performance.now();

    if(d.type==='state'){
      api.enemySid = d.sid || api.enemySid;
      enemy.x = typeof d.x==='number' ? d.x : enemy.x;
      enemy.y = typeof d.y==='number' ? d.y : enemy.y;
      enemy.hp = typeof d.hp==='number' ? d.hp : enemy.hp;
      enemy.name = d.nick || enemy.name;
      if(!match.live && match.round===1) {
        overlay.textContent = 'Rival conectado · iniciando';
        startRound();
      }
      return;
    }

    if(d.type==='shot'){
      enemyShots.push({x:d.x,y:d.y,vx:d.vx,vy:d.vy,life:60});
      return;
    }

    if(d.type==='hit'){
      if(!match.live) return;
      if(d.targetSid && d.targetSid!==api.sid) return;
      me.hp = clamp(me.hp - (d.dmg||20), 0, 100);
      if(me.hp<=0 && me.alive){
        me.alive=false;
        send({type:'round_win',winnerSid:d.sid,round:match.round});
        resolveRound(d.sid, match.round);
      }
      return;
    }

    if(d.type==='round_win'){
      resolveRound(d.winnerSid, d.round||match.round);
    }
  }

  async function connect(){
    const nick = (nickEl.value||'Player').trim().slice(0,14);
    const room = (roomEl.value||'').trim();
    if(!room){ setStatus('Escribe código de sala'); return; }
    try{
      const j = await joinRoom(room, nick||'Player');
      api.sid = j.sid; api.room = room; api.nick = nick||'Player'; api.connected = true;
      setStatus(`Conectado como ${api.nick} en sala ${api.room}`);
      overlay.textContent = 'Esperando rival...';
      overlay.classList.remove('hide');
      setScore();
    }catch(err){
      setStatus(err && err.error==='room_full' ? 'Sala llena (1v1)' : 'No se pudo conectar');
    }
  }

  addEventListener('keydown',e=>keys[e.key.toLowerCase()]=true);
  addEventListener('keyup',e=>keys[e.key.toLowerCase()]=false);

  cvs.addEventListener('mousedown',()=>{
    if(!match.live || !api.enemySid) return;
    const dx = enemy.x - me.x, dy = enemy.y - me.y;
    const d = Math.hypot(dx,dy) || 1;
    const vx = (dx/d)*12, vy=(dy/d)*12;
    shots.push({x:me.x,y:me.y,vx,vy,life:60});
    send({type:'shot',x:me.x,y:me.y,vx,vy});
  });

  connectBtn.addEventListener('click', connect);

  function update(){
    if(api.connected) send({type:'state',x:me.x,y:me.y,hp:me.hp,nick:api.nick});

    const spd = 3.8;
    let mx=0,my=0;
    if(keys['a']||keys['arrowleft']) mx-=1;
    if(keys['d']||keys['arrowright']) mx+=1;
    if(keys['w']||keys['arrowup']) my-=1;
    if(keys['s']||keys['arrowdown']) my+=1;
    const dash = (keys['shift']?1.8:1);
    me.x = clamp(me.x + mx*spd*dash, 20, cvs.width-20);
    me.y = clamp(me.y + my*spd*dash, 20, cvs.height-20);

    for(const arr of [shots, enemyShots]){
      for(let i=arr.length-1;i>=0;i--){
        const b=arr[i]; b.x+=b.vx; b.y+=b.vy; b.life--;
        if(b.life<=0||b.x<0||b.y<0||b.x>cvs.width||b.y>cvs.height) arr.splice(i,1);
      }
    }

    if(match.live){
      for(let i=shots.length-1;i>=0;i--){
        const b=shots[i];
        if(dist(b.x,b.y,enemy.x,enemy.y)<enemy.r+4){
          shots.splice(i,1);
          send({type:'hit',targetSid:api.enemySid,dmg:20});
        }
      }
      for(let i=enemyShots.length-1;i>=0;i--){
        const b=enemyShots[i];
        if(dist(b.x,b.y,me.x,me.y)<me.r+4){
          enemyShots.splice(i,1);
          me.hp = clamp(me.hp-20,0,100);
          if(me.hp<=0 && me.alive){
            me.alive=false;
            send({type:'round_win',winnerSid:api.enemySid,round:match.round});
            resolveRound(api.enemySid, match.round);
          }
        }
      }
    }
  }

  function draw(){
    ctx.fillStyle='#070d19';
    ctx.fillRect(0,0,cvs.width,cvs.height);

    for(let i=0;i<50;i++){
      ctx.fillStyle=`rgba(150,190,255,${(i%7)/24})`;
      ctx.fillRect((i*67)%cvs.width, (i*91)%cvs.height, 2, 2);
    }

    // me
    ctx.fillStyle='#3ec8ff';
    ctx.beginPath(); ctx.arc(me.x,me.y,me.r,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#fff'; ctx.font='12px sans-serif'; ctx.textAlign='center';
    ctx.fillText(api.nick||'Tú', me.x, me.y-22);

    // enemy
    ctx.fillStyle='#ff5a82';
    ctx.beginPath(); ctx.arc(enemy.x,enemy.y,enemy.r,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#fff';
    ctx.fillText(enemy.name||'Rival', enemy.x, enemy.y-22);

    // bullets
    ctx.fillStyle='#9be8ff';
    for(const b of shots) ctx.fillRect(b.x-2,b.y-2,4,4);
    ctx.fillStyle='#ff9db7';
    for(const b of enemyShots) ctx.fillRect(b.x-2,b.y-2,4,4);

    // hp bars
    ctx.fillStyle='rgba(255,255,255,.2)'; ctx.fillRect(20,16,220,12); ctx.fillRect(cvs.width-240,16,220,12);
    ctx.fillStyle='#3ec8ff'; ctx.fillRect(20,16,220*(me.hp/100),12);
    ctx.fillStyle='#ff5a82'; ctx.fillRect(cvs.width-240,16,220*(enemy.hp/100),12);
  }

  function loop(){
    update();
    draw();
    poll();
    if(api.connected && performance.now()-api.lastRx>7000) setStatus('Conectado, esperando paquetes del rival...');
    requestAnimationFrame(loop);
  }

  setScore();
  loop();
})();
