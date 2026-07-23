/* Standalone check for the rebuilt NRS parsers. Run:  node test-nrs-parsers.js
   It copies the SAME pure logic used in server.js and asserts it against the
   real July 17, 2026 samples + a synthetic NRS email body. No server, no network. */

// ---- pure helpers (verbatim from server.js) ----------------------------------------
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
function dateFromName(fname){
  const m = String(fname).replace(/_/g,' ').match(/([A-Za-z]{3,9})\s+(\d{1,2})\s*,?\s*(\d{4})/);
  if (!m) return null;
  const d = new Date(`${m[1]} ${m[2]}, ${m[3]} 12:00:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function nrsNum(v){ if(v==null) return null; const str=String(v).replace(/[^0-9.\-]/g,''); if(str===''||str==='-'||str==='.') return null; const n=Number(str); return isFinite(n)?n:null; }

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
    const upc=cU>=0?cleanCellSrv(r[cU]):'';
    const nm =cN>=0?cleanCellSrv(r[cN]):'';
    const qty=Math.round(nrsNum(r[cQ])||0);
    const amt=cA>=0?(nrsNum(r[cA])||0):0;
    if(!qty && !amt) continue;
    if(!upc){
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
    if(!upc && (!nm || !nm.trim())) continue;
    out.push({ upc:String(upc), name:nm, department:cD>=0?cleanCellSrv(r[cD]):'',
      inStock:nrsNum(r[cS]), predictedDays:cP>=0?nrsNum(r[cP]):null,
      countThreshold:cC>=0?nrsNum(r[cC]):null, daysThreshold:cT>=0?nrsNum(r[cT]):null });
  }
  return { rows:out, count:out.length };
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
function nrsParseBodyFromText(flat){
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
  return s;
}
function nrsBizDate(subject, attNames, receivedMs){
  let iso=dateFromName(subject||'');
  if(!iso){ for(const f of (attNames||[])){ iso=dateFromName(f); if(iso) break; } }
  if(!iso && receivedMs){ iso=new Date(receivedMs-86400000).toISOString(); }
  return iso ? iso.slice(0,10) : null;
}

// ---- samples (real July 17, 2026 data) ---------------------------------------------
const SALES_CSV = `UPC,Name,"Total Qty","Total Amount"
6931492322032,"Jumbo Glue Trap Blue-Touch 1",3,9.77
651950100625,"Kitchuten ",3,4.87
070847811169,"Monster Energy Drink 16 FL",3,8.97
010181073861,"Palmer s  soup ",2,8.68
073096500273,"4 Pc Aaa Panasonic Batteries Case Pack 48 4pk",2,4.33
,Taxable,601,3207.48
,Non-Taxable,168,704.85`;

const INV_CSV = `"Reorder Now"
UPC,Name,Department,"In Stock","Predicted Days","Count Threshold","Days Threshold"
022000004840,"Orbit Spearmint",Taxable,2,63,2,7
073390055189,Sweet,Condiments,2,,10,7
" "
" "`;

const BODY = `Daily Sales Report for FAMILY BAZAR
Net Sales: $4,071.74
Taxes: $264.73
Fees: $0.00
Total Sales: $4,336.47
Number of Baskets: 268
Items Sold: 857
Average Items per Basket: 3.20
Average Sale: $15.19
Discounts: $15.16`;

// ---- assertions --------------------------------------------------------------------
let pass=0, fail=0;
function eq(label, got, want){
  const ok = JSON.stringify(got)===JSON.stringify(want);
  console.log((ok?'  ok  ':' FAIL ')+label+'  ->  '+JSON.stringify(got)+(ok?'':'   (expected '+JSON.stringify(want)+')'));
  ok?pass++:fail++;
}

console.log('\n== Sales History ==');
const sh = nrsParseSalesHistory(SALES_CSV);
eq('item count (excludes dept rows)', sh.itemCount, 5);
eq('leading-zero UPC kept as string', sh.items[2].upc, '070847811169');
eq('first item', [sh.items[0].upc, sh.items[0].qty, sh.items[0].amount], ['6931492322032',3,9.77]);
eq('dept Taxable', sh.dept.taxable, {qty:601, amount:3207.48});
eq('dept Non-Taxable', sh.dept.nonTaxable, {qty:168, amount:704.85});

console.log('\n== Inventory Status ==');
const iv = nrsParseInventory(INV_CSV);
eq('row count (blank " " rows dropped)', iv.count, 2);
eq('UPC string', iv.rows[0].upc, '022000004840');
eq('department (tax class)', iv.rows[0].department, 'Taxable');
eq('department (category)', iv.rows[1].department, 'Condiments');
eq('in stock', [iv.rows[0].inStock, iv.rows[1].inStock], [2,2]);
eq('predicted days blank -> null', iv.rows[1].predictedDays, null);

console.log('\n== Email body summary ==');
const s = nrsParseBodyFromText(nrsStripHtml(BODY));
eq('net',       s.net, 4071.74);
eq('tax',       s.tax, 264.73);
eq('fees',      s.fees, 0);
eq('total',     s.total, 4336.47);
eq('baskets',   s.baskets, 268);
eq('items',     s.items, 857);
eq('avg sale',  s.avgSale, 15.19);
eq('discounts', s.discounts, 15.16);
eq('identity net+tax+fees=total', +(s.net+s.tax+s.fees).toFixed(2), s.total);

console.log('\n== Business date ==');
eq('from subject', nrsBizDate('Daily Sales Report Jul 17, 2026 for FAMILY BAZAR (74861,76391)', [], Date.now()), '2026-07-17');
eq('from filename fallback', nrsBizDate('no date here', ['Sales_History_Jul_17,_2026.csv'], Date.now()), '2026-07-17');

console.log('\n'+(fail? (fail+' FAILED, '+pass+' passed') : ('ALL '+pass+' CHECKS PASSED'))+'\n');
process.exit(fail?1:0);
