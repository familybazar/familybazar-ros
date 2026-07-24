/* ============================================================
   Family Bazar ROS — shared backend server
   Zero dependencies. Requires Node.js 18+ (uses built-in fetch).
   Run:   node server.js
   Then open the URL it prints. Tablets on the same WiFi use the
   LAN address (http://<your-pc-ip>:4000).
   ------------------------------------------------------------
   Files created next to this script at runtime:
     data.json     -> shared store data (products, inventory, etc.)
     secrets.json  -> API keys / tokens (NEVER sent to the browser)
   ============================================================ */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DIR     = __dirname;
// Where the store's data + keys live. On a cloud host set ROS_DATA_DIR to a PERSISTENT disk mount
// (e.g. /var/data) so data.json/secrets.json survive restarts and redeploys. Locally it defaults to
// the script folder, exactly as before.
const DATA_DIR = process.env.ROS_DATA_DIR || DIR;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e){}
const DATA    = path.join(DATA_DIR, 'data.json');
const SECRETS = path.join(DATA_DIR, 'secrets.json');
const PUBLIC  = path.join(DIR, 'public');
const PORT    = process.env.PORT || 4000;

const CATS = ['Grocery','Beverages','Snacks','Household','Health & Beauty',
              'Electronics','Baby','Pet','Frozen','Bakery','Tobacco','Other'];

/* ---------- tiny json file helpers ---------- */
function readJSON(file, fallback){ try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch(e){ return fallback; } }
function writeJSON(file, obj){ fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function uid(p){ return p+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function now(){ return new Date().toISOString(); }

/* ---------- initial data ---------- */
function emptyData(){ return { products:[], events:[], requests:[], searchLog:[], customers:[], invoices:[], supplierSkus:{}, movements:[], salesRollup:{}, salesTx:[], salesDaily:{}, salesMeta:{}, manualFinance:{ sales:[], expenses:[], settings:{ defaultGpPct:28 } }, nrsEmails:{}, nrsDaily:{}, nrsItems:[], nrsInventory:{}, nrsAggregate:null, nrsMeta:{}, billProviders:[], billDetections:{}, billMeta:{}, fulfillment:[], fulfillmentLocal:{}, version:1 }; }
if (!fs.existsSync(DATA))    writeJSON(DATA, emptyData());
if (!fs.existsSync(SECRETS)) writeJSON(SECRETS, {
  upcApiKey:'', aiProvider:'anthropic', aiApiKey:'', aiModel:'claude-haiku-4-5',
  cloverMerchantId:'', cloverApiToken:'', cloverBase:'https://api.clover.com',
  wooUrl:'', wooKey:'', wooSecret:'', wooAutoSync:false, wooPublishMode:'draft', wooOrderSync:false,
  cloverSalesSync:false, nrsAutoImport:false, nrsFolder:'',
  twilioSid:'', twilioToken:'', twilioFrom:'', sendgridKey:'', fromEmail:'', fromName:'Family Bazar',
  loyaltyPerDollar:1, loyaltyRewardPoints:100, loyaltyRewardValue:5
});

let data    = readJSON(DATA, emptyData());
let secrets = readJSON(SECRETS, {});
// Backfill new top-level stores onto an existing data.json (a loaded file doesn't get emptyData()'s keys).
['nrsEmails','nrsDaily','nrsInventory','nrsMeta','salesDaily','salesMeta','billDetections','billMeta'].forEach(k=>{
  if(!data[k] || typeof data[k]!=='object' || Array.isArray(data[k])) data[k]={};
});
if(!Array.isArray(data.nrsItems)) data.nrsItems=[];
if(!Array.isArray(data.salesTx))  data.salesTx=[];
if(!Array.isArray(data.billProviders)) data.billProviders=[];
if(data.nrsAggregate===undefined) data.nrsAggregate=null;
// Seed a default utility-bill provider (Con Edison) once, so email detection has a target out of the box.
if(!data.billProviders.some(p=>p.id==='coned')){
  data.billProviders.push({ id:'coned', name:'Con Edison', book:'general', category:'Utilities',
    senders:['coned.com','conedison.com'], subjectMatch:'', matchName:'Electric Bill', active:true, seeded:true });
}

// --- Secrets from environment (for cloud hosting) --------------------------------------------------
// So you never have to commit keys. Two ways, applied over whatever is in secrets.json:
//   1) ROS_SECRETS_JSON = '{"aiApiKey":"...","cloverApiToken":"..."}'  (one env var, whole blob)
//   2) ROS_SECRET_<key> = value   e.g. ROS_SECRET_aiApiKey, ROS_SECRET_imapPass
// Env values win at boot and are then persisted to the data dir like any other secret.
(function overlayEnvSecrets(){
  let changed = false;
  if (process.env.ROS_SECRETS_JSON){
    try { Object.assign(secrets, JSON.parse(process.env.ROS_SECRETS_JSON)); changed = true; }
    catch(e){ console.warn('  ROS_SECRETS_JSON is not valid JSON — ignored.'); }
  }
  for (const k of Object.keys(process.env)){
    if (k.startsWith('ROS_SECRET_')){ secrets[k.slice('ROS_SECRET_'.length)] = process.env[k]; changed = true; }
  }
  if (changed) { try { writeJSON(SECRETS, secrets); } catch(e){} }
})();

function saveData(){ writeJSON(DATA, data); }
function saveSecrets(){ writeJSON(SECRETS, secrets); }

/* ---------- http utils ---------- */
function send(res, code, obj, type){
  const body = type ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': type || 'application/json',
                        'Cache-Control':'no-store' });
  res.end(body);
}
function readBody(req){
  return new Promise((resolve)=>{
    let b=''; req.on('data', c=> { b+=c; if(b.length>5e7) req.destroy(); });
    req.on('end', ()=> { try{ resolve(b? JSON.parse(b): {}); }catch(e){ resolve({}); } });
  });
}
// Close any open strings/arrays/objects left by a truncated response (brackets inside strings ignored).
function balanceCloseJSON(t){
  let inStr=false, esc=false; const stack=[];
  for(let i=0;i<t.length;i++){ const c=t[i];
    if(inStr){ if(esc)esc=false; else if(c==='\\')esc=true; else if(c==='"')inStr=false; continue; }
    if(c==='"'){ inStr=true; continue; }
    if(c==='{'||c==='[') stack.push(c==='{'?'}':']');
    else if(c==='}'||c===']') stack.pop();
  }
  let out=t;
  for(let i=stack.length-1;i>=0;i--) out+=stack[i];
  return out;
}
// Resilient JSON extraction: handles ```code fences``` and, crucially, salvages a TRUNCATED response
// (e.g. hit max_tokens mid-invoice) by cutting to the last complete object and rebalancing brackets —
// so a long invoice yields the header + every complete line item instead of a silent blank.
// Returns { data, salvaged } — salvaged=true means the response was truncated and we recovered only
// the complete part, so the caller knows trailing items are missing and can fetch the rest.
function parseJSONLooseEx(text){
  if(!text) return { data:null, salvaged:false };
  let s = String(text).trim().replace(/^```[a-z]*\s*/i,'').replace(/\s*```$/,'').trim();
  const start = s.indexOf('{');
  if(start<0) return { data:null, salvaged:false };
  s = s.slice(start);
  const m = s.match(/\{[\s\S]*\}/);
  if(m){ try { return { data: JSON.parse(m[0]), salvaged:false }; } catch(e){} }
  try { return { data: JSON.parse(s), salvaged:false }; } catch(e){}
  const cut = s.lastIndexOf('}');
  if(cut>0){ try { return { data: JSON.parse(balanceCloseJSON(s.slice(0,cut+1))), salvaged:true }; } catch(e){} }
  return { data:null, salvaged:false };
}
function parseJSONLoose(text){ return parseJSONLooseEx(text).data; }

/* ---------- static files ---------- */
const MIME = {'.html':'text/html','.js':'text/javascript','.css':'text/css',
              '.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
function serveStatic(req, res){
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' ) p = '/preview.html';        // PB is now the primary ROS UI
  if (p === '/classic') p = '/index.html';    // old UI still reachable as a fallback
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[\/\\])+/,''));
  if (!file.startsWith(PUBLIC)) return send(res,403,{error:'forbidden'});
  fs.readFile(file, (err, buf)=>{
    if (err) return send(res,404,'Not found','text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

/* ============================================================
   AUTH — logins + roles (owner / manager / staff)
   Zero-dependency: scrypt password hashing + stateless HMAC-signed
   session cookies (no session store, so it survives cloud restarts
   and needs no sticky sessions). This is the gate that makes ROS
   safe to expose on a public URL.
   ============================================================ */
const ROLE_RANK = { staff:1, manager:2, owner:3 };
function roleAtLeast(user, min){ return !!user && (ROLE_RANK[user.role]||0) >= (ROLE_RANK[min]||99); }

// AUTH TOGGLE. Off for now so the site is public for review. Turn ON at the final stage with either
// env ROS_AUTH=1 or by setting "authEnabled": true in secrets.json. All the login machinery below
// stays intact — this only decides whether it is ENFORCED.
function authOn(){ return process.env.ROS_AUTH === '1' || secrets.authEnabled === true; }
// When auth is off, everyone is treated as an owner-level guest so the full UI works and nothing
// redirects to a login page.
const GUEST = { id:'guest', username:'guest', name:'Guest', role:'owner' };

function hashPw(pw, salt){ return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function makeUser(username, name, role, pw){
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: uid('u'), username: String(username).trim(), name: String(name||username).trim(),
           role: (ROLE_RANK[role]?role:'staff'), salt, hash: hashPw(pw, salt), createdAt: now() };
}
function checkPw(user, pw){
  try { const h = hashPw(pw, user.salt);
        return crypto.timingSafeEqual(Buffer.from(h,'hex'), Buffer.from(user.hash,'hex')); }
  catch(e){ return false; }
}
function authSecret(){
  if(!secrets.authSecret){ secrets.authSecret = crypto.randomBytes(32).toString('hex'); saveSecrets(); }
  return secrets.authSecret;
}
function signToken(payload){
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', authSecret()).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(tok){
  if(!tok || tok.indexOf('.')<0) return null;
  const [body, sig] = tok.split('.');
  const exp = crypto.createHmac('sha256', authSecret()).update(body).digest('base64url');
  try { if(sig.length!==exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null; }
  catch(e){ return null; }
  try { const p = JSON.parse(Buffer.from(body,'base64url').toString()); if(p.exp && Date.now()>p.exp) return null; return p; }
  catch(e){ return null; }
}
function parseCookies(req){
  const out={}; (req.headers.cookie||'').split(';').forEach(s=>{ const i=s.indexOf('='); if(i>0) out[s.slice(0,i).trim()]=decodeURIComponent(s.slice(i+1).trim()); });
  return out;
}
function currentUser(req){
  const p = verifyToken(parseCookies(req)['ros_session']);
  if(!p) return null;
  const u = (secrets.users||[]).find(x=>x.id===p.uid);
  return u ? { id:u.id, username:u.username, name:u.name, role:u.role } : null;
}
function setSessionCookie(res, req, tok, maxAgeSec){
  const https = (req.headers['x-forwarded-proto']||'').includes('https');
  const parts = [`ros_session=${tok||''}`, 'HttpOnly', 'Path=/', `Max-Age=${maxAgeSec}`, 'SameSite=Lax'];
  if(https) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
// First run: seed an owner. Password comes from ROS_OWNER_PASSWORD if set (cloud), else generated + printed once.
function ensureOwner(){
  if(!Array.isArray(secrets.users)) secrets.users = [];
  if(secrets.users.length) return;
  const envPw = (process.env.ROS_OWNER_PASSWORD||'').trim();
  const pw = envPw || crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g,'').slice(0,10);
  secrets.users.push(makeUser('owner','Owner','owner',pw));
  saveSecrets();
  if(!envPw){
    console.log('\n  *** ROS first-run owner login (shown once) ***');
    console.log('  Username: owner');
    console.log('  Password: '+pw);
    console.log('  Change it in Settings → Team after you log in.\n');
  }
}

// Which role an API path needs. Everything requires login; these need more. UI also hides controls,
// but the server is the real gate.
function requiredRole(url, method){
  if(method==='POST' && url==='/api/settings') return 'owner';           // API keys / integrations
  if(url.startsWith('/api/users')) return 'owner';                        // team management
  if(url==='/api/data/reset' || url==='/api/nrs/reset') return 'owner';   // destructive
  if(url==='/api/nrs/backfill') return 'manager';                        // preview-first, but writes on commit
  if(url.startsWith('/api/bills/')) return 'manager';                    // bill detection + confirm
  if(method==='POST' && (url==='/api/marketing/send' || url==='/api/woo/publish' ||
       url==='/api/catalog/publish-all' || url==='/api/invoices/post' || url==='/api/invoices/void' ||
       url==='/api/sales/clover/pull' || url==='/api/clover/rebuild'))
    return 'manager';
  return 'staff';   // any authenticated user
}
const AUTH_PUBLIC = new Set(['/login.html','/api/auth/login','/api/auth/logout','/api/auth/me',
  '/api/health','/favicon.ico','/manifest.webmanifest','/sw.js']);
function isPublicPath(url){ return AUTH_PUBLIC.has(url) || url.startsWith('/icons/'); }

/* ============================================================
   Integrations
   ============================================================ */

/* --- UPC / barcode lookup (UPCitemdb) --- */
async function upcLookup(barcode){
  const key = (secrets.upcApiKey||'').trim();
  const url = key
    ? `https://api.upcitemdb.com/prod/v1/lookup?upc=${encodeURIComponent(barcode)}`
    : `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`;
  const headers = key ? { 'user_key':key, 'key_type':'3scale' } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error('UPC lookup HTTP '+r.status);
  const j = await r.json();
  const item = j.items && j.items[0];
  if (!item) return null;
  return {
    name: item.title || '',
    brand: item.brand || '',
    description: item.description || '',
    category: item.category || '',
    image: (item.images && item.images[0]) || '',
    raw: { title:item.title, brand:item.brand, category:item.category }
  };
}

/* --- Open Food Facts family (free, no key, ~15/min): food, beauty, general --- */
async function offFetch(base, barcode){
  const url = `${base}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name,brands,generic_name,categories,image_url,image_front_url`;
  const r = await fetch(url, { headers:{ 'User-Agent':'FamilyBazarROS/1.0 (familybazarny.com)' } });
  if (!r.ok) return null;
  const j = await r.json();
  if (j.status !== 1 || !j.product) return null;
  const p = j.product;
  const name = (p.product_name || p.generic_name || '').trim();
  const image = p.image_front_url || p.image_url || '';
  if (!name && !image) return null;
  return {
    name,
    brand: (p.brands || '').split(',')[0].trim(),
    description: (p.generic_name || '').trim(),
    category: (p.categories || '').split(',').pop().trim(),
    image,
    raw: { title:name, brand:p.brands, category:p.categories }
  };
}
async function offLookup(barcode){
  for (const b of ['https://world.openfoodfacts.org','https://world.openbeautyfacts.org','https://world.openproductsfacts.org']){
    try { const res = await offFetch(b, barcode); if (res) return res; } catch(e){}
  }
  return null;
}

/* --- unified barcode lookup: Open Food Facts first (free), then UPCitemdb --- */
async function barcodeLookup(barcode){
  try { const off = await offLookup(barcode); if (off && (off.name || off.image)) { off._src='Open Food Facts'; return off; } } catch(e){}
  const u = await upcLookup(barcode);   // may throw (e.g. 429) if OFF found nothing
  if (u) { u._src = secrets.upcApiKey ? 'UPCitemdb' : 'UPCitemdb (trial)'; return u; }
  return null;
}

/* ===== PRODUCT NAMING + CATALOG HEALTH (unattended) =====
   Lifecycle: POS product → ROS sync → PUBLISH IMMEDIATELY → background cleanup/enrichment → auto-update.

   Publication is an OPERATIONAL decision, never a data-quality one. Every active, sellable product with
   a price goes to the website on the first pass, using the best name available at that moment — even if
   that is just the tidied register name. Enrichment then improves it in place, forever.

   nameScore is a CATALOG-HEALTH and PRIORITY metric only. It orders the work queue. It never blocks
   publication, and a product is never unpublished because enrichment failed or scored low.

   Naming rule: NORMALIZE, NEVER INVENT. Casing, spacing, punctuation, known shorthand and unmistakable
   misspellings may be fixed. Brand, variant, scent, size, count, pack quantity, compatibility and
   trademark claims may never be added without evidence. */

const BANNED_NAME_TOKENS = /(^|\s)(pcs|pc|pk|ea|inv|temp|misc|item|items|sku|dept|asst|asstd|new\s?item|store\s?item|unknown|n\/a)(\s|$)/i;
const SIZE_HINT = /(\d+\s?(oz|ml|l|g|kg|lb|ct|count|pack|pk|pcs|piece|pieces|sheet|sheets|ft|in|inch|mm|cm|w|v|mah|gb|tb))|(\d+\s?-\s?pack)|(\bpack of \d+)/i;
const INTERNAL_CODE = /^[A-Za-z]{1,3}\d{2,}$|^\d{2,}[A-Za-z]{1,3}$/;

// 0–100 with human-readable reasons. Deterministic, no AI, no cost.
function nameScore(rawName){
  const name = String(rawName||'').trim();
  const reasons = [];
  if(!name) return { score:0, reasons:['empty name'] };
  const words = name.split(/\s+/).filter(Boolean);
  let score = 100;
  if(words.length <= 1){ score -= 40; reasons.push('brand/word only — no product type'); }
  else if(words.length === 2){ score -= 15; reasons.push('very short name'); }
  if(name.length < 6){ score -= 20; reasons.push('too short'); }
  if(!/[a-z]/.test(name)){ score -= 10; reasons.push('ALL CAPS'); }
  if(BANNED_NAME_TOKENS.test(name)){ score -= 15; reasons.push('contains register/supplier shorthand'); }
  if(words.some(w=>INTERNAL_CODE.test(w.replace(/[^A-Za-z0-9]/g,'')))){ score -= 20; reasons.push('contains an internal/manufacturer code'); }
  if(!SIZE_HINT.test(name)){ score -= 10; reasons.push('no size or count'); }
  const norm = w => w.toLowerCase().replace(/[^a-z0-9]/g,'');
  for(let i=1;i<words.length;i++){ if(norm(words[i]) && norm(words[i])===norm(words[i-1])){ score -= 10; reasons.push('duplicated word'); break; } }
  score = Math.max(0, Math.min(100, score));
  return { score, reasons };
}

// A name is "weak" (enrichment priority) below this. It has NO effect on publication.
function weakNameBelow(){ const n = Number(secrets.weakNameScore); return Number.isFinite(n) ? n : 80; }

/* --- PUBLICATION: operational availability only ------------------------------------------------
   Active + sellable + priced. Not name quality, not barcode, not image, not enrichment success. */
function isPublishable(p){
  if(!p) return false;
  if(p.publishLock) return !!p.websiteEnabled;              // explicit staff override, either way
  if(p.archived || p.deleted) return false;
  if(p.active === false || p.status === 'INACTIVE') return false;
  if(!String(p.name||'').trim()) return false;              // not a real record
  return Number(p.retailPrice) > 0;                          // current storefront rule
}
function applyPublishState(p){
  if(p.publishLock) return !!p.websiteEnabled;
  const ok = isPublishable(p);
  p.websiteEnabled = ok;
  return ok;
}

/* --- DATA-QUALITY FLAGS: internal only. Never gate the website. --------------------------------- */
const QUALITY_FLAGS = ['MISSING_BARCODE','MISSING_IMAGE','WEAK_DISPLAY_NAME','MISSING_SIZE_OR_COUNT',
  'CATEGORY_UNVERIFIED','BRAND_UNKNOWN','BARCODE_LOOKUP_FAILED','POSSIBLE_DUPLICATE','POS_ONLY_DATA',
  'ENRICHMENT_PENDING'];
const BROAD_CATEGORIES = new Set(['','general','general merchandise','misc','miscellaneous','other','uncategorized','store','grocery']);

let _dupIndex = null;   // built lazily per health/flag pass: normalized displayName → count
function dupKey(p){ return String(p.displayName || p.name || '').toLowerCase().replace(/[^a-z0-9]/g,''); }
function buildDupIndex(){
  const m = new Map();
  for(const p of (data.products||[])){ const k = dupKey(p); if(!k) continue; m.set(k, (m.get(k)||0)+1); }
  _dupIndex = m;
}
function computeFlags(p){
  if(!_dupIndex) buildDupIndex();
  const f = [];
  const name = String(p.displayName || p.name || '');
  if(!String(p.barcode||'').replace(/\D/g,'')) f.push('MISSING_BARCODE');
  if(!String(p.image||p.imageUrl||'').trim()) f.push('MISSING_IMAGE');
  // Score on the fly when the worker hasn't reached this product yet, so the dashboard tells the
  // truth immediately instead of reading 0 until the whole catalog has been walked.
  const score = p.nameScore != null ? p.nameScore : nameScore(name).score;
  if(score < weakNameBelow()) f.push('WEAK_DISPLAY_NAME');
  if(!SIZE_HINT.test(name)) f.push('MISSING_SIZE_OR_COUNT');
  if(BROAD_CATEGORIES.has(String(p.category||'').trim().toLowerCase())) f.push('CATEGORY_UNVERIFIED');
  if(!String(p.brand||'').trim()) f.push('BRAND_UNKNOWN');
  if(p.lookupFailedAt) f.push('BARCODE_LOOKUP_FAILED');
  if((_dupIndex.get(dupKey(p))||0) > 1) f.push('POSSIBLE_DUPLICATE');
  if(!p.nameSource || p.nameSource === 'pos' || p.nameSource === 'rules') f.push('POS_ONLY_DATA');
  if(p.nameCheckedAt == null) f.push('ENRICHMENT_PENDING');
  return f;
}

/* --- NAME SOURCE HIERARCHY -----------------------------------------------------------------------
   1 verified manufacturer / barcode-database title
   2 structured invoice title
   3 trusted supplier mapping
   4 safely cleaned POS name
   5 original POS name (final fallback — always yields something publishable)          */
async function resolveDisplayName(p){
  const posRaw = String(p.name||'').trim();
  const cleaned = ruleName(posRaw) || posRaw;

  // 1 — barcode database (real manufacturer evidence)
  const bc = String(p.barcode||'').replace(/\D/g,'');
  if(bc.length >= 8){
    try{
      const found = await barcodeLookup(bc);
      const dbName = String((found&&found.name)||'').trim();
      if(dbName){
        delete p.lookupFailedAt; p.lookupTries = 0;
        if(!p.brand && found.brand) p.brand = found.brand;
        if(!p.image && !p.imageUrl && found.image){ p.image = found.image; p.imageSource = found._src || 'barcode db'; }
        return { name: ruleName(dbName) || dbName, src: found._src || 'barcode db' };
      }
      p.lookupFailedAt = now(); p.lookupTries = (p.lookupTries||0) + 1;   // found nothing → retry later
    }catch(e){
      p.lookupFailedAt = now(); p.lookupTries = (p.lookupTries||0) + 1;   // rate-limited/offline → retry later
    }
  }
  // 2 — structured invoice title captured at receiving
  const inv = String(p.invoiceTitle||'').trim();
  if(inv) return { name: ruleName(inv) || inv, src: 'invoice' };
  // 3 — trusted supplier mapping
  const sup = String(p.supplierTitle||'').trim();
  if(sup) return { name: ruleName(sup) || sup, src: 'supplier' };
  // 4 / 5 — cleaned POS name, else the raw POS name. Always publishable.
  return cleaned ? { name: cleaned, src: 'rules' } : { name: posRaw, src: 'pos' };
}

/* --- IMAGE HIERARCHY: best available, placeholder last. Never blocks publication. --------------- */
const CATEGORY_PLACEHOLDER = '/img/placeholder.svg';
function bestImage(p){
  return String(p.image || p.imageUrl || p.supplierImage || p.storePhoto || '').trim() || CATEGORY_PLACEHOLDER;
}

/* --- The autonomous worker ----------------------------------------------------------------------
   Priority: never-processed first, then failed lookups due a retry, then weak/incomplete records. */
const LOOKUP_RETRY_HOURS = 72;
function enrichmentQueue(){
  const out = [];
  const retryBefore = Date.now() - LOOKUP_RETRY_HOURS*3600*1000;
  for(const p of (data.products||[])){
    if(!p || p.nameLocked) continue;
    if(p.nameCheckedAt == null){ out.push([0,p]); continue; }                       // never processed
    const failedDue = p.lookupFailedAt && Date.parse(p.lookupFailedAt) < retryBefore && (p.lookupTries||0) < 8;
    if(failedDue){ out.push([1,p]); continue; }                                     // retry a failed lookup
    const stale = Date.parse(p.nameCheckedAt||0) < Date.now() - 30*24*3600*1000;
    if((p.nameScore != null && p.nameScore < weakNameBelow()) && stale){ out.push([2,p]); }  // revisit weak
  }
  out.sort((a,b)=> a[0]-b[0] || (Number(+b[1].qty>0) - Number(+a[1].qty>0)));        // in-stock first within tier
  return out.map(x=>x[1]);
}

// PUBLISH PASS — instant, no network, and deliberately INDEPENDENT of the enrichment toggle.
// Turning enrichment off must never stop products reaching the website.
function publishTick(){
  let publishedNow = 0;
  for(const p of (data.products||[])){
    if(!p) continue;
    const was = !!p.websiteEnabled;
    if(applyPublishState(p) && !was) publishedNow++;
  }
  if(publishedNow) saveData();
  return publishedNow;
}

async function autoNameTick(limit){
  const publishedNow = publishTick();
  if(!secrets.autoNaming) return { skipped:true, publishedNow };

  const queue = enrichmentQueue();
  const batch = queue.slice(0, limit || 20);
  let processed = 0, improved = 0;
  for(const p of batch){
    try{
      const r = await resolveDisplayName(p);
      // Never downgrade a name that already reads better (protects hand-written and earlier evidence).
      const prev = String(p.displayName||'').trim();
      const better = (prev && nameScore(prev).score > nameScore(r.name).score) ? prev : r.name;
      if(better !== prev) improved++;
      const s = nameScore(better);
      p.displayName = better;
      p.nameScore  = s.score;         // health metric ONLY — publication is untouched by it
      p.nameIssues = s.reasons;
      if(better === r.name) p.nameSource = r.src;
      p.nameCheckedAt = now();
      if(!p.image && !p.imageUrl) p.imageFallback = bestImage(p);
      processed++;
    }catch(e){ /* failure isolation: one bad product never stops the run */ }
    await new Promise(r=>setTimeout(r, 350));
  }
  _dupIndex = null;
  for(const p of batch){ try{ p.qualityFlags = computeFlags(p); }catch(e){} }
  saveData();
  return { processed, improved, publishedNow, remaining: Math.max(0, queue.length - batch.length) };
}

/* --- Catalog health dashboard ------------------------------------------------------------------- */
function catalogHealth(){
  const all = (data.products||[]).filter(Boolean);
  _dupIndex = null; buildDupIndex();
  const counts = {}; QUALITY_FLAGS.forEach(f=>counts[f]=0);
  let published = 0, fullyEnriched = 0;
  for(const p of all){
    if(p.websiteEnabled) published++;
    const f = computeFlags(p);
    p.qualityFlags = f;
    f.forEach(x=>{ if(counts[x]!=null) counts[x]++; });
    if(!f.length) fullyEnriched++;
  }
  return { total: all.length, published, fullyEnriched, flags: counts,
    weakNameBelow: weakNameBelow(), autoNaming: !!secrets.autoNaming,
    queued: enrichmentQueue().length };
}
function productsByFlag(flag, limit){
  const out = [];
  _dupIndex = null;
  for(const p of (data.products||[])){
    if(!p) continue;
    if(computeFlags(p).includes(flag)){
      out.push({ id:p.id, name:p.name, displayName:p.displayName||'', barcode:p.barcode||'',
        brand:p.brand||'', category:p.category||'', nameScore:p.nameScore==null?null:p.nameScore,
        qty:p.qty, price:p.retailPrice, published:!!p.websiteEnabled });
      if(out.length >= (limit||200)) break;
    }
  }
  return out;
}

/* --- Image coverage checker (READ-ONLY): estimate how many barcoded products WITHOUT a photo would
   get one from the free/existing sources, so a paid subscription is a data-backed decision, not a
   guess. Samples a random subset (gentle on the free APIs) and extrapolates. Changes nothing. --- */
async function imageCoverage(sampleSize){
  const all = data.products || [];
  const hasImg = (p)=> !!(String(p.image||'').trim());
  const withImage = all.filter(hasImg).length;
  const noImage = all.filter(p=>!hasImg(p));
  const sampleable = noImage.filter(p=> String(p.barcode||'').replace(/\D/g,'').length >= 8);

  // shuffle a copy, take N
  const pool = sampleable.slice();
  for(let i=pool.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=pool[i]; pool[i]=pool[j]; pool[j]=t; }
  const n = Math.min(Math.max(1, sampleSize||50), pool.length, 200);
  const sample = pool.slice(0, n);

  let matched=0, off=0, upc=0, errors=0; const examples=[];
  for(const p of sample){
    const bc = String(p.barcode).replace(/\D/g,'');
    try{
      const res = await barcodeLookup(bc);
      if(res && String(res.image||'').trim()){
        matched++;
        if(/open food/i.test(res._src||'')) off++; else upc++;
        if(examples.length<8) examples.push({ name:p.name||p.displayName||'', barcode:bc, src:res._src||'', image:res.image });
      }
    }catch(e){ errors++; }
    await new Promise(r=>setTimeout(r, 350));   // respect free-API rate limits
  }
  const pct = n ? Math.round((matched/n)*100) : 0;
  return {
    totalProducts: all.length,
    withImage,
    withoutImage: noImage.length,
    sampleable: sampleable.length,                 // no photo + has a scannable barcode
    noBarcode: noImage.length - sampleable.length, // can only be covered by a staff photo
    sampled: n,
    matched,
    coveragePct: pct,
    bySource: { off, upcitemdb: upc },
    estimatedNewImages: Math.round(sampleable.length * (pct/100)),
    errors,
    examples,
    upcKeySet: !!(secrets.upcApiKey||'').trim(),
  };
}

/* --- name-based image search (free, Open Food Facts) for items with NO barcode ---
   Gated by word overlap so we NEVER attach an unrelated photo: a candidate must share at least
   2 significant words with the product name AND cover >=50% of the name's words. --- */
function normWords(s){
  return String(s||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w.length>2);
}
function nameMatch(query, candidate){
  const A = normWords(query); if (A.length < 2) return { shared:0, ratio:0 };
  const B = new Set(normWords(candidate));
  let shared = 0; for (const w of new Set(A)) if (B.has(w)) shared++;
  return { shared, ratio: shared / new Set(A).size };
}
async function offSearchByName(name){
  const q = String(name||'').trim();
  if (q.length < 4 || normWords(q).length < 2) return null;
  for (const base of ['https://world.openfoodfacts.org','https://world.openbeautyfacts.org','https://world.openproductsfacts.org']){
    try {
      const url = `${base}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=6&fields=product_name,brands,image_front_url,image_url`;
      const r = await fetch(url, { headers:{ 'User-Agent':'FamilyBazarROS/1.0 (familybazarny.com)' } });
      if (!r.ok) continue;
      const j = await r.json();
      for (const p of (j.products || [])){
        const img = p.image_front_url || p.image_url || '';
        if (!img) continue;
        const m = nameMatch(q, [p.product_name, p.brands].filter(Boolean).join(' '));
        if (m.shared >= 2 && m.ratio >= 0.5) return { image: img, _src: 'Open Food Facts (name)' };
      }
    } catch(e){}
  }
  return null;
}

/* --- unified image lookup: real barcode DBs first, then safe name search --- */
async function imageLookup(p){
  if (p.barcode){
    try { const raw = await barcodeLookup(p.barcode); if (raw && raw.image) return { image: raw.image, src: raw._src || 'barcode' }; } catch(e){}
  }
  try { const n = await offSearchByName(p.name); if (n && n.image) return { image: n.image, src: n._src }; } catch(e){}
  return null;
}

// In-stock products first, so shoppable items get pictures before the rest of the catalog.
const inStockFirst = (a, b) => (Number(+b.qty > 0) - Number(+a.qty > 0));

/* --- AI enrichment (Anthropic or OpenAI) --- */
async function aiEnrich(rawInfo, barcode){
  const key = (secrets.aiApiKey||'').trim();
  if (!key) return null;
  const provider = secrets.aiProvider || 'anthropic';
  const model = aiModelName();
  const prompt =
`You are a retail catalog assistant for a neighborhood grocery/convenience store.
Given the raw product data below, produce clean catalog fields.
Return ONLY a JSON object with keys:
  name (clear shelf title, <= 60 chars),
  brand,
  category (MUST be exactly one of: ${CATS.join(', ')}),
  subcategory (short, e.g. "Soda", "Cereal", "Oral Care"),
  description (one helpful sentence, <= 160 chars),
  tags (array of 3-6 lowercase keywords).
Barcode: ${barcode||'unknown'}
Raw data: ${JSON.stringify(rawInfo||{})}`;

  const text = await aiText(prompt, 600);   // resilient: auto-picks a working model
  return parseJSONLoose(text);
}

/* --- product-name polish: rule-based cleanup + AI for the genuinely cryptic ones -------------
   Writes p.displayName (customer-facing) and NEVER touches p.name (kept for register matching). */
const _NAME_ACR = new Set(["USB","LED","LCD","OLED","HDMI","TV","PVC","EVA","ABS","XL","XXL","XS","SD","HD","AA","AAA","AC","DC","3D","ID","US","USA","NY","SPF","UV","BBQ","DIY","PU","RGB","IP","ML","OZ","LB","FT"]);
const _NAME_ABBR = { rzrs:"Razors", rzr:"Razor", asst:"Assorted", asstd:"Assorted", pk:"Pack", pkt:"Packet", pcs:"Pieces", ct:"Count", "w/":"with", blk:"Black", wht:"White", grn:"Green", yel:"Yellow", ylw:"Yellow", choc:"Chocolate", med:"Medium", lg:"Large", sm:"Small", pr:"Pair", btl:"Bottle", cont:"Container", dispsble:"Disposable", disp:"Disposable", stnls:"Stainless", plas:"Plastic", asrt:"Assorted" };
function ruleName(raw){
  let s = String(raw==null?"":raw).trim();
  if(!s) return "";
  s = s.replace(/^[^A-Za-z0-9]+/,"").replace(/\s+/g," ").trim();
  if(!s) return "";
  const words = s.split(" ").map(w=>{
    const bare = w.toLowerCase().replace(/[^a-z0-9/]/g,"");
    if(_NAME_ABBR[bare]) return _NAME_ABBR[bare];
    const up = w.toUpperCase().replace(/[^A-Z0-9]/g,"");
    if(_NAME_ACR.has(up)) return up;
    if(/^\d/.test(w)) return w.toLowerCase();
    if(/[a-z]/.test(w) && /[A-Z]/.test(w) && w[0]===w[0].toUpperCase()) return w;
    return w.charAt(0).toUpperCase()+w.slice(1).toLowerCase();
  });
  return words.join(" ").replace(/^./, c=>c.toUpperCase());
}
// Only spend AI on genuinely cryptic names; ALL-CAPS/normal names are fixed for free by ruleName.
function nameNeedsAI(s){
  s = String(s||"").trim(); if(!s) return false;
  const hasAbbrev = /\b(rzrs?|asstd?|asst|stnls|dispsble|disp|plas|blk|wht|grn|ylw|choc|pkt|cont|btl|asrt)\b/i.test(s);
  const startsJunk = /^[^A-Za-z0-9]/.test(s) || /^\d+\s+\d/.test(s);   // leading symbol, or "10 2 ..." garble
  const nonAscii = /[^\x20-\x7E]/.test(s);
  const veryShort = s.replace(/[^A-Za-z]/g,"").length < 5 && s.split(/\s+/).length <= 2;
  return hasAbbrev || startsJunk || nonAscii || veryShort;
}
async function aiCleanNames(items){
  const lines = items.map((p,i)=>`${i}. raw: ${JSON.stringify(String(p.name||"").slice(0,80))} | brand: ${JSON.stringify(p.brand||"")} | category: ${JSON.stringify(p.category||"")}`).join("\n");
  const prompt =
`You clean product names for a neighborhood variety/dollar store website.
Rewrite each raw cash-register name into a short, clear, human product title.
Rules: Title Case; expand obvious abbreviations (rzrs=razors, pk=pack, ct=count, asst=assorted, stnls=stainless); keep size/count/color EXACTLY as given; add the brand only if given and not already in the name; drop register codes and stray leading numbers/symbols that are not a real quantity; max 60 characters.
CRITICAL — NORMALIZE ONLY, NEVER INVENT. You may fix spelling, spacing and casing of words that are present. You may NOT add a brand, variant, scent, flavour, size, count or pack quantity that is not in the input, and you may NOT guess at a cryptic name. Correct an obvious misspelling of a real brand only when it is unmistakable (e.g. "VASELIN" -> "Vaseline"); if you are unsure what the product is, return the cleaned-up input as-is rather than inventing a plausible product.
Return ONLY a JSON array, one object per item, same indexes: [{"i":0,"title":"..."}]
Items:
${lines}`;
  const arr = parseJSONLoose(await aiText(prompt, 1500));
  if(!Array.isArray(arr)) return null;
  const out = new Array(items.length).fill(null);
  for(const o of arr){ if(o && typeof o.i==="number" && typeof o.title==="string") out[o.i]=o.title.trim(); }
  return out;
}
async function polishNames(limit){
  if(!(secrets.aiApiKey||"").trim()) throw new Error("Add an AI key in Settings first.");
  let list = (data.products||[]).filter(p=>(p.name||"").trim() && !p.displayName);
  list.sort((a,b)=> (Number(+b.qty>0) - Number(+a.qty>0)));      // in-stock first
  list = list.slice(0, Math.min(limit||150, 800));
  let ai=0, rule=0, failed=0;
  const queue=[];
  for(const p of list){
    if(nameNeedsAI(p.name)) queue.push(p);
    else { p.displayName = ruleName(p.name); rule++; }
  }
  for(let i=0;i<queue.length;i+=20){
    const chunk = queue.slice(i,i+20);
    let titles=null;
    try { titles = await aiCleanNames(chunk); } catch(e){ /* fall back to rule-based below */ }
    chunk.forEach((p,idx)=>{
      const t = titles && titles[idx];
      if(t && t.length>=3){ p.displayName = t.slice(0,70); ai++; }
      else { p.displayName = ruleName(p.name); failed++; }
    });
    await new Promise(r=>setTimeout(r,400));
  }
  saveData();
  const remaining = (data.products||[]).filter(p=>(p.name||"").trim() && !p.displayName).length;
  return { processed:list.length, ai, rule, failed, remaining };
}

/* --- resolve the AI model name (auto-fix the deprecated alias) --- */
function aiModelName(){
  const provider = secrets.aiProvider || 'anthropic';
  let m = (secrets.aiModel||'').trim();
  if (!m) m = provider==='openai' ? 'gpt-4o-mini' : 'claude-haiku-4-5';
  if (/^claude-3-5-haiku-latest$/i.test(m)) m = 'claude-haiku-4-5';  // old alias no longer valid
  return m;
}

/* --- free-text AI helper (for insights/recommendations) --- */
async function aiText(prompt, maxTokens){
  const key = (secrets.aiApiKey||'').trim();
  if (!key) throw new Error('Add an AI key in Settings to use AI features.');
  const provider = secrets.aiProvider || 'anthropic';
  maxTokens = maxTokens || 800;
  if (provider === 'openai'){
    const candidates = [...new Set([aiModelName(),'gpt-4o-mini','gpt-4o'])];
    let lastErr='';
    for (const model of candidates){
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method:'POST', headers:{ 'Authorization':'Bearer '+key, 'Content-Type':'application/json' },
        body: JSON.stringify({ model, max_tokens:maxTokens, messages:[{role:'user', content:prompt}] }) });
      const j = await r.json();
      if (j.error){ lastErr = j.error.message||'OpenAI error'; if (/model/i.test(lastErr)) continue; throw new Error(lastErr); }
      return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    }
    throw new Error('No usable OpenAI model. Last error: '+lastErr);
  }
  // Anthropic — try a few model names so a renamed/retired alias can't break it.
  const candidates = [...new Set([aiModelName(),'claude-haiku-4-5','claude-haiku-4-5-20251001','claude-3-5-haiku-20241022','claude-sonnet-4-5','claude-sonnet-4-6'])];
  let lastErr='';
  for (const model of candidates){
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{ 'x-api-key':key, 'anthropic-version':'2023-06-01', 'Content-Type':'application/json' },
      body: JSON.stringify({ model, max_tokens:maxTokens, messages:[{role:'user', content:prompt}] }) });
    const j = await r.json();
    if (j.error){
      lastErr = (j.error.message||'') + (j.error.type?(' ['+j.error.type+']'):'');
      const t = (j.error.type||'')+' '+(j.error.message||'');
      if (/not_found|model/i.test(t)) continue;        // try next model
      throw new Error(lastErr);                          // auth/credit/other -> report
    }
    return (j.content && j.content[0] && j.content[0].text) || '';
  }
  throw new Error('No Claude model worked with your key. Tried: '+candidates.join(', ')+'. Last error: '+lastErr);
}

/* --- combined catalog lookup used by the UI --- */
async function catalogLookup(barcode){
  const out = { barcode, found:false, source:[], suggestion:null, notes:[] };
  let raw = null;
  try {
    raw = await barcodeLookup(barcode);
    if (raw){ out.found = true; out.source.push(raw._src || 'barcode DB'); }
    else out.notes.push('No barcode match found in the free product databases.');
  } catch(e){ out.notes.push('Barcode lookup unavailable: '+e.message); }

  let ai = null;
  if (raw || barcode){
    try {
      ai = await aiEnrich(raw, barcode);
      if (ai) out.source.push('AI ('+(secrets.aiProvider||'anthropic')+')');
    } catch(e){ out.notes.push('AI step skipped: '+e.message); }
  }

  // Build a suggestion, preferring AI fields, falling back to raw lookup
  const base = raw || {};
  const sug = {
    barcode,
    name: (ai && ai.name) || base.name || '',
    brand: (ai && ai.brand) || base.brand || '',
    category: (ai && ai.category && CATS.includes(ai.category)) ? ai.category : guessCat(base.category),
    subcategory: (ai && ai.subcategory) || '',
    description: (ai && ai.description) || base.description || '',
    image: base.image || '',
    tags: (ai && ai.tags) || []
  };
  out.suggestion = sug;
  if (!secrets.aiApiKey) out.notes.push('AI key not set — add it in Settings for auto-written titles/descriptions.');
  return out;
}
function guessCat(c){
  if(!c) return 'Other';
  c = c.toLowerCase();
  if(/bever|drink|soda|water|juice|coffee|tea/.test(c)) return 'Beverages';
  if(/snack|chip|candy|cooky|cookie|chocolate/.test(c)) return 'Snacks';
  if(/baby|infant|diaper/.test(c)) return 'Baby';
  if(/pet|dog|cat/.test(c)) return 'Pet';
  if(/electronic|cable|charger|batter/.test(c)) return 'Electronics';
  if(/health|beauty|personal|hair|oral|medic/.test(c)) return 'Health & Beauty';
  if(/clean|household|paper|laundry/.test(c)) return 'Household';
  if(/frozen/.test(c)) return 'Frozen';
  if(/bak|bread/.test(c)) return 'Bakery';
  if(/grocer|food|pantry|can/.test(c)) return 'Grocery';
  return 'Other';
}

/* --- bulk enrich: fill category/image/description/brand for items missing them --- */
function needsEnrich(p){
  return (!p.category || p.category==='Other') || !p.image || !p.description || !p.brand;
}
async function enrichProducts(list, limit){
  let processed=0, catSet=0, imgSet=0, descSet=0, brandSet=0, failed=0;
  for (const p of list){
    if (processed >= limit) break;
    if (!needsEnrich(p)) continue;
    processed++;
    const needCat = (!p.category || p.category==='Other');
    const needImg = !p.image, needDesc = !p.description, needBrand = !p.brand;
    try {
      // 1) Best-effort image from the free barcode DBs (Open Food Facts first, then UPCitemdb).
      let raw = null;
      if (needImg && p.barcode){ try { raw = await barcodeLookup(p.barcode); } catch(e){} }
      // 2) AI works from the product's OWN name (from Clover/NRS) — no barcode lookup needed.
      let ai = null;
      try { ai = await aiEnrich({ name:p.name, brand:p.brand, category:p.category, upc:(raw||{}).raw }, p.barcode); } catch(e){}
      const bad = s => !s || /^(unknown|unspecified|n\/a|product)$/i.test(String(s).trim()) || /not available/i.test(String(s));
      if (ai){
        if (needCat  && ai.category && CATS.includes(ai.category) && ai.category!=='Other'){ p.category=ai.category; catSet++; }
        if (ai.subcategory && !bad(ai.subcategory) && !p.subcategory) p.subcategory=ai.subcategory;
        if (needDesc && !bad(ai.description)){ p.description=ai.description; descSet++; }
        if (needBrand&& !bad(ai.brand)){ p.brand=ai.brand; brandSet++; }
      }
      if (needImg && raw && raw.image){ p.image=raw.image; imgSet++; }
      else if (needImg && !p.image){
        // No barcode image — try a safe name-based search (free) before giving up.
        try { const n = await offSearchByName(p.name); if (n && n.image){ p.image=n.image; imgSet++; } } catch(e){}
      }
      p.lastUpdated = now();
    } catch(e){ failed++; }
    await new Promise(r=>setTimeout(r, 250));
  }
  return { processed, catSet, imgSet, descSet, brandSet, failed };
}

/* --- Clover live import (read items from Clover) --- */
async function cloverImport(){
  const mId   = (secrets.cloverMerchantId||'').trim();
  const token = (secrets.cloverApiToken||'').trim();
  const base  = (secrets.cloverBase||'https://api.clover.com').trim();
  if (!mId || !token) throw new Error('Clover merchant ID and API token are required (set them in Settings).');
  // Pull cost + Clover's own stock count (money is in cents; stock lives in itemStock).
  const url = `${base}/v3/merchants/${mId}/items?limit=1000&expand=categories,itemStock`;
  const r = await fetch(url, { headers:{ Authorization:'Bearer '+token } });
  if (!r.ok) throw new Error('Clover API HTTP '+r.status+' — check token/merchant ID.');
  const j = await r.json();
  const items = j.elements || [];
  let imported = 0, updated = 0;
  for (const it of items){
    const barcode = it.code || '';
    const sku = it.sku || it.code || '';
    const price = typeof it.price === 'number' ? +(it.price/100).toFixed(2) : null;
    const cost  = typeof it.cost  === 'number' ? +(it.cost/100).toFixed(2)  : null;
    const posQty = (it.itemStock && typeof it.itemStock.quantity === 'number') ? it.itemStock.quantity : null;
    const cat = (it.categories && it.categories.elements && it.categories.elements[0] && it.categories.elements[0].name) || '';
    const existing = data.products.find(p =>
      (p.cloverId && p.cloverId === it.id) ||
      (sku && p.sku === sku) || (barcode && p.barcode && p.barcode === barcode));
    if (existing){
      // POS is authoritative for the raw name, retail price and (as a hint) raw category. It is NOT
      // authoritative for cost (invoices are) or the customer-facing displayName/publicCategory.
      existing.name = it.name || existing.name;
      if (price != null) existing.retailPrice = price;
      if (cat) existing.category = cat;
      if (cost != null && existing.costPrice == null) existing.costPrice = cost; // don't clobber invoice cost
      if (posQty != null) existing.posQty = posQty;                              // reference only
      existing.source = 'Clover'; existing.cloverId = it.id;
      existing.lastUpdated = now();
      updated++;
    } else {
      data.products.push({
        id: uid('p'), sku: sku || uid('SKU').toUpperCase(), barcode,
        name: it.name || 'Unnamed item', brand:'', category: cat || 'Other', subcategory:'',
        description:'', image:'',
        costPrice: cost, retailPrice: price, salePrice:null,
        // Stock is UNKNOWN until a real count/receipt — NOT 0. posQty keeps Clover's number for reference.
        qty:0, stockKnown:false, needsCount:true, posQty,
        needsPrice: price == null,
        reorderThreshold:5, overstockThreshold:50,
        aisle:'', shelf:'', bin:'', supplier:'Clover', source:'Clover', cloverId: it.id,
        amazonEnabled:false, walmartEnabled:false, tiktokEnabled:false, websiteEnabled:false,
        dateAdded:now(), lastUpdated:now(), status:'Active', lastSale:null, lastRestock:null
      });
      imported++;
    }
  }
  saveData();
  return { imported, updated, total: items.length };
}

/* --- Clover item identifiers (for source tagging) --- */
async function cloverIdentifiers(){
  const mId=(secrets.cloverMerchantId||'').trim(), token=(secrets.cloverApiToken||'').trim(), base=(secrets.cloverBase||'https://api.clover.com').trim();
  if (!mId || !token) return null;
  const r = await fetch(`${base}/v3/merchants/${mId}/items?limit=1000`, { headers:{ Authorization:'Bearer '+token } });
  if (!r.ok) throw new Error('Clover API HTTP '+r.status);
  const j = await r.json(); const items = j.elements||[];
  const skus=new Set(), bars=new Set();
  for (const it of items){ if (it.sku) skus.add(it.sku); if (it.code) bars.add(it.code); }
  return { skus, bars };
}

/* --- Turn one Clover order into ROS events: NET revenue (after discounts), tax, skip refunded lines --- */
function cloverOrderToEvents(o, touchStock){
  const payments = (o.payments && o.payments.elements) || [];
  if (!payments.length) return null;                      // unpaid — ignore
  const oTime = o.createdTime ? new Date(o.createdTime).toISOString() : now();
  const orderTaxCents = payments.reduce((a,p)=>a+(p.taxAmount||0),0);
  const lines = (o.lineItems && o.lineItems.elements) || [];
  const lineData = [];
  for (const li of lines){
    if (li.refunded === true) continue;                   // skip refunded line items
    const price = (typeof li.price==='number') ? li.price : 0;
    let net = price;
    const ds = (li.discounts && li.discounts.elements) || [];
    for (const d of ds){                                  // line-level discounts (amount is negative)
      if (typeof d.amount==='number') net += d.amount;
      else if (typeof d.percentage==='number') net -= Math.round(price * d.percentage/100);
    }
    if (net < 0) net = 0;
    const it = li.item || {};
    lineData.push({ sku:it.sku||'', code:it.code||'', name:li.name||it.name||'', net });
  }
  // order-level discounts, distributed proportionally
  let subtotal = lineData.reduce((a,l)=>a+l.net,0);
  let orderDisc = 0;
  const od = (o.discounts && o.discounts.elements) || [];
  for (const d of od){ if (typeof d.amount==='number') orderDisc += d.amount; else if (typeof d.percentage==='number') orderDisc -= Math.round(subtotal*d.percentage/100); }
  if (subtotal>0 && orderDisc<0){ const f=Math.max(0,(subtotal+orderDisc)/subtotal); lineData.forEach(l=>l.net=Math.round(l.net*f)); }
  const orderNet = lineData.reduce((a,l)=>a+l.net,0) || 0;
  // aggregate by product
  const agg = {};
  for (const l of lineData){
    const p = (l.sku && data.products.find(x=>x.sku===l.sku))
           || (l.code && data.products.find(x=>x.barcode && x.barcode===l.code))
           || (l.name && l.name.toLowerCase()!=='custom item' && data.products.find(x=>x.name && x.name.trim().toLowerCase()===l.name.trim().toLowerCase()))
           || null;
    const key = p ? p.id : ('x:'+(l.sku||l.code||l.name));
    agg[key] = agg[key] || { p, qty:0, net:0, name:l.name, sku:l.sku||l.code };
    agg[key].qty += 1; agg[key].net += l.net;
  }
  let matched=0, unmatched=0, revenue=0, taxTotal=0; const items=[];
  for (const k in agg){
    const a = agg[k];
    const revNet = +(a.net/100).toFixed(2);
    const taxShare = orderNet>0 ? +((orderTaxCents*(a.net/orderNet))/100).toFixed(2) : 0;
    revenue += revNet; taxTotal += taxShare;
    if (a.p){
      if (touchStock){ a.p.qty=Math.max(0,(a.p.qty||0)-a.qty); a.p.lastSale=oTime; a.p.lastUpdated=now();
        postMovement({ productId:a.p.id, delta:-a.qty, reason:'SALE', sourceType:'clover', sourceRef:'clover:'+o.id+':'+a.sku, note:'POS (Clover) #'+String(o.id).slice(-6), actor:'pos', applyQty:false }); }
      data.events.unshift({ id:uid('e'), productId:a.p.id, type:'Stock decrease', qtyChange:-a.qty, rev:revNet, tax:taxShare, note:'POS (Clover) #'+String(o.id).slice(-6), timestamp:oTime });
      items.push({ sku:a.sku, qty:a.qty, name:a.name, matched:true }); matched++;
    } else {
      data.events.unshift({ id:uid('e'), productId:'', type:'Stock decrease', qtyChange:-a.qty, rev:revNet, tax:taxShare, note:'POS (Clover) #'+String(o.id).slice(-6)+' — unscanned', timestamp:oTime });
      items.push({ sku:a.sku, qty:a.qty, name:a.name, matched:false }); unmatched++;
    }
  }
  data.posSales.unshift({ source:'Clover', orderId:o.id, number:String(o.number||o.id).slice(-6), date:oTime,
    total:(o.total!=null?(o.total/100).toFixed(2):''), net:revenue.toFixed(2), tax:taxTotal.toFixed(2), items });
  // Stamp last-purchase date on the matching customer (date only → idempotent, safe on re-sync/rebuild).
  const oc = (o.customers && o.customers.elements) || [];
  if (oc.length){
    const cid = oc[0].id;
    const cust = (data.customers||[]).find(c=>c.cloverId===cid);
    if (cust && (!cust.lastPurchase || oTime > cust.lastPurchase)){ cust.lastPurchase = oTime; cust.lastVisit = oTime; }
  }
  return { matched, unmatched, revenue:+revenue.toFixed(2), tax:+taxTotal.toFixed(2) };
}

/* --- Clover in-store sales -> reduce ROS stock --- */
async function cloverSyncSales(){
  const mId   = (secrets.cloverMerchantId||'').trim();
  const token = (secrets.cloverApiToken||'').trim();
  const base  = (secrets.cloverBase||'https://api.clover.com').trim();
  if (!mId || !token) throw new Error('Clover not configured — set merchant ID and token in Settings.');
  const url = `${base}/v3/merchants/${mId}/orders?expand=lineItems.item,lineItems.discounts,payments,discounts,refunds,customers&limit=100&orderBy=modifiedTime+DESC`;
  const r = await fetch(url, { headers:{ Authorization:'Bearer '+token } });
  if (!r.ok) throw new Error('Clover orders API HTTP '+r.status+' — check token/merchant ID.');
  const j = await r.json();
  const orders = j.elements || [];
  data.cloverProcessed = data.cloverProcessed || {};
  data.posSales        = data.posSales || [];
  let applied = 0, unmatched = 0;
  for (const o of orders){
    if (data.cloverProcessed[o.id]) continue;
    const res = cloverOrderToEvents(o, true);
    if (!res) continue;                                   // unpaid
    data.cloverProcessed[o.id] = true; applied++; unmatched += res.unmatched;
  }
  if (data.posSales.length > 500) data.posSales = data.posSales.slice(0,500);
  if (applied) saveData();
  return { newOrders:applied, checked:orders.length, unmatched };
}
async function cloverSalesTick(){
  if (!secrets.cloverSalesSync) return;
  if (!secrets.cloverMerchantId || !secrets.cloverApiToken) return;
  try { await cloverSalesImport({ reset:false }); } catch(e){}   // v2: cursor + upsert (reconciles refunds)
}
setInterval(()=>{ cloverSalesTick().catch(()=>{}); }, 60000);   // near real-time (every minute)

// Rebuild Clover sales HISTORY + revenue (last 90 days) without changing stock counts.
async function cloverRebuildSales(){
  const mId=(secrets.cloverMerchantId||'').trim(), token=(secrets.cloverApiToken||'').trim(), base=(secrets.cloverBase||'https://api.clover.com').trim();
  if (!mId || !token) throw new Error('Clover not configured — set merchant ID and token in Settings.');
  const since = Date.now() - 90*864e5;
  let all=[], offset=0;
  while (offset < 5000){
    const url = `${base}/v3/merchants/${mId}/orders?expand=lineItems.item,lineItems.discounts,payments,discounts,refunds,customers&limit=100&offset=${offset}&filter=${encodeURIComponent('createdTime>='+since)}`;
    const r = await fetch(url, { headers:{ Authorization:'Bearer '+token } });
    if (!r.ok) throw new Error('Clover orders API HTTP '+r.status+' — check token/merchant ID.');
    const j = await r.json(); const els = j.elements || [];
    all.push(...els); if (els.length < 100) break; offset += 100;
  }
  // Clear old Clover events + posSales, then rebuild from scratch (revenue/history only, no stock change).
  data.events   = (data.events||[]).filter(e=> !/clover/i.test(e.note||''));
  data.posSales = (data.posSales||[]).filter(s=> s.source!=='Clover');
  data.cloverProcessed = {};
  let orders=0, matched=0, revenue=0, tax=0;
  for (const o of all){
    const res = cloverOrderToEvents(o, false);
    if (!res) continue;
    data.cloverProcessed[o.id]=true; orders++; matched+=res.matched; revenue+=res.revenue; tax+=res.tax;
  }
  if (data.posSales.length>500) data.posSales=data.posSales.slice(0,500);
  saveData();
  return { orders, matched, revenue:+revenue.toFixed(2), tax:+tax.toFixed(2) };
}

/* ============================================================
   SALES STORE v2 — source-tagged transactions + durable daily rollups
   data.salesTx   : one record per transaction (Clover order today; web/doordash later)
   data.salesDaily: one record per `${source}|${YYYY-MM-DD}` business date
   data.salesMeta : sync cursors/status per source
   Source is a first-class field so new channels need no redesign — add an importer + a source key.
   ============================================================ */
const STORE_TZ = 'America/New_York';
function bizDate(ms){ try{ return new Intl.DateTimeFormat('en-CA',{ timeZone:STORE_TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(ms)); }catch(e){ return new Date(ms).toISOString().slice(0,10); } }
function centsSum(arr, f){ return (arr||[]).reduce((a,x)=>a+(Number(f(x))||0),0); }

// Best-effort Clover device (register) id -> name map.
async function cloverDevices(){
  const mId=(secrets.cloverMerchantId||'').trim(), token=(secrets.cloverApiToken||'').trim(), base=(secrets.cloverBase||'https://api.clover.com').trim();
  if(!mId||!token) return {};
  try{ const r=await fetch(`${base}/v3/merchants/${mId}/devices?limit=100`,{headers:{Authorization:'Bearer '+token}});
    if(!r.ok) return {}; const j=await r.json(); const m={};
    (j.elements||[]).forEach(d=>{ m[d.id]=d.name||d.serial||d.model||String(d.id).slice(-4); }); return m;
  }catch(e){ return {}; }
}

// Turn a Clover order into a rich, self-contained sales transaction (all metrics, money in dollars).
function buildCloverTx(o, devMap){
  const lines=(o.lineItems&&o.lineItems.elements)||[];
  const payments=(o.payments&&o.payments.elements)||[];
  const refundsArr=(o.refunds&&o.refunds.elements)||[];
  const odisc=(o.discounts&&o.discounts.elements)||[];
  let grossC=0, discC=0, units=0, refUnits=0; const outLines=[];
  for(const li of lines){
    const price = typeof li.price==='number'?li.price:0;
    grossC += price;
    let d=0; const ds=(li.discounts&&li.discounts.elements)||[];
    for(const x of ds){ if(typeof x.amount==='number') d += -x.amount; else if(typeof x.percentage==='number') d += Math.round(price*x.percentage/100); }
    discC += d;
    if(li.refunded===true) refUnits++; else units++;
    const it=li.item||{};
    outLines.push({ sku:it.sku||it.code||'', name:li.name||it.name||'', net:+((price-d)/100).toFixed(2) });
  }
  for(const x of odisc){ if(typeof x.amount==='number') discC += -x.amount; else if(typeof x.percentage==='number') discC += Math.round(grossC*x.percentage/100); }
  const taxC=centsSum(payments,p=>p.taxAmount), tipC=centsSum(payments,p=>p.tipAmount), refundC=centsSum(refundsArr,r=>r.amount);
  const totalC = typeof o.total==='number'?o.total:(grossC-discC+taxC);
  let payType='—';
  if(payments.length){ const labels=[...new Set(payments.map(p=>(p.tender&&(p.tender.label||p.tender.labelKey))||'Other'))]; payType = labels.length>1?'Split':labels[0]; }
  const c=v=>+((v||0)/100).toFixed(2);
  const grossSales=c(grossC), discounts=c(discC), tax=c(taxC), tip=c(tipC), refunds=c(refundC);
  const netSales=+(grossSales-discounts-refunds).toFixed(2);
  return { id:'clover:'+o.id, source:'clover', orderId:o.id, number:String(o.number||o.id).slice(-6),
    ts: o.createdTime? new Date(o.createdTime).toISOString() : now(), date: bizDate(o.createdTime||Date.now()),
    modified: o.modifiedTime||o.createdTime||Date.now(),
    grossSales, discounts, refunds, netSales, tax, tip, total:c(totalC),
    units, refundedUnits:refUnits, paymentType:payType,
    employee:(o.employee&&o.employee.name)||'', device:(o.device&&(devMap[o.device.id]||o.device.id))||'',
    state:o.state||'', lines:outLines };
}

// Recompute daily rollups for one source from salesTx (durable, never truncated).
function rebuildDailyForSource(source){
  data.salesDaily = data.salesDaily || {};
  for(const k in data.salesDaily){ if(data.salesDaily[k] && data.salesDaily[k].source===source) delete data.salesDaily[k]; }
  const acc={};
  for(const t of (data.salesTx||[])){
    if(t.source!==source) continue;
    const key=source+'|'+t.date; const d=acc[key]||(acc[key]={source,date:t.date,gross:0,discounts:0,refunds:0,net:0,tax:0,tip:0,units:0,orders:0,byPayment:{}});
    d.gross+=t.grossSales||0; d.discounts+=t.discounts||0; d.refunds+=t.refunds||0; d.net+=t.netSales||0; d.tax+=t.tax||0; d.tip+=t.tip||0; d.units+=t.units||0; d.orders+=1;
    const pt=t.paymentType||'Other'; d.byPayment[pt]=+(((d.byPayment[pt]||0)+(t.netSales||0))).toFixed(2);
  }
  for(const key in acc){ const d=acc[key]; ['gross','discounts','refunds','net','tax','tip'].forEach(f=>d[f]=+d[f].toFixed(2)); d.aov=d.orders?+(d.net/d.orders).toFixed(2):0; d.status='imported'; d.syncedAt=now(); data.salesDaily[key]=d; }
}

// The rebuilt Clover SALES importer: cursor + full pagination + upsert (refunds/voids reconcile).
async function cloverSalesImport({ reset=false, days=90 }={}){
  const mId=(secrets.cloverMerchantId||'').trim(), token=(secrets.cloverApiToken||'').trim(), base=(secrets.cloverBase||'https://api.clover.com').trim();
  if(!mId||!token) throw new Error('Clover not configured — set merchant ID and token in Settings.');
  data.salesTx=data.salesTx||[]; data.salesDaily=data.salesDaily||{}; data.salesMeta=data.salesMeta||{}; data.cloverProcessed=data.cloverProcessed||{};
  const devMap = await cloverDevices();
  let cutoffMs;
  if(reset){
    data.salesTx = data.salesTx.filter(t=>t.source!=='clover');
    for(const k in data.salesDaily){ if(data.salesDaily[k] && data.salesDaily[k].source==='clover') delete data.salesDaily[k]; }
    data.events   = (data.events||[]).filter(e=> !/clover/i.test(e.note||''));
    data.posSales = (data.posSales||[]).filter(s=> s.source!=='Clover');
    data.cloverProcessed = {};
    data.salesMeta.cloverSyncedThrough = 0;
    cutoffMs = Date.now() - (Number(days)||90)*864e5;
  } else {
    const through = data.salesMeta.cloverSyncedThrough||0;
    cutoffMs = through ? Math.max(0, through - 6*3600*1000) : Date.now()-90*864e5;  // 6h overlap catches modified/refunded orders
  }
  const idx={}; data.salesTx.forEach((t,i)=>{ if(t.source==='clover') idx[t.orderId]=i; });
  let offset=0, fetched=0, upserts=0, maxMod=data.salesMeta.cloverSyncedThrough||0;
  while(offset<20000){
    const filter = encodeURIComponent('modifiedTime>='+cutoffMs);
    const url = `${base}/v3/merchants/${mId}/orders?expand=lineItems.item,lineItems.discounts,payments,refunds,discounts,employee,customers&limit=100&offset=${offset}&orderBy=modifiedTime+ASC&filter=${filter}`;
    const r = await fetch(url, { headers:{ Authorization:'Bearer '+token } });
    if(!r.ok) throw new Error('Clover orders API HTTP '+r.status+' — check token/merchant ID.');
    const els = (await r.json()).elements || [];
    for(const o of els){
      if(!(o.payments && o.payments.elements && o.payments.elements.length)) continue;   // unpaid — ignore
      const tx = buildCloverTx(o, devMap);
      if(idx[o.id]!=null) data.salesTx[idx[o.id]] = tx; else { data.salesTx.push(tx); idx[o.id]=data.salesTx.length-1; }
      upserts++;
      // Stock + legacy events: decrement ONCE per order (first time seen, live mode only).
      if(reset){ cloverOrderToEvents(o, false); data.cloverProcessed[o.id]=true; }
      else if(!data.cloverProcessed[o.id]){ cloverOrderToEvents(o, true); data.cloverProcessed[o.id]=true; }
      const m=o.modifiedTime||o.createdTime||0; if(m>maxMod) maxMod=m;
    }
    fetched+=els.length; if(els.length<100) break; offset+=100;
  }
  data.salesMeta.cloverSyncedThrough = maxMod || Date.now();
  data.salesMeta.cloverLastSync = now();
  rebuildDailyForSource('clover');
  if(data.salesTx.length>200000) data.salesTx = data.salesTx.slice(-200000);
  saveData();
  return { fetched, upserts, txTotal: data.salesTx.filter(t=>t.source==='clover').length, since: bizDate(cutoffMs) };
}

// One-time: seed NRS daily records from the legacy rollup so historical days show in the new dashboard.
function backfillNrsDaily(){
  data.salesDaily = data.salesDaily || {};
  const roll = data.salesRollup || {};
  let added=0;
  for(const day in roll){
    const key='nrs|'+day;
    if(data.salesDaily[key]) continue;
    const n=roll[day] && roll[day].nrs;
    if(!n || !(n.r||n.u)) continue;
    data.salesDaily[key]={ source:'nrs', date:day, gross:+(n.r||0).toFixed(2), net:+(n.r||0).toFixed(2),
      discounts:0, refunds:0, tax:0, tip:0, units:n.u||0, orders:0, aov:0, taxable:0, nonTaxable:0,
      status:'imported', syncedAt:null, report:'backfill' };
    added++;
  }
  if(added) saveData();
  return added;
}

// Range helpers for the dashboards (business dates, store timezone).
function todayBiz(){ return bizDate(Date.now()); }
function salesDailyRows(source, from, to){
  const out=[];
  for(const k in (data.salesDaily||{})){ const d=data.salesDaily[k];
    if(!d) continue; if(source && d.source!==source) continue;
    if(from && d.date<from) continue; if(to && d.date>to) continue; out.push(d);
  }
  return out.sort((a,b)=> a.date<b.date?1:-1);
}
function salesSummary(from, to){
  const bySource={};
  for(const d of salesDailyRows(null, from, to)){
    const s=bySource[d.source]||(bySource[d.source]={source:d.source,gross:0,discounts:0,refunds:0,net:0,tax:0,tip:0,units:0,orders:0,days:0});
    s.gross+=d.gross||0; s.discounts+=d.discounts||0; s.refunds+=d.refunds||0; s.net+=d.net||0; s.tax+=d.tax||0; s.tip+=d.tip||0; s.units+=d.units||0; s.orders+=d.orders||0; s.days+=1;
  }
  const combined={gross:0,discounts:0,refunds:0,net:0,tax:0,units:0,orders:0};
  for(const k in bySource){ const s=bySource[k]; ['gross','discounts','refunds','net','tax','tip'].forEach(f=>s[f]=+(s[f]||0).toFixed(2)); s.aov=s.orders?+(s.net/s.orders).toFixed(2):0;
    combined.gross+=s.gross; combined.discounts+=s.discounts; combined.refunds+=s.refunds; combined.net+=s.net; combined.tax+=s.tax; combined.units+=s.units; combined.orders+=s.orders; }
  ['gross','discounts','refunds','net','tax'].forEach(f=>combined[f]=+combined[f].toFixed(2));
  combined.aov = combined.orders?+(combined.net/combined.orders).toFixed(2):0;
  return { bySource, combined };
}

/* --- NRS auto-import: watch a drop folder for sales CSVs --- */
function nrsFolderPath(){
  const f = (secrets.nrsFolder||'').trim();
  return f ? f : path.join(DIR, 'nrs-inbox');
}
function ensureNrsFolder(){
  const f = nrsFolderPath();
  try { fs.mkdirSync(f, { recursive:true }); fs.mkdirSync(path.join(f,'processed'), { recursive:true }); } catch(e){}
  return f;
}
function parseCSVserver(text){
  const rows=[]; let row=[], cur='', q=false;
  for (let i=0;i<text.length;i++){ const c=text[i];
    if (q){ if (c==='"'){ if (text[i+1]==='"'){ cur+='"'; i++; } else q=false; } else cur+=c; }
    else { if (c==='"') q=true; else if (c===','){ row.push(cur); cur=''; }
      else if (c==='\n'||c==='\r'){ if (c==='\r'&&text[i+1]==='\n') i++; row.push(cur); rows.push(row); row=[]; cur=''; }
      else cur+=c; } }
  if (cur!==''||row.length){ row.push(cur); rows.push(row); }
  return rows.filter(r=>r.some(c=>c.trim()!==''));
}
function cleanCellSrv(v){ v=(v==null?'':String(v)).trim(); const m=v.match(/^="?(.*?)"?$/); return m?m[1].trim():v; }
function findHeaderRow(rows){
  for (let i=0;i<Math.min(rows.length,8);i++){
    const h=(rows[i]||[]).map(c=>cleanCellSrv(c).toLowerCase());
    if (h.includes('upc')||h.includes('barcode')||h.includes('sku')||h.includes('name')) return i;
  }
  return 0;
}
function findProduct(sk,bc,nm){
  return (sk && data.products.find(x=>x.sku===sk))
      || (bc && data.products.find(x=>x.barcode && x.barcode===bc))
      || (nm && data.products.find(x=>x.name && x.name.trim().toLowerCase()===nm.toLowerCase()));
}
// SALES report -> subtract sold quantities (and record actual $ + sale date)
function applySalesCsv(text, src, saleDate){
  const rows = parseCSVserver(text);
  const hr = findHeaderRow(rows);
  if (rows.length < hr+2) return { empty:true };
  const head = rows[hr].map(h=>cleanCellSrv(h).toLowerCase().replace(/_/g,' '));
  const col = names => { for (const n of names){ const i=head.indexOf(n); if (i>=0) return i; } return -1; };
  const cB = col(['barcode','upc','upc code','scan code','upccode','ean']);
  const cS = col(['sku','item sku','plu','item code']);
  const cN = col(['name','item name','description','product','item']);
  const cQ = col(['quantity sold','qty sold','units sold','total qty','total quantity','total qty sold','qty total','total units','quantity','qty','units','sold']);
  const cA = col(['total amount','amount','total sales','net amount','sales','revenue','total']);
  const ts = saleDate || now();
  if (cQ < 0 || (cB < 0 && cS < 0 && cN < 0)) return { badFormat:true };
  // Re-importing a day's report replaces it: drop any existing NRS events for this date first.
  const dayStr = new Date(ts).toISOString().slice(0,10);
  data.events = data.events.filter(e => !(/\(nrs\)/i.test(e.note||'') && String(e.timestamp).slice(0,10)===dayStr));
  let applied=0, unmatched=0, matchedUnits=0, matchedRev=0, allDetailRev=0, allDetailUnits=0, deptRev=0, deptUnits=0, taxableRev=0, nonTaxableRev=0; const items=[];
  for (let i=hr+1;i<rows.length;i++){ const r=rows[i];
    const bc = cB>=0 ? cleanCellSrv(r[cB]) : '';
    const sk = cS>=0 ? cleanCellSrv(r[cS]) : '';
    const nm = cN>=0 ? cleanCellSrv(r[cN]) : '';
    const qty = Math.round(Number(String(r[cQ]||'0').replace(/[^0-9.\-]/g,''))||0);
    if (!qty) continue;
    const amt = cA>=0 ? (Number(String(r[cA]||'').replace(/[^0-9.\-]/g,''))||0) : 0;
    if (!bc && !sk){ deptRev += amt; deptUnits += qty;                // department/summary total row (Taxable / Non-Taxable)
      if(/non[\s-]*tax/i.test(nm)) nonTaxableRev += amt; else if(/tax/i.test(nm)) taxableRev += amt; continue; }
    allDetailRev += amt; allDetailUnits += qty;
    const p = findProduct(sk,bc,nm);
    if (p){ p.qty=Math.max(0,(p.qty||0)-qty); p.lastSale=ts; p.lastUpdated=now(); matchedUnits+=qty; matchedRev+=amt;
      postMovement({ productId:p.id, delta:-qty, reason:'SALE', sourceType:'nrs', sourceRef:'nrs:'+src+':'+(sk||bc)+':'+ts, note:'POS (NRS) '+src, actor:'pos', applyQty:false });
      data.events.unshift({ id:uid('e'), productId:p.id, type:'Stock decrease', qtyChange:-qty, rev:(cA>=0?amt:undefined), note:'POS (NRS) '+src, timestamp:ts });
      items.push({ sku:sk||bc, qty, name:p.name, matched:true }); applied++;
    } else { unmatched++; items.push({ sku:sk||bc, qty, name:nm||'', matched:false }); }
  }
  // Grand total = department totals if present (they cover unscanned + unmatched); else the itemized total.
  // The remainder (everything not attributed to a matched product) becomes ONE revenue line so the day = NRS total.
  const grand = deptRev>0 ? deptRev : allDetailRev;
  const grandUnits = deptRev>0 ? deptUnits : allDetailUnits;
  const remRev = +(grand - matchedRev).toFixed(2);
  const remUnits = Math.max(0, grandUnits - matchedUnits);
  if (remRev > 0.005) data.events.unshift({ id:uid('e'), productId:'', type:'Stock decrease', qtyChange:-remUnits, rev:remRev, note:'POS (NRS) '+src+' — unscanned/unmatched', timestamp:ts });
  // Durable daily record for the NRS sales dashboard (date-wise; NRS is aggregate, no per-transaction data).
  data.salesDaily = data.salesDaily || {};
  data.salesDaily['nrs|'+dayStr] = { source:'nrs', date:dayStr,
    gross:+grand.toFixed(2), net:+grand.toFixed(2), discounts:0, refunds:0, tax:0, tip:0,
    units:grandUnits, orders:0, aov:0,
    taxable:+taxableRev.toFixed(2), nonTaxable:+nonTaxableRev.toFixed(2),
    status:'imported', syncedAt: now(), report: src };
  return { applied, unmatched, units:matchedUnits+remUnits, revenue:+grand.toFixed(2), items };
}
// Parse a date like "Jun_29,_2026" / "Jun 29, 2026" out of an NRS filename.
function dateFromName(fname){
  const m = String(fname).replace(/_/g,' ').match(/([A-Za-z]{3,9})\s+(\d{1,2})\s*,?\s*(\d{4})/);
  if (!m) return null;
  const d = new Date(`${m[1]} ${m[2]}, ${m[3]} 12:00:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
// INVENTORY / STOCK-ON-HAND report -> set counts (upsert). No per-item events (avoids bloat).
function applyInventoryCsv(text, src){
  const rows = parseCSVserver(text);
  const hr = findHeaderRow(rows);
  if (rows.length < hr+2) return { empty:true };
  const head = rows[hr].map(h=>cleanCellSrv(h).toLowerCase().replace(/_/g,' '));
  const col = names => { for (const n of names){ const i=head.indexOf(n); if (i>=0) return i; } return -1; };
  const cB = col(['upc','barcode','upc code','ean','scan code']);
  const cS = col(['sku','plu','item code','item sku']);
  const cN = col(['name','item name','description','product','item']);
  const cQ = col(['in stock','on hand','on-hand','onhand','qty on hand','quantity on hand','stock on hand','stock','quantity','qty','units']);
  const cR = col(['count threshold','reorder threshold','reorder point','min qty','reorder','threshold']);
  const cD = col(['department','category']);
  if (cQ < 0 || (cB < 0 && cS < 0 && cN < 0)) return { badFormat:true };
  let added=0, updated=0, setq=0;
  for (let i=hr+1;i<rows.length;i++){ const r=rows[i];
    const bc = cB>=0 ? cleanCellSrv(r[cB]) : '';
    const sk = cS>=0 ? cleanCellSrv(r[cS]) : '';
    const nm = cN>=0 ? cleanCellSrv(r[cN]) : '';
    if (!bc && !sk && !nm) continue;                 // skip blank/separator rows
    const qv = cQ>=0 ? cleanCellSrv(r[cQ]) : '';
    if (qv === '') continue;                          // no stock value on this row
    const qty = Math.round(Number(qv.replace(/[^0-9.\-]/g,''))||0);
    const rt  = cR>=0 ? Number(String(cleanCellSrv(r[cR])).replace(/[^0-9.\-]/g,'')) : NaN;
    const dept= cD>=0 ? cleanCellSrv(r[cD]) : '';
    const p = findProduct(sk,bc,nm);
    if (p){
      p.qty = qty; p.lastUpdated = now(); setq++;
      if (!isNaN(rt)) p.reorderThreshold = rt;
      if (dept && !/^tax/i.test(dept) && (!p.category || p.category==='Other')) p.category = dept;
      if (bc && !p.barcode) p.barcode = bc;
      if (p.source!=='Clover') p.source = 'NRS';
      updated++;
    } else {
      data.products.push({ id:uid('p'), sku: sk||bc||uid('SKU').toUpperCase(), barcode:bc, name: nm||'Unnamed',
        brand:'', category:(dept && !/^tax/i.test(dept))?dept:'Other', subcategory:'', description:'', image:'',
        costPrice:null, retailPrice:null, salePrice:null,
        qty, reorderThreshold:(!isNaN(rt)?rt:5), overstockThreshold:50,
        aisle:'', shelf:'', bin:'', supplier:'', tags:[], source:'NRS',
        websiteEnabled:false, amazonEnabled:false, walmartEnabled:false, tiktokEnabled:false,
        dateAdded:now(), lastUpdated:now(), status:'Active', lastSale:null, lastRestock:now() });
      added++; setq++;
    }
  }
  return { added, updated, setq, inventory:true };
}
async function nrsScan(manual){
  if (!manual && !secrets.nrsAutoImport) return { skipped:true };
  const folder = ensureNrsFolder();
  data.nrsProcessed = data.nrsProcessed || {};
  data.posSales     = data.posSales || [];
  data.nrsLog       = data.nrsLog || [];
  let files = [];
  try { files = fs.readdirSync(folder).filter(f=>/\.csv$/i.test(f)); } catch(e){ return { error:'Cannot read folder: '+folder }; }
  let processed=0, totalApplied=0;
  for (const fname of files){
    const full = path.join(folder, fname);
    let st; try { st = fs.statSync(full); } catch(e){ continue; }
    if (!st.isFile()) continue;
    if (Date.now()-st.mtimeMs < 15000) continue;          // skip files still being written
    let text; try { text = fs.readFileSync(full,'utf8'); } catch(e){ continue; }
    const hash = crypto.createHash('md5').update(text).digest('hex');
    const isInv = /invent|stock|on[\s_-]?hand|reorder/i.test(fname);   // route by filename
    let res;
    if (data.nrsProcessed[hash]) res = { dup:true };
    else res = isInv ? applyInventoryCsv(text, 'auto') : applySalesCsv(text, 'auto', dateFromName(fname));
    try { fs.renameSync(full, path.join(folder,'processed', Date.now()+'_'+fname)); } catch(e){}
    if (res.inventory){
      data.nrsProcessed[hash] = true;
      data.nrsLog.unshift({ file:fname, kind:'stock', applied:res.setq, added:res.added, at:now() });
      processed++;
    } else if (res.applied != null){
      data.nrsProcessed[hash] = true;
      data.posSales.unshift({ source:'NRS', orderId:hash.slice(0,8), number:fname, date:now(), total:'', items:(res.items||[]).slice(0,50) });
      data.nrsLog.unshift({ file:fname, kind:'sales', applied:res.applied, unmatched:res.unmatched, units:res.units, at:now() });
      totalApplied += res.applied; processed++;
    } else if (res.badFormat){
      data.nrsLog.unshift({ file:fname, error:'Unrecognized columns — need a quantity column plus barcode/UPC, SKU, or Name.', at:now() });
    } else if (res.dup){
      data.nrsLog.unshift({ file:fname, error:'Skipped — identical file already imported.', at:now() });
    } else if (res.empty){
      data.nrsLog.unshift({ file:fname, error:'Empty or unreadable CSV.', at:now() });
    }
  }
  if (data.nrsLog.length > 50) data.nrsLog = data.nrsLog.slice(0,50);
  if (data.posSales.length > 500) data.posSales = data.posSales.slice(0,500);
  if (processed) saveData();
  return { files: files.length, processed, applied: totalApplied, folder };
}
try { ensureNrsFolder(); } catch(e){}
setInterval(()=>{ nrsScan(false).catch(()=>{}); }, 60000);

/* --- NRS email auto-fetch: pull the daily reports straight from Gmail (no Drive script) ---
   Self-contained IMAP over TLS (built-in `tls`, no dependencies). Each run re-scans a rolling window
   of recent emails and saves any CSV attachments into the drop folder; the existing watcher + content
   hash mean a missed day self-heals and nothing double-imports. Read-only mailbox access (EXAMINE),
   never deletes or flags your email. */
function imapDateStr(d){
  const mon=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return String(d.getDate()).padStart(2,'0')+'-'+mon[d.getMonth()]+'-'+d.getFullYear();
}
function decodeQP(s){ return s.replace(/=\r?\n/g,'').replace(/=([0-9A-Fa-f]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16))); }
// Parse a MIME part's header block correctly: unfold continuation lines, then read Content-Type,
// boundary, transfer-encoding, disposition and filename ONLY from their real header lines (anchored to
// line starts). Without the ^ anchor these fields get matched inside DKIM/ARC signature header lists
// (h=Content-Type:Content-Transfer-Encoding:...), which breaks multipart detection entirely.
function mimeHeaders(head){
  const H = String(head).replace(/\r?\n[ \t]+/g,' ');   // unfold folded headers
  const ctLine = (H.match(/^content-type:\s*([^\r\n]+)/im)||[])[1] || '';
  const cdLine = (H.match(/^content-disposition:\s*([^\r\n]+)/im)||[])[1] || '';
  const ctype   = (ctLine.split(';')[0]||'').trim().toLowerCase();
  const boundary= (ctLine.match(/boundary="?([^";\r\n]+)"?/i)||[])[1];
  const enc     = ((H.match(/^content-transfer-encoding:\s*([^\r\n]+)/im)||[])[1]||'').trim().toLowerCase();
  const disp    = (cdLine.split(';')[0]||'').trim().toLowerCase();
  const fname   = ((cdLine.match(/filename\*?="?([^";\r\n]+)"?/i)||ctLine.match(/name\*?="?([^";\r\n]+)"?/i)||[])[1]||'').trim();
  return { ctype, boundary, enc, disp, fname, ctLine };
}
function extractCsvAttachments(raw){
  const out=[];
  function walk(section){
    const sep=section.indexOf('\r\n\r\n'); if(sep<0) return;
    const head=section.slice(0,sep); const body=section.slice(sep+4);
    const h=mimeHeaders(head);
    const ctype=h.ctype, boundary=h.boundary, disp=h.disp, enc=h.enc;
    const fnameM = h.fname ? [null, h.fname] : null;
    if(/multipart\//i.test(ctype)&&boundary){
      for(let p of body.split('--'+boundary)){ p=p.replace(/^\r\n/,'').replace(/\r\n$/,''); if(!p||p==='--') continue; walk(p); }
      return;
    }
    const fname=fnameM?fnameM[1]:'';
    const looksCsv=/\.csv$/i.test(fname)||/text\/csv|application\/vnd\.ms-excel|octet-stream/i.test(ctype);
    if(fname && (/attachment/i.test(disp)||looksCsv)){
      let bufd;
      if(enc==='base64') bufd=Buffer.from(body.replace(/\s+/g,''),'base64');
      else if(enc==='quoted-printable') bufd=Buffer.from(decodeQP(body),'binary');
      else bufd=Buffer.from(body,'binary');
      out.push({ filename:fname, buf:bufd });
    }
  }
  walk(raw);
  return out.filter(a=>/\.csv$/i.test(a.filename));
}
/* ================= NRS Gmail fetch (rebuilt v2) ======================================
   Reads NRS "Daily Sales Report" emails from Gmail's All Mail, parses the email-body
   summary (authoritative daily record) plus the Sales History and Inventory Status CSV
   attachments — all in memory, no local folder. Idempotent by Message-ID. Preview-first:
   preview mode reports what WOULD import and changes nothing. Read-only mailbox (EXAMINE),
   never deletes or flags mail. Committing writes ONLY the NRS stores + the shared sales
   rollup; it does NOT touch products, stock, or the inventory master. */
const NRS_PARSER_VERSION = 4;   // v4: store gross = net+discounts so Total-Sales math matches Clover
function nrsNum(v){ if(v==null) return null; const str=String(v).replace(/[^0-9.\-]/g,''); if(str===''||str==='-'||str==='.') return null; const n=Number(str); return isFinite(n)?n:null; }
// Collect text/plain + text/html bodies from a raw RFC822 message (mirrors the attachment walk).
function nrsExtractBodies(raw){
  let text='', html='';
  function walk(section){
    const sep=section.indexOf('\r\n\r\n'); if(sep<0) return;
    const head=section.slice(0,sep); const body=section.slice(sep+4);
    const h=mimeHeaders(head); const ctype=h.ctype, boundary=h.boundary, enc=h.enc;
    if(/multipart\//i.test(ctype)&&boundary){
      for(let p of body.split('--'+boundary)){ p=p.replace(/^\r\n/,'').replace(/\r\n$/,''); if(!p||p==='--') continue; walk(p); }
      return;
    }
    let decoded=body;
    try{
      if(enc==='base64') decoded=Buffer.from(body.replace(/\s+/g,''),'base64').toString('utf8');
      else if(enc==='quoted-printable') decoded=decodeQP(body);
    }catch(e){}
    if(/text\/plain/.test(ctype)) text+=decoded+'\n';
    else if(/text\/html/.test(ctype)) html+=decoded+'\n';
  }
  walk(raw);
  return { text, html };
}
// Instrumented walk for debugging: returns the MIME tree + extracted sizes/samples.
function nrsProbeBodies(raw){
  const trace=[]; let text='', html=''; const atts=[];
  function walk(section, depth){
    const sep=section.indexOf('\r\n\r\n');
    if(sep<0){ trace.push('d'+depth+': NO header/body split (len '+section.length+')'); return; }
    const head=section.slice(0,sep); const body=section.slice(sep+4);
    const h=mimeHeaders(head); const ctype=h.ctype, boundary=h.boundary, enc=h.enc, fname=h.fname;
    trace.push('d'+depth+': ctype='+(ctype||'(none)')+' enc='+(enc||'-')+' boundary='+(boundary||'-')+(fname?' file='+fname:'')+' bodyLen='+body.length);
    if(/multipart\//i.test(ctype)&&boundary){
      const parts=body.split('--'+boundary);
      trace.push('   -> '+parts.length+' parts on boundary');
      for(let p of parts){ p=p.replace(/^\r\n/,'').replace(/\r\n$/,''); if(!p||p==='--') continue; walk(p, depth+1); }
      return;
    }
    let dec=body; try{ if(enc==='base64') dec=Buffer.from(body.replace(/\s+/g,''),'base64').toString('utf8'); else if(enc==='quoted-printable') dec=decodeQP(body);}catch(e){}
    if(/text\/plain/.test(ctype)) text+=dec;
    else if(/text\/html/.test(ctype)) html+=dec;
    if(fname && /\.csv$/i.test(fname)) atts.push(fname);
  }
  walk(raw, 0);
  const flat=(text && text.replace(/<[^>]+>/g,' ')) || nrsStripHtml(html);
  return { tree:trace, textLen:text.length, htmlLen:html.length, attachments:atts,
    flatSample:(flat||'').replace(/\s+/g,' ').slice(0,600) };
}
function nrsStripHtml(h){
  return String(h||'')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi,' ')
    .replace(/<\/(td|th|tr|table|div|p|li|h[1-6])>/gi,' ')
    .replace(/<br\s*\/?>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&#36;/g,'$')
    .replace(/[ \t]+/g,' ').replace(/\s*\n\s*/g,'\n').trim();
}
// Parse the daily summary out of the email body. Best-effort across label variants; records the
// flattened text (_raw) so the exact labels can be confirmed against the first real email.
function nrsParseBodySummary(raw){
  const b=nrsExtractBodies(raw);
  const flat=(b.text && b.text.replace(/<[^>]+>/g,' ')) || nrsStripHtml(b.html);
  if(!flat || !/[0-9]/.test(flat)) return null;
  const one=flat.replace(/\s+/g,' ');
  const grab=(labels)=>{ for(const L of labels){ const re=new RegExp(L.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[^0-9$()\\-]{0,40}(\\(?\\$?\\s*[0-9][0-9,]*\\.?[0-9]*\\)?)','i'); const m=one.match(re); if(m){ let n=nrsNum(m[1]); if(n!=null && /^\(/.test(m[1].trim())) n=-n; return n; } } return null; };
  const s={
    net:      grab(['Net Sales','Net Sale','Net']),
    tax:      grab(['Sales Tax','Taxes','Tax']),
    fees:     grab(['Fees','Service Fee','Fee']),
    total:    grab(['Total Sales','Grand Total','Total Sale','Total']),
    baskets:  grab(['Number of Baskets','Total Baskets','Baskets','Transactions']),
    items:    grab(['Items Sold','Total Items','Number of Items','Items']),
    avgItems: grab(['Average Items per Basket','Avg Items per Basket','Average Items','Avg Items','Items per Basket']),
    avgSale:  grab(['Average Sale','Avg Sale','Average Basket','Avg Basket','Average Ticket']),
    discounts:grab(['Discounts','Discount']),
  };
  const nn=v=>typeof v==='number';
  if(!nn(s.total) && nn(s.net)&&nn(s.tax)) s.total=+(s.net+s.tax+(s.fees||0)).toFixed(2);
  if(!nn(s.net) && nn(s.total)&&nn(s.tax)) s.net=+(s.total-s.tax-(s.fees||0)).toFixed(2);
  s._raw=one.slice(0,1500);   // kept for tuning against the first real email
  return s;
}
// Sales History CSV -> item detail + department totals. UPC kept as a STRING (leading zeros intact).
function nrsParseSalesHistory(text){
  const rows=parseCSVserver(text); const hr=findHeaderRow(rows);
  if(rows.length<hr+2) return { empty:true };
  const head=rows[hr].map(h=>cleanCellSrv(h).toLowerCase().replace(/_/g,' '));
  const col=names=>{ for(const n of names){ const i=head.indexOf(n); if(i>=0) return i; } return -1; };
  const cU=col(['upc','barcode','upc code','ean','scan code']);
  const cN=col(['name','item name','description','product','item']);
  const cQ=col(['total qty','total quantity','qty sold','quantity sold','units sold','quantity','qty','units']);
  const cA=col(['total amount','amount','total sales','net amount','sales','total']);
  if(cQ<0 || cU<0) return { badFormat:true };
  const items=[]; const dept={ taxable:{qty:0,amount:0}, nonTaxable:{qty:0,amount:0} };
  let totalUnits=0, totalAmount=0;
  for(let i=hr+1;i<rows.length;i++){ const r=rows[i];
    const upc=cU>=0?cleanCellSrv(r[cU]):'';               // STRING — no numeric coercion
    const nm =cN>=0?cleanCellSrv(r[cN]):'';
    const qty=Math.round(nrsNum(r[cQ])||0);
    const amt=cA>=0?(nrsNum(r[cA])||0):0;
    if(!qty && !amt) continue;
    if(!upc){                                              // department summary row (Taxable / Non-Taxable)
      if(/non[\s-]*tax/i.test(nm)){ dept.nonTaxable.qty+=qty; dept.nonTaxable.amount+=amt; }
      else if(/tax/i.test(nm)){ dept.taxable.qty+=qty; dept.taxable.amount+=amt; }
      continue;
    }
    items.push({ upc:String(upc), name:nm, qty, amount:+amt.toFixed(2) });
    totalUnits+=qty; totalAmount+=amt;
  }
  dept.taxable.amount=+dept.taxable.amount.toFixed(2); dept.nonTaxable.amount=+dept.nonTaxable.amount.toFixed(2);
  return { items, dept, itemCount:items.length, totalUnits, totalAmount:+totalAmount.toFixed(2) };
}
// Inventory Status CSV -> stored separately as a dated snapshot (never auto-applied to stock).
function nrsParseInventory(text){
  const rows=parseCSVserver(text); const hr=findHeaderRow(rows);
  if(rows.length<hr+2) return { empty:true };
  const head=rows[hr].map(h=>cleanCellSrv(h).toLowerCase().replace(/_/g,' '));
  const col=names=>{ for(const n of names){ const i=head.indexOf(n); if(i>=0) return i; } return -1; };
  const cU=col(['upc','barcode','upc code','ean','scan code']);
  const cN=col(['name','item name','description','product','item']);
  const cD=col(['department','category']);
  const cS=col(['in stock','on hand','on-hand','onhand','stock','quantity','qty']);
  const cP=col(['predicted days','days left','predicted']);
  const cC=col(['count threshold','reorder threshold','reorder point','count']);
  const cT=col(['days threshold','day threshold']);
  if(cU<0 || cS<0) return { badFormat:true };
  const out=[];
  for(let i=hr+1;i<rows.length;i++){ const r=rows[i];
    const upc=cU>=0?cleanCellSrv(r[cU]):'';
    const nm =cN>=0?cleanCellSrv(r[cN]):'';
    if(!upc && (!nm || !nm.trim())) continue;             // blank / separator (" ") rows
    out.push({ upc:String(upc), name:nm, department:cD>=0?cleanCellSrv(r[cD]):'',
      inStock:nrsNum(r[cS]), predictedDays:cP>=0?nrsNum(r[cP]):null,
      countThreshold:cC>=0?nrsNum(r[cC]):null, daysThreshold:cT>=0?nrsNum(r[cT]):null });
  }
  return { rows:out, count:out.length };
}
// Business date for a report: subject "…Jul 17, 2026…" > attachment filename > received-minus-1-day.
function nrsBizDate(subject, attNames, receivedMs){
  let iso=dateFromName(subject||'');
  if(!iso){ for(const f of (attNames||[])){ iso=dateFromName(f); if(iso) break; } }
  if(!iso && receivedMs){ iso=new Date(receivedMs-86400000).toISOString(); }
  return iso ? iso.slice(0,10) : null;
}
function nrsHeaderVal(msg, name){
  const m=msg.match(new RegExp('^'+name+':\\s*([^\\r\\n]*(?:\\r\\n[ \\t][^\\r\\n]*)*)','im'));
  return m ? m[1].replace(/\r\n[ \t]+/g,' ').trim() : '';
}
// Write one email's parsed content into the durable NRS stores (commit path only).
function nrsCommit(rec){
  const key=rec.key;
  data.nrsEmails[key]={ key, messageId:rec.messageId, uid:rec.uid, from:rec.from, subject:rec.subject,
    receivedAt:rec.receivedAt, businessDate:rec.businessDate, attachments:rec.attNames,
    hasBody:!!rec.summary, hasSales:!!rec.sales, hasInventory:!!rec.inventory,
    parserVersion:NRS_PARSER_VERSION, importedAt:now(), warnings:rec.warnings||[], errors:rec.errors||[] };
  if(rec.businessDate && rec.summary){
    const s=rec.summary, sr=rec.sales||{};
    data.nrsDaily[rec.businessDate]={ date:rec.businessDate, source:'nrs-email', messageId:rec.messageId,
      receivedAt:rec.receivedAt, importedAt:now(),
      net:s.net, tax:s.tax, fees:s.fees, total:s.total, baskets:s.baskets, items:s.items,
      avgItems:s.avgItems, avgSale:s.avgSale, discounts:s.discounts };
    // Mirror into the shared sales store so existing dashboards read the authoritative body numbers.
    // NRS "Net Sales" is already net of discounts, so store gross = net + discounts (pre-discount).
    // That makes the dashboards' Total-Sales formula (gross − discounts + tax) equal net + tax for NRS,
    // exactly matching NRS's own "Total Sales" and keeping the combined Overall tab correct.
    const nNet=(s.net!=null?s.net:0), nDisc=(s.discounts!=null?s.discounts:0),
          nTax=(s.tax!=null?s.tax:0), nFees=(s.fees!=null?s.fees:0);
    data.salesDaily['nrs|'+rec.businessDate]={ source:'nrs', date:rec.businessDate,
      gross:+(nNet+nDisc).toFixed(2), net:+nNet.toFixed(2),
      discounts:+nDisc.toFixed(2), refunds:0, tax:+nTax.toFixed(2), tip:0,
      units:(s.items!=null?s.items:(sr.totalUnits||0)),
      orders:(s.baskets!=null?s.baskets:0), aov:(s.avgSale!=null?s.avgSale:0),
      taxable:sr.dept?sr.dept.taxable.amount:0, nonTaxable:sr.dept?sr.dept.nonTaxable.amount:0,
      total:(s.total!=null?s.total:+(nNet+nTax+nFees).toFixed(2)), fees:+nFees.toFixed(2),
      status:'imported', syncedAt:now(), report:'email' };
  }
  if(rec.businessDate && rec.sales && rec.sales.items){
    data.nrsItems=(data.nrsItems||[]).filter(x=>x.date!==rec.businessDate);   // replace this day's detail
    for(const it of rec.sales.items) data.nrsItems.push({ date:rec.businessDate, upc:it.upc, name:it.name, qty:it.qty, amount:it.amount });
  }
  if(rec.inventory && rec.inventory.rows){
    const snapDate=rec.businessDate||String(rec.receivedAt||now()).slice(0,10);
    data.nrsInventory[snapDate]={ date:snapDate, capturedFrom:rec.messageId, importedAt:now(),
      count:rec.inventory.count, rows:rec.inventory.rows };
  }
}
// Core engine. opts: { from:'YYYY-MM-DD', to:'YYYY-MM-DD', sinceDays, preview, max }
function nrsGmailRun(opts){
  opts=opts||{};
  data.nrsEmails=data.nrsEmails||{}; data.nrsDaily=data.nrsDaily||{};
  data.nrsInventory=data.nrsInventory||{}; data.nrsMeta=data.nrsMeta||{};
  if(!Array.isArray(data.nrsItems)) data.nrsItems=[];
  return new Promise((resolve)=>{
    let tls; try{ tls=require('tls'); }catch(e){ return resolve({error:'tls module unavailable'}); }
    const host=(secrets.imapHost||'imap.gmail.com').trim();
    const port=Number(secrets.imapPort)||993;
    const user=(secrets.imapUser||secrets.fromEmail||'').trim();
    const pass=(secrets.imapPass||'').trim();
    const sender=(secrets.imapSender||'no-reply@nrsplus.com').trim();
    const subjectNeedle=(secrets.nrsSubject||'Daily Sales Report').trim();
    if(!user||!pass) return resolve({error:'Add the mailbox email + Gmail app password in Settings.'});
    const folder=(secrets.imapFolder||'[Gmail]/All Mail');
    const preview=!!opts.preview;
    const max=Math.max(1, Math.min(2000, opts.max||1500));
    let sinceDate;
    if(opts.from) sinceDate=new Date(opts.from+(/T/.test(opts.from)?'':'T00:00:00'));
    else sinceDate=new Date(Date.now()-((opts.sinceDays||45)*86400000));
    if(isNaN(sinceDate.getTime())) sinceDate=new Date(Date.now()-45*86400000);
    let beforeDate=null;
    if(opts.to){ beforeDate=new Date(opts.to+'T00:00:00'); beforeDate.setDate(beforeDate.getDate()+1); if(isNaN(beforeDate.getTime())) beforeDate=null; }

    const log={ folder, searched:{ since:imapDateStr(sinceDate), before:beforeDate?imapDateStr(beforeDate):null, sender, subject:subjectNeedle },
      mode:preview?'preview':'commit', found:0, matched:0, previewed:0, imported:0, skippedDuplicate:0,
      skippedNonNrs:0, failed:[], samples:[] };

    let buf=''; const waiters=[]; let done=false;
    const finish=(v)=>{ if(done)return; done=true; try{sock.end();}catch(e){} resolve(v); };
    const sock=tls.connect({host,port,servername:host});
    sock.setEncoding('binary');
    sock.setTimeout(120000, ()=>finish(Object.assign(log,{error:'IMAP timed out.'})));
    sock.on('error', e=>finish(Object.assign(log,{error:'IMAP connection error: '+e.message})));
    function pump(){ if(!waiters.length)return; const w=waiters[0];
      const re=new RegExp('^'+w.tag+' (OK|NO|BAD)[^\\r\\n]*\\r\\n','m'); const m=re.exec(buf);
      if(m){ const end=m.index+m[0].length; const chunk=buf.slice(0,end); buf=buf.slice(end); waiters.shift(); w.resolve({raw:chunk, ok:m[1]==='OK'}); pump(); } }
    sock.on('data', d=>{ buf+=d; if(greeted) pump(); else if(/^\* OK/m.test(buf)){ greeted=true; buf=''; run(); } });
    let greeted=false, tagN=0;
    const cmd=(line)=>{ const t='F'+(++tagN); return new Promise(r=>{ waiters.push({tag:t,resolve:r}); sock.write(t+' '+line+'\r\n'); }); };
    async function run(){
      try{
        let r=await cmd('LOGIN "'+user.replace(/(["\\])/g,'\\$1')+'" "'+pass.replace(/(["\\])/g,'\\$1')+'"');
        if(!r.ok) return finish(Object.assign(log,{error:'Login failed — check the email and Gmail app password.'}));
        const ex=await cmd('EXAMINE "'+folder.replace(/(["\\])/g,'\\$1')+'"');
        if(!ex.ok) return finish(Object.assign(log,{error:'Could not open mailbox "'+folder+'". For Gmail use "[Gmail]/All Mail".'}));
        let crit='SINCE '+imapDateStr(sinceDate);
        if(beforeDate) crit+=' BEFORE '+imapDateStr(beforeDate);
        if(sender) crit+=' FROM "'+sender.replace(/(["\\])/g,'\\$1')+'"';
        const sr=await cmd('UID SEARCH '+crit);
        const sl=(sr.raw.match(/\* SEARCH([^\r\n]*)/)||[])[1]||'';
        let uids=sl.trim().split(/\s+/).filter(Boolean).map(Number).filter(n=>n>0);
        uids.sort((a,b)=>a-b);                     // oldest -> newest (safe resume)
        log.found=uids.length;
        if(opts.probe) uids=uids.slice(-1);        // probe: newest message only (fast)
        else if(uids.length>max) uids=uids.slice(-max);
        for(const uid of uids){
          let msg='';
          try{
            const fr=await cmd('UID FETCH '+uid+' (BODY.PEEK[])');
            const lm=fr.raw.match(/BODY\[\]\s*\{(\d+)\}\r\n/); if(!lm){ continue; }
            const start=fr.raw.indexOf(lm[0])+lm[0].length;
            msg=fr.raw.substr(start, Number(lm[1]));
          }catch(e){ log.failed.push({ uid, reason:'fetch failed: '+(e&&e.message||e) }); continue; }
          const from=nrsHeaderVal(msg,'from').toLowerCase();
          const subject=nrsHeaderVal(msg,'subject');
          const messageId=(nrsHeaderVal(msg,'message-id')||'').replace(/[<>]/g,'').trim();
          if(sender && !from.includes(sender.toLowerCase())){ log.skippedNonNrs++; continue; }
          if(subjectNeedle && !subject.toLowerCase().includes(subjectNeedle.toLowerCase())){ log.skippedNonNrs++; continue; }
          log.matched++;
          if(opts.probe){
            await cmd('LOGOUT');
            const pr=nrsProbeBodies(msg);
            return finish({ probe:true, subject, messageId, rawLen:msg.length,
              headExcerpt:msg.slice(0,500), tree:pr.tree, textLen:pr.textLen, htmlLen:pr.htmlLen,
              attachments:pr.attachments, flatSample:pr.flatSample });
          }
          const key=messageId || ('uid:'+folder+':'+uid);
          const already=!!(data.nrsEmails[key] && data.nrsEmails[key].parserVersion===NRS_PARSER_VERSION);
          if(already && !preview){ log.skippedDuplicate++; continue; }
          try{
            const dateHdr=nrsHeaderVal(msg,'date');
            const receivedMs=dateHdr?(Date.parse(dateHdr)||Date.now()):Date.now();
            const atts=extractCsvAttachments(msg);
            const attNames=atts.map(a=>a.filename);
            let sales=null, inventory=null; const warnings=[], errors=[];
            for(const a of atts){
              const t=a.buf.toString('utf8');
              const isInv=/invent|stock|reorder/i.test(a.filename);
              if(isInv){ const iv=nrsParseInventory(t); if(iv.badFormat||iv.empty) warnings.push('inventory attachment '+a.filename+': '+(iv.badFormat?'unrecognized columns':'empty')); else inventory=iv; }
              else { const sh=nrsParseSalesHistory(t); if(sh.badFormat||sh.empty) warnings.push('sales attachment '+a.filename+': '+(sh.badFormat?'unrecognized columns':'empty')); else sales=sh; }
            }
            const summary=nrsParseBodySummary(msg);
            if(!summary) warnings.push('no email body summary found');
            const businessDate=nrsBizDate(subject, attNames, receivedMs);
            if(!businessDate) warnings.push('could not determine business date');
            const rec={ key, uid, messageId, from, subject, receivedAt:new Date(receivedMs).toISOString(),
              businessDate, attNames, summary, sales, inventory, warnings, errors };
            if(preview){
              log.previewed++;
              if(log.samples.length<50) log.samples.push({ businessDate, subject, receivedAt:rec.receivedAt,
                messageId, alreadyImported:already, hasBody:!!summary,
                net:summary&&summary.net, tax:summary&&summary.tax, fees:summary&&summary.fees, total:summary&&summary.total,
                baskets:summary&&summary.baskets, items:summary&&summary.items,
                salesItems:sales?sales.itemCount:0, salesTotal:sales?sales.totalAmount:null,
                inventoryRows:inventory?inventory.count:0, attachments:attNames, warnings });
            } else {
              nrsCommit(rec);
              log.imported++;
            }
          }catch(e){ log.failed.push({ uid, subject, reason:'parse/commit failed: '+(e&&e.message||e) }); }
        }
        await cmd('LOGOUT');
        data.nrsMeta=data.nrsMeta||{};
        data.nrsMeta.lastRun={ at:now(), mode:log.mode, range:log.searched, found:log.found, matched:log.matched,
          previewed:log.previewed, imported:log.imported, skippedDuplicate:log.skippedDuplicate, failed:log.failed.length };
        if(!preview){ data.nrsMeta.lastCommitAt=now();
          data.nrsLog=data.nrsLog||[]; data.nrsLog.unshift({ file:'(gmail fetch)', kind:'email', applied:log.imported, added:log.imported, skipped:log.skippedDuplicate, at:now() });
          if(data.nrsLog.length>50) data.nrsLog=data.nrsLog.slice(0,50);
          saveData();
        }
        finish(log);
      }catch(e){ finish(Object.assign(log,{error:'IMAP error: '+(e&&e.message||e)})); }
    }
  });
}
// Back-compat wrapper: the old name now runs an incremental commit over recent days.
function imapFetchNrs(sinceDays){ return nrsGmailRun({ sinceDays:sinceDays||45, preview:false }); }
setInterval(()=>{ if(secrets.nrsEmailFetch) nrsGmailRun({ sinceDays:45, preview:false }).catch(()=>{}); }, 15*60*1000);

/* ================= Utility-bill email detection (Con Edison, National Grid, internet…) ==========
   Reuses the same read-only IMAP + the AI text model to read the ACTUAL amount + due date on variable
   bills. Writes to data.billDetections (a separate, non-destructive store) as "detected, awaiting
   confirmation" - it never marks anything paid and never changes a recurring bill until the owner
   confirms in Automated Finance. If the email has no amount (many utilities link to a portal), it is
   still recorded as "bill ready, add amount" so the owner gets a nudge instead of a silent miss. */
async function billExtract(bodyText, providerName){
  const text=(bodyText||'').replace(/\s+/g,' ').slice(0,6000);
  if(!text) return { error:'empty body' };
  const prompt='Classify and extract from this utility/service email for a small store. Provider: '+(providerName||'unknown')
    +'. Return ONLY compact JSON with keys: '
    +'kind ("bill" if it presents an amount DUE / a new statement / bill-is-ready; "payment" if it confirms a payment RECEIVED, a receipt, or autopay processed; "other" otherwise), '
    +'amount (number in USD - the amount due for a bill, or the amount paid for a payment; null if none), '
    +'dueDate (YYYY-MM-DD for bills, else null), paidDate (YYYY-MM-DD for payments, else null), '
    +'invoiceNo (string or null), accountNo (string or null), amountFound (true only if a dollar amount is explicitly present). '
    +'Never guess an amount or date that is not in the text. Email:\n"""'+text+'"""';
  let raw; try{ raw=await aiText(prompt, 300); }catch(e){ return { error:'ai: '+(e&&e.message||e) }; }
  const m=(raw||'').match(/\{[\s\S]*\}/); if(!m) return { error:'no json' };
  let obj; try{ obj=JSON.parse(m[0]); }catch(e){ return { error:'bad json' }; }
  const amt=(obj.amount!=null&&obj.amountFound)?Number(String(obj.amount).replace(/[^0-9.\-]/g,'')):null;
  return { kind:(obj.kind||'bill'), amount:isFinite(amt)?amt:null, dueDate:obj.dueDate||null, paidDate:obj.paidDate||null,
    invoiceNo:obj.invoiceNo||null, accountNo:obj.accountNo||null, amountFound:!!obj.amountFound };
}
// Canonical monthly occurrence date for a bill (its due-day within the month of dateStr), so bill-ready and
// payment emails for the same month land on the SAME occurrence and align with date-wise expense generation.
function billCanonicalDue(it, dateStr){ const d=new Date(dateStr+'T12:00:00'); if(isNaN(d.getTime()))return dateStr;
  if((it.frequency||'monthly')==='monthly'){ const a=it.startDate?new Date(it.startDate+'T12:00:00'):d; const dom=isNaN(a.getTime())?d.getDate():a.getDate();
    const dim=new Date(d.getFullYear(),d.getMonth()+1,0).getDate(); return new Date(d.getFullYear(),d.getMonth(),Math.min(dom,dim),12).toISOString().slice(0,10); }
  return dateStr; }
// Upsert an occurrence for a bill. Matches an existing occurrence by amount first (bridges a bill-ready and its
// later payment even across months), else creates one on the canonical monthly date. Merges amount + paid status.
function billUpsertOccurrence(it, amount, monthDateStr, opts){ opts=opts||{};
  const mf=data.manualFinance=data.manualFinance||{}; mf.payments=mf.payments||{};
  const amtR=Math.round(Number(amount)); let key=null;
  for(const k in mf.payments){ if(k.indexOf(it.id+'|')!==0)continue; const p=mf.payments[k];
    if(p&&p.amount!=null&&Math.round(Number(p.amount))===amtR){ key=k; if(!(p.status==='paid'&&!opts.paid))break; } }
  if(!key){ const canon=it.id+'|'+billCanonicalDue(it, monthDateStr); const ex=mf.payments[canon];
    // don't clobber a different bill that already sits on the canonical date - use the exact date instead
    key=(ex && ex.amount!=null && Math.round(Number(ex.amount))!==amtR) ? (it.id+'|'+monthDateStr) : canon; }
  const prev=mf.payments[key]||{};
  const rec=Object.assign({},prev,{ amount:Number(amount), expected:(prev.expected!=null?prev.expected:Number(amount)),
    dueDate:prev.dueDate||billCanonicalDue(it,monthDateStr), source:opts.source||prev.source||'email' });
  if(opts.paid){ rec.status='paid'; rec.paidDate=opts.paidDate||monthDateStr; }
  else if(rec.status!=='paid'){ rec.status=prev.status||'detected'; }
  mf.payments[key]=rec; return key; }
function billGmailRun(opts){
  opts=opts||{};
  data.billDetections=data.billDetections||{}; data.billMeta=data.billMeta||{}; data.billProviders=data.billProviders||[];
  return new Promise((resolve)=>{
    let tls; try{ tls=require('tls'); }catch(e){ return resolve({error:'tls module unavailable'}); }
    const providers=(data.billProviders||[]).filter(p=>p.active!==false);
    if(!providers.length) return resolve({ error:'No bill providers configured.' });
    const host=(secrets.imapHost||'imap.gmail.com').trim(); const port=Number(secrets.imapPort)||993;
    const user=(secrets.imapUser||secrets.fromEmail||'').trim(); const pass=(secrets.imapPass||'').trim();
    if(!user||!pass) return resolve({error:'Add the mailbox email + Gmail app password in Settings.'});
    const folder=(secrets.imapFolder||'[Gmail]/All Mail');
    const sinceDate=new Date(Date.now()-((opts.sinceDays||60)*86400000));
    const log={ providers:providers.map(p=>p.name), found:0, detected:0, skippedDuplicate:0, noAmount:0, failed:[] };
    let buf=''; const waiters=[]; let done=false;
    const finish=(v)=>{ if(done)return; done=true; try{sock.end();}catch(e){} resolve(v); };
    const sock=tls.connect({host,port,servername:host}); sock.setEncoding('binary');
    sock.setTimeout(120000, ()=>finish(Object.assign(log,{error:'IMAP timed out.'})));
    sock.on('error', e=>finish(Object.assign(log,{error:'IMAP connection error: '+e.message})));
    function pump(){ if(!waiters.length)return; const w=waiters[0]; const re=new RegExp('^'+w.tag+' (OK|NO|BAD)[^\\r\\n]*\\r\\n','m'); const m=re.exec(buf);
      if(m){ const end=m.index+m[0].length; const chunk=buf.slice(0,end); buf=buf.slice(end); waiters.shift(); w.resolve({raw:chunk, ok:m[1]==='OK'}); pump(); } }
    sock.on('data', d=>{ buf+=d; if(greeted) pump(); else if(/^\* OK/m.test(buf)){ greeted=true; buf=''; run(); } });
    let greeted=false, tagN=0;
    const cmd=(line)=>{ const t='B'+(++tagN); return new Promise(r=>{ waiters.push({tag:t,resolve:r}); sock.write(t+' '+line+'\r\n'); }); };
    async function run(){
      try{
        let r=await cmd('LOGIN "'+user.replace(/(["\\])/g,'\\$1')+'" "'+pass.replace(/(["\\])/g,'\\$1')+'"');
        if(!r.ok) return finish(Object.assign(log,{error:'Login failed - check the Gmail app password.'}));
        const ex=await cmd('EXAMINE "'+folder.replace(/(["\\])/g,'\\$1')+'"');
        if(!ex.ok) return finish(Object.assign(log,{error:'Could not open mailbox "'+folder+'".'}));
        for(const prov of providers){
          const senders=(prov.senders&&prov.senders.length?prov.senders:[prov.sender||'']).filter(Boolean);
          let uids=[];
          for(const snd of senders){
            const sr=await cmd('UID SEARCH SINCE '+imapDateStr(sinceDate)+' FROM "'+snd.replace(/(["\\])/g,'\\$1')+'"');
            const sl=(sr.raw.match(/\* SEARCH([^\r\n]*)/)||[])[1]||'';
            uids=uids.concat(sl.trim().split(/\s+/).filter(Boolean).map(Number).filter(n=>n>0));
          }
          uids=[...new Set(uids)].sort((a,b)=>a-b).slice(-6);   // newest few bills per provider
          for(const uid of uids){
            log.found++;
            let msg='';
            try{ const fr=await cmd('UID FETCH '+uid+' (BODY.PEEK[])'); const lm=fr.raw.match(/BODY\[\]\s*\{(\d+)\}\r\n/); if(!lm) continue; const start=fr.raw.indexOf(lm[0])+lm[0].length; msg=fr.raw.substr(start, Number(lm[1])); }
            catch(e){ log.failed.push({uid,reason:'fetch: '+(e&&e.message||e)}); continue; }
            const subject=nrsHeaderVal(msg,'subject'); const messageId=(nrsHeaderVal(msg,'message-id')||'').replace(/[<>]/g,'').trim();
            if(prov.subjectMatch && !subject.toLowerCase().includes(prov.subjectMatch.toLowerCase())) continue;
            const key=prov.id+'|'+(messageId||('uid:'+uid));
            if(data.billDetections[key]){ log.skippedDuplicate++; continue; }   // already seen this bill email
            const b=nrsExtractBodies(msg); const bodyText=(b.text||'').replace(/<[^>]+>/g,' ') || nrsStripHtml(b.html);
            const dateHdr=nrsHeaderVal(msg,'date'); const receivedMs=dateHdr?(Date.parse(dateHdr)||Date.now()):Date.now();
            let ext; try{ ext=await billExtract(bodyText, prov.name); }catch(e){ ext={error:String(e&&e.message||e)}; }
            const recvDay=new Date(receivedMs).toISOString().slice(0,10);
            const hasAmt=!!(ext&&ext.amount!=null);
            // PAYMENT / receipt email -> auto-mark the matching bill occurrence paid (a receipt is factual).
            if(ext && ext.kind==='payment' && hasAmt){
              const mf=data.manualFinance=data.manualFinance||{}; mf.recurring=mf.recurring||[];
              const nm=String(prov.matchName||prov.name).trim().toLowerCase();
              const it=mf.recurring.find(x=>x.book===(prov.book||'general') && (x.name||'').trim().toLowerCase()===nm);
              let applied=null;
              // A payment marks an EXISTING bill of the same amount paid; it never creates a dated expense
              // (the payment month is not the bill's billing month). If the bill isn't recorded yet, the
              // amount is kept on the detection and the bill-ready confirm will retro-match it.
              if(it){ const amtR=Math.round(Number(ext.amount)); const pays=(mf.payments||{});
                for(const k in pays){ if(k.indexOf(it.id+'|')!==0)continue; const p=pays[k]; if(p&&p.amount!=null&&Math.round(Number(p.amount))===amtR){ p.status='paid'; p.paidDate=ext.paidDate||recvDay; p.source=p.source||'email-payment'; applied=k; break; } }
                if(it.amountType!=='variable')it.amountType='variable'; }
              data.billDetections[key]={ key, kind:'payment', provider:prov.name, providerId:prov.id, book:prov.book||'general',
                category:prov.category||'Utilities', matchName:prov.matchName||prov.name, messageId, subject,
                receivedAt:new Date(receivedMs).toISOString(), amount:ext.amount, paidDate:ext.paidDate||recvDay,
                invoiceNo:(ext&&ext.invoiceNo)||null, status: applied?'applied':(it?'pending':'unmatched'), appliedTo:applied||null, detectedAt:now() };
              log.payments=(log.payments||0)+1;
              continue;
            }
            // BILL / statement email -> detection the owner confirms.
            data.billDetections[key]={ key, kind:'bill', provider:prov.name, providerId:prov.id, book:prov.book||'general',
              category:prov.category||'Utilities', matchName:prov.matchName||prov.name, messageId, subject,
              receivedAt:new Date(receivedMs).toISOString(), amount:hasAmt?ext.amount:null,
              // If the email prints no due date (Con Ed "bill ready"), estimate it ~21 days out (typical
              // utility terms) so this month's bill lands in the month it's actually due/paid, not the same
              // month as a prior bill; flag it as an estimate.
              dueDate:(ext&&ext.dueDate)||(hasAmt?new Date(receivedMs+21*86400000).toISOString().slice(0,10):null), dueEstimated:!(ext&&ext.dueDate)&&hasAmt,
              invoiceNo:(ext&&ext.invoiceNo)||null, accountNo:(ext&&ext.accountNo)||null,
              amountFound:!!(ext&&ext.amountFound), status:'new', error:(ext&&ext.error)||null, detectedAt:now() };
            if(ext&&ext.amount!=null) log.detected++; else log.noAmount++;
          }
        }
        await cmd('LOGOUT');
        data.billMeta.lastRun={ at:now(), found:log.found, detected:log.detected, noAmount:log.noAmount, failed:log.failed.length };
        saveData();
        finish(log);
      }catch(e){ finish(Object.assign(log,{error:'IMAP error: '+(e&&e.message||e)})); }
    }
  });
}
setInterval(()=>{ if(secrets.nrsEmailFetch && (data.billProviders||[]).some(p=>p.active!==false)) billGmailRun({ sinceDays:60 }).catch(()=>{}); }, 60*60*1000);

/* --- CSV export of products --- */
function productsCSV(){
  const cols = ['sku','barcode','name','brand','category','subcategory','description',
    'costPrice','retailPrice','salePrice','qty','reorderThreshold','aisle','shelf','bin','supplier'];
  const esc = v => { v = (v==null?'':String(v)); return /[",\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; };
  const rows = [cols.join(',')];
  for (const p of data.products) rows.push(cols.map(c=>esc(p[c])).join(','));
  return rows.join('\n');
}

/* --- WooCommerce (familybazarny.com) push --- */
// Maps ROS categories to your website's category names.
const WOO_CAT_MAP = {
  'Grocery':'Food, Candy & Drinks','Beverages':'Food, Candy & Drinks','Snacks':'Food, Candy & Drinks',
  'Frozen':'Food, Candy & Drinks','Bakery':'Food, Candy & Drinks','Household':'Household Supplies',
  'Health & Beauty':'Health & Beauty','Electronics':'Electronics & Accessories','Pet':'Pet Supplies'
};
function normCat(s){ return (s||'').toLowerCase().replace(/&amp;|&/g,'and').replace(/[^a-z0-9]+/g,''); }
function normWooUrl(u){
  u = (u||'').trim().replace(/\/+$/,'');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://'+u;   // add scheme if missing
  u = u.replace(/^(https?:\/\/)www\./i, '$1');        // use the canonical (non-www) host
  return u;
}
async function wooFetch(pathQ, method='GET', body){
  const base = normWooUrl(secrets.wooUrl);
  if (!base || !secrets.wooKey || !secrets.wooSecret)
    throw new Error('WooCommerce not configured — set the store URL and API keys in Settings.');
  const url  = `${base}/wp-json/wc/v3/${pathQ}`;
  const auth = Buffer.from(`${secrets.wooKey}:${secrets.wooSecret}`).toString('base64');
  const opt  = { method, headers:{ Authorization:'Basic '+auth, 'Content-Type':'application/json' } };
  if (body) opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch(e){ j = text; }
  if (!r.ok) throw new Error('Woo API '+r.status+': '+((j&&j.message)?j.message:String(j).slice(0,180)));
  return j;
}
let _wooCats=null, _wooCatsAt=0;
async function wooCategories(){
  if (_wooCats && Date.now()-_wooCatsAt < 300000) return _wooCats;
  const all=[]; let page=1;
  while (page<=5){
    const c = await wooFetch(`products/categories?per_page=100&page=${page}`);
    if (!Array.isArray(c) || !c.length) break;
    all.push(...c); if (c.length<100) break; page++;
  }
  _wooCats=all; _wooCatsAt=Date.now(); return all;
}
async function wooCatIds(rosCat){
  try {
    const target = normCat(WOO_CAT_MAP[rosCat]||rosCat);
    if (!target) return [];
    const cats = await wooCategories();
    const m = cats.find(c=>normCat(c.name)===target)
           || cats.find(c=>{const n=normCat(c.name); return n.includes(target)||target.includes(n);});
    return m ? [{id:m.id}] : [];
  } catch(e){ return []; }
}
function wooPayload(p, isNew){
  // Website price = custom webPrice if set, otherwise the in-store retail price.
  const webReg = (p.webPrice!=null && p.webPrice!=='') ? p.webPrice : p.retailPrice;
  const pay = {
    name: p.name, type:'simple', sku: p.sku||'',
    regular_price: webReg!=null ? String(webReg) : '',
    sale_price: (p.salePrice!=null && p.salePrice!=='') ? String(p.salePrice) : '',
    description: p.description||'', short_description: p.description||'',
    manage_stock:false,                                   // hide exact counts
    stock_status: (p.qty>0 ? 'instock' : 'outofstock')
  };
  return pay;
}
async function aiWriteDescription(p){
  const bits = [p.brand,p.name,p.category].filter(Boolean).join(' — ') || p.name || '';
  if (!bits) return '';
  const prompt = `Write a concise, friendly e-commerce product description for an online marketplace listing. Product: ${bits}. 2-3 short sentences highlighting practical benefits. Do NOT invent specs, model numbers, or a price. Return only the description text.`;
  const t = await aiText(prompt, 220);
  return (t||'').trim();
}
async function wooPublishOne(p){
  const isNew = !p.wooId;
  // Auto-write a listing description with AI when the product doesn't have one (needs AI key).
  if ((!p.description || !p.description.trim()) && (secrets.aiApiKey||'').trim()){
    try { const d = await aiWriteDescription(p); if (d) p.description = d; } catch(e){}
  }
  const pay = wooPayload(p, isNew);
  const cats = await wooCatIds(p.category);
  if (cats.length) pay.categories = cats;
  // Go-live mode: 'publish' forces live (new + existing); 'draft' makes new items drafts
  // but never demotes an item you've already published live.
  if (secrets.wooPublishMode === 'publish') pay.status = 'publish';
  else if (isNew) pay.status = 'draft';
  // Only send the image when it's new or changed, so WooCommerce doesn't re-download it every time.
  const sendImage = p.image && p.image !== p.wooImageSrc;
  if (sendImage) pay.images = [{ src:p.image }];
  let res, action;
  if (p.wooId){
    res = await wooFetch('products/'+p.wooId, 'PUT', pay); action='updated';
  } else {
    let existing=null;
    if (p.sku){
      const found = await wooFetch('products?sku='+encodeURIComponent(p.sku));
      if (Array.isArray(found) && found.length) existing = found[0];
    }
    if (existing){ res = await wooFetch('products/'+existing.id, 'PUT', pay); action='linked'; }
    else { res = await wooFetch('products', 'POST', pay); action='created'; }
  }
  p.wooId = res.id; p.wooStatus = res.status; p.wooLink = res.permalink||''; p.wooSyncedAt = now();
  if (sendImage) p.wooImageSrc = p.image;
  return { action, wooId:res.id, status:res.status, link:res.permalink };
}
async function wooAutoSyncTick(){
  if (!secrets.wooAutoSync) return;
  if (!secrets.wooUrl || !secrets.wooKey || !secrets.wooSecret) return;
  const due = data.products.filter(p => p.websiteEnabled &&
    (!p.wooSyncedAt || (p.lastUpdated && p.lastUpdated > p.wooSyncedAt)));
  if (!due.length) return;
  let changed=false;
  for (const p of due.slice(0,25)){ try { await wooPublishOne(p); changed=true; } catch(e){} }
  if (changed) saveData();
}
setInterval(()=>{ wooAutoSyncTick().catch(()=>{}); }, 180000);

/* --- find & remove duplicate products on WooCommerce (same SKU) --- */
async function wooDedupe(apply){
  let all=[], page=1;
  while (page<=100){
    const list = await wooFetch(`products?per_page=100&page=${page}&status=any&orderby=id&order=asc`);
    if (!Array.isArray(list) || !list.length) break;
    all.push(...list); if (list.length<100) break; page++;
  }
  const bySku={};
  for (const p of all){ const sku=(p.sku||'').trim(); if (!sku) continue; (bySku[sku]=bySku[sku]||[]).push(p); }
  const rosBySku={}; data.products.forEach(rp=>{ if (rp.sku) rosBySku[rp.sku]=rp; });
  let dupSkus=0, extra=0, deleted=0; const details=[];
  for (const sku in bySku){
    const arr=bySku[sku]; if (arr.length<2) continue;
    dupSkus++; extra += arr.length-1;
    const ros=rosBySku[sku];
    let keeper = (ros && arr.find(x=>x.id===ros.wooId)) || arr.find(x=>x.status==='publish') || arr.slice().sort((a,b)=>a.id-b.id)[0];
    const toDelete = arr.filter(x=>x.id!==keeper.id);
    if (apply){
      for (const d of toDelete){ try { await wooFetch('products/'+d.id+'?force=true','DELETE'); deleted++; } catch(e){} }
      if (ros){ ros.wooId=keeper.id; ros.wooStatus=keeper.status; ros.wooLink=keeper.permalink||''; ros.lastUpdated=now(); }
    }
    details.push({ sku, name:keeper.name, count:arr.length, keptId:keeper.id, deletedIds:toDelete.map(x=>x.id) });
  }
  if (apply) saveData();
  return { totalWoo:all.length, dupSkus, extra, deleted, applied:!!apply, details:details.slice(0,50) };
}

/* --- WooCommerce orders -> reduce ROS stock --- */
async function wooSyncOrders(){
  let orders = [];
  for (const st of ['processing','completed']){
    try { const list = await wooFetch(`orders?status=${st}&per_page=50&orderby=date&order=desc`);
          if (Array.isArray(list)) orders = orders.concat(list); } catch(e){ throw e; }
  }
  data.wooProcessed = data.wooProcessed || {};
  data.webSales     = data.webSales || [];
  let applied = 0, unmatched = 0;
  for (const o of orders){
    if (data.wooProcessed[o.id]) continue;
    const items = [];
    for (const li of (o.line_items||[])){
      const sku = li.sku || '';
      const qty = li.quantity || 0;
      const p = sku ? data.products.find(x=>x.sku === sku) : null;
      if (p){
        p.qty = Math.max(0, (p.qty||0) - qty);
        p.lastSale = now(); p.lastUpdated = now();
        postMovement({ productId:p.id, delta:-qty, reason:'SALE', sourceType:'web', sourceRef:'web:'+(o.number||o.id)+':'+sku, note:'Web order #'+(o.number||o.id), actor:'web', applyQty:false });
        data.events.unshift({ id:uid('e'), productId:p.id, type:'Stock decrease',
          qtyChange:-qty, note:'Web order #'+(o.number||o.id), timestamp:now() });
        items.push({ sku, qty, name:li.name, matched:true });
      } else { items.push({ sku, qty, name:li.name, matched:false }); unmatched++; }
    }
    data.wooProcessed[o.id] = true;
    data.webSales.unshift({ orderId:o.id, number:String(o.number||o.id),
      date:o.date_created||now(), total:o.total, status:o.status, items });
    applied++;
  }
  if (data.webSales.length > 500) data.webSales = data.webSales.slice(0,500);
  if (applied) saveData();
  return { newOrders:applied, checked:orders.length, unmatched };
}
async function wooOrderTick(){
  if (!secrets.wooOrderSync) return;
  if (!secrets.wooUrl || !secrets.wooKey || !secrets.wooSecret) return;
  try { await wooSyncOrders(); } catch(e){}
}
setInterval(()=>{ wooOrderTick().catch(()=>{}); }, 180000);
setInterval(()=>{ pullWebCustomersAuto().catch(()=>{}); }, 600000);   // pull website signups every 10 min when enabled
setInterval(()=>{ pullWebOrdersAuto().catch(()=>{}); }, 120000);      // pull website reservations every 2 min when platform is configured
setInterval(()=>{ pullFulfillmentAuto().catch(()=>{}); }, 120000);   // refresh the unified fulfillment queue every 2 min

// Publication runs on its own timer so it can never be switched off with enrichment.
setInterval(()=>{ try{ publishTick(); }catch(e){} }, 120000);
// Unattended enrichment: name + score + flag the next batch. New products from POS/invoice are
// picked up automatically because they arrive unprocessed. Runs forever, needs nobody.
setInterval(()=>{ autoNameTick(20).catch(()=>{}); }, 120000);

/* --- Google Merchant Center product feed --- */
function xmlEsc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])); }
function googleFeed(){
  const items = data.products.filter(p => p.websiteEnabled && p.wooLink &&
    ((p.webPrice!=null&&p.webPrice!=='')||p.retailPrice!=null));
  const rows = items.map(p=>{
    const price = ((p.webPrice!=null&&p.webPrice!=='')?p.webPrice:p.retailPrice);
    const avail = (p.qty>0?'in stock':'out of stock');
    return `  <item>
    <g:id>${xmlEsc(p.sku||p.id)}</g:id>
    <g:title>${xmlEsc(p.name)}</g:title>
    <g:description>${xmlEsc(p.description||p.name)}</g:description>
    <g:link>${xmlEsc(p.wooLink)}</g:link>
    ${p.image?`<g:image_link>${xmlEsc(p.image)}</g:image_link>`:''}
    <g:availability>${avail}</g:availability>
    <g:price>${Number(price).toFixed(2)} USD</g:price>
    ${p.brand?`<g:brand>${xmlEsc(p.brand)}</g:brand>`:''}
    ${p.barcode?`<g:gtin>${xmlEsc(p.barcode)}</g:gtin>`:''}
    <g:condition>new</g:condition>
    <g:identifier_exists>${p.barcode||p.brand?'yes':'no'}</g:identifier_exists>
  </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
  <title>Family Bazar</title>
  <link>https://familybazarny.com</link>
  <description>Family Bazar product feed</description>
${rows}
</channel>
</rss>`;
}

/* ============================================================
   Router
   ============================================================ */
/* ============================================================
   Marketing engine — SMS (Twilio) + Email (SendGrid) + AI copy
   ============================================================ */
function personalize(msg, c){
  return String(msg||'')
    .replace(/\{name\}/gi, (c&&c.name)?String(c.name).split(' ')[0]:'there')
    .replace(/\{points\}/gi, (c&&c.points!=null)?c.points:0)
    .replace(/\{store\}/gi, 'Family Bazar');
}
async function sendSMS(to, body){
  const sid=(secrets.twilioSid||'').trim(), tok=(secrets.twilioToken||'').trim(), from=(secrets.twilioFrom||'').trim();
  if(!sid||!tok||!from) throw new Error('Twilio not set up (SID, token, and from-number needed in Settings).');
  const url=`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth=Buffer.from(sid+':'+tok).toString('base64');
  const params=new URLSearchParams({ To:to, From:from, Body:body });
  const r=await fetch(url,{method:'POST',headers:{Authorization:'Basic '+auth,'Content-Type':'application/x-www-form-urlencoded'},body:params.toString()});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error('Twilio: '+(j.message||('HTTP '+r.status)));
  return j.sid||true;
}
async function sendEmail(to, subject, text){
  const key=(secrets.sendgridKey||'').trim(), fromE=(secrets.fromEmail||'').trim(), fromN=secrets.fromName||'Family Bazar';
  if(!key||!fromE) throw new Error('Email not set up (SendGrid key + from-email needed in Settings).');
  const r=await fetch('https://api.sendgrid.com/v3/mail/send',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({ personalizations:[{to:[{email:to}]}], from:{email:fromE,name:fromN}, subject:subject||'A note from Family Bazar', content:[{type:'text/plain',value:text}] })});
  if(!(r.status>=200&&r.status<300)){ const t=await r.text().catch(()=>''); throw new Error('SendGrid HTTP '+r.status+' '+t.slice(0,140)); }
  return true;
}
async function cloverCustomersImport(){
  const mId=(secrets.cloverMerchantId||'').trim(), token=(secrets.cloverApiToken||'').trim(), base=(secrets.cloverBase||'https://api.clover.com').trim();
  if(!mId||!token) throw new Error('Clover not configured (merchant ID + token in Settings).');
  const r=await fetch(`${base}/v3/merchants/${mId}/customers?expand=emailAddresses,phoneNumbers&limit=1000`,{headers:{Authorization:'Bearer '+token}});
  if(!r.ok) throw new Error('Clover customers API HTTP '+r.status);
  const j=await r.json(); const els=j.elements||[];
  data.customers = data.customers || [];
  let added=0, updated=0;
  for(const c of els){
    const name=((c.firstName||'')+' '+(c.lastName||'')).trim()||c.name||'Customer';
    const phone=(c.phoneNumbers&&c.phoneNumbers.elements&&c.phoneNumbers.elements[0]&&c.phoneNumbers.elements[0].phoneNumber)||'';
    const email=(c.emailAddresses&&c.emailAddresses.elements&&c.emailAddresses.elements[0]&&c.emailAddresses.elements[0].emailAddress)||'';
    let ex=data.customers.find(x=>(x.cloverId&&x.cloverId===c.id)||(phone&&x.phone===phone)||(email&&x.email&&x.email.toLowerCase()===email.toLowerCase()));
    if(ex){ ex.cloverId=c.id; if(phone)ex.phone=phone; if(email)ex.email=email; if(name&&!ex.name)ex.name=name; updated++; }
    else { data.customers.push({ id:uid('c'), cloverId:c.id, name, phone, email, points:0, tags:[], optIn:true, source:'Clover', createdAt:now(), lastContact:null, lastVisit:null, totalSpent:0 }); added++; }
  }
  saveData();
  return { added, updated, total: els.length };
}

/* --- pull website signups (from the customer platform) into the marketing list --- */
const PLATFORM_URL_DEFAULT = 'https://familybazar-platform.vercel.app';
async function pullWebCustomers(){
  const base = (secrets.platformUrl || PLATFORM_URL_DEFAULT).replace(/\/+$/,'');
  const secret = (secrets.platformSecret||'').trim();
  if(!secret) throw new Error('Set the Platform sync secret in Settings (same value as the website ROS_SYNC_SECRET).');
  const since = secrets.webCustPulledAt ? `?since=${encodeURIComponent(secrets.webCustPulledAt)}` : '';
  const r = await fetch(`${base}/api/connector/customers${since}`, { headers:{ 'x-ros-secret': secret } });
  if(!r.ok){ const t=await r.text().catch(()=>''); throw new Error('Website HTTP '+r.status+' '+t.slice(0,120)); }
  const j = await r.json();
  const list = Array.isArray(j.customers) ? j.customers : [];
  data.customers = data.customers || [];
  let added=0, updated=0;
  for(const c of list){
    const phone=(c.phone||'').trim(), email=(c.email||'').trim();
    if(!phone && !email) continue;
    const optIn = !!(c.smsOptIn || c.emailOptIn);
    const ex = data.customers.find(x=>(phone&&x.phone===phone)||(email&&x.email&&x.email.toLowerCase()===email.toLowerCase()));
    if(ex){
      if(phone&&!ex.phone) ex.phone=phone;
      if(email&&!ex.email) ex.email=email;
      if(c.name&&(!ex.name||ex.name==='Web signup')) ex.name=c.name;
      if(optIn) ex.optIn=true;
      if(!ex.source) ex.source='Website';
      if(!(ex.tags||[]).includes('website')) ex.tags=[...(ex.tags||[]),'website'];
      // Loyalty + activity summary come from the platform (the unified customer source of truth).
      if(c.loyaltyTier) ex.loyaltyTier=c.loyaltyTier;
      if(c.loyaltyPoints!=null) ex.loyaltyPoints=c.loyaltyPoints;
      if(c.activity) ex.activity=c.activity;
      if(typeof c.txnConsent==='boolean') ex.txnConsent=c.txnConsent;
      if(typeof c.smsOptIn==='boolean') ex.smsOptIn=c.smsOptIn;
      updated++;
    } else {
      data.customers.push({ id:uid('c'), name:c.name||'Web signup', phone, email, points:0, tags:['website'], optIn, source:'Website',
        loyaltyTier:c.loyaltyTier||null, loyaltyPoints:c.loyaltyPoints||0, activity:c.activity||null, txnConsent:(typeof c.txnConsent==='boolean'?c.txnConsent:true), smsOptIn:!!c.smsOptIn,
        createdAt:now(), lastContact:null, lastVisit:null, totalSpent:0 });
      added++;
    }
  }
  secrets.webCustPulledAt = new Date().toISOString(); saveSecrets();
  saveData();
  return { added, updated, total:list.length };
}
async function pullWebCustomersAuto(){
  if(!secrets.webCustomerSync) return;
  if(!(secrets.platformSecret||'').trim()) return;
  try { await pullWebCustomers(); } catch(e){ /* best-effort background pull */ }
}

/* --- single customer record: look up the full website profile (timeline, loyalty, tags) by phone --- */
async function customerLookup(q){
  const base = (secrets.platformUrl || PLATFORM_URL_DEFAULT).replace(/\/+$/,'');
  const secret = (secrets.platformSecret||'').trim();
  if(!secret) throw new Error('Set the Platform sync secret in Settings first.');
  const qs = q.id ? `id=${encodeURIComponent(q.id)}` : `phone=${encodeURIComponent(q.phone||'')}`;
  const r = await fetch(`${base}/api/connector/customer?${qs}`, { headers:{ 'x-ros-secret': secret } });
  if(!r.ok){ const t=await r.text().catch(()=>''); throw new Error('Website HTTP '+r.status+' '+t.slice(0,120)); }
  const j = await r.json();
  return j.customer || null;
}
async function customerSetTags(q, tags){
  const base = (secrets.platformUrl || PLATFORM_URL_DEFAULT).replace(/\/+$/,'');
  const secret = (secrets.platformSecret||'').trim();
  if(!secret) throw new Error('Set the Platform sync secret in Settings first.');
  const r = await fetch(`${base}/api/connector/customer/tags`, { method:'POST', headers:{ 'x-ros-secret': secret, 'content-type':'application/json' }, body: JSON.stringify({ id:q.id, phone:q.phone, tags }) });
  if(!r.ok){ const t=await r.text().catch(()=>''); throw new Error('Website HTTP '+r.status+' '+t.slice(0,120)); }
  const j = await r.json();
  return j.tags || [];
}

/* --- website reservations/orders: pull from the platform so staff can prep + notify on ready --- */
async function pullWebOrders(){
  const base = (secrets.platformUrl || PLATFORM_URL_DEFAULT).replace(/\/+$/,'');
  const secret = (secrets.platformSecret||'').trim();
  if(!secret) throw new Error('Set the Platform sync secret in Settings (same as the website ROS_SYNC_SECRET).');
  const since = secrets.webOrdersPulledAt ? `?since=${encodeURIComponent(secrets.webOrdersPulledAt)}` : '';
  const r = await fetch(`${base}/api/connector/orders${since}`, { headers:{ 'x-ros-secret': secret } });
  if(!r.ok){ const t=await r.text().catch(()=>''); throw new Error('Website HTTP '+r.status+' '+t.slice(0,120)); }
  const j = await r.json();
  const list = Array.isArray(j.orders) ? j.orders : [];
  data.webOrders = data.webOrders || [];
  let added=0;
  for(const o of list){
    if(!o.code) continue;
    const ex = data.webOrders.find(x=>x.code===o.code);
    if(ex){ ex.total=o.total; ex.lines=o.lines||ex.lines; ex.discount=o.discount||0; ex.couponCode=o.couponCode||null; continue; }   // refresh, keep local status
    data.webOrders.unshift({ code:o.code, status:'new', fulfillment:o.fulfillment||'PICKUP', name:o.contactName||'', phone:o.contactPhone||'', email:o.contactEmail||'', address:o.address||'', total:o.total, discount:o.discount||0, couponCode:o.couponCode||null, lines:o.lines||[], createdAt:o.createdAt||now(), notifiedAt:null, doneAt:null, via:null });
    added++;
  }
  secrets.webOrdersPulledAt = new Date().toISOString(); saveSecrets();
  saveData();
  return { added, total:list.length, open:data.webOrders.filter(x=>x.status!=='done').length };
}
async function pullWebOrdersAuto(){
  if(!(secrets.platformSecret||'').trim()) return;
  try { await pullWebOrders(); } catch(e){ /* best-effort background pull */ }
}

/* --- UNIFIED fulfillment queue: pull reservations/orders/repairs/services + act (status + notify) --- */
async function pullFulfillment(){
  const base=(secrets.platformUrl||PLATFORM_URL_DEFAULT).replace(/\/+$/,'');
  const secret=(secrets.platformSecret||'').trim();
  if(!secret) throw new Error('Set the Platform sync secret in Settings (same as the website ROS_SYNC_SECRET).');
  const r=await fetch(`${base}/api/connector/fulfillment`,{headers:{'x-ros-secret':secret}});
  if(!r.ok){ const t=await r.text().catch(()=>''); throw new Error('Website HTTP '+r.status+' '+t.slice(0,120)); }
  const j=await r.json();
  data.fulfillment = Array.isArray(j.items)?j.items:[];
  data.fulfillmentPulledAt = now();
  saveData();
  return { count:data.fulfillment.length };
}
async function pullFulfillmentAuto(){ if(!(secrets.platformSecret||'').trim()) return; try{ await pullFulfillment(); }catch(e){} }

// Product PUSH to the website. Locally this is a Windows Task Scheduler job (platform-sync.js). In the
// cloud there is no scheduler, so the server runs the same connector on a timer. Enable with env
// ROS_PUSH=1 or by setting secrets.autoPushProducts=true (kept OFF locally so it doesn't double-run).
let _pushingProducts = false;
function pushProductsToPlatform(){
  if (_pushingProducts) return;
  if (!(process.env.ROS_PUSH === '1' || secrets.autoPushProducts === true)) return;
  const base   = (secrets.platformUrl || PLATFORM_URL_DEFAULT).replace(/\/+$/,'');
  const secret = (secrets.platformSecret || '').trim();
  if (!secret) return;
  _pushingProducts = true;
  try {
    const child = spawn(process.execPath, [path.join(DIR, 'platform-sync.js')], {
      env: Object.assign({}, process.env, {
        ROS_DATA_DIR: DATA_DIR,
        PLATFORM_SYNC_URL: base + '/api/connector/sync',
        PLATFORM_SYNC_SECRET: secret,
      }),
      stdio: 'ignore',
    });
    child.on('exit', ()=>{ _pushingProducts = false; });
    child.on('error', ()=>{ _pushingProducts = false; });
  } catch(e){ _pushingProducts = false; }
}
setInterval(pushProductsToPlatform, 5*60*1000);   // every 5 min when enabled
async function fulfillmentUpdate(type, code, status, note){
  const base=(secrets.platformUrl||PLATFORM_URL_DEFAULT).replace(/\/+$/,'');
  const secret=(secrets.platformSecret||'').trim();
  if(!secret) throw new Error('Set the Platform sync secret in Settings.');
  const r=await fetch(`${base}/api/connector/fulfillment/update`,{method:'POST',headers:{'x-ros-secret':secret,'content-type':'application/json'},body:JSON.stringify({type,code,status,note:note||undefined})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
  return j;
}
function fulfillmentMsg(item, status){
  const first=(item.name||'').trim().split(' ')[0]||'there';
  if(status==='READY'){
    if(item.type==='order') return `Hi ${first}, your Family Bazar order ${item.code} is ready for pickup at 1145 Liberty Ave. Show this code at the counter. Reply STOP to opt out.`;
    if(item.type==='repair') return `Hi ${first}, your device repair ${item.code} at Family Bazar is ready for pickup at 1145 Liberty Ave. Reply STOP to opt out.`;
    return `Hi ${first}, your Family Bazar reservation ${item.code} is ready for pickup at 1145 Liberty Ave. Show this code at the counter. Reply STOP to opt out.`;
  }
  return '';
}
async function fulfillmentAct(type, code, status, notify){
  const CODE=String(code).toUpperCase();
  data.fulfillmentLocal = data.fulfillmentLocal || {};
  const key = type+':'+CODE;
  const loc = data.fulfillmentLocal[key] || (data.fulfillmentLocal[key]={});
  // Accept + Preparing are internal workflow stages — tracked in the ROS only, NOT sent to the customer.
  if(status==='ACCEPTED'){ loc.stage='accepted'; loc.acceptedAt=now(); saveData(); return { ok:true, stage:'accepted' }; }
  if(status==='PREPARING'){ loc.stage='preparing'; loc.preparingAt=now(); saveData(); return { ok:true, stage:'preparing' }; }
  // Everything else writes the customer-visible status to the platform.
  await fulfillmentUpdate(type, code, status);
  data.fulfillment = data.fulfillment||[];
  const item = data.fulfillment.find(x=>x.type===type && String(x.code).toUpperCase()===CODE);
  if(item) item.status=status;
  let via='';
  if(status==='READY'){
    loc.stage='ready';
    if(notify && item){
      const msg = fulfillmentMsg(item, 'READY');
      if(msg){
        if((item.phone||'').trim()){ try{ await sendSMS(item.phone,msg); via='sms'; }catch(e){} }
        if(!via && (item.email||'').trim()){ try{ await sendEmail(item.email,'Update from Family Bazar',msg); via='email'; }catch(e){} }
      }
      if(via){ loc.notifiedAt=now(); loc.notifiedVia=via; }
    }
  } else if(status==='FULFILLED'||status==='PICKED_UP'){ loc.stage='done'; loc.completedAt=now(); }
  else if(status==='CANCELLED'){ loc.stage='cancelled'; }
  saveData();
  return { ok:true, via };
}
async function notifyWebOrder(code){
  data.webOrders = data.webOrders || [];
  const o = data.webOrders.find(x=>x.code===code);
  if(!o) throw new Error('Order not found.');
  const first = (o.name||'').trim().split(' ')[0] || 'there';
  const msg = `Hi ${first}, your Family Bazar order ${o.code} is ready for pickup at 1145 Liberty Ave. Show this code at the counter. Reply STOP to opt out.`;
  let via='';
  if((o.phone||'').trim()){ try { await sendSMS(o.phone, msg); via='sms'; } catch(e){ /* fall back to email */ } }
  if(!via && (o.email||'').trim()){ await sendEmail(o.email, 'Your Family Bazar order is ready', msg); via='email'; }
  if(!via) throw new Error('No reachable phone/email on this order, or SMS/email is not set up in Settings.');
  o.status='ready'; o.notifiedAt=now(); o.via=via;
  saveData();
  return { ok:true, via };
}

/* ===== Supplier Invoice Intake (MVP): capture -> AI vision extraction -> review -> post ===== */
const INVOICE_DIR = path.join(DIR, 'invoices');
function ensureInvoiceDir(){ try{ if(!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR,{recursive:true}); }catch(e){} }
function invoiceHash(buffers){ const h=crypto.createHash('md5'); for(const b of buffers) h.update(b); return h.digest('hex'); }

// Vision extraction. files:[{mime,b64}]. Anthropic handles images + PDFs; OpenAI images only.
async function aiVision(files, prompt, maxTokens){
  const key=(secrets.aiApiKey||'').trim();
  if(!key) throw new Error('Add an AI key in Settings to use invoice scanning.');
  const provider=secrets.aiProvider||'anthropic';
  maxTokens=maxTokens||4000;
  if(provider==='openai'){
    const content=[{type:'text',text:prompt}];
    for(const f of files){
      if(/pdf/i.test(f.mime)) throw new Error('PDF scanning needs the Anthropic provider (or upload images instead).');
      content.push({type:'image_url',image_url:{url:`data:${f.mime||'image/jpeg'};base64,${f.b64}`}});
    }
    const cands=[...new Set([aiModelName(),'gpt-4o','gpt-4o-mini'])]; let last='';
    for(const model of cands){
      const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model,max_tokens:maxTokens,messages:[{role:'user',content}]})});
      const j=await r.json(); if(j.error){last=j.error.message||'error';if(/model/i.test(last))continue;throw new Error(last);}
      return (j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content)||'';
    }
    throw new Error('No usable OpenAI vision model. '+last);
  }
  const hasPdf=files.some(f=>/pdf/i.test(f.mime));
  const content=[{type:'text',text:prompt}];
  for(const f of files){
    if(/pdf/i.test(f.mime)) content.push({type:'document',source:{type:'base64',media_type:'application/pdf',data:f.b64}});
    else content.push({type:'image',source:{type:'base64',media_type:f.mime||'image/jpeg',data:f.b64}});
  }
  const cands=[...new Set([aiModelName(),'claude-sonnet-4-6','claude-haiku-4-5','claude-3-5-sonnet-20241022'])]; let last='';
  for(const model of cands){
    const headers={'x-api-key':key,'anthropic-version':'2023-06-01','Content-Type':'application/json'};
    if(hasPdf) headers['anthropic-beta']='pdfs-2024-09-25';
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers,body:JSON.stringify({model,max_tokens:maxTokens,messages:[{role:'user',content}]})});
    const j=await r.json();
    if(j.error){ last=(j.error.message||'')+' ['+(j.error.type||'')+']'; const t=(j.error.type||'')+' '+(j.error.message||''); if(/not_found|model/i.test(t))continue; throw new Error(last); }
    return (j.content&&j.content[0]&&j.content[0].text)||'';
  }
  throw new Error('No Claude vision model worked. '+last);
}

// Compact positional line format — dropping repeated key names roughly halves output tokens, so a
// 69-line invoice fits in one pass instead of being truncated. `lineCount` lets us verify completeness.
const LINE_FIELDS = 'description(string), sku(string|null), upc(string|null), casePack(number|null), qty(number|null), unitCost(number|null), lineTotal(number|null), confidence(0..1)';
const INVOICE_PROMPT =
`You are a careful data-entry assistant reading a SUPPLIER INVOICE for a variety/dollar store. Extract the header and EVERY line item exactly as printed. Do NOT invent values; if something is missing or unreadable use null and lower confidence.
Return ONLY JSON, no prose. Line items are ARRAYS (not objects) to save space:
{"invoice":{"supplier":string|null,"invoiceNumber":string|null,"invoiceDate":string|null,"po":string|null,"deliveryNote":string|null,"orderNumber":string|null,"totalCases":number|null,"subtotal":number|null,"tax":number|null,"freight":number|null,"total":number|null,"handwritten":boolean},
"lineCount":number,
"lines":[[${LINE_FIELDS}], ...]}
Field order in every line array is EXACTLY: ${LINE_FIELDS}.
Rules: numbers plain (no $ or commas). Dates YYYY-MM-DD when possible. confidence 0..1 per line (clear print >=0.9, blurry/handwritten lower). invoice.handwritten=true if mostly handwritten.
sku = the supplier's item/part number as printed. upc = ONLY a real 12-13 digit barcode number if the invoice prints one, otherwise null — never put the supplier item number in upc.
lineCount = how many line items the invoice actually has. Output EVERY line, to the last one.
IMPORTANT on quantities: wholesale invoices ship CASES. qty = the shipped/case quantity exactly as printed. casePack = units inside one case. unitCost = the printed unit/case price that satisfies qty x unitCost = lineTotal (do NOT divide it per piece). totalCases = the invoice's total case count if printed.`;

const contPrompt = (n) =>
`Continue reading the SAME supplier invoice. Return ONLY JSON, no prose:
{"lines":[[${LINE_FIELDS}], ...]}
Include ONLY the line items AFTER the first ${n}, in order, through the very last line. Same field order and rules as before. If none remain, return {"lines":[]}.`;

// Positional line array -> object. Tolerates the older keyed-object format too.
function toLineObj(a){
  if(Array.isArray(a)) return { description:a[0]??null, sku:a[1]??null, upc:a[2]??null, casePack:a[3]??null, qty:a[4]??null, unitCost:a[5]??null, lineTotal:a[6]??null, confidence:a[7]??null };
  return (a && typeof a === 'object') ? a : null;
}
const lineKey = (l) => [l&&l.description, l&&l.qty, l&&l.lineTotal].join('|');

async function extractInvoice(rec){
  const files = rec.files.map(f=>({ mime:f.mime, b64: fs.readFileSync(path.join(INVOICE_DIR, f.stored)).toString('base64') }));
  const raw = await aiVision(files, INVOICE_PROMPT, 8000);
  let res = parseJSONLooseEx(raw);
  const parsed = res.data || {};
  const inv = parsed.invoice || {};
  let lines = (Array.isArray(parsed.lines) ? parsed.lines : []).map(toLineObj).filter(Boolean);
  const expected = Number(parsed.lineCount) || 0;   // the model's own count — a HINT, it can undercount
  const total = Number(inv.total || 0);
  const sumOf = (ls) => ls.reduce((s,l)=> s + (Number(l.lineTotal) || (Number(l.qty||0)*Number(l.unitCost||0)) || 0), 0);
  // Line items sum to the SUBTOTAL — tax and freight are not line items. Comparing against the grand
  // total would make every taxed/freighted invoice look permanently "short" and loop pointlessly.
  const subtotalRaw = Number(inv.subtotal);
  const hasSubtotal = Number.isFinite(subtotalRaw) && subtotalRaw > 0;
  const goodsTotal = hasSubtotal
    ? subtotalRaw
    : (total > 0 ? Math.max(0, total - (Number(inv.tax)||0) - (Number(inv.freight)||0)) : 0);

  // Keep pulling until the invoice is demonstrably complete. The model's self-reported line count can
  // be wrong, so the AUTHORITATIVE signal is money: if the lines don't add up to the printed total,
  // lines are still missing. We also continue when the response was truncated or fell short of the count.
  const incomplete = () => res.salvaged
    || (expected && lines.length < expected)
    || (goodsTotal > 0 && sumOf(lines) < goodsTotal * 0.98);
  let passes = 0;
  while (passes < 6 && incomplete()) {
    passes++;
    let more;
    try { more = await aiVision(files, contPrompt(lines.length), 8000); } catch(e){ break; }
    const r2 = parseJSONLooseEx(more);
    let add = (Array.isArray((r2.data||{}).lines) ? r2.data.lines : []).map(toLineObj).filter(Boolean);
    // Drop repeats of lines we already captured around the boundary.
    const tail = new Set(lines.slice(-10).map(lineKey));
    while (add.length && tail.has(lineKey(add[0]))) add.shift();
    add = add.filter(l => !tail.has(lineKey(l)));
    if (!add.length) break;
    lines = lines.concat(add);
    res = r2;
    if (lines.length > 500) break; // sanity guard
  }

  const sum = sumOf(lines);
  rec.extracted = { invoice: inv, lines, lineCount: Math.max(expected||0, lines.length), computedTotal: Math.round(sum*100)/100, goodsTotal: Math.round(goodsTotal*100)/100 };

  const warns = [];
  const gotAnything = !!(inv.supplier || inv.invoiceNumber || inv.invoiceDate || inv.total || lines.length);
  if(!gotAnything){
    warns.push('Could not read this invoice automatically. Re-upload clearer photos or a searchable PDF, or enter it manually.');
    rec.rawText = String(raw||'').slice(0,4000);
  } else {
    delete rec.rawText;
    if(expected && lines.length < expected) warns.push(`Read ${lines.length} line items but the invoice appears to list ${expected} — check the end of the invoice.`);
    else if(res.salvaged) warns.push('Response was truncated — verify the last line items.');
  }
  if(goodsTotal && Math.abs(sum-goodsTotal) > Math.max(1, goodsTotal*0.02)){
    const diff = Math.abs(sum-goodsTotal).toFixed(2);
    const label = hasSubtotal ? 'subtotal' : 'goods total (total minus tax/freight)';
    warns.push(sum < goodsTotal
      ? `Lines add up to $${sum.toFixed(2)} but the ${label} is $${goodsTotal.toFixed(2)} — $${diff} SHORT, so line items are probably still missing.`
      : `Lines add up to $${sum.toFixed(2)} but the ${label} is $${goodsTotal.toFixed(2)} — $${diff} OVER, check for duplicated lines.`);
  }
  // Second integrity check, independent of money: the invoice's printed case count vs the lines.
  const totCases = Number(inv.totalCases)||0;
  const qtySum = lines.reduce((s,l)=> s + (Number(l.qty)||0), 0);
  if(totCases && Math.round(qtySum) !== Math.round(totCases)) warns.push(`Invoice says ${totCases} total cases but the lines add up to ${qtySum} — check quantities.`);
  if(lines.some(l=>l.qty==null)) warns.push('Some lines are missing a quantity');
  if(lines.some(l=>l.unitCost==null && l.caseCost==null)) warns.push('Some lines are missing a cost');
  if(lines.some(l=>Number(l.confidence)<0.6) || inv.handwritten) warns.push('Low-confidence or handwritten lines — review carefully');
  rec.warnings = warns;
  rec.status = 'needs_review';
  rec.extractedAt = now();
  saveData();
  return rec;
}

/* ---- Inventory movement ledger ----
   Append-only history of every stock change. Phase 1: movements are recorded AND product.qty is
   updated additively, so every existing reader (ROS UI, platform sync, Clover push) keeps working.
   Phase 2 (post-launch) makes qty derived from this ledger. See the Inventory Intake ADR §8/§13.

   Reasons: OPENING_BALANCE | RECEIPT | SALE | RETURN | ADJUSTMENT | COUNT | VOID
   Idempotency: (sourceType, sourceRef) is unique — the same receipt or sale can never post twice. */
function movementExists(sourceType, sourceRef){
  if(!sourceRef) return false;
  return (data.movements||[]).some(m => m.sourceType===sourceType && m.sourceRef===sourceRef);
}
// applyQty:false = record history only, for call sites that already adjusted qty themselves
// (the existing sales syncs). Keeps proven code paths untouched while the ledger stays complete.
function postMovement({ productId, delta, reason, sourceType, sourceRef, unitCost, note, actor, applyQty = true }){
  data.movements = data.movements || [];
  if(movementExists(sourceType, sourceRef)) return { skipped:true, reason:'duplicate' };
  const p = (data.products||[]).find(x=>String(x.id)===String(productId));
  if(!p) return { skipped:true, reason:'unknown_product' };
  const d = Number(delta)||0;
  const m = {
    id: 'MV-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase(),
    productId: String(productId), delta: d, reason: reason||'ADJUSTMENT',
    sourceType: sourceType||'manual', sourceRef: sourceRef||null,
    unitCost: (unitCost==null?null:Number(unitCost)), note: note||null, actor: actor||'system',
    at: now(), balanceAfter: null,
  };
  // Phase 1: keep qty as the working number, updated additively.
  if(applyQty){
    p.qty = Math.max(0, (Number(p.qty)||0) + d);
    p.lastUpdated = now();
  }
  m.balanceAfter = Number(p.qty)||0;
  data.movements.push(m);
  if(data.movements.length > 50000) data.movements = data.movements.slice(-40000); // bound the file
  return { ok:true, movement:m, balance:p.qty };
}
// Reverse a movement with an offsetting entry — corrections are never edits or deletions.
function reverseMovement(movementId, actor){
  const m = (data.movements||[]).find(x=>x.id===movementId);
  if(!m) return { error:'Movement not found.' };
  if(m.reversedBy) return { error:'Already reversed.' };
  const r = postMovement({
    productId: m.productId, delta: -m.delta, reason: 'VOID',
    sourceType: 'reversal', sourceRef: 'void:'+m.id,
    unitCost: m.unitCost, note: 'Reversal of '+m.id, actor,
  });
  if(r.ok){ m.reversedBy = r.movement.id; saveData(); }
  return r;
}

/* ---- Invoice line -> existing catalog product matching ----
   Order of confidence: real UPC > learned supplier SKU > catalog SKU > fuzzy name.
   Every manual correction is REMEMBERED per supplier, so the same item auto-matches next time. */
function normText(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }
function tokenSet(s){ const out=new Set(); for(const t of normText(s).split(' ')) if(t.length>1) out.add(t); return out; }
function diceScore(A,B){ if(!A.size||!B.size) return 0; let inter=0; const [S,L]=A.size<B.size?[A,B]:[B,A]; for(const t of S) if(L.has(t)) inter++; return (2*inter)/(A.size+B.size); }
function supplierKey(rec){ return normText((rec.extracted&&rec.extracted.invoice&&rec.extracted.invoice.supplier)||rec.supplier||''); }
function productIndex(){
  const products = data.products||[];
  const byId=new Map(), byBarcode=new Map(), bySku=new Map(), toks=[];
  for(const p of products){
    byId.set(String(p.id),p);
    const bc=String(p.barcode||'').replace(/\D/g,''); if(bc) byBarcode.set(bc,p);
    const sk=String(p.sku||'').trim().toLowerCase(); if(sk) bySku.set(sk,p);
    toks.push({ p, t: tokenSet((p.displayName||p.name||'')+' '+(p.brand||'')) });
  }
  return { products, byId, byBarcode, bySku, toks };
}
function decorateMatch(m, byId){
  const p = byId.get(String(m.productId));
  m.name = p ? (p.displayName||p.name||'') : '';
  m.image = p ? (p.image||'') : '';
  m.barcode = p ? (p.barcode||'') : '';
  return m;
}
function matchInvoiceLines(rec){
  const { byId, byBarcode, bySku, toks } = productIndex();
  const memory = (data.supplierSkus && data.supplierSkus[supplierKey(rec)]) || {};
  const lines = (rec.extracted && rec.extracted.lines) || [];
  for(const l of lines){
    if(l.match && l.match.locked) continue;           // a manual choice always wins
    const upc = String(l.upc||'').replace(/\D/g,'');
    const sku = String(l.sku||'').trim().toLowerCase();
    let m = null;
    if(upc.length>=8 && byBarcode.has(upc)) m={ productId:String(byBarcode.get(upc).id), score:1, method:'upc', locked:false };
    if(!m && sku && memory[sku] && byId.has(String(memory[sku]))) m={ productId:String(memory[sku]), score:0.99, method:'learned', locked:false };
    if(!m && sku && bySku.has(sku)) m={ productId:String(bySku.get(sku).id), score:0.92, method:'sku', locked:false };
    if(!m){
      const lt = tokenSet(l.description); let best=null, bs=0;
      for(const e of toks){ const s=diceScore(lt,e.t); if(s>bs){ bs=s; best=e.p; } }
      if(best && bs>=0.55) m={ productId:String(best.id), score:Math.round(bs*100)/100, method:'name', locked:false };
    }
    l.match = m ? decorateMatch(m, byId) : null;
  }
  const matched = lines.filter(x=>x.match).length;
  rec.matchStats = { total:lines.length, matched, unmatched:lines.length-matched };
  rec.matchedAt = now();
  saveData();
  return rec;
}
function setLineMatch(rec, index, productId){
  const lines = (rec.extracted && rec.extracted.lines) || [];
  const l = lines[index];
  if(!l) return rec;
  if(!productId){
    l.match = null;
  } else {
    const p = (data.products||[]).find(x=>String(x.id)===String(productId));
    if(!p) return rec;
    l.match = { productId:String(p.id), score:1, method:'manual', locked:true, name:(p.displayName||p.name||''), image:p.image||'', barcode:p.barcode||'' };
    // Learn it: this supplier's item number now maps to this product for every future invoice.
    const sku = String(l.sku||'').trim().toLowerCase();
    if(sku){
      const k = supplierKey(rec);
      data.supplierSkus = data.supplierSkus || {};
      data.supplierSkus[k] = data.supplierSkus[k] || {};
      data.supplierSkus[k][sku] = String(p.id);
    }
  }
  const matched = lines.filter(x=>x.match).length;
  rec.matchStats = { total:lines.length, matched, unmatched:lines.length-matched };
  saveData();
  return rec;
}

/* ---- Approve & post an invoice into inventory ----
   THE CASE-PACK RULE: wholesale invoices ship CASES. qty = cases, unitCost = price per CASE.
     units received = cases x casePack        (5 x 12 = 60, NOT 5)
     true unit cost = caseCost / casePack     ($15.48 / 12 = $1.29, NOT $15.48)
   Getting this wrong makes stock wrong by the pack size and margins fictional.

   Posting is LINE-LEVEL: clean lines post immediately, uncertain lines are held, so one unknown
   item never blocks a whole delivery. Idempotent per (invoice, line) — re-posting is safe. */
function genProductId(){ return 'INVP' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase(); }
function validBarcodeDigits(v){ const d=String(v||'').replace(/\D/g,''); return (d.length>=8 && d.length<=14) ? d : null; }
function findByBarcode(bc){ return (data.products||[]).find(p=>String(p.barcode||'').replace(/\D/g,'')===bc); }
// Trusted identity: barcode / supplier-SKU / learned / manual. A NAME match is deliberately excluded —
// "FACIAL TISSUE 200 CT" ~ "Facial Tissue" must never auto-merge (pack/brand/barcode aren't proven equal).
function isConfidentMatch(m){ return !!(m && m.productId && ['manual','upc','learned','sku'].includes(m.method)); }
function cleanDesc(s){ return String(s||'').replace(/\s+/g,' ').trim(); }

// Create a POS-ready DRAFT product from a reconciled invoice line that carries a real barcode.
// POS-readiness (identity, barcode, cost, stock) is SEPARATE from website-readiness (customer name,
// image, category, SEO) which stays PENDING in the enrichment pipeline. Never invents a barcode.
function createDraftFromLine(l, barcode, perUnit, pack, supplier, invId){
  const p = {
    id: genProductId(),
    barcode,
    sku: (l.sku && String(l.sku).trim()) || null,
    name: cleanDesc(l.description),   // internal name = raw invoice description
    displayName: '',                  // customer-facing name pending enrichment
    brand: null, description: null, image: null,
    category: null, publicCategory: '',
    retailPrice: 0, salePrice: 0,     // invoices carry no RETAIL price — staff price it at the POS
    costPrice: perUnit != null ? Math.round(perUnit*10000)/10000 : null,
    casePack: pack > 1 ? pack : (Number(l.casePack)>0?Number(l.casePack):null),
    qty: 0,                           // set by the RECEIPT movement
    reorderThreshold: 5, overstockThreshold: 50,
    websiteEnabled: false,            // NOT on the website until enriched (POS-ready ≠ website-ready)
    localDeliveryEnabled: true, nationwideShippingEnabled: false,
    source: 'invoice', createdFrom: 'invoice:'+invId,
    productStatus: 'draft', needsPrice: true, needsEnrichment: true,
    lastSupplier: supplier || null, lastCostAt: now(),
    createdAt: now(), lastUpdated: now(),
  };
  data.products = data.products || [];
  data.products.unshift(p);
  // Learn the supplier SKU → new product mapping so this supplier's next invoice auto-matches it.
  const sku = String(l.sku||'').trim().toLowerCase();
  if(sku && supplier){ const k = normText(supplier); data.supplierSkus = data.supplierSkus||{}; data.supplierSkus[k] = data.supplierSkus[k]||{}; data.supplierSkus[k][sku] = p.id; }
  return p;
}

function postInvoiceToInventory(rec, actor){
  const lines = (rec.extracted && rec.extracted.lines) || [];
  const supplier = (rec.extracted && rec.extracted.invoice && rec.extracted.invoice.supplier) || rec.supplier || '';
  let posted=0, held=0, postedValue=0, heldValue=0, unitsIn=0, createdCount=0;

  lines.forEach((l, idx) => {
    const lineValue = Number(l.lineTotal) || 0;
    if(l.posted){ posted++; postedValue += lineValue; unitsIn += Number(l.postedUnits)||0; if(l.createdNew) createdCount++; return; }

    const cases = Number(l.qty);
    const pack = Number(l.casePack) > 0 ? Number(l.casePack) : 1;
    const caseCost = Number(l.unitCost);
    const validQty = Number.isFinite(cases) && cases > 0;
    const validCost = Number.isFinite(caseCost) && caseCost > 0;
    const units = validQty ? Math.round(cases * pack) : 0;
    const perUnit = validCost ? (caseCost / pack) : null;
    const barcode = validBarcodeDigits(l.upc);
    const m = l.match;

    // Resolve the target product. Trusted matches only; a barcode already in catalog is the same product.
    let targetId = null, createdNew = false;
    if(isConfidentMatch(m)) targetId = m.productId;
    else if(barcode){ const existing = findByBarcode(barcode); if(existing) targetId = String(existing.id); }

    // Unresolved → create a draft, but only with a REAL barcode + clean qty/cost/description. Never
    // auto-merge a weak name match; never invent a barcode.
    if(!targetId){
      let hold = null;
      if(!barcode) hold = (m && m.productId)
        ? 'Possible name match only — confirm the product, or scan a barcode to add it new'
        : 'Needs a barcode — scan the item or assign a store code';
      else if(!validQty) hold = 'Missing or invalid quantity';
      else if(!validCost) hold = 'Missing or invalid cost';
      else if(!cleanDesc(l.description)) hold = 'Missing description';
      if(hold){ l.holdReason = hold; held++; heldValue += lineValue; return; }
      const np = createDraftFromLine(l, barcode, perUnit, pack, supplier, rec.id);
      targetId = np.id; createdNew = true; l.createdProductId = np.id;
    } else if(!validQty){
      l.holdReason = 'Missing or invalid quantity'; held++; heldValue += lineValue; return;
    }

    const r = postMovement({
      productId: targetId, delta: units, reason: 'RECEIPT',
      sourceType: 'invoice', sourceRef: `${rec.id}#${idx}`,
      unitCost: perUnit, note: `${cases} case(s) x ${pack} from ${supplier||'supplier'}`, actor,
    });

    if(r.ok || r.reason === 'duplicate'){
      l.posted = true; l.postedAt = now(); l.postedUnits = units; l.postedUnitCost = perUnit;
      if(createdNew){ l.createdNew = true; createdCount++; }
      if(r.ok) l.movementId = r.movement.id;
      delete l.holdReason;
      posted++; postedValue += lineValue; unitsIn += units;
      // Invoice is authoritative for acquisition cost. For an EXISTING product, remember the prior cost
      // so Undo can restore it; a freshly-created draft has nothing to restore.
      if(perUnit != null && !createdNew){
        const p = (data.products||[]).find(x=>String(x.id)===String(targetId));
        if(p){
          l.prevCost = (p.costPrice == null ? null : p.costPrice);
          l.prevCasePack = (p.casePack == null ? null : p.casePack);
          p.costPrice = Math.round(perUnit * 10000) / 10000;
          p.lastCostAt = now();
          if(supplier) p.lastSupplier = supplier;
          if(Number(l.casePack) > 0) p.casePack = Number(l.casePack);
        }
      }
    } else {
      l.holdReason = r.reason === 'unknown_product' ? 'Matched product no longer exists' : 'Could not post';
      held++; heldValue += lineValue;
    }
  });

  rec.postStats = {
    posted, held, created: createdCount,
    postedValue: Math.round(postedValue*100)/100,
    heldValue: Math.round(heldValue*100)/100,
    unitsIn,
  };
  rec.status = held > 0 ? 'partially_posted' : 'posted';
  rec.postedAt = now();
  saveData();
  return rec;
}
// Undo a posting: every posted line gets an offsetting movement. Never edits or deletes history.
function voidInvoicePosting(rec, actor){
  const lines = (rec.extracted && rec.extracted.lines) || [];
  let reversed = 0;
  lines.forEach(l => {
    if(l.posted && l.movementId){
      const r = reverseMovement(l.movementId, actor);
      if(r.ok){ reversed++; }
    }
    if(l.posted){
      // Restore the cost/pack we overwrote, so undo returns the product to its exact prior state.
      if(l.match && l.match.productId && l.prevCost !== undefined){
        const p = (data.products||[]).find(x=>String(x.id)===String(l.match.productId));
        if(p){
          p.costPrice = l.prevCost;
          if(l.prevCasePack !== undefined) p.casePack = l.prevCasePack;
          p.lastUpdated = now();
        }
      }
      l.posted = false;
      delete l.movementId; delete l.postedUnits; delete l.postedAt;
      delete l.postedUnitCost; delete l.prevCost; delete l.prevCasePack; delete l.createdNew;
    }
  });
  rec.status = 'needs_review';
  rec.postStats = null;
  rec.voidedAt = now();
  saveData();
  return { rec, reversed };
}

// Durable daily sales rollup — a compact per-day, per-source aggregate that persists for annual
// reporting even if the raw event log is later trimmed. Rebuilt from events (which currently retain
// full history); days present in events overwrite their rollup entry, older stored days are preserved.
function rollupRefresh(){
  const map={};
  for(const e of (data.events||[])){
    if(!e || !e.timestamp) continue;
    const isSale=(e.type==='Stock decrease')||(Number(e.qtyChange)<0);
    if(!isSale) continue;
    const day=String(new Date(e.timestamp).toISOString()).slice(0,10);
    const note=String(e.note||'').toLowerCase();
    const src=/\(nrs\)/.test(note)?'nrs' : /\(clover\)/.test(note)?'clover' : /web order/.test(note)?'web' : 'other';
    const rev=Number(e.rev)||0, units=Math.abs(Number(e.qtyChange)||0);
    const d=map[day]=map[day]||{nrs:{r:0,u:0},clover:{r:0,u:0},web:{r:0,u:0},other:{r:0,u:0}};
    d[src].r+=rev; d[src].u+=units;
  }
  data.salesRollup=data.salesRollup||{};
  for(const day in map){ const d=map[day];
    ['nrs','clover','web','other'].forEach(s=>{ d[s].r=+d[s].r.toFixed(2); });
    data.salesRollup[day]=d;
  }
  saveData();
  return data.salesRollup;
}

const server = http.createServer(async (req, res)=>{
  const url = req.url.split('?')[0];
  try {
    // ---- AUTH GATE ----------------------------------------------------------
    // When auth is OFF (review mode), skip all enforcement and treat the caller as a guest owner.
    const me = authOn() ? currentUser(req) : GUEST;

    // Public auth endpoints (no session required)
    if (url === '/api/auth/me') return send(res,200,{ user: me, authEnabled: authOn() });
    if (url === '/api/auth/login' && req.method === 'POST'){
      const b = await readBody(req);
      const u = (secrets.users||[]).find(x=> (x.username||'').toLowerCase() === String(b.username||'').trim().toLowerCase());
      if(!u || !checkPw(u, b.password||'')) return send(res,401,{ error:'Wrong username or password' });
      const tok = signToken({ uid:u.id, role:u.role, exp: Date.now() + 1000*60*60*24*14 });
      setSessionCookie(res, req, tok, 60*60*24*14);
      return send(res,200,{ ok:true, user:{ name:u.name, role:u.role } });
    }
    if (url === '/api/auth/logout'){ setSessionCookie(res, req, '', 0); return send(res,200,{ ok:true }); }

    // Everything else requires a valid session.
    if (!me && !isPublicPath(url)){
      if (url.startsWith('/api/')) return send(res,401,{ error:'auth required' });
      res.writeHead(302, { Location:'/login.html' }); return res.end();   // send browsers to login
    }
    // Role gate for sensitive APIs.
    if (me && url.startsWith('/api/') && !isPublicPath(url)){
      if (!roleAtLeast(me, requiredRole(url, req.method)))
        return send(res,403,{ error:'Your role does not allow this action.' });
    }

    // Team management (owner only — enforced above via requiredRole).
    if (url === '/api/users' && req.method === 'GET')
      return send(res,200,{ users: (secrets.users||[]).map(u=>({ id:u.id, username:u.username, name:u.name, role:u.role, createdAt:u.createdAt })) });
    if (url === '/api/users' && req.method === 'POST'){
      const b = await readBody(req);
      const un = String(b.username||'').trim();
      if(!un || !String(b.password||'').trim()) return send(res,400,{ error:'username and password required' });
      if((secrets.users||[]).some(u=>(u.username||'').toLowerCase()===un.toLowerCase())) return send(res,400,{ error:'username already exists' });
      secrets.users.push(makeUser(un, b.name||un, b.role||'staff', b.password));
      saveSecrets(); return send(res,200,{ ok:true });
    }
    if (url === '/api/users/delete' && req.method === 'POST'){
      const b = await readBody(req);
      const target = (secrets.users||[]).find(u=>u.id===b.id);
      if(!target) return send(res,404,{ error:'not found' });
      if(target.role==='owner' && (secrets.users||[]).filter(u=>u.role==='owner').length<=1)
        return send(res,400,{ error:'cannot delete the last owner' });
      secrets.users = secrets.users.filter(u=>u.id!==b.id); saveSecrets(); return send(res,200,{ ok:true });
    }
    if (url === '/api/users/password' && req.method === 'POST'){
      const b = await readBody(req);
      // Owner can reset anyone; anyone can change their own.
      const targetId = b.id && roleAtLeast(me,'owner') ? b.id : me.id;
      const u = (secrets.users||[]).find(x=>x.id===targetId);
      if(!u) return send(res,404,{ error:'not found' });
      if(!String(b.password||'').trim()) return send(res,400,{ error:'password required' });
      u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(b.password, u.salt);
      saveSecrets(); return send(res,200,{ ok:true });
    }
    // -------------------------------------------------------------------------

    if (url === '/api/health'){
      let disk={};
      try{ const st=fs.statSync(DATA); const raw=JSON.parse(fs.readFileSync(DATA,'utf8'));
        disk={ mtime:new Date(st.mtimeMs).toISOString(), sizeKB:Math.round(st.size/1024),
          diskNrsEmails:Object.keys(raw.nrsEmails||{}).length, diskNrsDaily:Object.keys(raw.nrsDaily||{}).length,
          diskProducts:(raw.products||[]).length }; }catch(e){ disk={ error:String(e&&e.message||e) }; }
      return send(res,200,{ ok:true, products:data.products.length,
        dataDir:DATA_DIR, pid:process.pid, uptimeSec:Math.round(process.uptime()),
        memNrsEmails:Object.keys(data.nrsEmails||{}).length, memNrsDaily:Object.keys(data.nrsDaily||{}).length,
        memNrsSalesDaily:Object.keys(data.salesDaily||{}).filter(k=>k.startsWith('nrs|')).length,
        lastCommitAt:(data.nrsMeta||{}).lastCommitAt||null, disk });
    }

    if (url === '/api/state' && req.method === 'GET')  return send(res,200,data);
    if (url === '/api/state' && req.method === 'PUT'){
      const body = await readBody(req);
      if (!body || !Array.isArray(body.products)) return send(res,400,{error:'invalid state'});
      // Preserve server-managed linkage so a stale client save can't wipe it (prevents duplicate publishes).
      const _prev = {}; (data.products||[]).forEach(p=>{ if (p && p.id) _prev[p.id]=p; });
      const _keep = ['wooId','wooStatus','wooLink','wooSyncedAt','wooImageSrc','cloverId','displayName'];
      const _merged = (body.products||[]).map(p=>{ const o=_prev[p.id]; if (o){ _keep.forEach(k=>{ if (o[k]!==undefined && p[k]===undefined) p[k]=o[k]; }); } return p; });
      // Server-created invoice drafts may not be in a stale client's product list yet — keep them so a
      // background save can't wipe them before the client reloads.
      const _bodyIds = new Set((body.products||[]).map(p=>String(p.id)));
      const _serverDrafts = (data.products||[]).filter(p=> p && p.source==='invoice' && !_bodyIds.has(String(p.id)));
      data = { products:_serverDrafts.concat(_merged), events:body.events||[], requests:body.requests||[],
               searchLog:body.searchLog||[], customers:body.customers||data.customers||[],
               webSales: data.webSales||[], wooProcessed: data.wooProcessed||{}, webOrders: data.webOrders||[], invoices: data.invoices||[], supplierSkus: data.supplierSkus||{}, movements: data.movements||[], salesRollup: data.salesRollup||{}, fulfillment: data.fulfillment||[], fulfillmentLocal: data.fulfillmentLocal||{},
               posSales: data.posSales||[], cloverProcessed: data.cloverProcessed||{},
               salesTx: data.salesTx||[], salesDaily: data.salesDaily||{}, salesMeta: data.salesMeta||{},
               nrsProcessed: data.nrsProcessed||{}, nrsLog: data.nrsLog||[],
               expenses: body.expenses!==undefined?body.expenses:(data.expenses||[]),
               purchaseList: body.purchaseList!==undefined?body.purchaseList:(data.purchaseList||[]),
               campaigns: body.campaigns!==undefined?body.campaigns:(data.campaigns||[]),
               manualFinance: body.manualFinance!==undefined?body.manualFinance:(data.manualFinance||{ sales:[], expenses:[], settings:{ defaultGpPct:28 } }), version:1 };
      saveData();
      return send(res,200,{ok:true});
    }

    if (url === '/api/settings' && req.method === 'GET'){
      return send(res,200,{
        upcConfigured: !!(secrets.upcApiKey||'').trim(),
        aiConfigured:  !!(secrets.aiApiKey||'').trim(),
        aiProvider: secrets.aiProvider||'anthropic',
        aiModel: aiModelName(),
        cloverConfigured: !!((secrets.cloverMerchantId||'').trim() && (secrets.cloverApiToken||'').trim()),
        cloverBase: secrets.cloverBase||'https://api.clover.com',
        cloverMerchantId: secrets.cloverMerchantId||'',
        wooConfigured: !!((secrets.wooUrl||'').trim() && (secrets.wooKey||'').trim() && (secrets.wooSecret||'').trim()),
        wooUrl: secrets.wooUrl||'',
        wooAutoSync: !!secrets.wooAutoSync,
        wooPublishMode: secrets.wooPublishMode||'draft',
        wooOrderSync: !!secrets.wooOrderSync,
        webSalesCount: (data.webSales||[]).length,
        cloverSalesSync: !!secrets.cloverSalesSync,
        posSalesCount: (data.posSales||[]).length,
        nrsAutoImport: !!secrets.nrsAutoImport,
        nrsFolder: nrsFolderPath(),
        imapConfigured: !!((secrets.imapUser||secrets.fromEmail||'').trim() && (secrets.imapPass||'').trim()),
        imapUser: secrets.imapUser||'', imapSender: secrets.imapSender||'no-reply@nrsplus.com',
        imapFolder: secrets.imapFolder||'[Gmail]/All Mail', nrsSubject: secrets.nrsSubject||'Daily Sales Report',
        nrsEmailFetch: !!secrets.nrsEmailFetch,
        nrsStatus: { emails:Object.keys(data.nrsEmails||{}).length, days:Object.keys(data.nrsDaily||{}).length,
          latest:Object.keys(data.nrsDaily||{}).sort().slice(-1)[0]||null, lastRun:(data.nrsMeta||{}).lastRun||null },
        nrsLog: (data.nrsLog||[]).slice(0,8),
        smsConfigured: !!((secrets.twilioSid||'').trim() && (secrets.twilioToken||'').trim() && (secrets.twilioFrom||'').trim()),
        emailConfigured: !!((secrets.sendgridKey||'').trim() && (secrets.fromEmail||'').trim()),
        twilioFrom: secrets.twilioFrom||'', fromEmail: secrets.fromEmail||'', fromName: secrets.fromName||'Family Bazar',
        loyaltyPerDollar: secrets.loyaltyPerDollar!=null?secrets.loyaltyPerDollar:1,
        loyaltyRewardPoints: secrets.loyaltyRewardPoints!=null?secrets.loyaltyRewardPoints:100,
        loyaltyRewardValue: secrets.loyaltyRewardValue!=null?secrets.loyaltyRewardValue:5,
        platformConfigured: !!((secrets.platformSecret||'').trim()),
        platformUrl: secrets.platformUrl || PLATFORM_URL_DEFAULT,
        webCustomerSync: !!secrets.webCustomerSync,
        webCustomers: (data.customers||[]).filter(c=>c.source==='Website').length,
        webOrdersOpen: (data.webOrders||[]).filter(x=>x.status!=='done').length,
        autoNaming: !!secrets.autoNaming,
        autoPushProducts: !!secrets.autoPushProducts,
        weakNameBelow: weakNameBelow(),
        catalogHealth: catalogHealth()
      });
    }
    if (url === '/api/settings' && req.method === 'POST'){
      const b = await readBody(req);
      ['upcApiKey','aiProvider','aiApiKey','aiModel','cloverMerchantId','cloverApiToken','cloverBase',
       'wooUrl','wooKey','wooSecret','wooPublishMode','nrsFolder','platformUrl','platformSecret',
       'twilioSid','twilioToken','twilioFrom','sendgridKey','fromEmail','fromName',
       'imapHost','imapPort','imapUser','imapPass','imapSender','imapFolder','nrsSubject']
        .forEach(k=>{ if (b[k] !== undefined && b[k] !== '') secrets[k] = b[k]; });
      if (typeof b.nrsEmailFetch === 'boolean') secrets.nrsEmailFetch = b.nrsEmailFetch;
      ['loyaltyPerDollar','loyaltyRewardPoints','loyaltyRewardValue']
        .forEach(k=>{ if (b[k] !== undefined && b[k] !== '' && !isNaN(Number(b[k]))) secrets[k] = Number(b[k]); });
      if (typeof b.wooAutoSync === 'boolean') secrets.wooAutoSync = b.wooAutoSync;
      if (typeof b.wooOrderSync === 'boolean') secrets.wooOrderSync = b.wooOrderSync;
      if (typeof b.cloverSalesSync === 'boolean') secrets.cloverSalesSync = b.cloverSalesSync;
      if (typeof b.nrsAutoImport === 'boolean') secrets.nrsAutoImport = b.nrsAutoImport;
      if (typeof b.webCustomerSync === 'boolean') secrets.webCustomerSync = b.webCustomerSync;
      if (typeof b.autoNaming === 'boolean') secrets.autoNaming = b.autoNaming;
      if (typeof b.autoPushProducts === 'boolean') secrets.autoPushProducts = b.autoPushProducts;
      // Enrichment-priority threshold only. Does NOT gate the website.
      if (b.weakNameBelow !== undefined && b.weakNameBelow !== '' && !isNaN(Number(b.weakNameBelow))){
        secrets.weakNameScore = Math.max(0, Math.min(100, Number(b.weakNameBelow)));
      }
      // allow explicit clearing with the special value "__clear__"
      Object.keys(b).forEach(k=>{ if (b[k] === '__clear__') secrets[k]=''; });
      saveSecrets();
      return send(res,200,{ok:true});
    }

    // Catalog health snapshot (counts + flag breakdown).
    if (url === '/api/catalog/health' && req.method === 'GET'){
      return send(res,200, catalogHealth());
    }
    // Drill into one data-quality flag for bulk workflows.
    if (url.startsWith('/api/catalog/flagged') && req.method === 'GET'){
      const u = new URL(req.url, 'http://x');
      const flag = (u.searchParams.get('flag')||'').toUpperCase();
      if(!QUALITY_FLAGS.includes(flag)) return send(res,400,{ error:'unknown flag' });
      return send(res,200,{ flag, items: productsByFlag(flag, Number(u.searchParams.get('limit'))||200) });
    }
    // Manual kick of the background worker (the timer does this on its own every 2 min).
    if (url === '/api/catalog/name-run' && req.method === 'POST'){
      const b = await readBody(req);
      const wasOn = secrets.autoNaming; secrets.autoNaming = true;
      try { const r = await autoNameTick(Number(b.limit)||20); return send(res,200,{ ...r, stats: catalogHealth() }); }
      catch(e){ return send(res,400,{ error:e.message }); }
      finally { secrets.autoNaming = wasOn; }
    }
    // Publish every eligible product right now + refresh scores/flags. Instant, no network calls.
    if (url === '/api/catalog/publish-all' && req.method === 'POST'){
      let published = 0;
      for(const p of (data.products||[])){
        if(!p) continue;
        if(applyPublishState(p)) published++;
        if(!p.nameLocked && !p.displayName) p.displayName = ruleName(p.name||'') || String(p.name||'');
        const s = nameScore(p.displayName || p.name || '');
        p.nameScore = s.score; p.nameIssues = s.reasons;
      }
      saveData();
      return send(res,200,{ ok:true, published, stats: catalogHealth() });
    }

    if (url === '/api/catalog/lookup' && req.method === 'POST'){
      const b = await readBody(req);
      const barcode = (b.barcode||'').trim();
      if (!barcode) return send(res,400,{error:'barcode required'});
      const result = await catalogLookup(barcode);
      return send(res,200,result);
    }

    if (url === '/api/nrs/products/import' && req.method === 'POST'){
      // Manual fallback for the SAME importer the folder-watcher uses — one code path, no divergence.
      const b = await readBody(req);
      if(!b || !b.csv) return send(res,400,{error:'No CSV provided.'});
      const isInv = /invent|stock|on[\s_-]?hand|reorder/i.test(String(b.filename||'')) || b.kind==='inventory';
      const result = isInv ? applyInventoryCsv(String(b.csv), 'manual') : applySalesCsv(String(b.csv), 'manual', null);
      if(result.badFormat) return send(res,400,{error:'Unrecognized columns — need a quantity column plus barcode/UPC, SKU, or Name.'});
      if(result.empty) return send(res,400,{error:'Empty or unreadable CSV.'});
      if(result.inventory) saveData();
      return send(res,200,result);
    }
    if (url === '/api/images/coverage' && req.method === 'POST'){
      const b = await readBody(req).catch(()=>({}));
      const result = await imageCoverage(Number(b.sample)||50);
      return send(res,200,result);
    }
    if (url === '/api/clover/import' && req.method === 'POST'){
      const result = await cloverImport();
      return send(res,200,result);
    }
    if (url === '/api/clover/sales/sync' && req.method === 'POST'){
      const result = await cloverSalesImport({ reset:false });   // v2 incremental
      return send(res,200,result);
    }
    if (url === '/api/clover/rebuild' && req.method === 'POST'){
      const b = await readBody(req).catch(()=>({}));
      const result = await cloverSalesImport({ reset:true, days:Number(b.days)||90 });   // wipe & re-pull
      return send(res,200,result);
    }
    // ---- Sales dashboards v2 ----
    if (url === '/api/sales/clover/pull' && req.method === 'POST'){
      const b = await readBody(req).catch(()=>({}));
      const result = await cloverSalesImport({ reset:!!b.reset, days:Number(b.days)||90 });
      return send(res,200,result);
    }
    if (url.startsWith('/api/sales/summary') && req.method === 'GET'){
      const u=new URL(req.url,'http://x');
      return send(res,200, salesSummary(u.searchParams.get('from')||'', u.searchParams.get('to')||''));
    }
    if (url.startsWith('/api/sales/rows') && req.method === 'GET'){
      const u=new URL(req.url,'http://x');
      return send(res,200,{ rows: salesDailyRows(u.searchParams.get('source')||'', u.searchParams.get('from')||'', u.searchParams.get('to')||''),
        today: todayBiz(), meta: data.salesMeta||{} });
    }
    if (url.startsWith('/api/sales/tx') && req.method === 'GET'){
      const u=new URL(req.url,'http://x');
      const source=u.searchParams.get('source')||'clover', from=u.searchParams.get('from')||'', to=u.searchParams.get('to')||'';
      const lim=Math.min(2000, Number(u.searchParams.get('limit'))||500);
      let rows=(data.salesTx||[]).filter(t=> t.source===source && (!from||t.date>=from) && (!to||t.date<=to));
      rows.sort((a,b)=> a.ts<b.ts?1:-1);
      return send(res,200,{ total:rows.length, rows:rows.slice(0,lim) });
    }
    if (url === '/api/nrs/email/fetch' && req.method === 'POST'){
      const b = await readBody(req).catch(()=>({}));
      // Manual "Fetch now" pulls full history by default (search is filtered to the NRS sender, so it
      // only returns daily reports). Idempotent: already-imported days are skipped.
      const result = await nrsGmailRun({ sinceDays:(b&&b.sinceDays)||760, from:b&&b.from, to:b&&b.to, preview:false });
      if(result.error) return send(res,400,result);
      return send(res,200,result);
    }
    // Preview-first Gmail backfill. Body: { from, to, sinceDays, commit }. Defaults to PREVIEW (no writes).
    if (url === '/api/nrs/backfill' && req.method === 'POST'){
      const b = await readBody(req);
      const commit = b.commit === true;
      if (commit){
        // Snapshot current NRS records before applying, so a bad run can be rolled back.
        data.nrsMeta = data.nrsMeta || {};
        data.nrsMeta.backup = { at:now(),
          nrsEmails: JSON.parse(JSON.stringify(data.nrsEmails||{})),
          nrsDaily:  JSON.parse(JSON.stringify(data.nrsDaily||{})),
          salesDailyNrs: Object.fromEntries(Object.entries(data.salesDaily||{}).filter(([k])=>k.startsWith('nrs|'))) };
      }
      const result = await nrsGmailRun({ from:b.from, to:b.to, sinceDays:b.sinceDays, max:b.max, preview:!commit });
      if(result.error) return send(res,400,result);
      return send(res,200,result);
    }
    // NRS coverage + freshness for the dashboard. Read-only.
    if (url === '/api/nrs/status' && req.method === 'GET'){
      const daily = data.nrsDaily || {};
      const dates = Object.keys(daily).sort();
      const emails = Object.keys(data.nrsEmails||{}).length;
      const invDates = Object.keys(data.nrsInventory||{}).sort();
      const itemDays = new Set((data.nrsItems||[]).map(x=>x.date)).size;
      // gap detection across the covered span
      const gaps=[]; if(dates.length>1){ const d0=new Date(dates[0]), d1=new Date(dates[dates.length-1]);
        for(let d=new Date(d0); d<=d1; d.setDate(d.getDate()+1)){ const k=d.toISOString().slice(0,10); if(!daily[k]) gaps.push(k); } }
      return send(res,200,{ emailsTracked:emails, dailyCount:dates.length,
        earliest:dates[0]||null, latest:dates[dates.length-1]||null,
        inventorySnapshots:invDates.length, latestInventory:invDates[invDates.length-1]||null,
        itemDetailDays:itemDays, missingDays:gaps.slice(0,120), missingCount:gaps.length,
        lastRun:(data.nrsMeta||{}).lastRun||null, lastCommitAt:(data.nrsMeta||{}).lastCommitAt||null,
        hasBackup:!!((data.nrsMeta||{}).backup) });
    }
    // Debug: inspect what parsing found for the tracked emails (attachments, body, warnings).
    if (url.split('?')[0] === '/api/nrs/emails' && req.method === 'GET'){
      const rows = Object.values(data.nrsEmails||{})
        .sort((a,b)=> String(b.receivedAt||'').localeCompare(String(a.receivedAt||'')))
        .slice(0,10)
        .map(e=>({ subject:e.subject, businessDate:e.businessDate, receivedAt:e.receivedAt,
          hasBody:e.hasBody, hasSales:e.hasSales, hasInventory:e.hasInventory,
          attachments:e.attachments, warnings:e.warnings, parserVersion:e.parserVersion }));
      return send(res,200,{ total:Object.keys(data.nrsEmails||{}).length,
        parserVersion:NRS_PARSER_VERSION, sample:rows });
    }
    // Debug: fetch ONE matched NRS email live and dump its MIME structure (why body/attachments miss).
    if (url.split('?')[0] === '/api/nrs/probe' && req.method === 'GET'){
      const result = await nrsGmailRun({ sinceDays:60, probe:true });
      return send(res,200,result);
    }
    if (url === '/api/nrs/scan' && req.method === 'POST'){
      const result = await nrsScan(true);
      return send(res,200,result);
    }
    // ---- Utility-bill email detection ----
    if (url === '/api/bills/fetch' && req.method === 'POST'){
      const b = await readBody(req).catch(()=>({}));
      if(b && b.reset){ data.billDetections={}; if(data.billMeta)data.billMeta.lastRun=null; saveData(); }  // clear + re-detect fresh
      const result = await billGmailRun({ sinceDays: (b&&b.sinceDays)||90 });
      if(result.error) return send(res,400,result);
      return send(res,200,result);
    }
    if (url.split('?')[0] === '/api/bills/detections' && req.method === 'GET'){
      const dets = Object.values(data.billDetections||{}).filter(d=>d.status==='new')
        .sort((a,b)=> String(b.receivedAt||'').localeCompare(String(a.receivedAt||'')));
      return send(res,200,{ providers:data.billProviders||[], detections:dets, lastRun:(data.billMeta||{}).lastRun||null });
    }
    if (url === '/api/bills/detection/dismiss' && req.method === 'POST'){
      const b = await readBody(req); const d=(data.billDetections||{})[b.key];
      if(!d) return send(res,404,{error:'not found'});
      d.status='dismissed'; d.dismissedAt=now(); saveData();
      return send(res,200,{ ok:true });
    }
    // Confirm applies the detected amount to the matching recurring bill (creates it if missing).
    if (url === '/api/bills/detection/confirm' && req.method === 'POST'){
      const b = await readBody(req); const d=(data.billDetections||{})[b.key];
      if(!d) return send(res,404,{error:'not found'});
      if(d.amount==null) return send(res,400,{error:'This bill email has no amount to confirm - enter it manually.'});
      const mf = data.manualFinance = data.manualFinance || {}; mf.recurring = mf.recurring || [];
      const nm = String(d.matchName||d.provider).trim().toLowerCase();
      let it = mf.recurring.find(x=>x.book===d.book && (x.name||'').trim().toLowerCase()===nm);
      if(it){ it.amount=d.amount; it.amountType='variable'; if(!it.provider)it.provider=d.provider; if(d.accountNo)it.accountNo=d.accountNo; if(it.active===false)it.active=true; }
      else { it={ id:uid('rc'), book:d.book, name:d.matchName||d.provider, category:d.category||'Utilities',
        frequency:'monthly', amount:d.amount, amountType:'variable', startDate:(d.dueDate||new Date().toISOString().slice(0,10)),
        reminderDays:3, active:true, paused:false, provider:d.provider, accountNo:d.accountNo||'' };
        mf.recurring.push(it); }
      // Record the DATED occurrence so date-wise finance uses this month's actual amount. Aligns the bill's
      // cycle to the real due day and merges with any payment already recorded for this amount.
      if(d.dueDate && !it.startDate) it.startDate=d.dueDate;
      const okey=billUpsertOccurrence(it, d.amount, d.dueDate||new Date().toISOString().slice(0,10), {source:'email'});
      // If a payment receipt for this exact amount already arrived, mark this bill paid now.
      const amtR2=Math.round(Number(d.amount));
      const paidDet=Object.values(data.billDetections).find(x=>x&&x.kind==='payment'&&x.providerId===d.providerId&&x.amount!=null&&Math.round(Number(x.amount))===amtR2);
      if(paidDet && mf.payments[okey]){ mf.payments[okey].status='paid'; mf.payments[okey].paidDate=paidDet.paidDate||mf.payments[okey].dueDate; paidDet.status='applied'; paidDet.appliedTo=okey; }
      d.status='confirmed'; d.appliedTo=it.id; d.appliedAt=now();
      // Collapse the other emails for the same bill (reminder/autopay/duplicate) so they stop showing.
      const amtR=Math.round(Number(d.amount));
      for(const k in data.billDetections){ const o=data.billDetections[k];
        if(!o || o===d || o.status!=='new' || o.providerId!==d.providerId) continue;
        const sameAmt=(o.amount!=null && Math.round(Number(o.amount))===amtR);
        const sameDue=(o.dueDate && d.dueDate && o.dueDate===d.dueDate);
        const amountless=(o.amount==null && String(o.receivedAt||'').slice(0,7)===String(d.receivedAt||'').slice(0,7));
        if(sameAmt||sameDue||amountless){ o.status='dismissed'; o.dismissedAt=now(); o.dismissedBy='confirm-sibling'; }
      }
      saveData();
      return send(res,200,{ ok:true, applied:it.name, amount:d.amount });
    }
    if (url === '/api/nrs/reset' && req.method === 'POST'){
      const b = await readBody(req).catch(()=>({}));
      if (b && b.rollback && data.nrsMeta && data.nrsMeta.backup){
        const bk = data.nrsMeta.backup;
        data.nrsEmails = bk.nrsEmails || {}; data.nrsDaily = bk.nrsDaily || {};
        for (const k of Object.keys(data.salesDaily||{})) if (k.startsWith('nrs|')) delete data.salesDaily[k];
        Object.assign(data.salesDaily, bk.salesDailyNrs || {});
        saveData();
        return send(res,200,{ ok:true, rolledBack:true, restoredDays:Object.keys(data.nrsDaily).length });
      }
      data.nrsProcessed = {}; data.nrsLog = []; saveData();
      return send(res,200,{ ok:true });
    }
    if (url === '/api/catalog/polish-names' && req.method === 'POST'){
      const b = await readBody(req);
      try { const r = await polishNames(b.limit || 150); return send(res,200,r); }
      catch(e){ return send(res,400,{ error:e.message }); }
    }
    if (url === '/api/weborders/pull' && req.method === 'POST'){
      try { const r = await pullWebOrders(); return send(res,200,r); }
      catch(e){ return send(res,400,{ error:e.message }); }
    }
    if (url === '/api/weborders/notify' && req.method === 'POST'){
      const b = await readBody(req);
      try { const r = await notifyWebOrder(b.code); return send(res,200,r); }
      catch(e){ return send(res,400,{ error:e.message }); }
    }
    if (url === '/api/weborders/done' && req.method === 'POST'){
      const b = await readBody(req);
      data.webOrders = data.webOrders || [];
      const o = data.webOrders.find(x=>x.code===b.code);
      if(o){ o.status='done'; o.doneAt=now(); saveData(); }
      return send(res,200,{ ok:true });
    }

    if (url === '/api/fulfillment/pull' && req.method === 'POST'){
      try { const r = await pullFulfillment(); return send(res,200,r); }
      catch(e){ return send(res,400,{ error:e.message }); }
    }
    if (url === '/api/fulfillment/act' && req.method === 'POST'){
      const b = await readBody(req);
      try { const r = await fulfillmentAct(b.type, String(b.code||''), b.status, !!b.notify); return send(res,200,r); }
      catch(e){ return send(res,400,{ error:e.message }); }
    }
    if (url === '/api/customer/lookup' && req.method === 'POST'){
      const b = await readBody(req);
      try { const customer = await customerLookup({ id:b.id, phone:b.phone }); return send(res,200,{ customer }); }
      catch(e){ return send(res,400,{ error:e.message }); }
    }
    if (url === '/api/customer/tags' && req.method === 'POST'){
      const b = await readBody(req);
      try { const tags = await customerSetTags({ id:b.id, phone:b.phone }, Array.isArray(b.tags)?b.tags:[]); return send(res,200,{ tags }); }
      catch(e){ return send(res,400,{ error:e.message }); }
    }
    if (url === '/api/invoices' && req.method === 'GET'){
      const list = (data.invoices||[]).map(r=>({
        id:r.id, status:r.status, supplier:(r.extracted&&r.extracted.invoice&&r.extracted.invoice.supplier)||r.supplier||'',
        invoiceNumber:(r.extracted&&r.extracted.invoice&&r.extracted.invoice.invoiceNumber)||null,
        createdAt:r.createdAt, lines:(r.extracted&&r.extracted.lines||[]).length,
        total:(r.extracted&&r.extracted.invoice&&r.extracted.invoice.total)||null, warnings:(r.warnings||[]).length, error:r.error||null
      }));
      return send(res,200,{ invoices:list });
    }
    if (url === '/api/invoices/get' && req.method === 'GET'){
      const id = new URL(req.url,'http://x').searchParams.get('id');
      const rec = (data.invoices||[]).find(x=>x.id===id);
      return send(res, rec?200:404, rec||{error:'Not found'});
    }
    if (url === '/api/invoices/upload' && req.method === 'POST'){
      const b = await readBody(req);
      const files = Array.isArray(b.files) ? b.files : [];
      if(!files.length) return send(res,400,{error:'No files uploaded.'});
      ensureInvoiceDir();
      data.invoices = data.invoices || [];
      const id = 'INV-' + Date.now().toString(36).toUpperCase();
      const buffers=[], stored=[];
      files.forEach((f,i)=>{
        const b64 = String(f.dataBase64||f.b64||'').replace(/^data:[^,]+,/,'');
        const buf = Buffer.from(b64,'base64'); buffers.push(buf);
        const ext = /pdf/i.test(f.mime||'')?'pdf':(/png/i.test(f.mime||'')?'png':'jpg');
        const name = `${id}-${i+1}.${ext}`;
        try{ fs.writeFileSync(path.join(INVOICE_DIR,name),buf); }catch(e){}
        stored.push({ name:f.name||name, mime:f.mime||'image/jpeg', stored:name });
      });
      const hash = invoiceHash(buffers);
      const dup = data.invoices.find(x=>x.fileHash===hash && x.status!=='failed');
      if(dup) return send(res,200,{ id:dup.id, duplicate:true });
      data.invoices.unshift({ id, status:'uploaded', supplier:b.supplier||'', location:b.location||'', createdAt:now(), files:stored, fileHash:hash, extracted:null, warnings:[], audit:[] });
      saveData();
      return send(res,200,{ id });
    }
    if (url === '/api/invoices/extract' && req.method === 'POST'){
      const b = await readBody(req);
      data.invoices = data.invoices || [];
      const rec = data.invoices.find(x=>x.id===b.id);
      if(!rec) return send(res,404,{error:'Invoice not found.'});
      rec.status='processing'; delete rec.error; saveData();
      try { await extractInvoice(rec); matchInvoiceLines(rec); return send(res,200,rec); }
      catch(e){ rec.status='failed'; rec.error=e.message; saveData(); return send(res,400,{error:e.message}); }
    }
    if (url === '/api/invoices/match' && req.method === 'POST'){
      const b = await readBody(req);
      const rec = (data.invoices||[]).find(x=>x.id===b.id);
      if(!rec) return send(res,404,{error:'Invoice not found.'});
      return send(res,200,matchInvoiceLines(rec));
    }
    if (url === '/api/invoices/line-match' && req.method === 'POST'){
      const b = await readBody(req);
      const rec = (data.invoices||[]).find(x=>x.id===b.id);
      if(!rec) return send(res,404,{error:'Invoice not found.'});
      return send(res,200,setLineMatch(rec, Number(b.index), b.productId||''));
    }
    if (url === '/api/invoices/post' && req.method === 'POST'){
      const b = await readBody(req);
      const rec = (data.invoices||[]).find(x=>x.id===b.id);
      if(!rec) return send(res,404,{error:'Invoice not found.'});
      if(!(rec.extracted&&(rec.extracted.lines||[]).length)) return send(res,400,{error:'Nothing to post — extract the invoice first.'});
      return send(res,200,postInvoiceToInventory(rec, b.actor||'staff'));
    }
    if (url === '/api/invoices/void' && req.method === 'POST'){
      const b = await readBody(req);
      const rec = (data.invoices||[]).find(x=>x.id===b.id);
      if(!rec) return send(res,404,{error:'Invoice not found.'});
      const r = voidInvoicePosting(rec, b.actor||'staff');
      return send(res,200,{ ...r.rec, reversed:r.reversed });
    }
    if (url.startsWith('/api/sales/report') && req.method === 'GET'){
      rollupRefresh();  // keep the durable rollup current with the event log
      const q = new URL(req.url,'http://x').searchParams;
      const group = (q.get('group')||'month').toLowerCase();
      const to = q.get('to') || new Date().toISOString().slice(0,10);
      const from = q.get('from') || new Date(Date.now()-365*86400000).toISOString().slice(0,10);
      const keyOf = (day)=>{
        if(group==='day') return day;
        if(group==='year') return day.slice(0,4);
        if(group==='week'){ const dt=new Date(day+'T00:00:00Z'); const sun=new Date(dt.getTime()-dt.getUTCDay()*86400000); return sun.toISOString().slice(0,10); }
        return day.slice(0,7); // month
      };
      const buckets={}, totals={nrs:0,clover:0,web:0,other:0,units:0,revenue:0};
      for(const day in (data.salesRollup||{})){
        if(day<from||day>to) continue;
        const d=data.salesRollup[day]; const k=keyOf(day);
        const b=buckets[k]=buckets[k]||{key:k,nrs:0,clover:0,web:0,other:0,units:0,revenue:0};
        for(const s of ['nrs','clover','web','other']){ const r=(d[s]&&d[s].r)||0; b[s]+=r; b.revenue+=r; totals[s]+=r; totals.revenue+=r; }
        const u=((d.nrs&&d.nrs.u)||0)+((d.clover&&d.clover.u)||0)+((d.web&&d.web.u)||0)+((d.other&&d.other.u)||0);
        b.units+=u; totals.units+=u;
      }
      const rows=Object.values(buckets).sort((a,b)=>a.key<b.key?-1:1).map(b=>({
        key:b.key, nrs:+b.nrs.toFixed(2), clover:+b.clover.toFixed(2), web:+b.web.toFixed(2), other:+b.other.toFixed(2), revenue:+b.revenue.toFixed(2), units:b.units }));
      Object.keys(totals).forEach(k=>{ if(k!=='units') totals[k]=+totals[k].toFixed(2); });
      return send(res,200,{ group, from, to, rows, totals });
    }
    if (url.startsWith('/api/sales/daily') && req.method === 'GET'){
      // Date-wise sales coverage, by source, from the event log. A $0 day = nothing imported for it.
      const q = new URL(req.url,'http://x').searchParams;
      const days = Math.min(180, Math.max(1, Number(q.get('days'))||30));
      const map = {};
      for(const e of (data.events||[])){
        if(!e || !e.timestamp) continue;
        const isSale = (e.type==='Stock decrease') || (Number(e.qtyChange)<0);
        if(!isSale) continue;
        const day = String(new Date(e.timestamp).toISOString()).slice(0,10);
        const note = String(e.note||'').toLowerCase();
        const src = /\(nrs\)/.test(note)?'nrs' : /\(clover\)/.test(note)?'clover' : /web order/.test(note)?'web' : 'other';
        const rev = Number(e.rev)||0, units = Math.abs(Number(e.qtyChange)||0);
        const d = map[day] = map[day] || { nrs:{r:0,u:0}, clover:{r:0,u:0}, web:{r:0,u:0}, other:{r:0,u:0} };
        d[src].r += rev; d[src].u += units;
      }
      const today = new Date(); today.setHours(0,0,0,0);
      const rows = [];
      for(let i=0;i<days;i++){
        const dt = new Date(today.getTime() - i*86400000);
        const day = dt.toISOString().slice(0,10);
        const d = map[day] || { nrs:{r:0,u:0}, clover:{r:0,u:0}, web:{r:0,u:0}, other:{r:0,u:0} };
        const totR = d.nrs.r+d.clover.r+d.web.r+d.other.r;
        const totU = d.nrs.u+d.clover.u+d.web.u+d.other.u;
        rows.push({ date:day, dow:dt.toLocaleDateString('en-US',{weekday:'short'}),
          nrs:{r:+d.nrs.r.toFixed(2),u:d.nrs.u}, clover:{r:+d.clover.r.toFixed(2),u:d.clover.u}, web:{r:+d.web.r.toFixed(2),u:d.web.u},
          totalRev:+totR.toFixed(2), totalUnits:totU, empty: totR===0 && totU===0 });
      }
      return send(res,200,{ days, rows });
    }
    if (url.startsWith('/api/movements') && req.method === 'GET'){
      const q = new URL(req.url,'http://x').searchParams;
      const pid = q.get('productId');
      let list = (data.movements||[]);
      if(pid) list = list.filter(m=>String(m.productId)===String(pid));
      return send(res,200,{ movements: list.slice(-200).reverse() });
    }
    if (url === '/api/customers/pull-web' && req.method === 'POST'){
      try { const r = await pullWebCustomers(); return send(res,200,r); }
      catch(e){ return send(res,400,{error:e.message}); }
    }
    if (url === '/api/clover/customers/import' && req.method === 'POST'){
      const result = await cloverCustomersImport();
      return send(res,200,result);
    }
    if (url === '/api/marketing/test' && req.method === 'POST'){
      const b = await readBody(req); const c = b.to||{}; const msg = personalize(b.message, c);
      try { if (b.channel==='sms'){ if(!c.phone) throw new Error('No phone number'); await sendSMS(c.phone,msg); }
            else { if(!c.email) throw new Error('No email address'); await sendEmail(c.email,b.subject,msg); }
            return send(res,200,{ ok:true }); }
      catch(e){ return send(res,200,{ ok:false, error:e.message }); }
    }
    if (url === '/api/marketing/send' && req.method === 'POST'){
      const b = await readBody(req); const rec = Array.isArray(b.recipients)?b.recipients:[];
      let sent=0, failed=0, skipped=0; const errors=[];
      for (const c of rec){
        try {
          const msg = personalize(b.message, c);
          if (b.channel==='sms'){ if(!c.phone){ skipped++; continue; } await sendSMS(c.phone,msg); }
          else { if(!c.email){ skipped++; continue; } await sendEmail(c.email,b.subject,msg); }
          sent++;
        } catch(e){ failed++; if(errors.length<5) errors.push(e.message); }
        await new Promise(r=>setTimeout(r,150));
      }
      return send(res,200,{ sent, failed, skipped, errors });
    }
    if (url === '/api/ai/compose' && req.method === 'POST'){
      const b = await readBody(req);
      const channel = b.channel==='sms'?'a text message (SMS)':'an email';
      const limit = b.channel==='sms'?'Keep it under 160 characters, no links unless essential.':'Keep it short (3-5 sentences), friendly, with a clear call to action.';
      const prompt = `Write ${channel} for Family Bazar, a friendly neighborhood variety/grocery store in Brooklyn, NY. Purpose: ${b.brief||'a weekly deals announcement'}. Use {name} as a placeholder for the customer's first name. ${limit} Return only the message text, no preamble.`;
      const text = await aiText(prompt, b.channel==='sms'?150:400);
      return send(res,200,{ text: text.trim() });
    }
    if (url === '/api/ai/insight' && req.method === 'POST'){
      const b = await readBody(req);
      const kind = b.kind || 'stocking';
      const today = new Date().toISOString().slice(0,10);
      let prompt;
      if (kind === 'promo'){
        const over = data.products.filter(p=>p.qty >= (p.overstockThreshold||50)).slice(0,40)
          .map(p=>`${p.name} — qty ${p.qty}, price $${p.retailPrice!=null?p.retailPrice:'?'}, cost $${p.costPrice!=null?p.costPrice:'?'}`);
        if (!over.length) return send(res,200,{ text:'No overstock items right now — nothing to discount.' });
        prompt = `You are a retail merchandiser for Family Bazar, a dollar/variety store in Brooklyn, NY. Today is ${today}. These items are overstocked:\n${over.join('\n')}\n\nFor each, suggest a sensible markdown (% off) and a punchy one-line promo idea to move it quickly. Keep margins in mind where cost is known. Return a concise markdown list.`;
      } else if (kind === 'reorder'){
        const low = data.products.filter(p=>p.qty <= (p.reorderThreshold||5)).slice(0,50)
          .map(p=>`${p.name} (${p.category||'?'}) — on hand ${p.qty}, reorder at ${p.reorderThreshold||5}, supplier ${p.supplier||'?'}`);
        prompt = `You are a purchasing assistant for Family Bazar (Brooklyn, NY variety store). Today is ${today}. These items are at/below reorder level:\n${low.join('\n')||'(none)'}\n\nProduce a prioritized reorder list grouped by supplier, with a suggested order quantity for each and a one-line rationale. Be concise; return markdown.`;
      } else {
        const cats = [...new Set(data.products.map(p=>p.category).filter(Boolean))].slice(0,25);
        const fails={}; (data.searchLog||[]).forEach(s=>{ if(!s.found) fails[s.term]=(fails[s.term]||0)+1; });
        const topFails = Object.entries(fails).sort((a,b)=>b[1]-a[1]).slice(0,12).map(x=>x[0]);
        const reqs = (data.requests||[]).slice(0,15).map(r=>r.name);
        prompt = `You are a retail buyer for Family Bazar, a dollar/variety store in Brooklyn, NY. Today is ${today}. Current departments: ${cats.join(', ')||'general variety'}. Customers searched but did NOT find: ${topFails.join(', ')||'n/a'}. Customer product requests: ${reqs.join(', ')||'n/a'}.\n\nRecommend specific products and categories to stock for the next 4–8 weeks, considering the season and upcoming US holidays/occasions relevant to a Brooklyn neighborhood store. Group by occasion/season, be concrete (name real product types), and keep it concise. Return markdown.`;
      }
      const text = await aiText(prompt, 900);
      return send(res,200,{ text });
    }
    if (url === '/api/ai/describe' && req.method === 'POST'){
      const b = await readBody(req);
      const p = (data.products||[]).find(x=>x.id===b.id) || b.product || {};
      const bits = [p.brand,p.name,p.category].filter(Boolean).join(' — ') || (b.name||'');
      if (!bits) return send(res,200,{ error:'No product info' });
      const prompt = `Write a concise, friendly e-commerce product description for an online marketplace listing. Product: ${bits}. 2-3 short sentences highlighting practical benefits. Do NOT invent specs, model numbers, or a price. Return only the description text.`;
      try { const text = await aiText(prompt, 220); return send(res,200,{ text:(text||'').trim() }); }
      catch(e){ return send(res,200,{ error:e.message }); }
    }
    if (url === '/api/ai/pricing' && req.method === 'POST'){
      const b = await readBody(req);
      const p = (data.products||[]).find(x=>x.id===b.id);
      if (!p) return send(res,200,{ error:'Product not found' });
      const cost = (p.costPrice!=null && p.costPrice!=='') ? Number(p.costPrice) : null;
      const retail = (p.salePrice!=null && p.salePrice!=='') ? Number(p.salePrice) : (p.retailPrice!=null ? Number(p.retailPrice) : null);
      const margin = b.margin!=null ? Number(b.margin) : 20;
      const ship = b.ship!=null ? Number(b.ship) : 0;
      const fees = b.fees || { website:3, google:3, amazon:15, walmart:15, tiktok:8 };
      const prompt = `You price products for Family Bazar, a Brooklyn variety/dollar store selling online. Product: "${p.name}"${p.brand?' by '+p.brand:''}${p.category?' (category: '+p.category+')':''}. In-store retail: ${retail!=null?'$'+retail.toFixed(2):'unknown'}. Unit cost: ${cost!=null?'$'+cost.toFixed(2):'unknown'}. Per-order shipping/handling to add: $${ship.toFixed(2)}. Target NET margin after fees: ${margin}%.\nMarketplace fee assumptions (% of sale price): Website ${fees.website}%, Google ${fees.google}% (via website), Amazon ${fees.amazon}%, Walmart ${fees.walmart}%, TikTok Shop ${fees.tiktok}%.\nFor each channel (website, google, amazon, walmart, tiktok) suggest a competitive online price that (a) covers cost + that channel's fee + shipping and still hits roughly the target net margin, and (b) is realistic versus typical marketplace pricing for this kind of item. Amazon/Walmart usually need higher prices to absorb fees; a well-known cheap item can't be overpriced. Return ONLY compact JSON: {"website":n,"google":n,"amazon":n,"walmart":n,"tiktok":n,"notes":"one short sentence on competitor/market positioning"}. Numbers only, no $.`;
      try {
        let text = await aiText(prompt, 400);
        let json=null; const m=(text||'').match(/\{[\s\S]*\}/); if(m){ try{ json=JSON.parse(m[0]); }catch(e){} }
        if(!json) return send(res,200,{ error:'Could not parse AI response', raw:text });
        return send(res,200,{ suggestions:json });
      } catch(e){ return send(res,200,{ error:e.message }); }
    }
    if (url === '/api/ai/ask' && req.method === 'POST'){
      const b = await readBody(req); const q = (b.question||'').trim();
      if (!q) return send(res,200,{ error:'No question' });
      const P = data.products||[]; const now = Date.now(); const d30 = now-30*864e5;
      let rev=0, units=0; const catRev={}, prodU={};
      (data.events||[]).forEach(e=>{ if(e.type!=='Stock decrease') return; const t=new Date(e.timestamp).getTime(); if(t<d30) return; const p=P.find(x=>x.id===e.productId); const u=Math.abs(e.qtyChange); const r=(e.rev!=null)?e.rev:0; rev+=r; units+=u; const c=(p&&p.category)||'Other'; catRev[c]=(catRev[c]||0)+r; if(p) prodU[p.name]=(prodU[p.name]||0)+u; });
      const low = P.filter(p=>p.qty>0 && p.qty<=(p.reorderThreshold||5)).length;
      const out = P.filter(p=>!(p.qty>0)).length;
      const topCat = Object.entries(catRev).sort((a,b)=>b[1]-a[1]).slice(0,5).map(x=>x[0]+' $'+Math.round(x[1])).join(', ');
      const topProd = Object.entries(prodU).sort((a,b)=>b[1]-a[1]).slice(0,8).map(x=>x[0]+' ('+x[1]+')').join(', ');
      const reqs = (data.requests||[]).filter(r=>r.status==='Open').slice(0,10).map(r=>r.name).filter(Boolean).join(', ');
      const cust = (data.customers||[]).length;
      const snapshot = `Store: Family Bazar, a Brooklyn variety/dollar store. Products: ${P.length}. Low stock: ${low}. Out of stock: ${out}. Customers: ${cust}. Last 30 days: revenue $${Math.round(rev)}, ${units} items sold. Top categories by revenue: ${topCat||'n/a'}. Top sellers (units): ${topProd||'n/a'}. Open customer requests: ${reqs||'none'}.`;
      const prompt = `You are the retail analyst and advisor for a small store owner. Current data snapshot:\n${snapshot}\n\nOwner's question: ${q}\n\nAnswer concisely and specifically using the numbers above. If the data can't answer it, say what's missing. Keep it short; use simple markdown.`;
      try { const text = await aiText(prompt, 700); return send(res,200,{ text }); }
      catch(e){ return send(res,200,{ error:e.message }); }
    }
    if (url === '/api/products/tag-sources' && req.method === 'POST'){
      let cl=null, cloverErr=null;
      try { cl = await cloverIdentifiers(); } catch(e){ cloverErr = e.message; }
      const counts = { Clover:0, NRS:0, Sample:0, Manual:0, Other:0 };
      for (const p of data.products){
        let src;
        if (cl && ((p.sku && cl.skus.has(p.sku)) || (p.barcode && cl.bars.has(p.barcode)))) src='Clover';
        else if (p.source==='NRS') src='NRS';
        else if (p.source==='Manual') src='Manual';
        else if (/^FB-1\d{3}$/i.test(p.sku||'')) src='Sample';
        else src = p.source || 'Other';
        p.source = src; counts[src] = (counts[src]||0)+1;
      }
      saveData();
      return send(res,200,{ counts, cloverChecked: !!cl, cloverErr });
    }

    if (url === '/api/catalog/fill-images' && req.method === 'POST'){
      const b = await readBody(req);
      let list = Array.isArray(b.ids) ? data.products.filter(p=>b.ids.includes(p.id)) : data.products;
      if (b.onlyFlagged) list = list.filter(p=>p.websiteEnabled);
      // `retry` clears the "already tried" marks so a fresh pass re-checks items (e.g. after adding a paid key).
      if (b.retry) data.products.forEach(p=>{ if(!p.image) delete p.imgTried; });
      // Only items still missing an image AND not already tried; in-stock products first. The per-run
      // limit + the imgTried mark keep us within free rate limits and let repeated runs move forward.
      list = list.filter(p=>!p.image && !p.imgTried).sort(inStockFirst);
      const limit = Math.min(b.limit||400, 2000);
      let filled=0, checked=0, failed=0, noimg=0, byName=0;
      for (const p of list){
        if (checked >= limit) break;
        checked++;
        try {
          const info = await imageLookup(p);   // barcode DBs first, then safe name search
          if (info && info.image){ p.image = info.image; p.lastUpdated = now(); filled++; if (/name/i.test(info.src)) byName++; }
          else { noimg++; p.imgTried = now(); }   // mark so we don't retry the same miss every batch
        } catch(e){ failed++; }                    // transient failure — leave unmarked so it retries later
        await new Promise(r=>setTimeout(r, 250));   // be gentle on the lookup APIs
      }
      saveData();
      const remaining = data.products.filter(p=>!p.image && !p.imgTried).length;
      return send(res,200,{ filled, checked, failed, noimg, byName, remaining });
    }
    if (url === '/api/catalog/enrich' && req.method === 'POST'){
      const b = await readBody(req);
      const limit = Math.min(b.limit||40, 100);
      let list = Array.isArray(b.ids) ? data.products.filter(p=>b.ids.includes(p.id)) : data.products;
      list = list.filter(needsEnrich).sort(inStockFirst);   // shoppable items first
      const r = await enrichProducts(list, limit);
      saveData();
      const remaining = data.products.filter(needsEnrich).length;
      return send(res,200,{ ...r, remaining });
    }

    if (url === '/api/woo/test'){
      try { const r = await wooFetch('products?per_page=1');
            return send(res,200,{ ok:true, reachable: Array.isArray(r) }); }
      catch(e){ return send(res,200,{ ok:false, error:e.message }); }
    }
    if (url === '/api/woo/publish' && req.method === 'POST'){
      const b = await readBody(req);
      let list = b.all ? data.products.filter(p=>p.websiteEnabled)
                       : data.products.filter(p=> (b.ids||[]).includes(p.id));
      const results = [];
      for (const p of list){
        try { const r = await wooPublishOne(p); results.push({ id:p.id, name:p.name, ok:true, ...r }); }
        catch(e){ results.push({ id:p.id, name:p.name, ok:false, error:e.message }); }
      }
      saveData();
      return send(res,200,{ results,
        ok: results.filter(r=>r.ok).length, failed: results.filter(r=>!r.ok).length });
    }
    if (url === '/api/woo/orders/sync' && req.method === 'POST'){
      const r = await wooSyncOrders();
      return send(res,200,r);
    }
    if (url === '/api/woo/dedupe' && req.method === 'POST'){
      const b = await readBody(req);
      const r = await wooDedupe(!!b.apply);
      return send(res,200,r);
    }
    if (url === '/feed/google.xml' || url === '/feed/google'){
      return send(res,200, googleFeed(), 'application/xml; charset=utf-8');
    }

    if (url === '/api/export.csv'){
      return send(res,200, productsCSV(), 'text/csv');
    }

    // static frontend
    return serveStatic(req, res);
  } catch(e){
    return send(res,500,{error: e.message || 'server error'});
  }
});

if (authOn()) ensureOwner();   // only seed the owner login when auth is enforced
try { backfillNrsDaily(); } catch(e){}   // seed NRS daily records from the legacy rollup once
server.listen(PORT, ()=>{
  const ips = [];
  const ni = os.networkInterfaces();
  for (const k in ni) for (const i of ni[k]) if (i.family==='IPv4' && !i.internal) ips.push(i.address);
  console.log('\n  Family Bazar ROS server is running.');
  console.log('  ------------------------------------');
  console.log('  On THIS computer:   http://localhost:'+PORT);
  ips.forEach(ip=> console.log('  On tablets (WiFi):  http://'+ip+':'+PORT));
  console.log('  ------------------------------------');
  console.log('  Data file:    '+DATA);
  console.log('  Keys file:    '+SECRETS+'  (kept private, never sent to browsers)');
  console.log('  Stop server:  press Ctrl + C\n');
});
