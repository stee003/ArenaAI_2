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

/* ─── v6: server-authoritative pricing ───
   Early-bird tiers flip automatically as seats sell. The client only ever
   *displays* a price; the server decides what a seat actually costs and
   returns the unit price charged on every booking. */
const PRICES = {
  seoul:{price:68}, pastry:{price:28},
  pasta:{price:54,  early:{seats:4, price:46}},
  hotpot:{price:45, early:{seats:6, price:39}},
  mezze:{price:62,  early:{seats:8, price:52}},
  vermouth:{price:35},
  ramen:{price:40,  early:{seats:2, price:34}},
  bread:{price:72,  early:{seats:4, price:62}},
  amaro:{price:38,  early:{seats:6, price:32}},
};
const HOSTS = { seoul:'DK', pastry:'JP', pasta:'MB', hotpot:'LT', mezze:'OH', vermouth:'CL', ramen:'KS', bread:'PN', amaro:'WH' };
function priceSheet(id){
  if(PRICES[id]) return PRICES[id];
  const c = db.customEvents.find(e=>e.id===id);
  return c && c.price ? { price: Number(c.price)||40 } : { price: 40 };
}
function priceNow(id){
  const sheet = priceSheet(id), st = seatState(id), sold = (totals(id)||0) - st.left;
  if(sheet.early && sold < sheet.early.seats)
    return { now: sheet.early.price, tier:'early', earlyLeft: sheet.early.seats - sold, price: sheet.price };
  return { now: sheet.price, tier:'general', earlyLeft: 0, price: sheet.price };
}

/* ─── v6: the waitlist machine ───
   Freed seats don't just sit there: the first person in line gets a
   10-minute expiring claim window. Let it lapse and it rolls to the next
   human. Polling clients drive the sweep, so the machine keeps moving
   as long as anyone anywhere has the app open. */
function sweepOffers(){
  const now = Date.now(); let dirty = false;
  db.waitlist.forEach(w=>{
    if(w.offer && w.offer.exp <= now){
      db.waitlist = db.waitlist.filter(x=>x!==w); delete w.offer; db.waitlist.push(w); dirty = true;
    }
  });
  Object.keys(db.seats).forEach(id=>{
    const st = seatState(id);
    if(st.left < 1) return;
    if(db.waitlist.some(w=>w.eventId===id && w.offer)) return;
    const next = db.waitlist.find(w=>w.eventId===id && !w.offer);
    if(next){ next.offer = { exp: now + 10*60*1000, hold: 'H-'+Math.random().toString(36).slice(2,8).toUpperCase() }; dirty = true; }
  });
  if(dirty) persist();
}

/* ─── v6: seeded field notes so ratings are alive from first boot ─── */
const SEED_REVIEWS = [
  { id:'rv-seed1', eventId:'seoul',    name:'Marisol', stars:5, text:'Came alone, left with two dinner plans and a crush on the ssamjang.', at:1756400000000 },
  { id:'rv-seed2', eventId:'mezze',    name:'Sam',     stars:5, text:'The Fairuz record landed exactly as the knafeh came out. I\u2019m not saying I cried.', at:1757000000000 },
  { id:'rv-seed3', eventId:'hotpot',   name:'Alexis',  stars:5, text:'Sixteen strangers went quiet for twenty minutes straight. Then someone cried about the broth.', at:1757500000000 },
  { id:'rv-seed4', eventId:'vermouth', name:'Rae',     stars:4, text:'Waitlisted twice, worth every minute of the sulk. The midnight tortilla!', at:1757800000000 },
];

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
  return { seats, customEvents: [], bookings: [], waitlist: [], track: [], sessions: {}, otps: {}, reviews: SEED_REVIEWS.slice() };
}

let db;
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); if(!db.seats) throw 0; }
catch(e){ db = seed(); persist(); }
db.sessions = db.sessions || {};
db.otps = db.otps || {};
db.reviews = db.reviews || [];
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
  sweepOffers();   // lazy machine: anyone's poll moves offers along
  const seats = {}, taken = {}, waitlistCounts = {}, prices = {}, ratings = {}, payouts = {};
  for(const id of Object.keys(db.seats)){ seats[id] = db.seats[id].left; taken[id] = db.seats[id].taken; prices[id] = priceNow(id); }
  db.waitlist.forEach(w=>{ waitlistCounts[w.eventId] = (waitlistCounts[w.eventId]||0)+1 });
  db.reviews.forEach(r=>{
    const a = ratings[r.eventId] || (ratings[r.eventId] = { sum:0, n:0, quotes:[] });
    a.sum += r.stars; a.n++;
    a.quotes.push({ stars:r.stars, text:r.text, name:r.name, at:r.at });
  });
  Object.values(ratings).forEach(a=>{
    a.avg = Math.round(a.sum/a.n*10)/10;
    a.quotes.sort((x,y)=>y.at-x.at); a.quotes = a.quotes.slice(0,3); delete a.sum;
  });
  db.bookings.forEach(b=>{
    const cust = db.customEvents.find(e=>e.id===b.eventId);
    const av = HOSTS[b.eventId] || (cust && cust.av) || 'DK';
    const p = payouts[av] || (payouts[av] = { gross:0, n:0, parties:0 });
    p.gross += Number(b.total)||0; p.n += b.qty||1; p.parties++;
  });
  return { seats, taken, waitlistCounts, customEvents: db.customEvents, prices, ratings, payouts, serverTime: Date.now() };
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
    if(req.method==='GET' && u.pathname==='/api/me'){
      const token = u.searchParams.get('token')||'';
      const sess = db.sessions[token];
      if(!sess) return send(401,{error:'bad token'});
      const mine = db.bookings.filter(b=>b.user===sess.email);
      sweepOffers();
      const offers = db.waitlist
        .filter(w=>w.email===sess.email && w.offer && w.offer.exp>Date.now())
        .map(w=>({ eventId:w.eventId, exp:w.offer.exp, hold:w.offer.hold }));
      return send(200,{ email: sess.email, bookings: mine, offers });
    }
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
      const p = priceNow(eventId);   // server-authoritative unit price — read BEFORE seats move
      st.taken = st.taken.concat(reqSeats);
      st.left -= reqSeats.length;
      const code = 'PK-'+Math.random().toString(36).slice(2,6).toUpperCase();
      const sessUser = body.authToken && db.sessions[body.authToken] ? db.sessions[body.authToken].email : null;
      db.bookings.push({ code, eventId, seats:reqSeats, qty:reqSeats.length,
        name:String(name||'').slice(0,80), email:String(email||'').slice(0,120),
        diet:String(diet||'').slice(0,200), total:p.now*reqSeats.length, charged:Number(body.total)||null,
        price:p.now, user: sessUser, at:Date.now() });
      persist();
      return send(200,{ code, left: st.left, taken: st.taken, price: p.now, tier: p.tier, earlyLeft: p.earlyLeft });
    }

    if(u.pathname==='/api/cancel'){
      const i = db.bookings.findIndex(b=>b.code===body.code);
      if(i<0) return send(404,{error:'booking not found'});
      const b = db.bookings[i]; db.bookings.splice(i,1);
      const st = seatState(b.eventId);
      st.taken = st.taken.filter(s=>!b.seats.includes(s));
      st.left += b.qty;
      const hadWait = db.waitlist.some(w=>w.eventId===b.eventId);
      sweepOffers();   // freed seats start the claim-window clock for #1
      persist();
      return send(200,{ ok:true, promoted: hadWait, left: st.left, taken: st.taken });
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

    if(u.pathname==='/api/auth/request'){
      const email = String(body.email||'').trim().toLowerCase();
      if(!email || !email.includes('@')) return send(400,{error:'bad email'});
      const code = ''+Math.floor(100000+Math.random()*900000);
      db.otps[email] = { code, exp: Date.now()+10*60*1000 };
      persist();
      // demo build: can't send real email, so the one-time code returns in the response
      return send(200,{ ok:true, devCode: code });
    }

    if(u.pathname==='/api/auth/verify'){
      const email = String(body.email||'').trim().toLowerCase();
      const o = db.otps[email];
      if(!o || o.code!==String(body.code||'').trim() || o.exp<Date.now()) return send(401,{error:'bad code'});
      const token = 'tk_'+Math.random().toString(36).slice(2)+Date.now().toString(36);
      db.sessions[token] = { email, at: Date.now() };
      delete db.otps[email];
      persist();
      return send(200,{ ok:true, token, email });
    }

    if(u.pathname==='/api/checkin'){
      const code = String(body.code||'').trim().toUpperCase();
      const b = db.bookings.find(x=>x.code===code);
      if(!b) return send(404,{error:'not a valid ticket'});
      if(b.checkedIn) return send(200,{ status:'already', booking: b });
      b.checkedIn = Date.now(); persist();
      return send(200,{ status:'ok', booking: b });
    }

    if(u.pathname==='/api/waitlist/claim'){
      sweepOffers();
      const eventId = String(body.eventId||'');
      const hold = String(body.hold||'');
      const sessUser = body.authToken && db.sessions[body.authToken] ? db.sessions[body.authToken].email : null;
      const email = sessUser || String(body.email||'').trim().toLowerCase();
      const wi = db.waitlist.findIndex(w=>w.eventId===eventId && w.email===email && w.offer && w.offer.hold===hold);
      if(wi<0) return send(404,{error:'no live offer for you — it may have expired or rolled past you'});
      const w = db.waitlist[wi];
      if(w.offer.exp <= Date.now()){ sweepOffers(); return send(410,{error:'offer expired — the seat rolled to the next person'}); }
      const st = seatState(eventId), t = totals(eventId)||0;
      let seat = -1;
      for(let i=0;i<t;i++){ if(!st.taken.includes(i)){ seat = i; break; } }
      if(seat<0) return send(409,{ left: st.left, taken: st.taken });
      const p = priceNow(eventId);   // price as offered — BEFORE the seat moves
      st.taken.push(seat); st.left--;
      db.waitlist.splice(wi,1);
      const code = 'PK-'+Math.random().toString(36).slice(2,6).toUpperCase();
      db.bookings.push({ code, eventId, seats:[seat], qty:1, name:w.name||'Waitlist guest',
        email:email, diet:'', total:p.now, charged:p.now, price:p.now,
        user: sessUser, at:Date.now(), source:'waitlist' });
      sweepOffers();  // seats may remain — keep the machine moving
      persist();
      return send(200,{ code, seat, left: st.left, taken: st.taken, total: p.now, price: p.now, tier: p.tier });
    }

    if(u.pathname==='/api/review'){
      const sess = body.authToken && db.sessions[body.authToken];
      if(!sess) return send(401,{error:'sign in to leave a field note'});
      const b = db.bookings.find(x=>x.code===String(body.code||'').trim().toUpperCase());
      if(!b || b.user!==sess.email) return send(403,{error:'that ticket is not on your account'});
      if(!b.checkedIn) return send(403,{error:'reviews unlock after the host checks you in at the door'});
      if(b.reviewed) return send(409,{error:'already reviewed'});
      const stars = Math.max(1, Math.min(5, Math.round(Number(body.stars)||0)));
      db.reviews.push({ id:'rv'+Date.now().toString(36), eventId:b.eventId,
        name:String(b.name||sess.email.split('@')[0]).trim().split(' ')[0].slice(0,40),
        stars, text:String(body.text||'').slice(0,240), at:Date.now() });
      b.reviewed = true; persist();
      return send(200,{ ok:true });
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
