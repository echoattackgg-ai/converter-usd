// Собирает курсы на стороне GitHub (без ограничений браузера) и пишет rates.json рядом со страницей.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const sane = v => typeof v === 'number' && v > 20 && v < 500;
const num = v => (v == null ? null : Number(String(v).replace(',', '.')));

async function getJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(url + ' → ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function yahoo() {
  const j = await getJSON('https://query1.finance.yahoo.com/v8/finance/chart/RUB=X?interval=15m&range=1d');
  const res = j?.chart?.result?.[0]; const m = res?.meta;
  const price = num(m?.regularMarketPrice);
  if (!sane(price)) throw new Error('yahoo: bad price');
  if (m.regularMarketTime && Date.now() / 1000 - m.regularMarketTime > 4 * 86400) throw new Error('yahoo: stale');
  const series = (res?.indicators?.quote?.[0]?.close || []).map(num).filter(sane);
  return {
    usd: price, usdPrev: num(m.chartPreviousClose ?? m.previousClose),
    usdLow: num(m.regularMarketDayLow) || (series.length ? Math.min(...series) : null),
    usdHigh: num(m.regularMarketDayHigh) || (series.length ? Math.max(...series) : null),
    usdSrc: 'рынок'
  };
}

async function cbr() {
  const j = await getJSON('https://www.cbr-xml-daily.ru/daily_json.js');
  const u = j?.Valute?.USD;
  if (!sane(num(u?.Value))) throw new Error('cbr: bad');
  return { cbr: num(u.Value), cbrPrev: num(u.Previous), cbrDate: j.Date };
}

async function rapira() {
  const j = await getJSON('https://api.rapira.net/open/market/rates');
  const it = (j.data || []).find(x => String(x.symbol).toUpperCase() === 'USDT/RUB');
  let p = num(it?.close);
  if (!sane(p) && sane(num(it?.askPrice)) && sane(num(it?.bidPrice))) p = (num(it.askPrice) + num(it.bidPrice)) / 2;
  if (!sane(p)) throw new Error('rapira: bad');
  return { usdt: p, usdtPrev: num(it.lastDayClose), usdtSrc: 'Rapira' };
}

async function bybitP2P() {
  const j = await getJSON('https://api2.bybit.com/fiat/otc/item/online', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId: 'USDT', currencyId: 'RUB', side: '1', size: '10', page: '1', amount: '', authMaker: false, canTrade: false })
  });
  const prices = (j?.result?.items || []).slice(0, 7).map(x => num(x.price)).filter(sane).sort((a, b) => a - b);
  if (!prices.length) throw new Error('bybit: empty');
  return { usdt: prices[Math.floor(prices.length / 2)], usdtPrev: null, usdtSrc: 'Bybit P2P' };
}

const first = async (...fns) => { for (const f of fns) { try { return await f(); } catch (e) { console.log(String(e)); } } return null; };

const prev = existsSync('rates.json') ? JSON.parse(readFileSync('rates.json', 'utf8')) : {};
const [usd, c, usdt] = await Promise.all([first(yahoo), first(cbr), first(rapira, bybitP2P)]);
const out = { ...prev, ...(c || {}), ...(usd || {}), ...(usdt || {}) };
if (!usd && c) Object.assign(out, { usd: c.cbr, usdPrev: c.cbrPrev, usdLow: null, usdHigh: null, usdSrc: 'ЦБ' });
if (!sane(out.usd) || !sane(out.usdt)) { console.log('no usable data, keeping previous file'); process.exit(0); }
out.ts = Date.now();
out.parts = { usd: !!usd, cbr: !!c, usdt: !!usdt };
writeFileSync('rates.json', JSON.stringify(out, null, 1) + '\n');
console.log(out);
