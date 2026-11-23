// Holt Kurse bei Yahoo Finance und schreibt sie nach quotes.json.
// Läuft per GitHub-Automatik (kein Browser, daher keine CORS-Sperre).
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const pad = n => String(n).padStart(2, '0');

async function getJSON(path) {
  let last;
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch('https://' + host + '.finance.yahoo.com' + path, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { last = e; }
  }
  throw last;
}

async function series(sym, range, interval) {
  const j = await getJSON('/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + range + '&interval=' + interval + '&includePrePost=false');
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error((j && j.chart && j.chart.error && j.chart.error.description) || 'Symbol unbekannt');
  const off = (res.meta && res.meta.gmtoffset) || 0, ts = res.timestamp || [];
  const cl = ((res.indicators && res.indicators.quote && res.indicators.quote[0]) || {}).close || [];
  const m = new Map();
  ts.forEach((t, i) => {
    const c = cl[i];
    if (c == null || !isFinite(c)) return;
    const d = new Date((t + off) * 1000);
    m.set(d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()), +c.toFixed(4));
  });
  return { list: [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, c]) => ({ d, c })), meta: res.meta || {} };
}

async function fromSymbol(sym) {
  const d = await series(sym, '1y', '1d');
  const w = await series(sym, '2y', '1wk');
  if (d.list.length < 50 || w.list.length < 31) throw new Error('Zu wenige Kursdaten');
  return {
    name: d.meta.longName || d.meta.shortName || sym,
    currency: d.meta.currency || '',
    liveTime: (d.meta.regularMarketTime || 0) * 1000,
    daily: d.list,
    weekly: w.list
  };
}

async function findByIsin(isin) {
  const j = await getJSON('/v1/finance/search?q=' + encodeURIComponent(isin) + '&quotesCount=8&newsCount=0');
  const q = (j.quotes || []).filter(x => x.symbol);
  const pick = q.find(x => /\.DE$/.test(x.symbol)) || q[0];
  return pick && pick.symbol;
}

const cfg = JSON.parse(fs.readFileSync('symbols.json', 'utf8'));
let out = { updated: '', symbols: {} };
try { out = JSON.parse(fs.readFileSync('quotes.json', 'utf8')); } catch (e) {}
out.symbols = out.symbols || {};

let ok = 0;
for (const item of cfg) {
  const want = typeof item === 'string' ? { symbol: item } : item;
  let sym = want.symbol, data = null;
  try { data = await fromSymbol(sym); }
  catch (e) {
    console.log(sym + ': ' + e.message);
    if (want.isin) {
      try { const alt = await findByIsin(want.isin); if (alt && alt !== sym) { console.log('Alternative per ISIN: ' + alt); sym = alt; data = await fromSymbol(alt); } }
      catch (e2) { console.log('ISIN-Suche: ' + e2.message); }
    }
  }
  if (data) {
    out.symbols[want.symbol] = data;      // unter dem konfigurierten Namen speichern
    if (sym !== want.symbol) out.symbols[sym] = data;
    ok++;
    console.log(want.symbol + ': ' + data.daily.length + ' Tage, ' + data.weekly.length + ' Wochen, Kurs ' + data.daily[data.daily.length - 1].c);
  }
}
if (!ok) { console.error('Kein Symbol konnte geladen werden.'); process.exit(1); }
out.updated = new Date().toISOString();
fs.writeFileSync('quotes.json', JSON.stringify(out));
