'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, shell, session, screen, nativeTheme, net } = require('electron');
const path = require('path');
const fs = require('fs');

// ニコニコのログイン状態を全枠で共有・保存するためのパーティション
const PARTITION = 'persist:nico';
const WATCH = id => `https://live.nicovideo.jp/watch/${id}`;
const LOGIN_URL = 'https://account.nicovideo.jp/login?site=nicolive';
const ID_RE = /^lv\d+$/;
const NICO_HOST_RE = /^https:\/\/([\w-]+\.)*nicovideo\.jp\//;

let win = null;
let loginWin = null;
let viewerWin = null;
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
app.userAgentFallback = fixUA(app.userAgentFallback);
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
const hideCmt = {};              // lv番号 -> true なら、映像の上を流れるコメントを隠す
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
  wc.executeJavaScript(`window.__nmvOn=${playerOnly ? 'true' : 'false'}; window.__nmvUpd && window.__nmvUpd();`).catch(() => {});
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
const THEMES = ['system', 'light', 'dark'];
const bgColor = () => (nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f4f6fa');
function setTheme(t) {
  if (!THEMES.includes(t)) return;
  nativeTheme.themeSource = t;
}
nativeTheme.on('updated', () => {
  for (const w of [win, viewerWin]) if (w && !w.isDestroyed()) w.setBackgroundColor(bgColor());
});
ipcMain.on('mv:theme', (_e, t) => setTheme(t));

function createWindow() {
  const st = loadState();
  if (st && THEMES.includes(st.theme)) setTheme(st.theme);
  win = new BrowserWindow({
    width: 1600, height: 900, minWidth: 720, minHeight: 480,
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
  hookFsKeys(win.webContents);
  win.on('enter-full-screen', () => { if (win) win.webContents.send('mv:fs', true); exitBarStart(); });
  win.on('leave-full-screen', () => { exitBarStop(); if (win) win.webContents.send('mv:fs', false); });
  win.loadFile(path.join(__dirname, 'ui.html'));
  win.on('closed', () => {
    win = null; views.clear();
    if (loginWin && !loginWin.isDestroyed()) loginWin.close();
    if (viewerWin && !viewerWin.isDestroyed()) viewerWin.close();
  });
}

// F11で全画面、全画面中はEscで戻る(映像のビューにフォーカスがあっても効くように各ビューにも付ける)
function setFs(on) { if (win && !win.isDestroyed()) win.setFullScreen(typeof on === 'boolean' ? on : !win.isFullScreen()); }
function hookFsKeys(wc) {
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { e.preventDefault(); setFs(); }
    else if (input.key === 'Escape' && win && win.isFullScreen()) { e.preventDefault(); setFs(false); }
    else if (input.key === 'Escape' && win && !win.isDestroyed()) win.webContents.send('mv:unfocus');
  });
}
// 全画面中、画面の一番上にカーソルが行くと「✕ 全画面を終了」ボタンを出す(映像のビューはマウスを奪うので、カーソル位置を定期的に調べる)
let exitView = null, exitShown = false, exitTimer = null;
const EXIT_W = 190, EXIT_H = 44;
const EXIT_HTML = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}button{width:100%;height:100%;box-sizing:border-box;font:700 14px "Yu Gothic UI","Meiryo",sans-serif;color:#fff;background:#1b1f27ee;border:1px solid #ffffff55;border-radius:0 0 10px 10px;border-top:0;cursor:pointer}button:hover{background:#c0392bee}</style><button id="b" type="button">✕ 全画面を終了</button><script>document.getElementById("b").onclick=()=>window.exitFs()</script>';
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
  exitTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isFullScreen()) { exitBarStop(); return; }
    const cb = win.getContentBounds(), p = screen.getCursorScreenPoint();
    const rx = p.x - cb.x, ry = p.y - cb.y;
    const inWin = rx >= 0 && rx < cb.width && ry >= 0;
    const mid = cb.width / 2;
    const near = inWin && ry <= (exitShown ? EXIT_H + 8 : 4) && (!exitShown || Math.abs(rx - mid) <= EXIT_W / 2 + 40 || ry <= 4);
    if (near && !exitShown) {
      exitView.setBounds({ x: Math.round(mid - EXIT_W / 2), y: 0, width: EXIT_W, height: EXIT_H });
      win.contentView.addChildView(exitView); exitShown = true;
    } else if (near && exitShown) {
      win.contentView.removeChildView(exitView); win.contentView.addChildView(exitView);   // 常に最前面
    } else if (!near && exitShown) {
      win.contentView.removeChildView(exitView); exitShown = false;
    }
  }, 120);
}
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
  wc.on('dom-ready', () => {
    wc.insertCSS(PLAYER_CSS).catch(() => {});
    wc.executeJavaScript(PLAYER_JS).then(() => { applyMode(wc); applyVol(id, wc); applyHide(id, wc); }).catch(() => {});
    sendInfo(id, wc);
  });
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
      views.delete(id);
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
async function notifyAuth() {
  const v = await isLoggedIn().catch(() => false);
  if (win && !win.isDestroyed()) win.webContents.send('mv:auth', v);
  return v;
}
function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) { loginWin.focus(); return; }
  loginWin = new BrowserWindow({
    width: 520, height: 780, parent: win || undefined,
    title: 'ニコニコにログイン', autoHideMenuBar: true, backgroundColor: '#ffffff',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const wc = loginWin.webContents;
  wc.setUserAgent(fixUA(wc.getUserAgent()));
  wc.setWindowOpenHandler(({ url }) => {
    if (NICO_HOST_RE.test(url)) wc.loadURL(url);
    else if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  loginWin.on('closed', () => { loginWin = null; });
  wc.loadURL(LOGIN_URL);
}
async function logout() {
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
    const form = document.querySelector('form[class*="___comment-post-form___"]');
    if (!form) return { ok: false, error: 'コメント欄が見つかりません(放送が終了している、読み込み中など)' };
    const box = form.querySelector('input[class*="___comment-text-box___"]');
    const btn = form.querySelector('button[type="submit"]');
    if (!box || !btn) return { ok: false, error: 'コメント欄の形式が想定と違います(サイト側の変更の可能性)' };
    const msg = form.querySelector('[class*="___disabled-message___"]');
    if (box.disabled || (msg && getComputedStyle(msg).display !== 'none')) {
      return { ok: false, error: 'この枠ではコメントできません(未ログイン、投稿不可の枠など)' };
    }
    const setVal = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const cmd = form.querySelector('input[class*="___command-text-box___"]');
    if (cmd && ANON && !/184/.test(cmd.value)) { setVal(cmd, '184'); }
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
  try { return await v.webContents.executeJavaScript(commentScript(t, !!use184)); }
  catch { return { ok: false, error: 'コメントの送信に失敗しました' }; }
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
 * 統合コメントビューア(別窓)
 *  各枠のコメントを1つの窓に時系列でまとめて表示する。
 *  コメントは各枠のページから読み取ったもの(view-preload.js)を、ここで集めて転送する。
 * ------------------------------------------------------------------ */
const commentBuf = [];
const MAX_BUF = 3000;
const sourcesList = () => [...views.keys()].map(id => ({ id, name: (infos.get(id) && infos.get(id).name) || id }));
const pushViewer = (ch, payload) => { if (viewerWin && !viewerWin.isDestroyed()) viewerWin.webContents.send(ch, payload); };
function pushSources() { pushViewer('vw:sources', sourcesList()); }
// コメントビューアの位置・大きさは、閉じても次回に引き継ぐ
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
function openViewer() {
  if (viewerWin && !viewerWin.isDestroyed()) { viewerWin.show(); viewerWin.focus(); return; }
  const vb = loadViewerBounds();
  viewerWin = new BrowserWindow({
    width: (vb && vb.width) || 480, height: (vb && vb.height) || 760, minWidth: 300, minHeight: 300,
    ...(vb && Number.isFinite(vb.x) ? { x: vb.x, y: vb.y } : {}),
    title: '統合コメントビューア', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true, backgroundColor: bgColor(),
    webPreferences: { preload: path.join(__dirname, 'viewer-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  viewerWin.setMenuBarVisibility(false);
  viewerWin.loadFile(path.join(__dirname, 'viewer.html'));
  if (vb && vb.max) viewerWin.maximize();
  const later = () => { clearTimeout(vbTimer); vbTimer = setTimeout(saveViewerBounds, 400); };
  viewerWin.on('resize', later); viewerWin.on('move', later);
  viewerWin.on('close', saveViewerBounds);   // 閉じる直前の大きさを保存
  viewerWin.on('closed', () => { viewerWin = null; });
}
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
ipcMain.on('mv:open-viewer', () => openViewer());
ipcMain.handle('vw:init', () => ({ backlog: commentBuf, sources: sourcesList() }));
ipcMain.on('vw:clear', () => { commentBuf.length = 0; });
ipcMain.on('vw:ontop', (_e, v) => { if (viewerWin && !viewerWin.isDestroyed()) viewerWin.setAlwaysOnTop(!!v); });
ipcMain.on('mv:comments', (e, list) => {
  const hit = [...views].find(([, v]) => v.webContents === e.sender);
  if (!hit || !Array.isArray(list)) return;
  const now = Date.now();
  const items = list.slice(0, 200)
    .filter(x => x && typeof x.text === 'string' && x.text)
    .map(x => ({ t: now, id: hit[0], no: Number(x.no) || 0, text: x.text.slice(0, 1000) }));
  if (!items.length) return;
  commentBuf.push(...items);
  if (commentBuf.length > MAX_BUF) commentBuf.splice(0, commentBuf.length - MAX_BUF);
  pushViewer('vw:comments', items);
});


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
ipcMain.handle('mv:ev-top', async (_e, key, n) => {
  if (!KEY_RE.test(String(key))) return { ok: false };
  const lim = Math.min(Math.max(parseInt(n, 10) || 4, 1), 12);
  try {
    const j = await evGet(`${AUD}/auditions/${key}/rankings?limit=${lim}`);
    const list = ((j && j.data && j.data.entry_items) || []).slice(0, lim)
      .map(e => ({ rank: Number(e.rank) || 0, uid: String(e.item_id || ''), name: String(e.name || '').slice(0, 40), score: Number(e.total_score) || 0, icon: imgOk(e.thumbnail_url) }))
      .filter(e => /^\d{1,12}$/.test(e.uid));
    await Promise.all(list.map(async e => { e.lv = await liveOfUser(e.uid); e.sm = e.lv ? await summonsOf(e.lv) : null; }));
    return { ok: true, top: list };
  } catch { return { ok: false }; }
});
function applyOverlay() {
  for (const v of views.values()) {
    let show = !drag;
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
  menuView.webContents.on('blur', () => { if (menuType !== 'sug' && Date.now() - menuOpenedAt > 500) closeMenu(); });
  menuView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return menuReady;
}
function raiseMenu() { if (menuView && menuOpen && win) { win.contentView.removeChildView(menuView); win.contentView.addChildView(menuView); } }
function closeMenu() {
  if (!menuOpen) return;
  menuOpen = false; menuClosedAt = Date.now(); menuClosedType = menuType;
  if (menuView && !menuView.webContents.isDestroyed()) menuView.setVisible(false);
  if (win && !win.isDestroyed()) win.webContents.send('mv:menu-closed', menuType);
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
  if (!win || !['ev', 'pp', 'dlg', 'sug'].includes(type)) return;
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
ipcMain.on('mv:reload', (_e, id) => { const v = views.get(id); if (v) v.webContents.loadURL(WATCH(id)); });
ipcMain.on('mv:external', (_e, id) => { if (ID_RE.test(id)) shell.openExternal(WATCH(id)); });
ipcMain.handle('mv:auth', () => isLoggedIn().catch(() => false));
ipcMain.on('mv:login', () => openLogin());
ipcMain.on('mv:logout', () => { logout(); });

app.whenReady().then(() => {
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
app.on('window-all-closed', () => app.quit());
