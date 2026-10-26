'use strict';
// 各枠(ニコ生ページ)の中で動く小さなスクリプト。
// 「プレイヤーのみ」表示のとき、映像の上でマウスをドラッグすると、枠の並べ替えを始める。
const { ipcRenderer } = require('electron');

let down = null, dragging = false, suppressClick = false;
const skip = t => !!(t && t.closest && t.closest('button, a, input, textarea, select, [role="slider"], [class*="seek"], [class*="control"]'));
const playerOnly = () => document.documentElement.classList.contains('nmv');

window.addEventListener('mousedown', e => {
  if (e.button !== 0 || !playerOnly() || skip(e.target)) { down = null; return; }
  down = { x: e.screenX, y: e.screenY }; dragging = false;
}, true);

window.addEventListener('mousemove', e => {
  if (!down || dragging) return;
  if (!(e.buttons & 1)) { down = null; return; }
  if (Math.hypot(e.screenX - down.x, e.screenY - down.y) > 8) {
    dragging = true;
    ipcRenderer.send('mv:vdrag', 'start');
  }
}, true);

function finish() {
  if (dragging) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 50); ipcRenderer.send('mv:vdrag', 'end'); }
  down = null; dragging = false;
}
window.addEventListener('mouseup', finish, true);
window.addEventListener('blur', finish);
// ダブルクリックでその枠だけ表示(プレイヤー自体の全画面切替は止める)
window.addEventListener('dblclick', e => {
  if (!playerOnly() || skip(e.target)) return;
  e.stopPropagation(); e.preventDefault();
  ipcRenderer.send('mv:vdbl');
}, true);
// ドラッグの最後に出るクリックは、プレイヤーに渡さない(再生/停止の誤操作を防ぐ)
window.addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);

/* ------------------------------------------------------------------ *
 * コメントの収集(統合コメントビューア用)
 *  視聴ページのコメント一覧(コメント番号つきの行)を読み取って、メイン側へ送る。
 *  一覧は画面に見えている行だけが入る作りなので、行の増減を監視して新しい番号だけ拾う。
 *  広告・お知らせなど番号のない行は対象外。
 * ------------------------------------------------------------------ */
const ROW = '[class*="___comment-data-grid___"] [class*="___table-row___"]';
const TABLE = '[class*="___comment-data-grid___"] [class*="___body___"] [class*="___table___"]';
const seen = new Set();
let scanTimer = 0, prevTexts = null;

// 番号のない一覧(幅がせまいときは「コメント」列だけ)用: 前回の一覧とのずれから、新しく増えた分だけを取り出す
function alignNew(prev, cur) {
  const n = cur.length;
  if (!prev || !prev.length) return cur.slice();
  const eq = (a, b, k) => { for (let i = 0; i < k; i++) if (a[i] !== b[i]) return false; return true; };
  let down = n, up = n;   // 下に追加(古い→新しい)・上に追加(新しい→古い)のずれの大きさ
  for (let s = 0; s <= n; s++) { if (n - s <= prev.length - s && eq(cur, prev.slice(s), n - s)) { down = s; break; } }
  for (let s = 0; s <= n; s++) { if (n - s <= prev.length && eq(cur.slice(s), prev, n - s)) { up = s; break; } }
  if (down === n && up === n) return cur.slice();
  return down <= up ? cur.slice(n - down) : cur.slice(0, up);
}

// 一覧が下まで追従していないと、新しいコメントが描画されない(行が増えない)ので、見えない間は下に張りつけておく
function pinBottom() {
  if (!playerOnly()) return;
  const b = document.querySelector('[class*="___comment-data-grid___"] [class*="___body___"]');
  if (b && b.scrollHeight - b.scrollTop - b.clientHeight > 8) b.scrollTop = b.scrollHeight;
}

function scan() {
  scanTimer = 0;
  pinBottom();
  const out = [];
  const texts = [];
  document.querySelectorAll(ROW).forEach(r => {
    const c = r.querySelector('[class*="___table-cell___"]');
    if (!c) return;
    // 番号つきの一覧(広い表示): 1つめが番号、2つめが本文
    if (c.children.length >= 2 && /^\d+$/.test((c.children[0].textContent || '').trim())) {
      const no = (c.children[0].textContent || '').trim();
      const text = (c.children[1].textContent || '').trim();
      if (!text || seen.has(no)) return;
      seen.add(no);
      out.push({ no: Number(no), text });
      return;
    }
    // 番号のない一覧(せまい表示): 本文だけ
    const ct = r.querySelector('.comment-text');
    const text = ct ? (ct.textContent || '').trim() : '';
    if (text) texts.push(text);
  });
  if (texts.length) {
    alignNew(prevTexts, texts).forEach(t => out.push({ no: 0, text: t }));
    prevTexts = texts;
  }
  if (seen.size > 4000) { const keep = [...seen].slice(-2000); seen.clear(); keep.forEach(k => seen.add(k)); }
  if (out.length) ipcRenderer.send('mv:comments', out);
}
const schedule = () => { if (!scanTimer) scanTimer = setTimeout(scan, 80); };

let watched = null;
function attach() {
  const t = document.querySelector(TABLE);
  if (t && t !== watched) {
    watched = t;
    new MutationObserver(schedule).observe(t, { childList: true, subtree: true, characterData: true });
    schedule();
  }
}
setInterval(() => { attach(); schedule(); }, 400);   // 画面の作り直しや取りこぼしへの保険

// ブラウザから、放送のリンク(URL)をこの枠へドラッグして追加できるようにする
const dropText = dt => {
  if (!dt) return '';
  const parts = [];
  for (const t of ['text/uri-list', 'text/x-moz-url', 'text/plain', 'text/html']) { try { const v = dt.getData(t); if (v) parts.push(v); } catch { /* 無視 */ } }
  return parts.join('\n').slice(0, 5000);
};
const hasLink = dt => !!dt && [...(dt.types || [])].some(t => /uri-list|moz-url|plain|html/.test(t));
addEventListener('dragover', e => { if (hasLink(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }, true);
addEventListener('drop', e => {
  if (!hasLink(e.dataTransfer)) return;
  e.preventDefault(); e.stopPropagation();   // このページが、ドロップされたリンクへ移動してしまうのを防ぐ
  const text = dropText(e.dataTransfer);
  if (/lv\d+/i.test(text)) ipcRenderer.send('mv:drop', text);
}, true);
