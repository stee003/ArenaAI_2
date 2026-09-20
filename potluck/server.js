/* Potluck demo backend — zero-dependency Node server (Node 18+).
 *
 * Serves the static app AND a tiny JSON API that turns the demo multiplayer:
 *   GET  /api/state      → seats left, taken seat indices, waitlist counts, custom events
 *   POST /api/book       → atomic seat claim (409 on conflict with fresh state)
 *   POST /api/cancel     → release seats by booking code, promotes waitlist #1
 *   POST /api/publish    → host-published tables, shared across all browsers
 *   POST /api/waitlist   → server-authoritative queue position
 *   POST /api/track      → subscribe / notify / follow / venue / member events
 *
 * Single-threaded Node means claims serialize naturally — no locks needed.
 * State persists to data.json (gitignored). The front end degrades gracefully
 * to localStorage mode when this server isn't present.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data.json');
const PORT = process.env.PORT || 8080;

const BASE_TOTALS = { seoul:14, pastry:10, pasta:12, hotpot:16, mezze:18, vermouth:20, ramen:8, bread:12, amaro:16 };
const BASE_LEFT   = { seoul:3,  pastry:2,  pasta:7,  hotpot:11, mezze:14, vermouth:0, ramen:8, bread:9, amaro:16 };

/* Deterministic seat-fill simulation — same algorithm as the client,
   so seat maps agree across modes. */
function hashSeed(s){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619) } return h>>>0 }
function mul32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; var t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296 } }
function simulatedTaken(id, total, left){
  const sold = total - left, rnd = mul32(hashSeed(id)), set = new Set();
  while(set.size < sold && set.size < total) set.add(Math.floor(rnd()*total));
  return [...set];
}

function seed(){
  const seats = {};
  for(const id of Object.keys(BASE_TOTALS)){
    seats[id] = { left: BASE_LEFT[id], taken: simulatedTaken(id, BASE_TOTALS[id], BASE_LEFT[id]) };
  }
  return { seats, customEvents: [], bookings: [], waitlist: [], track: [] };
}

let db;
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); if(!db.seats) throw 0; }
catch(e){ db = seed(); persist(); }
function persist(){ try{ fs.writeFileSync(DATA, JSON.stringify(db)); }catch(e){} }

function totals(id){
  if(BASE_TOTALS[id]) return BASE_TOTALS[id];
  const c = db.customEvents.find(e=>e.id===id);
  return c ? c.total : null;
}
function seatState(id){
  if(!db.seats[id]) db.seats[id] = { left: totals(id)||0, taken: [] };
  return db.seats[id];
}
function publicState(){
  const seats = {}, taken = {}, waitlistCounts = {};
  for(const id of Object.keys(db.seats)){ seats[id] = db.seats[id].left; taken[id] = db.seats[id].taken; }
  db.waitlist.forEach(w=>{ waitlistCounts[w.eventId] = (waitlistCounts[w.eventId]||0)+1 });
  return { seats, taken, waitlistCounts, customEvents: db.customEvents, serverTime: Date.now() };
}

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png',
  '.svg':'image/svg+xml', '.ico':'image/x-icon', '.csv':'text/csv' };

function readBody(req){
  return new Promise((res)=>{
    let b='';
    req.on('data', c=>{ b+=c; if(b.length>1e5) req.destroy(); });
    req.on('end', ()=>{ try{ res(b?JSON.parse(b):{}) }catch(e){ res({}) } });
    req.on('error', ()=>res({}));
  });
}

const server = http.createServer(async (req, res)=>{
  const u = new URL(req.url, 'http://x');

  /* ---------- API ---------- */
  if(u.pathname.startsWith('/api/')){
    const send = (code,obj)=>{ res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(obj)); };

    if(req.method==='GET' && u.pathname==='/api/state') return send(200, publicState());
    if(req.method!=='POST') return send(405,{error:'method'});

    const body = await readBody(req);

    if(u.pathname==='/api/book'){
      const { eventId, seats:reqSeats, name, email, diet } = body||{};
      const total = totals(eventId);
      if(!total || !Array.isArray(reqSeats) || !reqSeats.length) return send(400,{error:'bad booking'});
      const st = seatState(eventId);
      if(reqSeats.length>6) return send(400,{error:'max 6 seats per booking'});
      const bad = reqSeats.some(s=>typeof s!=='number' || s<0 || s>=total);
      const claimed = reqSeats.some(s=>st.taken.includes(s));
      if(bad || claimed || reqSeats.length>st.left){
        return send(409,{ left: st.left, taken: st.taken });   // client re-picks
      }
      st.taken = st.taken.concat(reqSeats);
      st.left -= reqSeats.length;
      const code = 'PK-'+Math.random().toString(36).slice(2,6).toUpperCase();
      db.bookings.push({ code, eventId, seats:reqSeats, qty:reqSeats.length,
        name:String(name||'').slice(0,80), email:String(email||'').slice(0,120),
        diet:String(diet||'').slice(0,200), at:Date.now() });
      persist();
      return send(200,{ code, left: st.left, taken: st.taken });
    }

    if(u.pathname==='/api/cancel'){
      const i = db.bookings.findIndex(b=>b.code===body.code);
      if(i<0) return send(404,{error:'booking not found'});
      const b = db.bookings[i]; db.bookings.splice(i,1);
      const st = seatState(b.eventId);
      st.taken = st.taken.filter(s=>!b.seats.includes(s));
      st.left += b.qty;
      let promoted = false;
      const wi = db.waitlist.findIndex(w=>w.eventId===b.eventId);
      if(wi>=0){ db.waitlist.splice(wi,1); promoted = true; }
      persist();
      return send(200,{ ok:true, promoted, left: st.left, taken: st.taken });
    }

    if(u.pathname==='/api/publish'){
      const e = Object.assign({}, body.event||{});
      if(!e.title || !e.total) return send(400,{error:'missing fields'});
      e.id = 'x'+Date.now().toString(36);
      e.custom = true; e.left = e.total; e.wc = 0;
      db.customEvents.push(e);
      db.seats[e.id] = { left: e.total, taken: [] };
      persist();
      return send(200,{ event: e });
    }

    if(u.pathname==='/api/waitlist'){
      const eventId = body.eventId || body.id;
      db.waitlist.push({ eventId, name:String(body.name||'').slice(0,80), email:String(body.email||'').slice(0,120), at:Date.now() });
      persist();
      const pos = db.waitlist.filter(w=>w.eventId===eventId).length;
      return send(200,{ ok:true, pos });
    }

    if(u.pathname==='/api/track'){
      db.track.push({ type:String(body.type||'?').slice(0,40), payload:body.payload||null, at:Date.now() });
      persist();
      return send(200,{ok:true});
    }

    return send(404,{error:'unknown endpoint'});
  }

  /* ---------- static ---------- */
  let p = decodeURIComponent(u.pathname);
  if(p==='/') p='/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if(!file.startsWith(ROOT)){ res.writeHead(403); return res.end(); }
  fs.readFile(file,(err,buf)=>{
    if(err){ res.writeHead(404); return res.end('not found'); }
    res.writeHead(200,{'Content-Type':MIME[path.extname(file).toLowerCase()]||'application/octet-stream'});
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', ()=> console.log('🍲 Potluck live on http://0.0.0.0:'+PORT+' (static + /api)'));
