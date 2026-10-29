'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, shell, session, screen, nativeTheme, net, dialog, clipboard, ClipboardItem, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// 多重起動の禁止: 2つ目を開くと、同じ保存場所(Cookie)を取り合ってログインが外れるため、エラーを出して終了する
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({ type: 'error', title: 'ニコ生マルチビュー', message: 'ニコ生マルチビューは、すでに起動しています。', detail: '2つ目を起動すると、ログイン状態が解除されることがあるため、起動できません。\nすでに開いている窓を使ってください(見当たらないときは、タスクバーを確認してください)。', buttons: ['OK'] });
    app.exit(0);
  });
} else {
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
}

// ニコニコのログイン状態を全枠で共有・保存するためのパーティション
const PARTITION = 'persist:nico';
const WATCH = id => `https://live.nicovideo.jp/watch/${id}`;
const LOGIN_URL = 'https://account.nicovideo.jp/login?site=nicolive';
const ID_RE = /^lv\d+$/;
const NICO_HOST_RE = /^https:\/\/([\w-]+\.)*nicovideo\.jp\//;

let win = null;
let loginWin = null;
let viewerOpenPref = false, quitting = false, viewerWin = null, viewerView = null, dockedPref = false, dockW = 420, snapOff = 0;   // viewerView: メインの窓に合体しているコメビュ
let overlayRect = null;   // メニューの範囲(null=全部隠す)。範囲に重なる枠だけ隠す
let overlayOpen = false;   // 候補リストなどをHTML側で表示している間は、映像(ネイティブのビュー)を隠す
const views = new Map(); // lv番号 -> WebContentsView
let playerOnly = true;   // プレイヤー(映像+コメント)だけを表示する

// User-Agent から Electron の表記を外す(通常のChromeとして扱われるように)
// 通常のChromeと同じ形のUser-Agentにする(アプリ名・Electronの表記を外す)。
// アプリ名が日本語でも消えるよう、app.name をそのまま取り除く。Cloudflareの確認(Turnstile)が
// 見慣れないUser-Agentで失敗するのを避けるため、ページ内のiframeにも効くよう app 全体にも設定する。
const escRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fixUA = ua => ua
  .replace(new RegExp('\\s' + escRe(app.name) + '\\/\\S+', 'g'), '')
  .replace(/\s(Electron|nico-multiview)\/\S+/g, '');
const ORIG_UA = app.userAgentFallback;   // 手を加えない本来の名前(ログイン窓で使う)
app.userAgentFallback = fixUA(app.userAgentFallback);
// 終了中に、すでに閉じた窓・ビューへ触れて出る「Object has been destroyed」は、害がないので無視する(それ以外のエラーは、これまでどおり表示)
process.on('uncaughtException', err => { if (/Object has been destroyed/.test(String(err && err.message))) return; appLog('エラー: ' + String(err && err.message || err), 'ERROR'); throw err; });

/* ------------------------------------------------------------------ *
 * 動作ログ(設定の「ログ」から見られる)
 *  接続の開始・切り替え・終了、投稿の成否、更新、ログインなどの出来事を残す。
 *  URL は残さない(放送ID、枠の番号などは残す)。 メモリ上だけに持ち、アプリを閉じると消える。
 * ------------------------------------------------------------------ */
const LOG_MAX = 500;
const logBuf = [];
let logWin = null;
const logClean = t => String(t == null ? '' : t).replace(/(?:https?|wss?):\/\/\S+/gi, '(URL)').replace(/\s+/g, ' ').slice(0, 300);
function appLog(msg, level) {
  const e = { t: Date.now(), l: level === 'ERROR' || level === 'WARN' ? level : 'INFO', m: logClean(msg) };
  logBuf.push(e);
  if (logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX);
  if (logWin && !logWin.isDestroyed()) logWin.webContents.send('lg:line', e);
}
const ses = () => session.fromPartition(PARTITION);

/* ------------------------------------------------------------------ *
 * プレイヤーだけ表示
 *  視聴ページから「映像+コメントが流れる部分」だけを全面に出す。
 *  1) クラス名(前半一致)で探す  2) 見つからなければ「一番大きい映像」から
 *     操作ボタンを含む最小の祖先を探す(広告の映像は除外)
 *  どちらでも見つからないときは何もせず、元のページをそのまま表示する。
 * ------------------------------------------------------------------ */
const SCREEN = '[class*="___player-display-screen___"]';
const PLAYER_CSS = `
html.nmv, html.nmv body { overflow: hidden !important; background: #000 !important; }
html.nmv body * { visibility: hidden !important; }
html.nmv [data-nmv-screen], html.nmv [data-nmv-screen] * { visibility: visible !important; }
html.nmv-nocmt [class*="___comment-layer___"] { display: none !important; }
html.nmv-nobar [class*="___seek-controller___"] { display: none !important; }
/* ガラステーマ: 映像の左右・上下の黒い余白も、ガラス(透明)にする */
html.nmv-glass, html.nmv-glass body { background: transparent !important; }
/* 番組が見つからないとき: ニコ生のエラーページは見せず、黒い背景に案内だけを出す */
html.nmv-nf, html.nmv-nf body { background: #000 !important; overflow: hidden !important; }
html.nmv-nf body > *:not(#nmv-notice) { visibility: hidden !important; }
html.nmv [data-nmv-screen] {
  /* 枠に収まる最大の16:9にして中央に置く(横長・縦長の枠でも映像が切れない。余白は黒) */
  position: fixed !important; inset: auto !important; left: 50% !important; top: 50% !important;
  transform: translate(-50%, -50%) !important;
  width: min(100vw, calc(100vh * 16 / 9)) !important; height: min(100vh, calc(100vw * 9 / 16)) !important;
  min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important;
  margin: 0 !important; padding: 0 !important; z-index: 2147483646 !important; background: #000 !important;
}
/* シークバー(タイムシフトの巻き戻し)は、映像の下端に重ねて、枠にマウスを乗せたときだけ出す */
html.nmv [class*="___seek-controller___"], html.nmv [class*="___seek-controller___"] * { visibility: visible !important; }
html.nmv [class*="___seek-controller___"] {
  position: fixed !important; z-index: 2147483647 !important; margin: 0 !important; padding: 0 !important;
  left: calc(50vw - min(100vw, 100vh * 16 / 9) / 2) !important; width: min(100vw, calc(100vh * 16 / 9)) !important;
  top: calc(50vh + min(100vh, 100vw * 9 / 16) / 2 - 12px) !important; height: 12px !important;
  opacity: 0; transition: opacity .15s;
}
html.nmv:hover [class*="___seek-controller___"] { opacity: 1; }`;
const PLAYER_JS = `(() => {
  if (window.__nmvUpd) { window.__nmvUpd(); return; }
  window.__nmvOn = true;
  const SCREEN = '${SCREEN}';
  const isAd = v => !!v.closest('aside, iframe, [id*="smarttag"], [class*="trv"], [class*="truvid"]');
  function findScreen() {
    const a = document.querySelector(SCREEN);
    if (a) return a;
    const vs = [...document.querySelectorAll('video')].filter(v => !isAd(v) && v.clientWidth > 200)
      .sort((x, y) => y.clientWidth * y.clientHeight - x.clientWidth * x.clientHeight);
    if (!vs.length) return null;
    let n = vs[0].parentElement;
    while (n && n !== document.body) { if (n.querySelector('button')) return n; n = n.parentElement; }
    return vs[0].parentElement;
  }
  window.__nmvVol = null;
  window.__nmvVolApply = () => {
    if (window.__nmvVol == null) return;
    document.querySelectorAll('video').forEach(v => { if (!isAd(v) && Math.abs(v.volume - window.__nmvVol) > 0.01) v.volume = window.__nmvVol; });
  };
  window.__nmvUpd = () => {
    const html = document.documentElement;
    document.querySelectorAll('[data-nmv-screen]').forEach(e => e.removeAttribute('data-nmv-screen'));
    const el = window.__nmvOn !== false ? findScreen() : null;
    if (el) el.setAttribute('data-nmv-screen', '');
    html.classList.toggle('nmv', !!el);
  };
  setInterval(() => { window.__nmvUpd(); window.__nmvVolApply(); }, 1000);
  window.__nmvUpd();
})()`;
// 新しいバージョンのお知らせ(GitHubの最新リリースと比べるだけ。自動ではダウンロードしない)
const REL_PAGE = 'https://github.com/kako774/nico-multiview/releases';
const DL_PAGE = 'https://nico-ran.stream/tools/nico-multiview/';
const verNum = s => String(s || '').replace(/^v/i, '').split('.').map(x => parseInt(x, 10) || 0);
const isNewer = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
// 更新のしくみ: 新しいバージョンがあれば知らせる。 アプリ本体(app.asar。数百KB)だけの更新で済むときは、
// アプリの中でダウンロードして入れ替え、再起動する(Windowsのみ)。 実行環境(Electron)が変わるときは、配布ページから新しいZIPを入れ直してもらう。
const UPD_BASE = 'https://github.com/kako774/nico-multiview/releases/latest/download/';
let updManifest = null;
async function fetchManifest() {
  const res = await net.fetch(UPD_BASE + 'update.json', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const j = JSON.parse((await res.text()).replace(/^﻿/, ''));
  if (!j || typeof j.version !== 'string' || !/^[0-9a-f]{64}$/.test(j.sha256 || '') || !(j.size > 0 && j.size < 20 * 1024 * 1024)) return null;
  if (!verifyManifest(j)) return null;   // 署名が合わないものは、更新として扱わない
  return j;
}
// 更新の案内(update.json)の電子署名を確かめる。 配布元が乗っ取られても、秘密鍵がなければ偽の更新は通らない
const UPDATE_PUBKEY = 'MCowBQYDK2VwAyEAD0vhtUaKrXBr/62h0ghdS9VLPMa5qV/EXbUJERf0tpQ=';
function verifyManifest(j) {
  try {
    const c = require('crypto');
    if (typeof j.sig !== 'string' || !j.sig) return false;
    const key = c.createPublicKey({ key: Buffer.from(UPDATE_PUBKEY, 'base64'), format: 'der', type: 'spki' });
    const msg = ['nmv-update', j.version, j.sha256, j.size, j.electron].join('\n');
    return c.verify(null, Buffer.from(msg), key, Buffer.from(j.sig, 'base64'));
  } catch { return false; }
}
function canSelfUpdate(j) {
  if (process.platform !== 'win32' || !app.isPackaged || !j) return false;
  if (j.electron !== process.versions.electron) return false;   // 実行環境が変わる更新は、ZIPの入れ直し
  try { require('fs').accessSync(process.resourcesPath, require('fs').constants.W_OK); } catch { return false; }
  return true;
}
ipcMain.handle('mv:update-check', async () => {
  try {
    const res = await net.fetch('https://api.github.com/repos/kako774/nico-multiview/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false };
    const j = await res.json();
    const tag = String(j && j.tag_name || '');
    if (!/^v?\d+(\.\d+){1,2}$/.test(tag)) return { ok: false };
    const newer = isNewer(tag, app.getVersion());
    let auto = false;
    if (newer) { try { updManifest = await fetchManifest(); auto = !!updManifest && updManifest.version === tag.replace(/^v/i, '') && canSelfUpdate(updManifest); } catch { updManifest = null; } }
    if (newer) promptUpdate(tag.replace(/^v/i, ''), auto);
    return { ok: true, latest: tag.replace(/^v/i, ''), newer, auto };
  } catch { return { ok: false }; }
});
let updating = false, updPrepared = null;
// 新しい app.asar をダウンロードして、照合する(まだ入れ替えない)
async function prepareUpdate(man) {
  const fs = require('fs'), crypto = require('crypto');
  const res = await net.fetch(`https://github.com/kako774/nico-multiview/releases/download/v${man.version}/app.asar`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('ダウンロードできませんでした(' + res.status + ')');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== man.size) throw new Error('ファイルの大きさが合いません');
  if (crypto.createHash('sha256').update(buf).digest('hex') !== man.sha256) throw new Error('ファイルが壊れています(照合に失敗)');
  const dir = path.join(app.getPath('userData'), 'update');
  fs.mkdirSync(dir, { recursive: true });
  const next = path.join(dir, 'app.asar.new');
  fs.writeFileSync(next, buf);
  return next;
}
// このアプリが終わるのを待って入れ替え(元のファイルは .bak に残す)、再起動する。
// 入れ替えは、このアプリ自身(Electron を Node として起動)に任せる。 PowerShell は、環境によって動かないことがあるため使わない。
const APPLY_JS = `
const fs = (() => { try { return require('original-fs'); } catch { return require('fs'); } })();
const cp = require('child_process');
const [pid, target, next, exe, res] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 60; i++) { try { process.kill(Number(pid), 0); } catch (e) { break; } await sleep(500); }
  await sleep(700);
  let ok = false, err = '';
  for (let i = 0; i < 40; i++) {
    try { fs.copyFileSync(target, target + '.bak'); fs.copyFileSync(next, target); try { fs.unlinkSync(next); } catch (e) {} ok = true; break; }
    catch (e) { err = String(e && e.message || e); await sleep(500); }
  }
  try { fs.writeFileSync(res, ok ? 'OK' : 'NG: ' + err); } catch (e) {}
  try { const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; const c = cp.spawn(exe, [], { detached: true, stdio: 'ignore', env }); c.unref(); } catch (e) {}
})();
`;
function finishUpdate(next) {
  const fs = require('fs');
  const target = path.join(process.resourcesPath, 'app.asar');
  const dir = path.dirname(next), script = path.join(dir, 'apply.js'), res = path.join(dir, 'result.txt');
  try { fs.rmSync(res, { force: true }); } catch { /* 無視 */ }
  fs.writeFileSync(script, APPLY_JS);
  const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
  const child = require('child_process').spawn(process.execPath, [script, String(process.pid), target, next, process.execPath, res], { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.on('error', () => {});
  child.unref();
  setTimeout(() => app.quit(), 300);
}
// 起動したときに、前回の更新の結果をログへ残す
function logUpdateResult() {
  try {
    const fs = require('fs'), f = path.join(app.getPath('userData'), 'update', 'result.txt');
    if (!fs.existsSync(f)) return;
    const t = fs.readFileSync(f, 'utf8').trim(); fs.rmSync(f, { force: true });
    if (t === 'OK') appLog(`更新を適用しました(v${app.getVersion()})`);
    else appLog('更新の入れ替えに失敗: ' + t.slice(0, 120), 'ERROR');
  } catch { /* 無視 */ }
}
const msgBox = opts => (win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
// 更新の流れ: (確認) → ダウンロードと照合 → 「再起動します」でOK → 入れ替えて再起動
async function runUpdate(man, ask) {
  if (updating) return { ok: false, error: '更新中です' };
  if (!man || !canSelfUpdate(man)) return { ok: false, error: 'この版は、アプリの中では更新できません。配布ページから入れ直してください' };
  if (ask) {
    const r = await msgBox({ type: 'question', title: 'ニコ生マルチビュー', message: `更新があります(v${man.version})。更新しますか?`, detail: '「更新する」を押すと、更新ファイルをダウンロードします(数百KBです)。', buttons: ['更新する', 'あとで'], defaultId: 0, cancelId: 1, noLink: true });
    if (r.response !== 0) return { ok: false, cancelled: true };
  }
  updating = true;
  try {
    appLog(`更新 v${man.version}: ダウンロード開始`);
    const next = await prepareUpdate(man);
    appLog(`更新 v${man.version}: 照合に成功。再起動して入れ替えます`);
    await msgBox({ type: 'info', title: 'ニコ生マルチビュー', message: '更新の準備ができました。', detail: 'OKを押すと、アプリを再起動します。', buttons: ['OK'], defaultId: 0, noLink: true });
    finishUpdate(next);
    return { ok: true };
  } catch (e) {
    updating = false;
    const error = String(e && e.message || e).slice(0, 100);
    appLog('更新に失敗: ' + error, 'ERROR');
    await msgBox({ type: 'error', title: 'ニコ生マルチビュー', message: '更新できませんでした。', detail: error + '\n\n配布ページから、新しいZIPを入れ直してください。', buttons: ['OK'], noLink: true }).catch(() => {});
    return { ok: false, error };
  }
}
ipcMain.handle('mv:update-apply', () => runUpdate(updManifest, false));
// 新しい版が見つかったら、起動中に1回だけ、確認の窓を出す(同じ版では、アプリを起動し直すまで出さない)
let promptedVer = '';
async function promptUpdate(latest, auto) {
  if (promptedVer === latest || updating) return;
  await ensurePolicy();   // 利用できない版のときは、その案内だけを出す(更新の案内を2つ重ねない)
  if (policyShown) return;
  promptedVer = latest;
  if (auto) { runUpdate(updManifest, true); return; }
  const r = await msgBox({ type: 'info', title: 'ニコ生マルチビュー', message: `新しいバージョン(v${latest})があります。`, detail: '配布ページから、新しいZIPをダウンロードしてください。', buttons: ['配布ページを開く', 'あとで'], defaultId: 0, cancelId: 1, noLink: true });
  if (r.response === 0) shell.openExternal(DL_PAGE);
}
ipcMain.on('mv:open-release', () => shell.openExternal(DL_PAGE));

/* ------------------------------------------------------------------ *
 * 利用できない古い版の停止(policy.json)
 *  配布側が「この版より古いものは使えない」と決めたとき、起動時と6時間おきに確かめて、案内を出して止める。
 *  policy.json は更新ファイルと同じ鍵で署名されていて、署名が合わないものは無視する。
 *  取得できないとき(オフライン、障害など)は、前回取得できたものを使う。 なければ、そのまま使える。
 * ------------------------------------------------------------------ */
const POLICY_URL = 'https://github.com/kako774/nico-multiview/releases/download/policy/policy.json';
function verifyPolicy(j) {
  try {
    const c = require('crypto');
    if (!j || typeof j.minVersion !== 'string' || !/^\d+(\.\d+){1,2}$/.test(j.minVersion) || typeof j.sig !== 'string') return false;
    const key = c.createPublicKey({ key: Buffer.from(UPDATE_PUBKEY, 'base64'), format: 'der', type: 'spki' });
    const msg = ['nmv-policy', j.minVersion, j.message || '', j.issued].join('\n');
    return c.verify(null, Buffer.from(msg), key, Buffer.from(j.sig, 'base64'));
  } catch { return false; }
}
function loadPolicy() {
  const fs = require('fs'), f = path.join(app.getPath('userData'), 'policy.json');
  let cached = null;
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (verifyPolicy(j)) cached = j; } catch { /* なし */ }
  return { cached, f };
}
let policyShown = false, policyPromise = null;
function ensurePolicy() { return policyPromise || (policyPromise = checkPolicy().catch(() => {})); }
async function checkPolicy() {
  if (policyShown) return;
  const fs = require('fs');
  const { cached, f } = loadPolicy();
  let best = cached;
  try {
    const res = await net.fetch(POLICY_URL, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const j = JSON.parse((await res.text()).replace(/^﻿/, ''));
      // 古い方針に巻き戻されないよう、発行時刻が新しいものだけ採用する
      if (verifyPolicy(j) && (!best || Number(j.issued) >= Number(best.issued))) { best = j; try { fs.writeFileSync(f, JSON.stringify(j)); } catch { /* 無視 */ } }
    }
  } catch { /* 取得できなくても、前回のものを使う */ }
  if (!best || !isNewer(best.minVersion, app.getVersion())) return;
  policyShown = true;
  appLog(`この版(v${app.getVersion()})は利用できません(v${best.minVersion} 以上が必要)`, 'WARN');
  const extra = String(best.message || '').slice(0, 300);
  const r = await dialog.showMessageBox({ type: 'warning', title: 'ニコ生マルチビュー', message: 'このバージョンは、利用できなくなりました。', detail: `v${best.minVersion} 以上への更新が必要です(いまは v${app.getVersion()})。` + (extra ? '\n\n' + extra : ''), buttons: ['更新する', '終了'], defaultId: 0, cancelId: 1, noLink: true });
  if (r.response === 0) {
    let man = null;
    try { man = await fetchManifest(); } catch { /* 無視 */ }
    if (man && canSelfUpdate(man) && !isNewer(best.minVersion, man.version)) {
      updManifest = man;
      const u = await runUpdate(man, false);
      if (u && u.ok) return;   // 入れ替えて再起動する
    } else shell.openExternal(DL_PAGE);
  }
  app.quit();
}
ipcMain.handle('mv:version', () => app.getVersion());
const hideCmt = {};              // lv番号 -> true なら、映像の上を流れるコメントを隠す
let seekOn = true;   // シークバー(巻き戻し)を使えるか
const applySeek = wc => { if (!wc.isDestroyed()) wc.executeJavaScript(`document.documentElement.classList.toggle('nmv-nobar', ${seekOn ? 'false' : 'true'})`).catch(() => {}); };
// メッセージのポップアップ: 映像のビューの上に重ねて、画面の下あたりに数秒だけ出す(枠の大きさは変わらない)
let toastView = null, toastShown = false, toastTimer = null, toastReady = null;
const TOAST_HTML = '<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent;overflow:hidden;font:14px/1.5 \'Yu Gothic UI\',Meiryo,sans-serif"><div id="t" style="box-sizing:border-box;margin:0;padding:10px 16px 10px 40px;border-radius:10px;color:#fff;font-weight:700;position:relative;border:1px solid rgba(255,255,255,.35);word-break:break-all"><span id="i" style="position:absolute;left:12px;top:10px;width:18px;height:18px;border-radius:50%;background:rgba(255,255,255,.9);color:#222;font-size:12px;line-height:18px;text-align:center"></span><span id="x"></span></div>';
let toastWin = null, toastWinReady = null;
function hideToast() {
  clearTimeout(toastTimer);
  if (toastView && toastShown && win && !win.isDestroyed()) { try { win.contentView.removeChildView(toastView); } catch { /* 無視 */ } }
  toastShown = false;
  if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
}
const toastFill = (wc, text, err) => wc.executeJavaScript(`(()=>{const t=document.getElementById('t');document.getElementById('x').textContent=${JSON.stringify(text.slice(0, 300))};document.getElementById('i').textContent=${err ? "'!'" : "'i'"};t.style.background=${err ? "'#c0392b'" : "'#2b6cb0'"};return t.offsetHeight})()`).catch(() => 48);
ipcMain.on('mv:toast', async (_e, text, err) => {
  if (!win || win.isDestroyed() || typeof text !== 'string' || !text) return;
  const wb = win.getBounds();
  const wa = screen.getDisplayMatching(wb).workArea;
  const w = Math.max(240, Math.min(640, wb.width - 40));
  const outside = false;   // メッセージは、窓の中(画面内)に出す。窓の外に出す場合は、ここを true にする
  // まず、窓の外(すぐ下)に出す。画面の下に余白がないときは、窓の中に出す
  if (outside) {
    if (!toastWin || toastWin.isDestroyed()) {
      toastWin = new BrowserWindow({ width: w, height: 60, show: false, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      toastWin.setMenuBarVisibility(false);
      toastWinReady = toastWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TOAST_HTML)).catch(() => {});
      toastWin.on('closed', () => { toastWin = null; });
    }
    await toastWinReady;
    if (toastWin && !toastWin.isDestroyed()) {
      toastWin.setBounds({ x: wb.x, y: 0, width: w, height: 400 });
      const h = Math.min(220, Math.max(40, Math.round(await toastFill(toastWin.webContents, text, err)) + 8));
      const y = wb.y + wb.height + 2;
      if (y + h <= wa.y + wa.height) {
        hideToast();
        toastWin.setBounds({ x: Math.round(wb.x + (wb.width - w) / 2), y, width: w, height: h });
        toastWin.showInactive();
        toastTimer = setTimeout(hideToast, err ? 8000 : 4500);
        return;
      }
      toastWin.hide();
    }
  }
  if (!toastView) {
    toastView = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    toastView.setBackgroundColor('#00000000');
    toastReady = toastView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TOAST_HTML)).catch(() => {});
  }
  await toastReady;
  const [cw, ch] = win.getContentSize();
  const iw = Math.max(240, Math.min(640, cw - 40));
  toastView.setBounds({ x: 0, y: 0, width: iw, height: 400 });
  const h = Math.min(220, Math.max(40, Math.round(await toastFill(toastView.webContents, text, err))));
  toastView.setBounds({ x: Math.round((cw - iw) / 2), y: Math.max(0, ch - h - 28), width: iw, height: h });
  if (toastShown) win.contentView.removeChildView(toastView);
  win.contentView.addChildView(toastView); toastShown = true;
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, err ? 8000 : 4500);
});
ipcMain.on('mv:seek', (_e, v) => { seekOn = v !== false; for (const vw of views.values()) applySeek(vw.webContents); });
const applyHide = (id, wc) => {
  if (wc.isDestroyed()) return;
  wc.executeJavaScript(`document.documentElement.classList.toggle('nmv-nocmt', ${hideCmt[id] ? 'true' : 'false'})`).catch(() => {});
};
const volumes = {};              // lv番号 -> 0..1 (UIで決めた音量)
const applyVol = (id, wc) => {
  if (wc.isDestroyed() || typeof volumes[id] !== 'number') return;
  wc.executeJavaScript(`window.__nmvVol=${volumes[id]}; window.__nmvVolApply && window.__nmvVolApply();`).catch(() => {});
};
const applyMode = wc => {
  if (wc.isDestroyed()) return;
  const on = playerOnly;
  wc.executeJavaScript(`window.__nmvOn=${on ? 'true' : 'false'}; window.__nmvUpd && window.__nmvUpd();`).catch(() => {});
};

/* ------------------------------------------------------------------ *
 * 放送者名・番組名の取得
 *  視聴ページに埋め込まれたデータ(#embedded-data)から読み取り、UIのラベルに使う。
 * ------------------------------------------------------------------ */
const INFO_JS = `(() => {
  try {
    const el = document.getElementById('embedded-data');
    if (!el) return null;
    const pr = (JSON.parse(el.getAttribute('data-props')) || {}).program || {};
    return { name: (pr.supplier && pr.supplier.name) || '', title: pr.title || '' };
  } catch (e) { return null; }
})()`;
const infos = new Map(); // lv番号 -> { name, title }
async function sendInfo(id, wc, tries = 0) {
  if (wc.isDestroyed()) return;
  let info = null;
  try { info = await wc.executeJavaScript(INFO_JS); } catch { /* 読み込み中など */ }
  if (info && info.name) {
    infos.set(id, { name: String(info.name), title: String(info.title || '') });
    if (win && !win.isDestroyed()) win.webContents.send('mv:info', id, info);
    pushSources();
    try { giftPush(); emoPush(); emoTitle(); } catch { /* 起動中は無視 */ }
    return;
  }
  if (tries < 5) setTimeout(() => sendInfo(id, wc, tries + 1), 1500);
}

/* ------------------------------------------------------------------ *
 * 状態の保存
 * ------------------------------------------------------------------ */
const stateFile = () => path.join(app.getPath('userData'), 'state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; }
}
function saveState(s) {
  try { fs.writeFileSync(stateFile(), JSON.stringify(s)); } catch { /* 保存失敗は無視 */ }
}

/* ------------------------------------------------------------------ *
 * ウィンドウ / 各枠のビュー
 * ------------------------------------------------------------------ */
// 画面の明るさ(自動=OSに合わせる / ライト / ダーク)。ビューア窓もこれに従う。
const THEMES = ['system', 'light', 'dark', 'glass', 'glassb', 'glassc', 'glassf'];
const GLASS_BG = { glass: '#14162a', glassb: '#14162a', glassc: '#e9edf6', glassf: '#101226' };
const bgColor = () => (nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f4f6fa');
// 「ガラス」テーマ: Windows 11 なら窓の背景を半透明(アクリル)にする。使えない環境では、ガラス風の背景絵で代用する
let glassOn = false, glassOk = false, glassKind = 'glassb';
function applyGlass() {
  if (!win || win.isDestroyed()) return;
  glassOk = false;
  const build = parseInt(String((process.getSystemVersion && process.getSystemVersion()) || '').split('.')[2] || '0', 10);
  // 全画面中は、すりガラス(アクリル)をやめて、背景絵で代用する(全画面とアクリルの組み合わせで、透明な部分が点滅するのを防ぐ)
  if (glassOn && !win.isFullScreen() && process.platform === 'win32' && build >= 22621 && typeof win.setBackgroundMaterial === 'function') {
    try { win.setBackgroundMaterial('acrylic'); win.setBackgroundColor('#00000000'); glassOk = true; } catch { /* 代用表示にする */ }
  }
  if (!glassOk) {
    try { if (typeof win.setBackgroundMaterial === 'function') win.setBackgroundMaterial('none'); } catch { /* 無視 */ }
    win.setBackgroundColor(glassOn ? (GLASS_BG[glassKind] || '#14162a') : bgColor());
  }
  win.webContents.send('mv:glass', glassOk);
  applyGlassViewer();
  for (const v of views.values()) applyGlassView(v.webContents, v);
}
// 映像のビューの背景(左右・上下の余白)を、ガラステーマのときだけ透明にする
function applyGlassView(wc, view) {
  if (wc.isDestroyed()) return;
  try { if (view) view.setBackgroundColor(glassOn ? '#00000000' : '#000000'); } catch { /* 無視 */ }
  wc.executeJavaScript(`document.documentElement.classList.toggle('nmv-glass', ${glassOn ? 'true' : 'false'})`).catch(() => {});
}
let curTheme = 'system';
// コメビュにも、テーマ(ガラスなど)を伝える。別窓のときは、窓の背景もガラスにする
function applyGlassViewer() {
  if (viewerWin && !viewerWin.isDestroyed()) {
    let ok = false;
    if (glassOn && glassOk) { try { viewerWin.setBackgroundMaterial('acrylic'); viewerWin.setBackgroundColor('#00000000'); ok = true; } catch { /* 無視 */ } }
    if (!ok) { try { if (typeof viewerWin.setBackgroundMaterial === 'function') viewerWin.setBackgroundMaterial('none'); } catch { /* 無視 */ } viewerWin.setBackgroundColor(glassOn ? (GLASS_BG[glassKind] || '#14162a') : bgColor()); }
  }
  if (viewerView) { try { viewerView.setBackgroundColor(glassOn && glassOk ? '#00000000' : (glassOn ? (GLASS_BG[glassKind] || '#14162a') : bgColor())); } catch { /* 無視 */ } }
  pushViewer('vw:theme', curTheme, glassOk);
}
function setTheme(t) {
  if (!THEMES.includes(t)) return;
  curTheme = t === 'glass' ? 'glassb' : t;
  glassOn = /^glass/.test(t); if (glassOn) glassKind = t === 'glass' ? 'glassb' : t;
  nativeTheme.themeSource = glassOn ? (glassKind === 'glassc' ? 'light' : 'dark') : t;
  applyGlass();
}
nativeTheme.on('updated', () => {
  for (const w of [win, viewerWin]) if (w && !w.isDestroyed() && !glassOn) w.setBackgroundColor(bgColor());
  if (viewerView && !glassOn) { try { viewerView.setBackgroundColor(bgColor()); } catch { /* 無視 */ } }
});
ipcMain.on('mv:theme', (_e, t) => setTheme(t));

// メインの窓の位置・大きさは、閉じても次回に引き継ぐ(全画面にしていたときは、その前の大きさ)
const winFile = () => path.join(app.getPath('userData'), 'window-bounds.json');
function loadWinBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(winFile(), 'utf8'));
    if (![b.width, b.height].every(Number.isFinite) || b.width < 720 || b.height < 480) return null;
    const hasPos = [b.x, b.y].every(Number.isFinite) && screen.getAllDisplays().some(d => {
      const a = d.workArea, ox = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x), oy = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
      return ox >= 200 && oy >= 120;
    });
    return hasPos ? { x: b.x, y: b.y, width: b.width, height: b.height, max: !!b.max } : { width: b.width, height: b.height, max: !!b.max };
  } catch { return null; }
}
function saveWinBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.isMaximized() || win.isMinimized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(winFile(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, max: win.isMaximized() }));
  } catch { /* 保存失敗は無視 */ }
}
function createWindow() {
  const st = loadState();
  const wb = loadWinBounds();
  if (st && THEMES.includes(st.theme)) setTheme(st.theme);
  win = new BrowserWindow({
    width: (wb && wb.width) || 1600, height: (wb && wb.height) || 900, minWidth: 720, minHeight: 480,
    ...(wb && Number.isFinite(wb.x) ? { x: wb.x, y: wb.y } : {}),
    backgroundColor: bgColor(),
    icon: path.join(__dirname, 'icon.png'),
    title: 'ニコ生マルチビュー',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  if (wb && wb.max) win.maximize();
  let wbTimer = null;
  const wbLater = () => { clearTimeout(wbTimer); wbTimer = setTimeout(saveWinBounds, 500); };
  win.on('resize', wbLater); win.on('move', wbLater); win.on('close', () => { quitting = true; saveWinBounds(); });
  hookFsKeys(win.webContents);
  win.on('enter-full-screen', () => { if (win) win.webContents.send('mv:fs', true); exitBarSync(); setTimeout(applyGlass, 50); });
  win.on('leave-full-screen', () => { exitBarSync(); if (win) win.webContents.send('mv:fs', false); setTimeout(applyGlass, 50); });
  win.loadFile(path.join(__dirname, 'ui.html'));
  win.webContents.on('did-finish-load', applyGlass);
  if (viewerOpenPref) win.webContents.once('did-finish-load', () => setTimeout(() => { try { if (win && !win.isDestroyed() && !viewerWin && !viewerView) openViewer(); } catch (e) { appLog('コメビュの復元に失敗: ' + (e && e.message || e), 'ERROR'); } }, 600));
  win.on('closed', () => {
    win = null; views.clear();
    if (loginWin && !loginWin.isDestroyed()) loginWin.close();
    if (toastWin && !toastWin.isDestroyed()) toastWin.destroy();
    if (viewerWin && !viewerWin.isDestroyed()) viewerWin.close();
    viewerView = null;
  });
}

// F11で全画面、全画面中はEscで戻る(映像のビューにフォーカスがあっても効くように各ビューにも付ける)
function setFs(on) { if (win && !win.isDestroyed()) win.setFullScreen(typeof on === 'boolean' ? on : !win.isFullScreen()); }
function hookFsKeys(wc) {
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { e.preventDefault(); setFs(); }
    else if (input.key === 'F10') { e.preventDefault(); if (win && !win.isDestroyed()) win.webContents.send('mv:clean', !cleanOn); }
    else if (input.key === 'Escape' && win && win.isFullScreen()) { e.preventDefault(); setFs(false); }
    else if (input.key === 'Escape' && win && !win.isDestroyed()) win.webContents.send('mv:unfocus');
  });
}
// 全画面中、画面の一番上にカーソルが行くと「✕ 全画面を終了」ボタンを出す(映像のビューはマウスを奪うので、カーソル位置を定期的に調べる)
let exitView = null, exitShown = false, exitTimer = null, cleanOn = false;
const EXIT_W = 230, EXIT_H = 44;
const EXIT_HTML = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}button{width:100%;height:100%;box-sizing:border-box;font:700 14px "Yu Gothic UI","Meiryo",sans-serif;color:#fff;background:#1b1f27ee;border:1px solid #ffffff55;border-radius:0 0 10px 10px;border-top:0;cursor:pointer}button:hover{background:#c0392bee}</style><button id="b" type="button">✕ 全画面を終了</button><script>document.getElementById("b").onclick=()=>window.exitFs()</script>';
// 全画面か「枠のみ表示」のどちらかがONのあいだ、一番上にカーソルを持っていくと戻るボタンを出す
const exitWanted = () => !!(win && !win.isDestroyed() && (win.isFullScreen() || cleanOn));
function exitLabel() {
  const fs = win && win.isFullScreen();
  return fs && cleanOn ? '✕ 元の表示に戻す' : fs ? '✕ 全画面を終了' : '✕ 枠のみ表示をやめる';
}
function exitBarStop() {
  if (exitTimer) { clearInterval(exitTimer); exitTimer = null; }
  if (exitView && exitShown && win && !win.isDestroyed()) { try { win.contentView.removeChildView(exitView); } catch {} }
  exitShown = false;
}
function exitBarStart() {
  if (exitTimer) return;
  if (!exitView) {
    exitView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'exit-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    exitView.setBackgroundColor('#00000000');
    exitView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(EXIT_HTML));
  }
  let shownLabel = '';
  exitTimer = setInterval(() => {
    if (!exitWanted()) { exitBarStop(); return; }
    const cb = win.getContentBounds(), p = screen.getCursorScreenPoint();
    const rx = p.x - cb.x, ry = p.y - cb.y;
    const inWin = rx >= 0 && rx < cb.width && ry >= 0;
    const mid = cb.width / 2;
    // 出す範囲: 画面の上端から30pxの、中央付近(左右400px)。出したあとは、ボタンの周りの広め(下に90px・左右に250px)にいる間は出し続ける
    const near = inWin && (exitShown ? (ry <= EXIT_H + 90 && Math.abs(rx - mid) <= EXIT_W / 2 + 250) || ry <= 30 : (ry <= 30 && Math.abs(rx - mid) <= 400));
    if (near && !exitShown) {
      const lb = exitLabel();
      if (lb !== shownLabel) { shownLabel = lb; exitView.webContents.executeJavaScript('document.getElementById("b").textContent=' + JSON.stringify(lb)).catch(() => {}); }
      exitView.setBounds({ x: Math.round(mid - EXIT_W / 2), y: 0, width: EXIT_W, height: EXIT_H });
      win.contentView.addChildView(exitView); exitShown = true;
    } else if (near && exitShown) {
      // 常に最前面(すでに一番手前なら何もしない。毎回付け外しすると点滅する)
      const ch = win.contentView.children; if (ch[ch.length - 1] !== exitView) { win.contentView.removeChildView(exitView); win.contentView.addChildView(exitView); }
    } else if (!near && exitShown) {
      win.contentView.removeChildView(exitView); exitShown = false;
    }
  }, 120);
}
function exitBarSync() { if (exitWanted()) exitBarStart(); else exitBarStop(); }
ipcMain.on('mv:clean-state', (_e, on) => { cleanOn = !!on; exitBarSync(); });
ipcMain.on('mv:exit-all', () => {
  if (win && !win.isDestroyed() && win.isFullScreen()) setFs(false);
  if (cleanOn && win && !win.isDestroyed()) win.webContents.send('mv:clean', false);
});
ipcMain.on('mv:vdbl', e => {
  for (const [id, v] of views) if (v.webContents === e.sender && win) { win.webContents.send('mv:focus', id); break; }
});
ipcMain.on('mv:fullscreen', (_e, on) => setFs(typeof on === 'boolean' ? on : undefined));

function makeView(id) {
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'view-preload.js'),   // プレイヤー上のドラッグ検出
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // 枠が隠れても再生を止めない
    },
  });
  const wc = view.webContents;
  hookFsKeys(wc);
  wc.setUserAgent(fixUA(wc.getUserAgent()));
  // 新しいウィンドウは出さず、外部ブラウザで開く
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  applyGlassView(wc, view);
  wc.on('dom-ready', () => {
    wc.insertCSS(PLAYER_CSS).catch(() => {});
    applyGlassView(wc, view);
    wc.executeJavaScript(PLAYER_JS).then(() => { applyMode(wc); applyVol(id, wc); applyHide(id, wc); applySeek(wc); }).catch(() => {});
    sendInfo(id, wc);
  });
  wc.on('did-start-navigation', (_e, _u, _inPlace, isMain) => { if (isMain) watchReady(id, wc); });
  wc.loadURL(WATCH(id));
  setTimeout(raiseMenu, 0);
  return view;
}

// UI側が計算した各枠の位置に合わせて、ネイティブのビューを同期する
function syncViews(rects, audioId, wantPlayerOnly, vols, hides) {
  if (!win) return;
  // 音声ONの枠(複数可)。旧形式(1つのID)でも受け付ける
  const audioSet = new Set((Array.isArray(audioId) ? audioId : [audioId]).filter(x => typeof x === 'string' && ID_RE.test(x)));
  if (hides && typeof hides === 'object') {
    for (const id of Object.keys(hides)) {
      if (!ID_RE.test(id)) continue;
      const b = hides[id] === true;
      if (!!hideCmt[id] !== b) { hideCmt[id] = b; const vw = views.get(id); if (vw) applyHide(id, vw.webContents); }
    }
  }
  if (vols && typeof vols === 'object') {
    for (const [id, v] of Object.entries(vols)) {
      const n = Number(v);
      if (!ID_RE.test(id) || !Number.isFinite(n)) continue;
      const c = Math.min(1, Math.max(0, n));
      if (volumes[id] !== c) { volumes[id] = c; const vw = views.get(id); if (vw) applyVol(id, vw.webContents); }
    }
  }
  if (typeof wantPlayerOnly === 'boolean' && wantPlayerOnly !== playerOnly) {
    playerOnly = wantPlayerOnly;
    for (const v of views.values()) applyMode(v.webContents);
  }
  const want = new Set(rects.map(r => r.id));
  for (const [id, v] of views) {
    if (!want.has(id)) {
      win.contentView.removeChildView(v);
      v.webContents.close();
      views.delete(id); readyIds.delete(id); closeEmotion(id);
      pushSources();
    }
  }
  for (const r of rects) {
    if (!ID_RE.test(r.id)) continue;
    let v = views.get(r.id);
    if (!v) {
      v = makeView(r.id);
      views.set(r.id, v);
      win.contentView.addChildView(v);
      pushSources();
    }
    v.setBounds({
      x: Math.round(r.x), y: Math.round(r.y),
      width: Math.max(0, Math.round(r.w)), height: Math.max(0, Math.round(r.h)),
    });
    v.webContents.setAudioMuted(!audioSet.has(r.id));
  }
  applyOverlay();
}

// 「プレイヤーだけ表示」の準備ができるまで、映像のビューを隠して「読み込み中…」を見せる
const readyIds = new Set();
function watchReady(id, wc) {
  readyIds.delete(id); applyOverlay();
  const t0 = Date.now();
  const iv = setInterval(async () => {
    if (wc.isDestroyed() || !views.has(id) || views.get(id).webContents !== wc) return clearInterval(iv);
    let ok = false;
    try {
      // 「プレイヤーだけ表示」では、映像が見つかるまで待つ。ただし、番組が見つからないページ・案内が出るページは、待たずに表示する
      ok = await wc.executeJavaScript(playerOnly
        ? "document.documentElement.classList.contains('nmv') || !!document.getElementById('nmv-notice') || (document.readyState === 'complete' && !document.getElementById('embedded-data') && /ご指定のページが見つかりませんでした/.test(document.body ? document.body.textContent : ''))"
        : "document.readyState === 'complete'");
      if (ok) { try { wc.executeJavaScript(CSTATE_JS).catch(() => {}); } catch { /* 無視 */ } }
    } catch { /* 読み込み中 */ }
    if (ok || Date.now() - t0 > 25000) {   // 25秒たっても準備できなければ、そのまま表示する
      clearInterval(iv);
      setTimeout(() => { if (!wc.isDestroyed()) { readyIds.add(id); applyOverlay(); } }, 250);
    }
  }, 300);
}
const reloadAll = () => { for (const [id, v] of views) v.webContents.loadURL(WATCH(id)); };

/* ------------------------------------------------------------------ *
 * ログイン
 *  ID・パスワードはニコニコ公式のログインページに自分で入力する。
 *  このアプリはパスワードを受け取らず、保存もしない。
 *  ログイン後の Cookie は全枠で共有され、次回起動後も保たれる。
 * ------------------------------------------------------------------ */
async function isLoggedIn() {
  const cs = await ses().cookies.get({ name: 'user_session' });
  return cs.some(c => /(^|\.)nicovideo\.jp$/.test(c.domain) && c.value && c.value !== 'deleted');
}
// ログインのしかた(Googleなど)を覚えておき、設定に「(Google)」と表示する
const viaFile = () => path.join(app.getPath('userData'), 'login-via.txt');
let loginVia = '';
try { loginVia = require('fs').readFileSync(viaFile(), 'utf8').trim(); } catch { /* なし */ }
function setVia(s) { loginVia = s || ''; try { require('fs').writeFileSync(viaFile(), loginVia); } catch { /* 無視 */ } }
let lastAuthLog = null;
async function notifyAuth() {
  const v = await isLoggedIn().catch(() => false);
  if (lastAuthLog !== v) { lastAuthLog = v; appLog(v ? 'ログイン状態: ログイン中' + (loginVia ? `(${loginVia})` : '') : 'ログイン状態: 未ログイン'); }
  if (win && !win.isDestroyed()) win.webContents.send('mv:auth', v, v ? loginVia : '');
  return v;
}
let uaHookSet = false;
function setupLoginUA() {
  if (uaHookSet) return; uaHookSet = true;
  // Googleのログインページへの通信だけ、本来の名前を送る(同じ窓の中で Google へ移動する場合のため)
  ses().webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*', 'https://accounts.google.co.jp/*'] }, (details, cb) => {
    const h = Object.assign({}, details.requestHeaders); h['User-Agent'] = ORIG_UA; cb({ requestHeaders: h });
  });
}
function openLogin() {
  setupLoginUA();
  if (loginWin && !loginWin.isDestroyed()) { loginWin.focus(); return; }
  appLog('ログイン窓を開きました');
  loginWin = new BrowserWindow({
    width: 520, height: 780, parent: win || undefined,
    title: 'ニコニコにログイン', autoHideMenuBar: true, backgroundColor: '#ffffff',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const wc = loginWin.webContents;
  // ログインの途中で開く別の窓(Googleなど)は、外のブラウザではなく、この窓の子として開き、同じログイン状態を共有する
  // (参考にしたアプリ nico-live-recorder と同じ動き)。
  // ニコニコのページ(Cloudflare の確認 Turnstile を含む)には、名前に細工をした状態(「Electron」を含まない)で入る。
  // Googleのログインページには、本来の名前で入る(下の onBeforeSendHeaders と、別の窓)。
  wc.setUserAgent(fixUA(ORIG_UA));
  const childPrefs = { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true };
  wc.setWindowOpenHandler(({ url }) => {
    if (!/^https:\/\//.test(url)) return { action: 'deny' };
    appLog('ログイン窓: 別の窓を開きました');
    return { action: 'allow', overrideBrowserWindowOptions: { parent: loginWin, width: 500, height: 680, autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: childPrefs } };
  });
  // 別の窓(Googleなどのログイン)は、本来の名前にする(設定を変えるとその窓は読み込み直される)
  wc.on('did-create-window', child => { try { child.webContents.setUserAgent(ORIG_UA); } catch { /* 無視 */ } });
  loginWin.on('closed', () => { loginWin = null; });
  wc.on('did-fail-load', (_e, code, desc, _u, main) => { if (main) appLog(`ログイン窓: 読み込み失敗 ${code} ${desc}`, 'ERROR'); });
  wc.loadURL(LOGIN_URL).catch(e => appLog('ログイン窓: loadURL ' + (e && e.message || e), 'ERROR'));
}

// 普段のブラウザ(Chrome / Edge)でログインして、そのログイン状態をこのアプリに取り込む。
// Googleなどのログインは、アプリ内の画面だと断られるため。専用のプロフィールで本物のブラウザを開き、
// ログインできたら cookie(nicovideo.jp のぶんだけ)を受け取ってブラウザを閉じる。
const { spawn } = require('child_process');
let browserLoginRun = null;
function findBrowser() {
  const e = process.env, list = [];
  if (process.platform === 'win32') {
    for (const b of [e['PROGRAMFILES'], e['PROGRAMFILES(X86)'], e['LOCALAPPDATA']].filter(Boolean)) {
      list.push(path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else list.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge');
  return list.find(p => { try { return require('fs').existsSync(p); } catch { return false; } }) || '';
}
function cdpCall(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout')); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params: params || {} }));
    ws.onmessage = ev => { try { const j = JSON.parse(ev.data); if (j.id === 1) { clearTimeout(t); try { ws.close(); } catch {} j.error ? reject(new Error(j.error.message)) : resolve(j.result); } } catch {} };
    ws.onerror = () => { clearTimeout(t); reject(new Error('ws')); };
  });
}
async function browserCookies(port) {
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const r = await cdpCall(info.webSocketDebuggerUrl, 'Storage.getCookies');
  return { cookies: (r.cookies || []).filter(c => /(^|\.)nicovideo\.jp$/.test(c.domain.replace(/^\./, ''))), ws: info.webSocketDebuggerUrl };
}
async function browserLogin() {
  if (browserLoginRun) { return { ok: false, error: 'ブラウザでのログインを待っています(開いているブラウザの窓で、ログインしてください)' }; }
  const exe = findBrowser();
  if (!exe) return { ok: false, error: 'Chrome か Edge が見つかりませんでした' };
  const port = 9300 + Math.floor(Math.random() * 600);
  const dir = path.join(app.getPath('userData'), 'browser-login');
  const child = spawn(exe, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', LOGIN_URL], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  browserLoginRun = true;
  const until = Date.now() + 10 * 60 * 1000;
  let done = false, wsUrl = '', viaGoogle = false;
  while (Date.now() < until && !done) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const got = await browserCookies(port);
      wsUrl = got.ws;
      try { const tg = await cdpCall(got.ws, 'Target.getTargets'); if ((tg.targetInfos || []).some(t => /^https:\/\/accounts\.google\.com\//.test(t.url || ''))) viaGoogle = true; } catch { /* 無視 */ }
      const us = got.cookies.find(c => c.name === 'user_session' && c.value && c.value !== 'deleted' && c.value.length > 20);
      if (us) {
        for (const c of got.cookies.filter(c => c.name === 'user_session' || c.name === 'user_session_secure')) {
          if (!c.value || c.value === 'deleted') continue;
          await ses().cookies.set({ url: 'https://www.nicovideo.jp/', domain: c.domain, path: c.path || '/', name: c.name, value: c.value, secure: true, httpOnly: true, expirationDate: c.expires > 0 ? c.expires : Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 });
        }
        await ses().cookies.flushStore();
        done = true;
      }
    } catch (e) {
      if (wsUrl) break;   // 一度つながったあとに切れた = ブラウザが閉じられた
    }
  }
  if (wsUrl) cdpCall(wsUrl, 'Browser.close').catch(() => {});
  browserLoginRun = null;
  if (done) { setVia(viaGoogle ? 'Google' : ''); reloadAll(); notifyAuth(); return { ok: true }; }
  return { ok: false, error: 'ログインを確認できませんでした' };
}
ipcMain.on('mv:browser-login', async () => {
  appLog('ブラウザでのログインを開始');
  const r = await browserLogin();
  appLog('ブラウザでのログイン: ' + (r && r.ok ? '完了' : '完了せず'), r && r.ok ? 'INFO' : 'WARN');
  if (win && !win.isDestroyed()) win.webContents.send('mv:browser-login-result', r);
});
async function logout() {
  setVia('');
  await ses().clearStorageData({ storages: ['cookies'] });
  reloadAll();
  notifyAuth();
}

/* ------------------------------------------------------------------ *
 * コメント投稿
 *  各枠の視聴ページにあるコメント欄へ入力して送信ボタンを押す(通常の投稿と同じ)。
 *  投稿できたかは、ページ側が入力欄を空にしたかどうかで判定する。
 * ------------------------------------------------------------------ */
function commentScript(text, use184) {
  return `(async () => {
    const T = ${JSON.stringify(text)}, ANON = ${use184 ? 'true' : 'false'};
    window.__nmvAnon = ANON;   // 投稿メッセージの isAnonymous に使う(view-preload.js)
    const form = document.querySelector('form[class*="___comment-post-form___"]');
    if (!form) return { ok: false, error: 'コメント欄が見つかりません(放送が終了している、読み込み中など)' };
    const box = form.querySelector('input[class*="___comment-text-box___"]');
    const btn = form.querySelector('button[type="submit"]');
    if (!box || !btn) return { ok: false, error: 'コメント欄の形式が想定と違います(サイト側の変更の可能性)' };
    const msg = form.querySelector('[class*="___disabled-message___"]');
    if (box.disabled || (msg && getComputedStyle(msg).display !== 'none')) {
      return { ok: false, error: 'この枠ではコメントできません(未ログイン、投稿不可の枠など)' };
    }
    // 184かどうかは、view-preload.js が投稿メッセージで指定する
    const setVal = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const cmd = form.querySelector('input[class*="___command-text-box___"]');
    if (cmd) {
      // 184のON/OFFをアプリの指定に合わせる(ページ側に残っていた184も外す)
      const parts = cmd.value.split(/\\s+/).filter(x => x && x !== '184');
      if (ANON) parts.push('184');
      const nv = parts.join(' ');
      if (nv !== cmd.value) setVal(cmd, nv);
    }
    setVal(box, T);
    await new Promise(r => setTimeout(r, 80));
    if (btn.disabled) { setVal(box, ''); return { ok: false, error: '送信できません(文字数オーバーなど)' }; }
    btn.click();
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 150));
      if (box.value === '') return { ok: true };
    }
    setVal(box, '');
    return { ok: false, error: '送信できなかった可能性があります' };
  })()`;
}

ipcMain.handle('mv:comment', async (_e, id, text, use184) => {
  const v = views.get(id);
  if (!ID_RE.test(String(id)) || !v) return { ok: false, error: '枠が見つかりません' };
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: '空のコメントは送れません' };
  if (!(await isLoggedIn())) return { ok: false, error: '先にログインしてください' };
  try {
    let r = await v.webContents.executeJavaScript(commentScript(t, !!use184));
    appLog(`${id}: コメント投稿 ${r && r.ok ? '成功' + (use184 ? '(184)' : '') : '失敗: ' + ((r && r.error) || '不明')}`, r && r.ok ? 'INFO' : 'ERROR');
    return r;
  }
  catch { appLog(`${id}: コメント投稿 失敗(送信エラー)`, 'ERROR'); return { ok: false, error: 'コメントの送信に失敗しました' }; }
});


/* ------------------------------------------------------------------ *
 * 枠のドラッグ並べ替え
 *  映像(ネイティブのビュー)はHTMLの上に重なっていて、HTML標準のドラッグ操作が使えない。
 *  そこで、ドラッグ中はマウスの位置をここで読み取ってUIへ送り、UIが「どの枠の上か」を判定する。
 *  ドラッグ中は、つかんだ枠以外の映像を一時的に隠して、UI側の大きなドロップ先を見せる。
 * ------------------------------------------------------------------ */
let drag = null;
function cursorInUi() {
  const p = screen.getCursorScreenPoint(), b = win.getContentBounds();
  return { x: p.x - b.x, y: p.y - b.y };
}
function startDrag(id, fromView) {
  if (drag || !win || win.isDestroyed() || !ID_RE.test(String(id))) return;
  drag = { id, timer: null, guard: null };
  for (const [vid, v] of views) v.setVisible(fromView && vid === id);
  win.webContents.send('mv:drag', { type: 'start', id });
  drag.timer = setInterval(() => {
    if (!win || win.isDestroyed()) return endDrag();
    win.webContents.send('mv:drag', { type: 'pos', ...cursorInUi() });
  }, 30);
  drag.guard = setTimeout(endDrag, 30000);  // マウスを離した通知が届かなかった場合の保険
}
function endDrag() {
  if (!drag) return;
  clearInterval(drag.timer); clearTimeout(drag.guard);
  drag = null;
  applyOverlay();
  if (win && !win.isDestroyed()) win.webContents.send('mv:drag', { type: 'end', ...cursorInUi() });
}
ipcMain.on('mv:drag-start', (_e, id) => startDrag(id, false));
ipcMain.on('mv:drag-end', () => endDrag());
ipcMain.on('mv:vdrag', (e, phase) => {
  const hit = [...views].find(([, v]) => v.webContents === e.sender);
  if (!hit) return;
  if (phase === 'start') startDrag(hit[0], true); else endDrag();
});


/* ------------------------------------------------------------------ *
 * コメビュ(別窓)
 *  各枠のコメントを1つの窓に時系列でまとめて表示する。
 *  コメントは各枠のページから読み取ったもの(view-preload.js)を、ここで集めて転送する。
 * ------------------------------------------------------------------ */
const commentBuf = [];
const MAX_BUF = 3000;
const sourcesList = () => [...views.keys()].map(id => ({ id, name: (infos.get(id) && infos.get(id).name) || id }));
const viewerWC = () => (viewerView && !viewerView.webContents.isDestroyed() ? viewerView.webContents : viewerWin && !viewerWin.isDestroyed() ? viewerWin.webContents : null);
const pushViewer = (ch, payload) => { const wc = viewerWC(); if (wc) wc.send(ch, payload); };
function pushSources() { pushViewer('vw:sources', sourcesList()); }
// コメビュの位置・大きさは、閉じても次回に引き継ぐ
const viewerFile = () => path.join(app.getPath('userData'), 'viewer-bounds.json');
function loadViewerBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(viewerFile(), 'utf8'));
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width < 300 || b.height < 300) return null;
    // 画面の外に出てしまわないよう、いま接続されている画面のどれかに十分かかっているときだけ位置を使う
    const ok = screen.getAllDisplays().some(d => {
      const a = d.workArea, ox = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x), oy = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
      return ox >= 120 && oy >= 80;
    });
    return ok ? { x: b.x, y: b.y, width: b.width, height: b.height, max: !!b.max } : { width: b.width, height: b.height, max: !!b.max };
  } catch { return null; }
}
let vbTimer = 0;
function saveViewerBounds() {
  if (!viewerWin || viewerWin.isDestroyed()) return;
  try {
    const b = viewerWin.isMaximized() || viewerWin.isMinimized() ? viewerWin.getNormalBounds() : viewerWin.getBounds();
    fs.writeFileSync(viewerFile(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, max: viewerWin.isMaximized() }));
  } catch { /* 保存失敗は無視 */ }
}
// 合体の設定(次回も同じ形で開く)
const dockFile = () => path.join(app.getPath('userData'), 'dock.json');
try { const d = JSON.parse(fs.readFileSync(dockFile(), 'utf8')); dockedPref = !!d.docked; viewerOpenPref = !!d.open; if (d.width >= 280 && d.width <= 1400) dockW = Math.round(d.width); } catch { /* なし */ }
function saveDock() { try { fs.writeFileSync(dockFile(), JSON.stringify({ docked: dockedPref, width: dockW, open: viewerOpenPref })); } catch { /* 無視 */ } }
const sendDockState = on => { if (win && !win.isDestroyed()) win.webContents.send('mv:dock', !!on, dockW); };
// 窓をドラッグして合体できる位置に来たとき、メインの窓の右側に「ここで離すと結合します」と重ねて見せる
let snapView = null, snapShown = false, snapSeq = 0;
const SNAP_HTML = 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none}div{box-sizing:border-box;height:100%;display:flex;align-items:center;justify-content:center;text-align:center;font:700 20px "Yu Gothic UI","Meiryo",sans-serif;color:#fff;background:rgba(26,115,232,.55);border:3px dashed #fff;line-height:1.8;padding:20px;text-shadow:0 1px 4px rgba(0,0,0,.5)}</style><div>ここで離すと<br>コメビュを<br>メインの窓に結合します</div>');
function snapPreview(on) {
  if (!win || win.isDestroyed()) return;
  const seq = ++snapSeq;
  if (!on) {
    if (snapView && snapShown) { try { win.contentView.removeChildView(snapView); } catch { /* 無視 */ } snapShown = false; }
    return;
  }
  if (snapShown) return;
  win.webContents.executeJavaScript("(() => { const r = document.getElementById('wrap').getBoundingClientRect(); return [r.top, r.bottom]; })()").then(tb => {
    if (seq !== snapSeq || !win || win.isDestroyed()) return;   // 表示をやめる指示が、あとから来ていた
    if (!snapView) {
      snapView = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      try { snapView.setBackgroundColor('#00000000'); } catch { /* 無視 */ }
      snapView.webContents.loadURL(SNAP_HTML);
    }
    const [w] = win.getContentSize(), top = Math.round(tb[0]), h = Math.max(0, Math.round(tb[1] - tb[0]));
    const width = Math.min(dockW, Math.round(w * 0.6));
    snapView.setBounds({ x: w - width, y: top, width, height: h });
    win.contentView.addChildView(snapView); snapShown = true;
  }).catch(() => {});
}
// 窓が、メインの窓の右端に合体できる距離にあるか
function nearDockEdge() {
  if (!viewerWin || viewerWin.isDestroyed() || !win || win.isDestroyed() || win.isMinimized() || win.isFullScreen() || viewerWin.isMaximized() || Date.now() < snapOff) return false;
  // 合体できる範囲: メインの窓の「右側」(ここに合体したときに入る幅)の中。ここにマウスを持っていって離すと合体する(窓の外側では合体しない)
  const b = win.getContentBounds(), p = screen.getCursorScreenPoint();
  const zone = Math.min(dockW, Math.round(b.width * 0.6));
  return p.x >= b.x + b.width - zone && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
}
// コメビュを、メインの窓の右側に合体させる
function dockViewer() {
  snapPreview(false);
  if (!win || win.isDestroyed()) return;
  if (viewerWin && !viewerWin.isDestroyed()) {
    // 窓の移動中や、その窓からの操作の最中に、同じ窓をその場で壊すと落ちるため、いったん隠して、少しあとに閉じる
    saveViewerBounds(); const w = viewerWin; viewerWin = null;
    try { w.hide(); } catch { /* 無視 */ }
    setTimeout(() => { try { if (!w.isDestroyed()) w.destroy(); } catch { /* 無視 */ } }, 300);
  }
  if (!viewerView) {
    viewerView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'viewer-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    try { viewerView.setBackgroundColor(glassOn && glassOk ? '#00000000' : (glassOn ? (GLASS_BG[glassKind] || '#14162a') : bgColor())); } catch { /* 無視 */ }
    const wc = viewerView.webContents;
    wc.on('did-finish-load', () => { if (!wc.isDestroyed()) wc.send('vw:docked', true); });
    wc.loadFile(path.join(__dirname, 'viewer.html'));
    viewerView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    win.contentView.addChildView(viewerView);
  }
  dockedPref = true; viewerOpenPref = true; saveDock(); sendDockState(true);
  appLog('コメビュをメインの窓に合体しました');
}
// 合体を解く(keepPref: 次回も合体で開く設定は残す = 「閉じる」)
function closeDock(keepPref) {
  if (viewerView) {
    try { if (win && !win.isDestroyed()) win.contentView.removeChildView(viewerView); } catch { /* 無視 */ }
    try { viewerView.webContents.close(); } catch { /* 無視 */ }
    viewerView = null;
  }
  if (!keepPref) { dockedPref = false; saveDock(); }
  if (keepPref && !quitting) { viewerOpenPref = false; saveDock(); }   // 「閉じる」
  sendDockState(false);
}
function undockViewer() {
  closeDock(false);
  snapOff = Date.now() + 2500;   // 切り離した直後に、また吸い付かないようにする
  openViewer();
  if (viewerWin && !viewerWin.isDestroyed() && win && !win.isDestroyed()) {
    const b = win.getBounds(), v = viewerWin.getBounds();
    viewerWin.setBounds({ x: Math.min(b.x + b.width + 90, Math.max(b.x, screen.getDisplayMatching(b).workArea.x + screen.getDisplayMatching(b).workArea.width - v.width)), y: b.y, width: Math.max(v.width, 420), height: Math.min(Math.max(v.height, 600), b.height) });
  }
}
function openViewer() {
  if (viewerView) { closeDock(true); return; }   // 合体中にもう一度押すと、閉じる
  if (viewerWin && !viewerWin.isDestroyed()) { viewerWin.show(); viewerWin.focus(); return; }
  if (dockedPref && win && !win.isDestroyed()) { dockViewer(); return; }
  const vb = loadViewerBounds();
  viewerOpenPref = true; saveDock();
  viewerWin = new BrowserWindow({
    width: (vb && vb.width) || 480, height: (vb && vb.height) || 760, minWidth: 300, minHeight: 300,
    ...(vb && Number.isFinite(vb.x) ? { x: vb.x, y: vb.y } : {}),
    title: 'コメビュ', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true, backgroundColor: bgColor(),
    webPreferences: { preload: path.join(__dirname, 'viewer-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  viewerWin.setMenuBarVisibility(false);
  viewerWin.loadFile(path.join(__dirname, 'viewer.html'));
  applyGlassViewer();
  if (vb && vb.max) viewerWin.maximize();
  const later = () => { clearTimeout(vbTimer); vbTimer = setTimeout(saveViewerBounds, 400); };
  viewerWin.on('resize', later); viewerWin.on('move', later);
  // メインの窓の右端に近づけて離すと、吸い付いて合体する
  viewerWin.on('move', () => snapPreview(nearDockEdge()));   // 近づけている間は、結合の案内を出す
  viewerWin.on('moved', () => {
    snapPreview(false);
    if (nearDockEdge()) { snapOff = Date.now() + 1500; setTimeout(() => { try { dockViewer(); } catch (e) { appLog('合体に失敗: ' + (e && e.message || e), 'ERROR'); } }, 120); }
  });
  viewerWin.on('close', saveViewerBounds);   // 閉じる直前の大きさを保存
  viewerWin.on('closed', () => { const was = viewerWin; viewerWin = null; snapPreview(false); if (!quitting && was !== null) { viewerOpenPref = false; saveDock(); } });
}
// ログの窓
function openLogWin() {
  if (logWin && !logWin.isDestroyed()) { logWin.setAlwaysOnTop(true, 'screen-saver'); logWin.show(); logWin.focus(); return; }
  logWin = new BrowserWindow({
    width: 640, height: 480, minWidth: 360, minHeight: 240, title: 'ログ', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true, backgroundColor: bgColor(),
    webPreferences: { preload: path.join(__dirname, 'log-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  logWin.setMenuBarVisibility(false);
  logWin.setAlwaysOnTop(true, 'screen-saver');   // 「最前面」の窓より手前に出す
  logWin.loadFile(path.join(__dirname, 'log.html'));
  logWin.on('closed', () => { logWin = null; });
}
ipcMain.on('mv:log-open', () => openLogWin());
// バージョン情報(Electron などのバージョン)を表示する。「コピー」で、そのまま貼り付けられる
ipcMain.on('mv:about', async () => {
  const pv = process.versions;
  const text = [
    `ニコ生マルチビュー v${app.getVersion()}`,
    `Electron ${pv.electron}`,
    `Chromium ${pv.chrome}`,
    `Node.js ${pv.node}`,
    `V8 ${pv.v8}`,
    `OS ${process.platform} ${process.arch} (${require('os').release()})`,
  ].join('\n');
  const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: 'info', title: 'バージョン情報', message: 'ニコ生マルチビュー', detail: text, buttons: ['閉じる', 'コピー'], defaultId: 0, cancelId: 0, noLink: true });
  if (r.response === 1) { try { await clipboard.writeText(text); } catch { /* 無視 */ } }
});
ipcMain.handle('lg:init', () => logBuf);
ipcMain.on('lg:clear', () => { logBuf.length = 0; });
ipcMain.on('lg:copy', (_e, text) => { if (typeof text === 'string') clipboard.writeText(text.slice(0, 200000)); });
// 枠にドラッグされたリンクから、放送(lv番号)を追加する
ipcMain.on('mv:drop', (e, text) => {
  if (![...views.values()].some(v => v.webContents === e.sender)) return;
  if (typeof text !== 'string' || !/lv\d+/i.test(text)) return;
  if (win && !win.isDestroyed()) win.webContents.send('mv:add', text.slice(0, 5000));
});
// 枠のプレイヤーの操作ボタン(10秒戻し / ライブへ戻る)を押す
const PLAYER_BTN = { back: '___back-button___', fwd: '___forward-button___', live: '___live-button___', head: '___head-button___' };
ipcMain.on('mv:player', (_e, id, act) => {
  const v = views.get(id), cls = PLAYER_BTN[act];
  if (!v || !cls || v.webContents.isDestroyed()) return;
  v.webContents.executeJavaScript(`(() => { const b = document.querySelector('[class*="${cls}"]'); if (b && !b.disabled) b.click(); return !!b; })()`).catch(() => {});
});
// 各枠が「コメントできる状態か」を調べて、UIの投稿欄に反映する(タイムシフト=放送終了後の視聴では、投稿できない)
const CSTATE_JS = `(() => {
  let ended = false;
  try {
    const el = document.getElementById('embedded-data');
    const p = el && JSON.parse(el.getAttribute('data-props') || '{}');
    const st = p && p.program && p.program.status;
    ended = !!st && st !== 'ON_AIR';
  } catch (e) { /* 無視 */ }
  const form = document.querySelector('form[class*="___comment-post-form___"]');
  const box = form && form.querySelector('input[class*="___comment-text-box___"]');
  const msg = form && form.querySelector('[class*="___disabled-message___"]');
  const msgOn = !!(msg && getComputedStyle(msg).display !== 'none' && msg.textContent.trim());
  // 一般会員は、事前の予約がないとタイムシフトを見られない(ページに案内が出る)
  let premium = false;
  let priv = false;   // 配信者がタイムシフトを公開していない番組
  if (ended) {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue || '';
      if (/プレミアム登録が必要/.test(t)) { premium = true; break; }
      if (/タイムシフト非公開/.test(t)) { priv = true; break; }
    }
  }
  // 「ご指定のページが見つかりませんでした」(削除された・存在しない番組)
  let nf = false;
  if (!ended) { try { nf = !document.getElementById('embedded-data') && /ご指定のページが見つかりませんでした/.test(document.body ? document.body.textContent : ''); } catch (e) { /* 無視 */ } }
  // 一般会員で見られないときは、映像の真ん中に案内を重ねる(見られる状態になったら消す)
  let box2 = document.getElementById('nmv-notice');
  const kind = nf ? 'x' : (ended && premium ? 'p' : (ended && priv ? 'n' : ''));
  if (kind) {
    if (!box2) {
      box2 = document.createElement('div'); box2.id = 'nmv-notice';
      box2.setAttribute('style', 'position:fixed!important;left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;z-index:2147483647!important;max-width:82%!important;padding:22px 36px!important;border-radius:12px!important;background:rgba(0,0,0,.82)!important;color:#fff!important;font:700 26px/1.7 "Yu Gothic UI","Meiryo",sans-serif!important;text-align:center!important;pointer-events:none!important;visibility:visible!important;box-shadow:0 4px 24px rgba(0,0,0,.5)!important');
    }
    if (box2.dataset.k !== kind) {
      box2.dataset.k = kind;
      box2.innerHTML = kind === 'x' ? '番組が見つかりません<br><span style="visibility:visible!important;font-weight:400;font-size:17px;opacity:.85">(削除された、または視聴できない番組です)</span>' : kind === 'p' ? 'タイムシフトの視聴には<br>プレミアム会員が必要です<br><span style="visibility:visible!important;font-weight:400;font-size:17px;opacity:.85">(事前のタイムシフト予約をしていれば、一般会員でも見られます)</span>' : 'タイムシフト非公開の番組です<br><span style="visibility:visible!important;font-weight:400;font-size:17px;opacity:.85">(配信者が公開していないため、視聴できません)</span>';
      document.body.appendChild(box2);
    }
  } else if (box2) box2.remove();
  document.documentElement.classList.toggle('nmv-nf', kind === 'x');
  return { ended, premium, priv, nf, off: nf || ended || !!(box && box.disabled) || msgOn, msg: msgOn ? msg.textContent.trim().slice(0, 60) : '' };
})()`;
const noticed = new Set();   // 一般会員の通知を出した枠
const cstates = new Map();
setInterval(() => {
  if (!win || win.isDestroyed()) return;
  for (const [id, v] of views) {
    if (v.webContents.isDestroyed()) continue;
    v.webContents.executeJavaScript(CSTATE_JS).then(s => {
      if (!s || win.isDestroyed()) return;
      const why = s.nf ? '番組が見つからないため、コメントできません' : s.ended ? 'タイムシフトではコメントできません' : (s.msg || (s.off ? 'この枠ではコメントできません' : ''));
      if (s.ended && s.premium && !noticed.has(id)) {
        noticed.add(id);
        const msg = 'タイムシフトの視聴には、プレミアム会員(または、事前のタイムシフト予約)が必要です';
        appLog(`${id}: ${msg}`, 'WARN');
      }
      if (s.nf && !noticed.has(id)) { noticed.add(id); appLog(`${id}: 番組が見つかりません(削除された、または視聴できない番組です)`, 'WARN'); }
      if (s.ended && s.priv && !noticed.has(id)) { noticed.add(id); appLog(`${id}: タイムシフト非公開の番組です`, 'WARN'); }
      const key = s.off ? why : '';
      if (cstates.get(id) === key) return;
      cstates.set(id, key);
      win.webContents.send('mv:cstate', id, key);
    }).catch(() => {});
  }
  for (const id of [...cstates.keys()]) if (!views.has(id)) { cstates.delete(id); noticed.delete(id); }
}, 2000);
ipcMain.on('mv:open-viewer', () => openViewer());
ipcMain.on('vw:dock', () => setTimeout(() => { try { dockViewer(); } catch (e) { appLog('合体に失敗: ' + (e && e.message || e), 'ERROR'); } }, 30));
ipcMain.on('vw:undock', () => setTimeout(() => { try { undockViewer(); } catch (e) { appLog('切り離しに失敗: ' + (e && e.message || e), 'ERROR'); } }, 30));
ipcMain.on('mv:dock-rect', (_e, r) => {
  if (!viewerView) return;
  if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) { try { viewerView.setVisible(false); } catch { /* 無視 */ } return; }
  try { viewerView.setVisible(true); viewerView.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) }); } catch { /* 無視 */ }
});
ipcMain.on('mv:dock-width', (_e, w) => { if (Number.isFinite(w) && w >= 280 && w <= 1400) { dockW = Math.round(w); saveDock(); } });
let viewerOpt = { hideSrc: false, simple: false };   // コメビュの表示設定(設定画面から届く)
ipcMain.handle('vw:init', () => ({ backlog: commentBuf, sources: sourcesList(), modes: Object.fromEntries(liveMode), opt: viewerOpt, theme: curTheme, acrylic: glassOk }));
// 窓の中身の大きさを dx, dy だけ変える(画面の作業領域に収まる範囲で)。映像を1280x720に合わせるのに使う
ipcMain.handle('mv:resize-by', (_e, dx, dy) => {
  if (!win || win.isDestroyed()) return { ok: false, why: 'nowin' };
  if (win.isFullScreen()) return { ok: false, why: 'fullscreen' };
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { ok: false, why: 'arg' };
  if (win.isMaximized()) win.unmaximize();
  const [cw, ch] = win.getContentSize();
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const fb = win.getBounds(), cb = win.getContentBounds();
  const maxW = wa.width - (fb.width - cb.width), maxH = wa.height - (fb.height - cb.height);
  const nw = Math.round(Math.min(maxW, Math.max(720, cw + dx))), nh = Math.round(Math.min(maxH, Math.max(480, ch + dy)));
  win.setContentSize(nw, nh);
  // 画面からはみ出さないよう、位置も調整する
  const b = win.getBounds();
  win.setPosition(Math.max(wa.x, Math.min(b.x, wa.x + wa.width - b.width)), Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height)));
  return { ok: true, clamped: nw !== Math.round(cw + dx) || nh !== Math.round(ch + dy) };
});
ipcMain.on('mv:always-top', (_e, v) => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!v); });
ipcMain.on('mv:viewer-opt', (_e, o) => { viewerOpt = { hideSrc: !!(o && o.hideSrc), simple: !!(o && o.simple) }; pushViewer('vw:opt', viewerOpt); });
ipcMain.on('vw:copy', (_e, t) => { if (typeof t === 'string') clipboard.writeText(t.slice(0, 5000)); });
ipcMain.on('vw:clear', () => { commentBuf.length = 0; });
ipcMain.on('vw:ontop', (_e, v) => { if (viewerWin && !viewerWin.isDestroyed()) viewerWin.setAlwaysOnTop(!!v); });
// コメントは、サイト(nico-ran.stream)のコメントビューアと同じ流し込み(SSE)から受け取る。
// 画面の一覧を読み取る方式は、画面の作りが変わると止まるので使わない(view-preload.js の読み取りは送らない扱い)。
ipcMain.on('mv:comments', () => {});
const LIVE_API = 'https://nico-ran.stream/api/comments-live';
const liveReaders = new Map();   // lv番号 -> { ctl, maxN, fails }
function addLiveItems(id, list) {
  const now = Date.now();
  const items = list.filter(c => c && typeof c.x === 'string' && c.x)
    .map(c => ({ t: (Number(c.at) > 1e9 ? Number(c.at) * 1000 : now), id, no: Number(c.n) || 0, text: c.x.slice(0, 1000), nm: c.nm || '', u: typeof c.u === 'string' ? c.u.slice(0, 80) : '' }));
  if (!items.length) return;
  commentBuf.push(...items);
  if (commentBuf.length > MAX_BUF) commentBuf.splice(0, commentBuf.length - MAX_BUF);
  pushViewer('vw:comments', items);
}
// ---- 取得のしかた: まず直接(ニコ生につなぐ)。 つながらなければ、サイト(nico-ran.stream)経由に切り替える ----
const liveMode = new Map();   // lv番号 -> 'direct' | 'site'
function setLiveMode(id, mode) {
  if (liveMode.get(id) === mode) return;
  appLog(`${id}: コメントの受け取り ${mode === 'direct' ? '開始(直接)' : '切り替え(サイト経由)'}`);
  liveMode.set(id, mode);
  pushViewer('vw:mode', Object.fromEntries(liveMode));
}
const direct = require('./live-direct.js').make({ fetch: (u, o) => net.fetch(u, o), WebSocket, ua: app.userAgentFallback });
const sleepAbort = (ms, sig) => new Promise(res => { const t = setTimeout(res, ms); sig.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });

// サイト経由(SSE)。 約5分たったら戻って、直接をもう一度試す
async function siteSession(id, st) {
  const until = Date.now() + 5 * 60 * 1000;
  while (!st.ctl.signal.aborted && !st.gone && Date.now() < until) {
    let wait = 300;
    try {
      const res = await net.fetch(`${LIVE_API}?lv=${encodeURIComponent(id)}&after=${st.maxN}`, { signal: st.ctl.signal });
      if (!res.ok || !res.body) throw new Error('http ' + res.status);
      const rd = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const r = await rd.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, k); buf = buf.slice(k + 2);
          const ev = (/^event: (.+)$/m.exec(block) || [])[1], data = (/^data: (.*)$/m.exec(block) || [])[1];
          if (!ev || data === undefined) continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          if (ev === 'c' && Array.isArray(j)) { st.fails = 0; emitChats(id, st, j); }
          else if (ev === 'bye') { if (j && j.after > st.maxN) st.maxN = j.after; }
          else if (ev === 'gone') { st.gone = true; }
          else if (ev === 'srverr') { st.fails++; wait = Math.min(8000, 1500 * st.fails); }
        }
      }
    } catch (e) {
      if (st.ctl.signal.aborted) return;
      st.fails++; wait = Math.min(8000, 1500 * st.fails);
    }
    await sleepAbort(wait, st.ctl.signal);
  }
}
// 直接・サイト経由のどちらから来たコメントも、番号で重複を除いて送る
function emitChats(id, st, list) {
  if (!st.seen) st.seen = new Set();
  const fresh = [];
  for (const c of list) {
    if (!c || typeof c.x !== 'string') continue;
    if (c.n) { if (st.seen.has(c.n)) continue; st.seen.add(c.n); if (c.n > st.maxN) st.maxN = c.n; }
    fresh.push(c);
  }
  if (st.seen.size > 3000) { const keep = [...st.seen].slice(-1500); st.seen.clear(); keep.forEach(n => st.seen.add(n)); }
  addLiveItems(id, fresh.sort((a, b) => (a.n || 0) - (b.n || 0)));
}
async function liveLoop(id, st) {
  let directFails = 0;
  while (!st.ctl.signal.aborted && !st.gone) {
    if (st.mode === 'direct') {
      const rc = new AbortController();
      st.ctl.signal.addEventListener('abort', () => rc.abort(), { once: true });
      let gotSeg = false;
      // 15秒たっても、コメントの流れにつながれなければ、いったん諦める
      const guard = setTimeout(() => { if (!gotSeg) rc.abort(); }, 15000);
      setLiveMode(id, 'direct');
      try {
        await direct.run(id, rc.signal, { onSegment: () => { gotSeg = true; }, onChats: list => emitChats(id, st, list) });
      } catch (e) { if (e && e.gone) st.gone = true; }
      clearTimeout(guard); rc.abort();
      if (st.ctl.signal.aborted || st.gone) break;
      if (gotSeg) { directFails = 0; await sleepAbort(2000, st.ctl.signal); continue; }
      if (++directFails >= 2) { appLog(`${id}: 直接つながらないため、サイト経由に切り替えます`, 'WARN'); st.mode = 'site'; directFails = 0; continue; }
      await sleepAbort(2000, st.ctl.signal);
    } else {
      setLiveMode(id, 'site');
      await siteSession(id, st);
      if (!st.gone && !st.ctl.signal.aborted) st.mode = 'direct';
    }
  }
  if (st.gone) appLog(`${id}: 放送が終了しました`);
  liveMode.delete(id);
  appLog(`${id}: コメントの受け取りを終了`);
}
// コメビュの窓が開いている間だけ、いま開いている各枠のコメントを受け取る
function syncLive() {
  const want = new Set(viewerWC() ? views.keys() : []);
  for (const [id, st] of liveReaders) if (!want.has(id) || st.gone) { st.ctl.abort(); liveReaders.delete(id); }
  for (const id of want) {
    if (liveReaders.has(id) || !/^lv\d+$/.test(id)) continue;
    const st = { ctl: new AbortController(), maxN: 0, fails: 0, gone: false, mode: 'direct' };
    liveReaders.set(id, st);
    appLog(`${id}: コメントの受け取りを準備`);
    liveLoop(id, st);
  }
}
setInterval(syncLive, 2000);


/* ------------------------------------------------------------------ *
 * 放送者名での検索(候補表示)
 *  ニコ生の検索(放送中のみ)に問い合わせて、放送者名・番組名・視聴者数を返す。
 *  入力した文字列は、ニコニコの検索以外には送られない。
 * ------------------------------------------------------------------ */
ipcMain.handle('mv:search', async (_e, q) => {
  const kw = String(q || '').trim().slice(0, 50);
  if (!kw) return { ok: true, items: [] };
  // 比較用に正規化(全角半角・大小文字・空白をそろえる)
  const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const nk = norm(kw);
  if (!nk) return { ok: true, items: [] };
  const getJ = async (url, headers) => {
    const res = await net.fetch(url, { headers: Object.assign({ Accept: 'application/json' }, headers || {}), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  };
  const imgUrl = u => (typeof u === 'string' && /^https:\/\//.test(u) ? u : '');
  try {
    // ① 放送者名で探す: ユーザー検索(ニコニコ全体)で名前の候補を出し、いま放送中の番組があるかを放送履歴で調べる
    const byUser = (async () => {
      const j = await getJ('https://nvapi.nicovideo.jp/v1/search/user?' + new URLSearchParams({ keyword: kw, pageSize: '20', page: '1' }).toString(),
        { 'X-Frontend-Id': '6', 'X-Frontend-Version': '0', 'X-Niconico-Language': 'ja-jp' });
      const users = ((j && j.data && j.data.items) || []).filter(u => u && Number.isFinite(Number(u.id))).slice(0, 20);
      const lists = await Promise.all(users.map(async u => {
        try {
          const h = await getJ(`https://live.nicovideo.jp/front/api/v2/user-broadcast-history?providerId=${u.id}&providerType=user&isIncludeNonPublic=false&offset=0&limit=5`);
          const out = [];
          for (const it of ((h && h.data && h.data.programsList) || [])) {
            const id = it && it.id && typeof it.id === 'object' ? it.id.value : it && it.id;
            const pr = it && it.program || {};
            if (typeof id !== 'string' || !ID_RE.test(id) || !(pr.schedule && pr.schedule.status === 'ON_AIR')) continue;
            const th = it.thumbnail || {};
            out.push({
              id, name: String((pr.provider && pr.provider.name) || u.nickname || ''), title: String(pr.title || ''),
              watch: Number(it.statistics && it.statistics.viewers && it.statistics.viewers.value) || 0,
              thumb: imgUrl((th.screenshot && (th.screenshot.small || th.screenshot.middle)) || (th.listing && (th.listing.middle || (th.listing.large && th.listing.large.value)))),
              type: String((pr.provider && pr.provider.type) || '').toLowerCase(),
            });
          }
          return out;
        } catch { return []; }
      }));
      return lists.flat();
    })();
    // ② 番組検索(番組名・説明文が対象)の結果のうち、放送者名にも一致するもの(チャンネル・公式の放送など)
    const byProg = (async () => {
      const one = async page => {
        const j = await getJ('https://live.nicovideo.jp/front/api/pages/search/v1/programs?' +
          new URLSearchParams({ keyword: kw, sortOrder: 'viewCountDesc', column: 'main', status: 'onair', page: String(page) }).toString().replace(/\+/g, '%20'));
        return (j && j.data && Array.isArray(j.data.programs)) ? j.data.programs : [];
      };
      const pages = await Promise.all([1, 2].map(p => one(p).catch(() => [])));
      return pages.flat().filter(p => p && ID_RE.test(String(p.nicoliveProgramId))).map(p => ({
        id: String(p.nicoliveProgramId), name: String((p.supplier && p.supplier.name) || (p.socialGroup && p.socialGroup.name) || ''), title: String(p.title || ''),
        watch: Number(p.statistics && p.statistics.watchCount) || 0, thumb: imgUrl(p.listingThumbnail), type: String(p.providerType || ''),
        grp: String((p.socialGroup && p.socialGroup.name) || ''),
      })).filter(p => norm(p.name).includes(nk) || norm(p.grp).includes(nk));
    })();
    const [u, g] = await Promise.allSettled([byUser, byProg]);
    if (u.status === 'rejected' && g.status === 'rejected') return { ok: false };
    const seen = new Set(), items = [];
    for (const p of [...(u.value || []), ...(g.value || [])]) {
      if (seen.has(p.id)) continue; seen.add(p.id);
      const nm = norm(p.name);
      items.push({ id: p.id, name: p.name, title: p.title, watch: p.watch, thumb: p.thumb, type: p.type,
        _rank: nm === nk ? 0 : nm.startsWith(nk) ? 1 : nm.includes(nk) ? 2 : 3 });
    }
    // 名前が完全一致 → 前方一致 → 部分一致 → ほか(ユーザー検索で近いと判定されたもの)、その中では来場者数の多い順
    items.sort((a, b) => (a._rank - b._rank) || (b.watch - a.watch));
    return { ok: true, items: items.slice(0, 15).map(({ _rank, ...r }) => r) };
  } catch { return { ok: false }; }
});
/* ------------------------------------------------------------------ *
 * ギフトイベント(ニコニコのオーディション機能)の上位者
 *  公式の公開API(ログイン不要)から、開催中のイベント一覧と順位を取り、
 *  上位者の「いま放送中の番組」を放送履歴から探す。
 * ------------------------------------------------------------------ */
const AUD = 'https://audition.nicovideo.jp/capi/v1';
const evGet = async (url, ms = 8000) => {
  const res = await net.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
};
const tsec = x => { const t = Date.parse(x); return Number.isFinite(t) ? t / 1000 : 0; };
const KEY_RE = /^[\w-]{1,80}$/;
const imgOk = u => (typeof u === 'string' && /^https:\/\/[a-z0-9.-]+\.(nicovideo\.jp|nimg\.jp)(\/|$)/.test(u) ? u : '');
function evKind(a) {
  const rules = (Array.isArray(a && a.score_rules) ? a.score_rules : []).map(r => String((r && r.score_source_key) || ''));
  const plat = (Array.isArray(a && a.expose_platforms) ? a.expose_platforms : []).map(String);
  const gift = rules.some(k => /nage|gift/i.test(k)) || plat.some(k => /_gift$/.test(k));
  const ad = rules.some(k => /^nicoad_(live|video)$/.test(k)) || plat.some(k => /_nicoad$/.test(k));
  return gift && !ad ? 'gift' : ad && !gift ? 'ad' : '';
}
function mapEv(a, now) {
  if (!a || !KEY_RE.test(String(a.key))) return null;
  const start = tsec(a.voting_start_at), end = tsec(a.voting_end_at);
  if (!start || !end || now < start || now >= end) return null;
  if (a.entry_item_type && a.entry_item_type !== 'user') return null;
  return { key: a.key, kind: evKind(a), title: String(a.title || '').slice(0, 100), end, entries: Number(a.entry_count) || 0 };
}
// 開催中のイベント一覧: 放送中の盛り上がっている番組が参加しているイベント + 覚えているキー + 手入力のキー
// フォロー中の「いま放送中」の番組(ログインしているアカウントのもの)
const FOLLOW_URL = 'https://live.nicovideo.jp/follow?status=onair';
const str = v => (typeof v === 'string' ? v : '');
// 番組の情報の中から、サムネイル画像のURL(https)を探す
function findThumb(o, depth) {
  if (!o || typeof o !== 'object' || depth > 5) return '';
  const pri = [];
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === 'string') { if (/^https:\/\//.test(v) && /thumb|screenshot|image|listing|poster|small|middle|large|url|value/i.test(k)) pri.push(v); }
    else if (v && typeof v === 'object' && /thumb|screenshot|image|listing|poster|url|value|small|middle|large/i.test(k)) { const r = findThumb(v, depth + 1); if (r) pri.push(r); }
  }
  return pri[0] || '';
}
function collectLv(o, out, depth) {
  if (!o || typeof o !== 'object' || depth > 8) return;
  if (Array.isArray(o)) { o.forEach(x => collectLv(x, out, depth + 1)); return; }
  if (/^lv\d+$/.test(str(o.id)) && (o.title || o.programTitle || o.name)) {
    const st = str(o.liveCycle || o.status || '');
    if (!st || /ON_?AIR/i.test(st)) {
      const th = o.thumbnail || o.thumbnails || {};
      out.push({
        id: o.id, title: str(o.title || o.programTitle || o.name).slice(0, 120),
        name: str((o.programProvider && o.programProvider.name) || (o.socialGroup && o.socialGroup.name) || (o.user && o.user.nickname) || o.providerName || o.nickname).slice(0, 60),
        thumb: findThumb(o, 0),
        watch: Number((o.statistics && o.statistics.watchCount) || o.watchCount || 0) || 0,
      });
    }
  }
  for (const k of Object.keys(o)) collectLv(o[k], out, depth + 1);
}
async function followViaApi() {
  try {
    const res = await ses().fetch('https://live.nicovideo.jp/front/api/pages/follow/v1/programs?status=onair', { headers: { Accept: 'application/json', 'X-Frontend-Id': '9' }, cache: 'no-store', signal: AbortSignal.timeout(6000) });   // キャッシュを使わない(古い一覧が残らないように)
    if (!res.ok) return null;
    const j = await res.json();
    const out = []; collectLv(j, out, 0);
    // 取れた(または、放送中が0件という正しい返事)なら、これで決まり。ページを読み込む遅い方法には進まない
    if (out.length || (j && typeof j === 'object' && (j.data || (j.meta && j.meta.status === 200)))) return out;
  } catch { /* 次の方法へ */ }
  return null;
}
// APIで取れないときは、フォロー中のページを見えない窓で開いて、番組へのリンクを読み取る
async function followViaPage() {
  const w = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    await Promise.race([w.loadURL(FOLLOW_URL), sleep(15000).then(() => { throw new Error('timeout'); })]);
    if (/account\.nicovideo\.jp|\/login/.test(w.webContents.getURL())) return { login: true };
    await sleep(2500);
    for (let i = 0; i < 3; i++) { await w.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)').catch(() => {}); await sleep(900); }
    const list = await w.webContents.executeJavaScript(`(() => {
      const m = new Map();
      document.querySelectorAll('a[href*="/watch/lv"]').forEach(a => {
        const mm = (a.getAttribute('href') || '').match(/\\/watch\\/(lv\\d+)/); if (!mm) return;
        const id = mm[1], box = a.closest('li, article') || a, img = a.querySelector('img') || box.querySelector('img');
        const txt = (a.getAttribute('title') || a.getAttribute('aria-label') || a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
        const cur = m.get(id) || { id, title: '', name: '', thumb: '', watch: 0 };
        if (txt.length > cur.title.length) cur.title = txt;
        if (!cur.thumb && img) cur.thumb = (img.getAttribute('data-src') || img.currentSrc || img.src || '').replace(/^http:/, 'https:');
        m.set(id, cur);
      });
      return [...m.values()];
    })()`);
    return { list: Array.isArray(list) ? list : [] };
  } finally { try { w.destroy(); } catch { /* 無視 */ } }
}
let followCache = { t: 0, list: null };   // 直前に取れた一覧(続けて開いたとき、すぐ返す)
ipcMain.handle('mv:follow-list', async (_e, force) => {
  try {
    if (!force && followCache.list && Date.now() - followCache.t < 15000) return { ok: true, list: followCache.list };
    if (!(await isLoggedIn().catch(() => false))) return { ok: false, error: 'ログインしてください(設定の「ニコニコにログイン」)' };
    let list = await followViaApi();
    if (!list) {
      const r = await followViaPage();
      if (r.login) return { ok: false, error: 'ログインしてください(設定の「ニコニコにログイン」)' };
      list = r.list;
    }
    const seen = new Set(); list = list.filter(x => /^lv\d+$/.test(x.id) && !seen.has(x.id) && seen.add(x.id)).slice(0, 60);
    followCache = { t: Date.now(), list };
    return { ok: true, list };
  } catch (e) {
    appLog('フォロー中の放送の取得に失敗: ' + String(e && e.message || e).slice(0, 80), 'WARN');
    return { ok: false, error: '取得できませんでした' };
  }
});
ipcMain.handle('mv:ev-list', async (_e, extraKeys) => {
  const now = Date.now() / 1000;
  const found = new Map();
  const add = a => { const e = mapEv(a, now); if (e && !found.has(e.key)) found.set(e.key, e); };
  const keys = [...new Set((Array.isArray(extraKeys) ? extraKeys : []).filter(k => KEY_RE.test(String(k))))].slice(0, 20);
  const lvs = [];
  try {
    const kws = ['ギフト', 'の'];
    const lists = await Promise.all(kws.map(kw => evGet('https://live.nicovideo.jp/front/api/pages/search/v1/programs?' +
      new URLSearchParams({ keyword: kw, sortOrder: 'viewCountDesc', column: 'main', status: 'onair', page: '1' }).toString().replace(/\+/g, '%20'), 8000).catch(() => null)));
    for (const j of lists) for (const p of ((j && j.data && j.data.programs) || [])) {
      const id = String(p && p.nicoliveProgramId);
      if (ID_RE.test(id) && !lvs.includes(id)) lvs.push(id);
    }
  } catch { /* 一覧が取れなくても、キーからは調べる */ }
  await Promise.all([
    ...lvs.slice(0, 40).map(id => evGet(`${AUD}/entry_items?item_type=live&item_id=${id}&include_owner_items=true&expose_platform=live`, 6000)
      .then(b => { for (const it of (b && b.data && b.data.entry_items) || []) add(it && it.audition); }).catch(() => {})),
    ...keys.map(k => evGet(`${AUD}/auditions/${k}`, 6000).then(b => add(b && b.data)).catch(() => {})),
  ]);
  const events = [...found.values()].sort((a, b) => (a.kind === 'gift' ? 0 : 1) - (b.kind === 'gift' ? 0 : 1) || a.end - b.end);
  return { ok: true, events };
});
// その人の「いま放送中の番組」
async function liveOfUser(uid) {
  try {
    const j = await evGet(`https://live.nicovideo.jp/front/api/v2/user-broadcast-history?providerId=${uid}&providerType=user&isIncludeNonPublic=false&offset=0&limit=10`, 6000);
    const list = j && j.data && Array.isArray(j.data.programsList) ? j.data.programsList : [];
    for (const it of list) {
      const id = it && it.id && typeof it.id === 'object' ? it.id.value : it && it.id;
      const st = it && it.program && it.program.schedule && it.program.schedule.status;
      if (typeof id === 'string' && ID_RE.test(id) && st === 'ON_AIR') return id;
    }
  } catch { /* 取れなければ放送なし扱い */ }
  return null;
}
// 番組のギフト履歴から、召喚獣(通常/改/神)の個数を数える
function summonKind(name) {
  if (typeof name !== 'string') return null;
  const t = name.normalize('NFKC').replace(/\s+/g, '');
  if (!t.startsWith('召喚獣')) return null;
  if (t.includes('神') || t.includes('ゴッド')) return 'god';
  if (t.includes('改')) return 'kai';
  return t === '召喚獣' ? 'normal' : null;
}
async function summonsOf(lv) {
  const out = { normal: 0, kai: 0, god: 0 };
  try {
    const res = await net.fetch('https://api.gift.nicovideo.jp/v3/contents/nage_agv/' + lv + '/histories', {
      headers: { accept: 'application/json', 'x-frontend-id': '9', 'x-frontend-version': '657.0.0', origin: 'https://gift.nicovideo.jp', referer: 'https://gift.nicovideo.jp/' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return out;
    const j = await res.json();
    for (const h of ((j && j.data && j.data.histories) || [])) { const k = summonKind(h && h.item && h.item.name); if (k) out[k]++; }
  } catch { /* 取れなければ0 */ }
  return out;
}
const evLiveCache = new Map(), EV_SLOW_MS = 30000;   // uid → { lv, sm, 取得時刻 }
ipcMain.handle('mv:ev-top', async (_e, key, n) => {
  if (!KEY_RE.test(String(key))) return { ok: false };
  const lim = Math.min(Math.max(parseInt(n, 10) || 4, 1), 12);
  try {
    const j = await evGet(`${AUD}/auditions/${key}/rankings?limit=${lim}`);
    const list = ((j && j.data && j.data.entry_items) || []).slice(0, lim)
      .map(e => ({ rank: Number(e.rank) || 0, uid: String(e.item_id || ''), name: String(e.name || '').slice(0, 40), score: Number(e.total_score) || 0, icon: imgOk(e.thumbnail_url) }))
      .filter(e => /^\d{1,12}$/.test(e.uid));
    // 順位・点数は毎回(10秒ごと)取る。放送中の枠・召喚獣の数は通信が多いので、覚えておいて30秒ごとに取り直す
    const now = Date.now();
    await Promise.all(list.map(async e => {
      let c = evLiveCache.get(e.uid);
      if (!c || now - c.t > EV_SLOW_MS) {
        const lv = await liveOfUser(e.uid);
        c = { t: now, lv, sm: null, smT: 0, smLv: '' };
        const old = evLiveCache.get(e.uid);
        if (old && old.lv === lv) { c.sm = old.sm; c.smT = old.smT; c.smLv = old.smLv; }
        evLiveCache.set(e.uid, c);
      }
      if (c.lv && (c.smLv !== c.lv || now - c.smT > EV_SLOW_MS)) { c.sm = await summonsOf(c.lv); c.smT = now; c.smLv = c.lv; }
      e.lv = c.lv; e.sm = c.lv ? c.sm : null;
    }));
    return { ok: true, top: list };
  } catch { return { ok: false }; }
});
const vidOf = v => { for (const [k, x] of views) if (x === v) return k; return ''; };
function applyOverlay() {
  for (const v of views.values()) {
    let show = !drag && readyIds.has(vidOf(v));
    if (show && overlayOpen) {
      if (!overlayRect) show = false;
      else {
        const b = v.getBounds(), r = overlayRect;
        show = b.x + b.width <= r.x || r.x + r.width <= b.x || b.y + b.height <= r.y || r.y + r.height <= b.y;
      }
    }
    v.setVisible(show);
  }
}
ipcMain.on('mv:overlay', (_e, on, rect) => {
  overlayOpen = !!on;
  overlayRect = on && rect && Number.isFinite(rect.x + rect.y + rect.width + rect.height) ? { x: rect.x - 4, y: rect.y - 4, width: rect.width + 8, height: rect.height + 8 } : null;
  applyOverlay();
});

/* ------------------------------------------------------------------ *
 * メニュー(ギフトイベント / 枠の保存 / 追跡開始の確認)
 *  映像と同じネイティブのビューにして、いちばん手前に重ねる(映像を隠さずに済む)。
 * ------------------------------------------------------------------ */
let menuLatest = null, menuOpening = false, menuOpenedAt = 0, menuView = null, menuType = '', menuOpen = false, menuClosedAt = 0, menuClosedType = '', menuPos = null, menuReady = null;
function ensureMenu() {
  if (menuView) return menuReady;
  menuView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'menu-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  menuView.setBackgroundColor('#00000000');
  menuView.setVisible(false);
  win.contentView.addChildView(menuView);
  menuReady = new Promise(res => menuView.webContents.once('did-finish-load', res));
  menuView.webContents.loadFile(path.join(__dirname, 'menu.html'));
  menuView.webContents.on('blur', () => { try { if (menuType !== 'sug' && Date.now() - menuOpenedAt > 500) closeMenu(); } catch { /* 終了中は無視 */ } });
  menuView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return menuReady;
}
function raiseMenu() { if (menuView && menuOpen && win) { win.contentView.removeChildView(menuView); win.contentView.addChildView(menuView); } }
function closeMenu() {
  if (!menuOpen) return;
  menuOpen = false; menuClosedAt = Date.now(); menuClosedType = menuType;
  try { if (menuView && !menuView.webContents.isDestroyed()) menuView.setVisible(false); } catch { /* 終了中は無視 */ }
  try { if (win && !win.isDestroyed()) win.webContents.send('mv:menu-closed', menuType); } catch { /* 終了中は無視 */ }
}
function placeMenu(h) {
  if (!menuPos || !win) return;
  const [cw, ch] = win.getContentSize();
  const w = Math.min(menuPos.w || 460, cw - 16);
  const x = Math.max(8, Math.min(menuPos.x, cw - w - 8));
  const y = Math.max(0, menuPos.y);
  menuView.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(Math.max(60, Math.min(h || 320, ch - y - 8))) });
}
ipcMain.on('mv:menu-open', async (_e, type, anchor, data) => {
  if (!win || !['ev', 'pp', 'dlg', 'sug', 'set', 'fl', 'fm'].includes(type)) return;
  if (menuOpen && menuType === type) { closeMenu(); return; }
  if (!menuOpen && menuClosedType === type && Date.now() - menuClosedAt < 300) return;   // ボタンを押して閉じた直後の再オープンを防ぐ
  menuLatest = data; menuOpening = true;
  await ensureMenu();
  menuOpening = false;
  data = menuLatest;
  menuType = type; menuOpen = true; menuOpenedAt = Date.now();
  menuPos = { x: Number(anchor && anchor.left) || 8, y: (Number(anchor && anchor.bottom) || 0) + 4, w: Number(anchor && anchor.width) || 0 };
  placeMenu(320);
  win.contentView.removeChildView(menuView); win.contentView.addChildView(menuView);
  menuView.setVisible(true);
  menuView.webContents.send('menu:show', type, data);
  if (type !== 'sug') menuView.webContents.focus();   // 検索候補は、入力欄のフォーカスを奪わない
});
ipcMain.on('mv:menu-close', (_e, force) => {
  if (!menuOpen) return;
  if (force) { if (menuType === 'sug') closeMenu(); return; }
  if (menuType !== 'sug' && Date.now() - menuOpenedAt > 300) closeMenu();
});
ipcMain.on('mv:menu-data', (_e, data) => { if (menuOpening) menuLatest = data; else if (menuOpen && menuView) menuView.webContents.send('menu:data', data); });
ipcMain.on('menu:size', (e, h) => { if (menuOpen && menuView && e.sender === menuView.webContents) placeMenu(Number(h)); });
ipcMain.on('menu:close', e => { if (menuView && e.sender === menuView.webContents) closeMenu(); });
ipcMain.on('menu:act', (e, action, payload, keep) => {
  if (!menuView || e.sender !== menuView.webContents) return;
  if (win && !win.isDestroyed()) win.webContents.send('mv:menu-act', String(action), payload);
  if (menuType === 'sug') { if (win && !win.isDestroyed()) win.webContents.focus(); return; }   // 候補を選んだら入力欄へ戻す
  if (!keep) closeMenu();
});

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
ipcMain.handle('mv:load', () => loadState());
ipcMain.on('mv:save', (_e, s) => saveState(s));
ipcMain.on('mv:sync', (_e, rects, audioId, po, vols, hides) => {
  if (Array.isArray(rects)) syncViews(rects, audioId, po, vols, hides);
});
/* ------------------------------------------------------------------ *
 * 🎁 ギフトウィンドウ(別窓)
 *  上のバーで「投げる先の枠」を選び、その放送のギフトページ(gift.nicovideo.jp)を下に出す。
 *  ニコニコの公式ギフトを使うだけで、アプリがギフトを代わりに送ることはない。
 * ------------------------------------------------------------------ */
let giftWin = null, giftView = null, giftTarget = '', giftTargets = [];
const GIFT_BAR = 52;
const GIFT_URL = lv => `https://gift.nicovideo.jp/live/${lv}/purchase?frontend_id=9&frontend_version=658.1.0&item_list_disabled=false`;
function giftLayout() {
  if (!giftWin || giftWin.isDestroyed() || !giftView) return;
  const [w, h] = giftWin.getContentSize();
  giftView.setBounds({ x: 0, y: GIFT_BAR, width: w, height: Math.max(0, h - GIFT_BAR) });
}
// 投げる先・エモーション先の一覧: 名前は、放送者名(取得済みのもの)を優先する
const targetList = () => giftTargets.map(t => { const i = infos.get(t.id); return { id: t.id, name: (i && i.name) || t.name }; });
function giftPush() { if (giftWin && !giftWin.isDestroyed()) giftWin.webContents.send('gift:state', targetList(), giftTarget); }
function giftLoad(id) {
  giftTarget = ID_RE.test(String(id)) ? String(id) : '';
  giftPush();
  if (!giftView || giftView.webContents.isDestroyed()) return;
  if (!giftTarget) { giftView.webContents.loadURL('about:blank'); return; }
  const wc = giftView.webContents;
  wc.loadURL(GIFT_URL(giftTarget)).catch(() => {});
}
function openGift(id) {
  if (giftWin && !giftWin.isDestroyed()) { giftWin.show(); giftWin.focus(); giftLoad(id || giftTarget); return; }
  giftWin = new BrowserWindow({
    width: 560, height: 860, minWidth: 380, minHeight: 420,
    title: 'ギフト', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true, backgroundColor: bgColor(),
    webPreferences: { preload: path.join(__dirname, 'gift-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  giftWin.setMenuBarVisibility(false);
  giftWin.loadFile(path.join(__dirname, 'gift.html'));
  giftView = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  giftWin.contentView.addChildView(giftView);
  giftView.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) giftView.webContents.loadURL(url).catch(() => {}); return { action: 'deny' }; });
  giftWin.on('resize', giftLayout);
  giftWin.webContents.once('did-finish-load', () => { giftLayout(); giftLoad(id); });
  giftWin.on('closed', () => { giftWin = null; giftView = null; });
}
ipcMain.on('mv:gift-open', (_e, id) => openGift(id));
ipcMain.on('mv:gift-targets', (_e, list) => {
  giftTargets = Array.isArray(list) ? list.filter(x => x && ID_RE.test(String(x.id))).map(x => ({ id: String(x.id), name: String(x.name || x.id).slice(0, 60) })) : [];
  if (giftTarget && !giftTargets.some(t => t.id === giftTarget)) { giftTarget = ''; if (giftView && !giftView.webContents.isDestroyed()) giftView.webContents.loadURL('about:blank'); }
  giftPush();
  if (emoTarget && !giftTargets.some(t => t.id === emoTarget)) closeEmotion(emoTarget); else { emoPush(); emoTitle(); }
});
ipcMain.on('gift:pick', (_e, id) => giftLoad(id));
ipcMain.on('gift:ready', () => giftPush());
ipcMain.on('gift:reopen', () => { if (giftTarget) giftLoad(giftTarget); });
ipcMain.on('mv:reload', (_e, id) => { const v = views.get(id); noticed.delete(id); if (v) v.webContents.loadURL(WATCH(id)); });
// この枠の映像(流れるコメントごと)を、クリップボードにコピーして、ピクチャのフォルダにPNGで保存する
const shotBase = dir => {
  if (typeof dir === 'string' && dir && path.isAbsolute(dir)) return dir;
  for (const k of ['pictures', 'documents', 'userData']) { try { const b = app.getPath(k); if (b) return path.join(b, 'ニコ生マルチビュー'); } catch { /* 次へ */ } }
  return path.join(app.getPath('userData'), 'shots');
};
ipcMain.handle('mv:shot-pick', async (_e, cur) => {
  const r = await dialog.showOpenDialog(win, { title: 'スクリーンショットの保存先', defaultPath: shotBase(cur), properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths[0] ? { dir: '' } : { dir: r.filePaths[0] };
});
ipcMain.on('mv:log', (_e, level, msg) => { if (typeof msg === 'string') appLog(msg.slice(0, 200), level === 'WARN' ? 'WARN' : 'INFO'); });
ipcMain.on('mv:shot-open', (_e, dir) => { const d = shotBase(dir); try { fs.mkdirSync(d, { recursive: true }); } catch { /* 無視 */ } shell.openPath(d); });
ipcMain.handle('mv:shot', async (_e, id, label, dirPref, noCmt) => {
  let step = '開始';
  try {
    const v = ID_RE.test(String(id)) && views.get(id);
    if (!v || v.webContents.isDestroyed()) return { ok: false, error: '枠が見つかりません' };
    step = '映像の取り込み';
    const wc = v.webContents;
    try { wc.invalidate(); } catch { /* 無視 */ }
    // 映像の部分だけを撮る(黒い余白は含めない)。ページの中の video の、実際に映像が出ている範囲を求める
    let rect = null;
    try {
      rect = await wc.executeJavaScript(`(() => {
        let best = null, area = 0;
        document.querySelectorAll('video').forEach(v => { const r = v.getBoundingClientRect(); if (r.width * r.height > area && v.videoWidth > 0) { best = v; area = r.width * r.height; } });
        if (!best) return null;
        const r = best.getBoundingClientRect(), vw = best.videoWidth, vh = best.videoHeight, k = Math.min(r.width / vw, r.height / vh);
        const w = vw * k, h = vh * k, x = r.left + (r.width - w) / 2, y = r.top + (r.height - h) / 2;
        const X = Math.max(0, Math.round(x)), Y = Math.max(0, Math.round(y));
        return { x: X, y: Y, width: Math.min(Math.round(w), innerWidth - X), height: Math.min(Math.round(h), innerHeight - Y) };
      })()`);
    } catch { rect = null; }
    if (rect && !(rect.width > 8 && rect.height > 8)) rect = null;
    // コメントなしで撮るときは、流れるコメントの層をいったん隠してから撮り、元の状態に戻す
    const restoreCmt = () => { try { applyHide(id, wc); } catch { /* 無視 */ } };
    if (noCmt) {
      try { await wc.executeJavaScript(`document.documentElement.classList.add('nmv-nocmt')`); } catch { /* 無視 */ }
      await new Promise(r => setTimeout(r, 180));
    }
    const cap = r => Promise.race([r ? wc.capturePage(r) : wc.capturePage(), new Promise((_, rej) => setTimeout(() => rej(new Error('時間切れ')), 6000))]);
    let img = await cap(rect);
    if (!img || img.isEmpty()) {
      const b = v.getBounds();
      img = await cap({ x: 0, y: 0, width: Math.max(1, b.width), height: Math.max(1, b.height) });
    }
    if (noCmt) restoreCmt();
    if (!img || img.isEmpty()) return { ok: false, error: '映像を取り込めませんでした(空の画像)' };
    step = 'コピー';
    let copied = false;
    const png = img.toPNG();
    try {
      // Electron 45 のクリップボードは、非同期の write() に ClipboardItem を渡す形
      if (typeof clipboard.write === 'function' && typeof ClipboardItem === 'function') {
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
        copied = true;
      } else if (typeof clipboard.writeImage === 'function') { clipboard.writeImage(img); copied = true; }
    } catch (e) { appLog('スクショのコピーに失敗(本体側): ' + String(e && e.message || e).slice(0, 80), 'WARN'); }
    step = '保存';
    const dir = shotBase(dirPref);
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date(), z = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
    const nm = String(label || '').replace(/[^0-9A-Za-z\u3040-\u30ff\u3400-\u9fff_-]+/g, '_').slice(0, 30);
    const file = path.join(dir, `${nm ? nm + '_' : ''}${id}_${stamp}.png`);
    fs.writeFileSync(file, png);
    appLog('スクリーンショットを保存しました' + (copied ? '(クリップボードにもコピー)' : '') + ': ' + file);
    return { ok: true, file, png: copied ? null : png };   // 本体側でコピーできなかったときは、画面側(ui.html)でコピーする
  } catch (e) {
    const m = String(e && e.message || e).slice(0, 80);
    appLog(`スクリーンショットに失敗(${step}): ${m}`, 'WARN');
    try { if (noCmt) applyHide(id, views.get(id).webContents); } catch { /* 無視 */ }
    return { ok: false, error: `撮影に失敗しました(${step}: ${m})` };
  }
});
// エモーション: その放送のエモーション画面を、小さな別窓で開く(ログインはアプリのものを共有)
let emoWin = null, emoView = null, emoTarget = '';
const EMO_URL = id => `https://emotion.nicovideo.jp/play/${id}?realtime=true&frontend_id=9&frontend_version=658.2.0`;
const EMO_BAR = 52;
function emoPush() { if (emoWin && !emoWin.isDestroyed()) emoWin.webContents.send('emo:state', targetList(), emoTarget); }
function emoLayout() {
  if (!emoWin || emoWin.isDestroyed() || !emoView) return;
  const [cw, ch] = emoWin.getContentSize();
  emoView.setBounds({ x: 0, y: EMO_BAR, width: cw, height: Math.max(0, ch - EMO_BAR) });
}
function emoTitle() { if (emoWin && !emoWin.isDestroyed()) { const t = targetList().find(x => x.id === emoTarget); emoWin.setTitle(emoTarget ? `エモーション - ${t ? t.name : emoTarget}` : 'エモーション'); } }
function emoLoad(id) {
  emoTarget = ID_RE.test(String(id)) ? String(id) : '';
  emoPush(); emoTitle();
  if (!emoView || emoView.webContents.isDestroyed()) return;
  if (!emoTarget) { emoView.webContents.loadURL('about:blank'); return; }
  emoView.webContents.loadURL(EMO_URL(emoTarget)).catch(e => appLog(`エモーションを開けませんでした: ${String(e && e.message || e).slice(0, 80)}`, 'WARN'));
  appLog(`${emoTarget}: エモーションを開きました`);
}
function closeEmotion(id) {   // 枠が閉じられたとき: その枠が対象なら、対象を空にする(窓は残す)
  if (emoTarget === id) { emoTarget = ''; if (emoView && !emoView.webContents.isDestroyed()) emoView.webContents.loadURL('about:blank'); emoPush(); emoTitle(); }
}
function openEmotion(id) {
  if (emoWin && !emoWin.isDestroyed()) { if (emoWin.isMinimized()) emoWin.restore(); emoWin.show(); emoWin.focus(); emoLoad(id || emoTarget); return; }
  emoWin = new BrowserWindow({
    width: 440, height: 760, minWidth: 320, minHeight: 360,
    title: 'エモーション', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true, backgroundColor: bgColor(),
    webPreferences: { preload: path.join(__dirname, 'emotion-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  emoWin.setMenuBarVisibility(false);
  emoWin.loadFile(path.join(__dirname, 'emotion.html'));
  emoView = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  emoWin.contentView.addChildView(emoView);
  emoView.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  emoWin.on('resize', emoLayout);
  emoWin.webContents.once('did-finish-load', () => { emoLayout(); emoLoad(id); });
  emoWin.on('closed', () => { emoWin = null; emoView = null; });
}
ipcMain.on('emo:ready', () => emoPush());
ipcMain.on('emo:pick', (_e, id) => emoLoad(id));
ipcMain.on('emo:reopen', () => { if (emoTarget) emoLoad(emoTarget); });
ipcMain.on('mv:emotion', (_e, id) => { if (ID_RE.test(String(id))) openEmotion(id); });
// 枠の放送者名の右クリックメニュー(放送の詳細・放送のURLのコピー・放送者のユーザーページ)
const PROG_JS = `(() => {
  try {
    const el = document.getElementById('embedded-data');
    const p = el && JSON.parse(el.getAttribute('data-props') || '{}');
    const g = p && p.program || {};
    const sup = g.supplier || {};
    const st = (p && p.program && p.program.statistics) || {};
    return { title: g.title || '', name: sup.name || '', page: sup.pageUrl || '', uid: sup.programProviderId || '', type: sup.supplierType || '', status: g.status || '', begin: g.beginTime || g.openTime || 0, end: g.endTime || 0, desc: (g.description || '').replace(/<[^>]*>/g, ' ').split(String.fromCharCode(10)).join(' ').replace(/ {2,}/g, ' ').trim().slice(0, 200), viewers: st.watchCount || (p.site && p.site.relive && 0) || 0, comments: st.commentCount || 0 };
  } catch (e) { return null; }
})()`;
ipcMain.handle('mv:frame-act', async (_e, kind, id) => {
  if (!ID_RE.test(String(id))) return { ok: false };
  const v = views.get(id);
  const info = v && !v.webContents.isDestroyed() ? await v.webContents.executeJavaScript(PROG_JS).catch(() => null) : null;
  if (kind === 'url') { try { await clipboard.writeText(WATCH(id)); } catch { /* 無視 */ } return { ok: true }; }
  if (kind === 'user') {
    let u = info && info.page && /^https:\/\/(www\.nicovideo\.jp|ch\.nicovideo\.jp|com\.nicovideo\.jp)\//.test(info.page) ? info.page : '';
    if (!u && info && /^\d+$/.test(String(info.uid))) u = (info.type === 'community' ? 'https://com.nicovideo.jp/community/co' : 'https://www.nicovideo.jp/user/') + info.uid;
    if (u) shell.openExternal(u); else return { ok: false, error: '放送者のページが見つかりません(放送の読み込み後にもう一度お試しください)' };
    return { ok: true };
  }
  if (kind === 'detail') {
    const f = t => { if (!t) return ''; const d = new Date(Number(t) * (Number(t) < 1e12 ? 1000 : 1)); return isNaN(d) ? '' : d.toLocaleString('ja-JP'); };
    const lines = [];
    if (info) {
      if (info.title) lines.push(`タイトル: ${info.title}`);
      if (info.name) lines.push(`放送者: ${info.name}`);
      lines.push(`放送ID: ${id}`);
      if (info.begin) lines.push(`開始: ${f(info.begin)}`);
      if (info.end) lines.push(`終了(予定): ${f(info.end)}`);
      if (info.status) lines.push(`状態: ${info.status === 'ON_AIR' ? '放送中' : info.status === 'ENDED' ? '終了' : info.status}`);
      if (info.viewers) lines.push(`来場者数: ${Number(info.viewers).toLocaleString('ja-JP')}`);
      if (info.comments) lines.push(`コメント数: ${Number(info.comments).toLocaleString('ja-JP')}`);
      if (info.desc) lines.push('', info.desc);
    } else lines.push(`放送ID: ${id}`, '(放送の情報を取得できませんでした)');
    lines.push('', WATCH(id));
    await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: 'info', title: '放送の詳細', message: (info && info.title) || id, detail: lines.join('\n'), buttons: ['閉じる', 'URLをコピー'], defaultId: 0, cancelId: 0, noLink: true })
      .then(r => { if (r.response === 1) clipboard.writeText(WATCH(id)).catch(() => {}); });
    return { ok: true };
  }
  return { ok: false };
});
ipcMain.on('mv:external', (_e, id) => { if (ID_RE.test(id)) shell.openExternal(WATCH(id)); });
ipcMain.handle('mv:auth', () => isLoggedIn().catch(() => false));
ipcMain.handle('mv:auth-via', () => loginVia);
ipcMain.on('mv:login', () => openLogin());
ipcMain.on('mv:logout', () => { logout(); });

app.setAppUserModelId('dev.nico-multiview');
app.whenReady().then(() => {
  if (!gotLock) return;   // 多重起動の2つ目は、ここから先(ウィンドウ作成など)を行わない
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);   // Altキーで出る「File / Edit / View / Window」のメニューを出さない
  appLog('アプリを起動(v' + app.getVersion() + ')');
  logUpdateResult();
  setTimeout(() => { ensurePolicy(); setInterval(checkPolicy, 6 * 3600 * 1000); }, 3000);
  // ログインが完了したら(user_session が付いたら)ログイン画面を閉じて全枠を読み込み直す
  ses().cookies.on('changed', async (_e, cookie, _cause, removed) => {
    if (cookie.name !== 'user_session' || !/(^|\.)nicovideo\.jp$/.test(cookie.domain)) return;
    const logged = await notifyAuth();
    if (logged && !removed && loginWin && !loginWin.isDestroyed()) {
      setTimeout(() => {
        if (loginWin && !loginWin.isDestroyed()) loginWin.close();
        reloadAll();
      }, 800);
    }
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
