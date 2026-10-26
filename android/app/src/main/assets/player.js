(function(){ if(window.__nmvInit){ return; } window.__nmvInit=true;
var st=document.createElement("style");st.textContent="\nhtml.nmv, html.nmv body { overflow: hidden !important; background: #000 !important; }\nhtml.nmv body * { visibility: hidden !important; }\nhtml.nmv [data-nmv-screen], html.nmv [data-nmv-screen] * { visibility: visible !important; }\nhtml.nmv-nocmt [class*=\"___comment-layer___\"] { display: none !important; }\nhtml.nmv [data-nmv-screen] {\n  /* 枠に収まる最大の16:9にして中央に置く(横長・縦長の枠でも映像が切れない。余白は黒) */\n  position: fixed !important; inset: auto !important; left: 50% !important; top: 50% !important;\n  transform: translate(-50%, -50%) !important;\n  width: min(100vw, calc(100vh * 16 / 9)) !important; height: min(100vh, calc(100vw * 9 / 16)) !important;\n  min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important;\n  margin: 0 !important; padding: 0 !important; z-index: 2147483646 !important; background: #000 !important;\n}\n/* シークバー(タイムシフトの巻き戻し)は、映像の下端に重ねて、枠にマウスを乗せたときだけ出す */\nhtml.nmv [class*=\"___seek-controller___\"], html.nmv [class*=\"___seek-controller___\"] * { visibility: visible !important; }\nhtml.nmv [class*=\"___seek-controller___\"] {\n  position: fixed !important; z-index: 2147483647 !important; margin: 0 !important; padding: 0 !important;\n  left: calc(50vw - min(100vw, 100vh * 16 / 9) / 2) !important; width: min(100vw, calc(100vh * 16 / 9)) !important;\n  top: calc(50vh + min(100vh, 100vw * 9 / 16) / 2 - 12px) !important; height: 12px !important;\n  opacity: 0; transition: opacity .15s;\n}\nhtml.nmv:hover [class*=\"___seek-controller___\"] { opacity: 1; }";document.documentElement.appendChild(st);
(() => {
  if (window.__nmvUpd) { window.__nmvUpd(); return; }
  window.__nmvOn = true;
  const SCREEN = '[class*="___player-display-screen___"]';
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
})();
window.__nmvMute=true;
setInterval(function(){document.querySelectorAll("video").forEach(function(v){var m=!!window.__nmvMute;if(v.muted!==m)v.muted=m;});},700);
})();