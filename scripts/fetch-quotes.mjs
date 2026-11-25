// Holt Kurse und schreibt sie nach quotes.json. Läuft per GitHub-Automatik (kein Browser, keine CORS-Sperre).
// Quellen der Reihe nach: Yahoo Finance, Stooq, optional Alpha Vantage (Secret ALPHA_KEY).
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const pad = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clip = s => String(s).replace(/\s+/g, ' ').slice(0, 100);

/* ---------- Yahoo ---------- */
async function yahooJSON(path) {
  let last;
  for (let round = 0; round < 2; round++) {
    for (const host of ['query1', 'query2']) {
      try {
        const r = await fetch('https://' + host + '.finance.yahoo.com' + path, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) { last = e; }
    }
    await sleep(3000);
  }
  throw last;
}
async function yahooSeries(sym, range, interval) {
  const j = await yahooJSON('/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + range + '&interval=' + interval + '&includePrePost=false');
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
async function fromYahoo(want) {
  let sym = want.symbol;
  const go = async s => {
    const d = await yahooSeries(s, '1y', '1d'), w = await yahooSeries(s, '2y', '1wk');
    return { name: d.meta.longName || d.meta.shortName || s, currency: d.meta.currency || '', liveTime: (d.meta.regularMarketTime || 0) * 1000, daily: d.list, weekly: w.list };
  };
  try { return await go(sym); }
  catch (e) {
    if (!want.isin || /429/.test(e.message)) throw e;
    const j = await yahooJSON('/v1/finance/search?q=' + encodeURIComponent(want.isin) + '&quotesCount=8&newsCount=0');
    const q = (j.quotes || []).filter(x => x.symbol);
    const alt = (q.find(x => /\.DE$/.test(x.symbol)) || q[0] || {}).symbol;
    if (!alt || alt === sym) throw e;
    console.log('  Alternative per ISIN: ' + alt);
    return await go(alt);
  }
}

/* ---------- Stooq (CSV, ohne Schlüssel) ---------- */
async function stooqSeries(sym, i) {
  const r = await fetch('https://stooq.com/q/d/l/?s=' + encodeURIComponent(sym.toLowerCase()) + '&i=' + i, { headers: { 'User-Agent': UA } });
  const t = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (!t.startsWith('Date,')) throw new Error('Unerwartete Antwort: ' + clip(t));
  return t.trim().split('\n').slice(1).map(l => { const c = l.split(','); return { d: c[0], c: parseFloat(c[4]) }; }).filter(x => x.d && isFinite(x.c));
}
async function fromStooq(want) {
  const sym = want.stooq || want.symbol;
  const daily = (await stooqSeries(sym, 'd')).slice(-260);
  const weekly = (await stooqSeries(sym, 'w')).slice(-110);
  return { name: want.symbol, currency: want.currency || '', liveTime: 0, daily, weekly };
}

/* ---------- Alpha Vantage (nur mit Secret ALPHA_KEY) ---------- */
async function alphaSeries(sym, fn, extra) {
  const r = await fetch('https://www.alphavantage.co/query?function=' + fn + '&symbol=' + encodeURIComponent(sym) + (extra || '') + '&apikey=' + encodeURIComponent(process.env.ALPHA_KEY));
  const j = await r.json();
  if (j.Note || j.Information) throw new Error('Limit: ' + clip(j.Note || j.Information));
  const s = j['Time Series (Daily)'] || j['Weekly Time Series'];
  if (!s) throw new Error('Keine Daten: ' + clip(JSON.stringify(j)));
  return Object.keys(s).sort().map(d => ({ d, c: parseFloat(s[d]['4. close']) })).filter(x => isFinite(x.c));
}
async function fromAlpha(want) {
  if (!process.env.ALPHA_KEY) throw new Error('kein Secret ALPHA_KEY');
  const sym = want.alpha || want.symbol;
  /* Gratis-Schlüssel: höchstens eine Anfrage pro Sekunde. Pause dazwischen, bei Drosselung einmal wiederholen. */
  const get = async (fn, extra) => {
    try { return await alphaSeries(sym, fn, extra); }
    catch (e) { if (!/spreading|per second/i.test(e.message)) throw e; await sleep(8000); return await alphaSeries(sym, fn, extra); }
  };
  const daily = await get('TIME_SERIES_DAILY', '&outputsize=compact');
  await sleep(2000);
  const weekly = (await get('TIME_SERIES_WEEKLY')).slice(-110);
  /* Zusätzlich der aktuelle Kurs (GLOBAL_QUOTE). Ob er für diese Börse mehr liefert als den Schlusskurs, zeigt das Protokoll. */
  await sleep(2000);
  let quote = null;
  try {
    const r = await fetch('https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=' + encodeURIComponent(sym) + '&apikey=' + encodeURIComponent(process.env.ALPHA_KEY));
    const j = await r.json();
    console.log('  GLOBAL_QUOTE roh: ' + clip(JSON.stringify(j)));
    const g = j['Global Quote'];
    if (g && g['05. price']) quote = { price: +g['05. price'], day: g['07. latest trading day'], prev: +g['08. previous close'], change: g['10. change percent'] };
  } catch (e) { console.log('  GLOBAL_QUOTE fehlgeschlagen: ' + e.message); }
  return { name: want.symbol, currency: want.currency || '', liveTime: 0, daily, weekly, quote };
}

/* ---------- Ablauf ---------- */
const cfg = JSON.parse(fs.readFileSync('symbols.json', 'utf8'));
let out = { updated: '', symbols: {} };
try { out = JSON.parse(fs.readFileSync('quotes.json', 'utf8')); } catch (e) {}
out.symbols = out.symbols || {};

const SOURCES = [['Yahoo', fromYahoo], ['Stooq', fromStooq], ['Alpha Vantage', fromAlpha]];
let ok = 0;
for (const item of cfg) {
  const want = typeof item === 'string' ? { symbol: item } : item;
  let data = null;
  for (const [name, fn] of SOURCES) {
    try {
      const d = await fn(want);
      if (d.daily.length < 50 || d.weekly.length < 31) throw new Error('Zu wenige Kursdaten (' + d.daily.length + ' Tage, ' + d.weekly.length + ' Wochen)');
      data = Object.assign(d, { source: name });
      console.log(want.symbol + ': ' + name + ' ok, ' + d.daily.length + ' Tage, ' + d.weekly.length + ' Wochen, letzter Kurs ' + d.daily[d.daily.length - 1].c + ' (' + d.daily[d.daily.length - 1].d + ')');
      break;
    } catch (e) { console.log(want.symbol + ': ' + name + ' fehlgeschlagen: ' + e.message); }
  }
  if (data) { out.symbols[want.symbol] = data; ok++; }
}
if (!ok) {
  console.log('::warning::Keine Quelle lieferte Kurse. quotes.json bleibt unverändert.');
  process.exit(0);
}
out.updated = new Date().toISOString();
fs.writeFileSync('quotes.json', JSON.stringify(out));
