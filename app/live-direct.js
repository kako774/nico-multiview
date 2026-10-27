'use strict';
// コメントを、ニコ生から直接受け取る(サイトを経由しない)。
// 手順(nico-ran.stream のコメントビューアと同じ):
//   1. 放送ページを取得して、埋め込みのデータからWebSocketのURLを読む
//   2. WebSocketにつないで startWatching を送り、コメントサーバーの取得口(viewUri)を教えてもらう
//   3. 取得口から、直近の「区切り」のURLを探し、その流れ(protobuf)を読みつづけてコメントを取り出す
// 公式の公開APIではない仕組みなので、ニコニコ側の変更で動かなくなることがある(その場合は、呼び出し側がサイト経由に切り替える)。
// ログイン情報は使わない(匿名で接続する。ログイン中の視聴を「別の場所で視聴された」と切らないため)。

// ---- protobuf を、型を決めずに読む(番号→値の並び) ----
function readVarint(b, p) {
  let r = 0, mul = 1;
  for (let i = 0; i < 10; i++) {
    if (p >= b.length) return null;
    const c = b[p++];
    r += (c & 0x7f) * mul;
    if (!(c & 0x80)) return [r, p];
    mul *= 128;
  }
  return null;
}
function parseFields(b) {
  const out = []; let p = 0;
  while (p < b.length) {
    const k = readVarint(b, p); if (!k) return null;
    p = k[1];
    const f = Math.floor(k[0] / 8), t = k[0] % 8;
    if (t === 0) { const v = readVarint(b, p); if (!v) return null; p = v[1]; out.push({ f, t, v: v[0] }); }
    else if (t === 2) {
      const l = readVarint(b, p); if (!l) return null; p = l[1];
      if (p + l[0] > b.length) return null;
      out.push({ f, t, b: b.subarray(p, p + l[0]) }); p += l[0];
    } else if (t === 1) { if (p + 8 > b.length) return null; p += 8; }
    else if (t === 5) { if (p + 4 > b.length) return null; p += 4; }
    else return null;
  }
  return out;
}
function splitDelimited(buf) {
  const msgs = []; let p = 0;
  while (p < buf.length) {
    const l = readVarint(buf, p); if (!l) break;
    p = l[1];
    if (p + l[0] > buf.length) break;
    msgs.push(buf.subarray(p, p + l[0])); p += l[0];
  }
  return msgs;
}
const td = new TextDecoder('utf-8', { fatal: false });
const asText = b => td.decode(b);

// ---- コメント(Chat)を探す ----
// ChunkedMessage: f1=メタ(f2=時刻)、f2=本体(f1=コメント)。 コメントは f1=本文・f2=名前・f5=ユーザーID(数字)・f6=ハッシュ化ID・f8=コメント番号
const isChat = c => c && c.some(z => z.f === 1 && z.t === 2) && c.some(z => z.f === 8 && z.t === 0) && c.some(z => (z.f === 5 && z.t === 0) || (z.f === 6 && z.t === 2));
function metaAt(b) {
  const m = parseFields(b); if (!m) return null;
  for (const x of m) if (x.f === 2 && x.t === 2) { const t = parseFields(x.b); if (t && t[0] && t[0].f === 1 && t[0].t === 0 && t[0].v > 1.5e9 && t[0].v < 2.5e9) return t[0].v; }
  return null;
}
function collect(b, depth, acc) {
  const f = parseFields(b); if (!f || depth > 5) return;
  const meta = f.find(x => x.f === 1 && x.t === 2 && metaAt(x.b) !== null);
  if (meta) {
    const at = metaAt(meta.b);
    for (const x of f) if (x.f === 2 && x.t === 2) {
      for (const y of parseFields(x.b) || []) if (y.f === 1 && y.t === 2) {
        const c = parseFields(y.b);
        if (!isChat(c)) continue;
        let raw = null, hashed = null, text = '', name = '', no = 0, prem = 0;
        for (const z of c) {
          if (z.f === 5 && z.t === 0) raw = z.v;
          if (z.f === 6 && z.t === 2) hashed = asText(z.b);
          if (z.f === 1 && z.t === 2) text = asText(z.b);
          if (z.f === 2 && z.t === 2) name = asText(z.b);
          if (z.f === 8 && z.t === 0) no = z.v;
          if (z.f === 4 && z.t === 0) prem = z.v;
        }
        acc.push({ at, u: raw ? 'r' + raw : 'h' + hashed, x: text, n: no, nm: name, pr: prem });
      }
    }
    return;
  }
  for (const x of f) if (x.t === 2 && x.b.length > 8) collect(x.b, depth + 1, acc);
}
const firstUri = (b, depth = 0) => {
  if (depth > 6) return null;
  for (const q of parseFields(b) || []) if (q.t === 2) {
    const t = asText(q.b); if (/^https?:\/\//.test(t)) return t;
    if (q.b.length > 1) { const r = firstUri(q.b, depth + 1); if (r) return r; }
  }
  return null;
};
// 取得口の一覧(entries)から、直近の区切り(segment / previous)のURLを取り出す
function recentUrisOf(entries) {
  const recent = [];
  for (const e of entries) {
    for (const x of parseFields(e) || []) {
      if (x.t !== 2) continue;
      if (x.f === 1 || x.f === 3) {
        const u = (parseFields(x.b) || []).find(y => y.f === 3 && y.t === 2);
        if (u) { const t = asText(u.b); if (/^https?:\/\//.test(t)) recent.push(t); }
      }
    }
  }
  return recent;
}
const hasNext = buf => splitDelimited(buf).some(m => (parseFields(m) || []).some(x => x.f === 4));
const unescapeAttr = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const sleep = (ms, sig) => new Promise(res => {
  const t = setTimeout(res, ms);
  if (sig) sig.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

// env: { fetch, WebSocket, ua, watchBase }
function make(env) {
  const headers = extra => Object.assign({ 'user-agent': env.ua }, extra || {});
  const watchBase = env.watchBase || 'https://live.nicovideo.jp/watch/';

  async function watchSocketUrl(id, sig) {
    const res = await env.fetch(watchBase + id, { headers: headers({ accept: 'text/html' }), signal: sig });
    if (!res.ok) throw new Error('watch http ' + res.status);
    const html = await res.text();
    const m = html.match(/id="embedded-data"[^>]*data-props="([^"]*)"/);
    if (!m) throw new Error('no embedded-data');
    const props = JSON.parse(unescapeAttr(m[1]));
    if (!props.program || props.program.status !== 'ON_AIR') throw new Error('not on air');
    const ws = props.site && props.site.relive && props.site.relive.webSocketUrl;
    if (!ws) throw new Error('no webSocketUrl');
    return ws;
  }
  function messageServerUri(wsUrl, sig) {
    return new Promise((resolve, reject) => {
      let ws, done = false;
      const fin = (fn, v) => { if (done) return; done = true; clearTimeout(t); try { ws.close(); } catch { /* 無視 */ } fn(v); };
      const t = setTimeout(() => fin(reject, new Error('ws timeout')), 8000);
      if (sig) sig.addEventListener('abort', () => fin(reject, new Error('aborted')), { once: true });
      try { ws = new env.WebSocket(wsUrl, { headers: headers({ origin: 'https://live.nicovideo.jp' }) }); }
      catch (e) { return fin(reject, e); }
      ws.onopen = () => ws.send(JSON.stringify({ type: 'startWatching', data: { stream: { quality: 'abr', protocol: 'hls', latency: 'low', chasePlay: false }, room: { protocol: 'webSocket', commentable: true }, reconnect: false } }));
      ws.onmessage = ev => {
        let j; try { j = JSON.parse(ev.data); } catch { return; }
        if (j.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        else if (j.type === 'messageServer' && j.data && j.data.viewUri) fin(resolve, j.data.viewUri.replace(/\?.*$/, ''));
        else if (j.type === 'error' || j.type === 'disconnect') fin(reject, new Error('ws ' + j.type));
      };
      ws.onerror = () => fin(reject, new Error('ws error'));
      ws.onclose = () => fin(reject, new Error('ws closed'));
    });
  }
  // 流れ(ストリーム)を、必要な分だけ読む
  async function readBody(u, maxBytes, maxMs, isDone, idleMs, sig) {
    const ctl = new AbortController(); const guard = setTimeout(() => ctl.abort(), maxMs + 3000);
    if (sig) sig.addEventListener('abort', () => ctl.abort(), { once: true });
    const chunks = []; let total = 0;
    try {
      const res = await env.fetch(u, { headers: headers(), signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rd = res.body.getReader(); const t0 = Date.now();
      try {
        while (total < maxBytes && Date.now() - t0 < maxMs) {
          const r = await Promise.race([rd.read(), new Promise(rs => setTimeout(() => rs({ timeout: true }), total && idleMs ? idleMs : Math.max(200, maxMs - (Date.now() - t0))))]);
          if (r.timeout || r.done) break;
          chunks.push(r.value); total += r.value.length;
          if (isDone) { const cur = Buffer.concat(chunks); if (isDone(cur)) break; }
        }
      } catch (e) { if (!total) throw e; }
      try { await rd.cancel(); } catch { /* 無視 */ }
    } finally { clearTimeout(guard); }
    return Buffer.concat(chunks);
  }
  async function recentUris(view, sig) {
    const first = await readBody(view + '?at=now', 2000, 2500, hasNext, 0, sig);
    let at = null;
    for (const m of splitDelimited(first)) for (const x of parseFields(m) || []) if (x.f === 4 && x.t === 2) { const q = parseFields(x.b); if (q && q[0] && q[0].t === 0) at = q[0].v; }
    if (!at) throw new Error('no next');
    const list = await readBody(view + '?at=' + at, 30000, 3000, hasNext, 800, sig);
    return recentUrisOf(splitDelimited(list)).slice(-3);
  }
  // 1つの区切り(ストリーム)を、終わるまで読みつづけ、コメントが来るたびに渡す
  async function pump(u, sig, hooks) {
    let buf = Buffer.alloc(0);
    try {
      const res = await env.fetch(u, { headers: headers(), signal: sig });
      if (!res.ok) return;
      hooks.onSegment();
      const rd = res.body.getReader();
      for (;;) {
        const r = await rd.read();
        if (r.done) break;
        buf = Buffer.concat([buf, Buffer.from(r.value)]);
        let p = 0; const out = [];
        for (;;) {
          const l = readVarint(buf, p); if (!l) break;
          if (l[1] + l[0] > buf.length) break;
          collect(buf.subarray(l[1], l[1] + l[0]), 0, out);
          p = l[1] + l[0];
        }
        buf = buf.subarray(p);
        if (out.length) hooks.onChats(out);
        if (sig.aborted) break;
      }
      try { await rd.cancel(); } catch { /* 無視 */ }
    } catch { /* 途中で切れたら、その区切りは終わり */ }
  }
  // 放送ごとの接続。 止めるか、続けられなくなるまで戻らない(終了した放送は 'gone' を投げる)
  async function run(id, sig, hooks) {
    let wsUrl;
    try { wsUrl = await watchSocketUrl(id, sig); }
    catch (e) { if (/not on air/.test(String(e && e.message))) { const g = new Error('gone'); g.gone = true; throw g; } throw e; }
    const view = await messageServerUri(wsUrl, sig);
    const seen = new Set(); let fails = 0;
    while (!sig.aborted) {
      let uris;
      try { uris = await recentUris(view, sig); fails = 0; }
      catch (e) { if (sig.aborted) return; if (++fails >= 3) throw e; await sleep(2000, sig); continue; }
      for (const u of uris) if (!seen.has(u)) { seen.add(u); pump(u, sig, hooks); }
      if (seen.size > 200) { const k = [...seen].slice(-50); seen.clear(); k.forEach(x => seen.add(x)); }
      await sleep(3000, sig);
    }
  }
  return { run, watchSocketUrl, messageServerUri, recentUris };
}

module.exports = { make, parseFields, splitDelimited, collect, readVarint };
