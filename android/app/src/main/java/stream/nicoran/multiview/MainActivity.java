package stream.nicoran.multiview;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.app.AlertDialog;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.time.OffsetDateTime;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** ニコ生マルチビュー(Android版・試作)。ニコ生の視聴ページを、画面を分けて複数同時に表示する。 */
public class MainActivity extends Activity {
    private static final Pattern CHROME_VER = Pattern.compile("Chrome/([\\d.]+)");
    private static final Pattern LV = Pattern.compile("lv\\d+", Pattern.CASE_INSENSITIVE);

    private final List<String> ids = new ArrayList<>();      // いま画面に出す枠(追跡中の上位 + 手で追加した枠)
    private final List<String> manual = new ArrayList<>();   // 手で追加した枠(保存する)
    private final List<String> tracked = new ArrayList<>();  // ギフトイベントの上位(放送中の人)
    private final Set<String> dismissed = new HashSet<>();   // 追跡中に✕で閉じた枠
    private final Map<String, String> labelText = new HashMap<>();
    private final Map<String, TextView> labels = new HashMap<>();
    private final Map<String, WebView> webs = new HashMap<>();
    private final Map<String, FrameLayout> tiles = new HashMap<>();
    private final Map<String, TextView> soundBtns = new HashMap<>();
    private String audioId = "";
    private String playerJs = "";

    private FrameLayout root;
    private LinearLayout main, toolbar, stage;
    private EditText input;
    private FrameLayout overlay;
    private WebView overlayWeb;
    private SharedPreferences prefs;
    private String uaReal = "";
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newFixedThreadPool(8);
    private String trackKey = "", trackTitle = "";
    private int topN = 4;
    private int trackGen = 0;
    private boolean trackBusy = false;
    private Button evBtn, topBtn, loginBtn;
    private String focusId = "";
    private final Map<String, Integer> vols = new HashMap<>();           // 枠ごとの音量(%)
    private final Map<String, String[]> smCache = new HashMap<>();      // lv -> {取得時刻, 通常, 改, 神}
    private final Map<String, String> smText = new HashMap<>();         // lv -> 召喚獣の表示
    private final Map<String, long[]> liveT = new HashMap<>();     // uid -> 取得時刻
    private final Map<String, String> liveOf = new HashMap<>();    // uid -> 放送中のlv(なければ"")

    /** 実際のWebView(Chrome)のバージョンに合わせたUA。偽のバージョンだと、Turnstileなどのボット判定に落ちやすい。 */
    private String realUa() {
        String d = WebSettings.getDefaultUserAgent(this);
        return d.replace("; wv", "").replaceAll(" Version/[\\d.]+", "");
    }
    private String desktopUa() {
        Matcher m = CHROME_VER.matcher(WebSettings.getDefaultUserAgent(this));
        String v = m.find() ? m.group(1) : "124.0.0.0";
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + v + " Safari/537.36";
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences("mv", Context.MODE_PRIVATE);
        playerJs = readAsset("player.js");
        uaReal = WebSettings.getDefaultUserAgent(this).replace("; wv", "").replaceAll(" Version/[\\d.]+", "");
        CookieManager.getInstance().setAcceptCookie(true);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        main = new LinearLayout(this);
        main.setOrientation(LinearLayout.VERTICAL);
        root.addView(main, new FrameLayout.LayoutParams(-1, -1));

        toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.VERTICAL);
        toolbar.setBackgroundColor(0xFF1A2132);
        toolbar.setPadding(dp(6), dp(4), dp(6), dp(4));
        main.addView(toolbar, new LinearLayout.LayoutParams(-1, -2));

        LinearLayout row1 = new LinearLayout(this);
        row1.setOrientation(LinearLayout.HORIZONTAL);
        row1.setGravity(Gravity.CENTER_VERTICAL);
        input = new EditText(this);
        input.setHint("lv番号 か 放送のURL");
        input.setHintTextColor(0xFF8A94AD);
        input.setTextColor(Color.WHITE);
        input.setSingleLine(true);
        input.setTextSize(14);
        input.setImeOptions(EditorInfo.IME_ACTION_DONE);
        input.setOnEditorActionListener((v, a, e) -> { addFromInput(); return true; });
        row1.addView(input, new LinearLayout.LayoutParams(0, -2, 1));
        row1.addView(btn("追加", v -> addFromInput()));
        toolbar.addView(row1, new LinearLayout.LayoutParams(-1, -2));

        LinearLayout row2 = new LinearLayout(this);
        row2.setOrientation(LinearLayout.HORIZONTAL);
        loginBtn = btn("ログイン", v -> openOverlay("ログイン", "https://account.nicovideo.jp/login?site=nicolive"));
        row2.addView(loginBtn);
        row2.addView(btn("全て消音", v -> { audioId = ""; applyAudio(); }));
        evBtn = btn("ギフトイベント", v -> onEventButton());
        row2.addView(evBtn);
        topBtn = btn("上位4", v -> { topN = topN >= 6 ? 2 : (topN == 2 ? 3 : (topN == 3 ? 4 : 6)); topBtn.setText("上位" + topN); if (!trackKey.isEmpty()) refreshTop(); });
        row2.addView(topBtn);
        row2.addView(btn("保存枠", v -> showPresets()));
        row2.addView(btn("全画面", v -> setFull(true)));
        toolbar.addView(row2, new LinearLayout.LayoutParams(-1, -2));

        stage = new LinearLayout(this);
        stage.setOrientation(LinearLayout.VERTICAL);
        main.addView(stage, new LinearLayout.LayoutParams(-1, 0, 1));

        setContentView(root);

        String saved = prefs.getString("ids", "");
        for (String s : saved.split(",")) if (LV.matcher(s).matches() && !manual.contains(s)) manual.add(s);
        Matcher m = LV.matcher(String.valueOf(getIntent() == null ? "" : getIntent().getDataString()));
        if (m.find()) addId(m.group().toLowerCase());
        updateLoginLabel();
        recompute(); rebuild();
    }

    private Button btn(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(13);
        b.setMinWidth(0); b.setMinimumWidth(0);
        b.setPadding(dp(10), 0, dp(10), 0);
        b.setOnClickListener(l);
        return b;
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            return o.toString("UTF-8");
        } catch (Exception e) { return ""; }
    }

    private void save() { prefs.edit().putString("ids", String.join(",", manual)).apply(); }

    private void addFromInput() {
        String t = input.getText().toString();
        Matcher m = LV.matcher(t);
        boolean any = false;
        while (m.find()) { addId(m.group().toLowerCase()); any = true; }
        if (!any) { Toast.makeText(this, "lv番号が見つかりません", Toast.LENGTH_SHORT).show(); return; }
        input.setText("");
        InputMethodManager im = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (im != null) im.hideSoftInputFromWindow(input.getWindowToken(), 0);
        rebuild();
    }

    private void addId(String id) { if (!manual.contains(id)) { manual.add(id); save(); } recompute(); }

    private void removeId(String id) {
        manual.remove(id); save();
        if (tracked.contains(id)) dismissed.add(id);
        if (audioId.equals(id)) audioId = "";
        recompute(); rebuild();
    }

    /** 画面に出す枠のリストを作り直し、もう要らない枠のWebViewは片づける */
    private void recompute() {
        List<String> next = new ArrayList<>();
        for (String t : tracked) if (!dismissed.contains(t) && !next.contains(t)) next.add(t);
        for (String m : manual) if (!next.contains(m)) next.add(m);
        ids.clear(); ids.addAll(next);
        for (String id : new ArrayList<>(webs.keySet())) {
            if (ids.contains(id)) continue;
            WebView w = webs.remove(id);
            FrameLayout t = tiles.remove(id);
            soundBtns.remove(id); labels.remove(id);
            if (t != null && t.getParent() != null) ((ViewGroup) t.getParent()).removeView(t);
            if (w != null) { w.stopLoading(); w.destroy(); }
            if (audioId.equals(id)) audioId = "";
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility"})
    private WebView makeWeb(final String id) {
        WebView w = new WebView(this);
        configure(w, true);
        w.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String url) {
                v.evaluateJavascript(playerJs, null);
                v.evaluateJavascript("window.__nmvMute=" + (id.equals(audioId) ? "false" : "true") + ";", null);
                Integer vv = vols.get(id);
                if (vv != null) v.evaluateJavascript("window.__nmvVol=" + (vv / 100.0) + ";", null);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !"https".equals(r.getUrl().getScheme());
            }
        });
        w.loadUrl("https://live.nicovideo.jp/watch/" + id);
        return w;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configure(WebView w, boolean desktop) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(desktop ? desktopUa() : realUa());
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        w.setBackgroundColor(Color.BLACK);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
    }

    private FrameLayout makeTile(final String id) {
        FrameLayout f = new FrameLayout(this);
        f.setBackgroundColor(Color.BLACK);
        WebView w = webs.get(id);
        if (w == null) { w = makeWeb(id); webs.put(id, w); }
        f.addView(w, new FrameLayout.LayoutParams(-1, -1));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(0x99000000);
        TextView snd = chip("🔇", v -> { audioId = id.equals(audioId) ? "" : id; applyAudio(); });
        soundBtns.put(id, snd);
        bar.addView(snd);
        bar.addView(chip("🎁", v -> openOverlay("ギフト " + id,
            "https://gift.nicovideo.jp/live/" + id + "/purchase?frontend_id=9&frontend_version=658.1.0&item_list_disabled=false")));
        final WebView ww = w;
        bar.addView(chip("↻", v -> ww.reload()));
        bar.addView(chip("⛶", v -> { focusId = id.equals(focusId) ? "" : id; rebuild(); }));
        android.widget.SeekBar sb = new android.widget.SeekBar(this);
        sb.setMax(100); sb.setProgress(vols.containsKey(id) ? vols.get(id) : 100);
        sb.setOnSeekBarChangeListener(new android.widget.SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(android.widget.SeekBar b, int p, boolean u) {
                vols.put(id, p); ww.evaluateJavascript("window.__nmvVol=" + (p / 100.0) + ";", null);
            }
            @Override public void onStartTrackingTouch(android.widget.SeekBar b) { }
            @Override public void onStopTrackingTouch(android.widget.SeekBar b) { }
        });
        bar.addView(sb, new LinearLayout.LayoutParams(dp(80), -2));
        bar.addView(chip("✕", v -> removeId(id)));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.END);
        f.addView(bar, lp);
        TextView lab = new TextView(this);
        lab.setTextColor(Color.WHITE); lab.setTextSize(12); lab.setSingleLine(true);
        lab.setBackgroundColor(0x99000000); lab.setPadding(dp(6), dp(2), dp(6), dp(2));
        lab.setEllipsize(android.text.TextUtils.TruncateAt.END);
        lab.setMaxWidth(dp(300));
        labels.put(id, lab);
        String lt = labelText.get(id);
        lab.setText(lt == null ? "" : lt); lab.setVisibility(lt == null || lt.isEmpty() ? View.GONE : View.VISIBLE);
        f.addView(lab, new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.START));
        return f;
    }

    private TextView chip(String label, View.OnClickListener l) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextColor(Color.WHITE);
        t.setTextSize(18);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(10), dp(4), dp(10), dp(4));
        t.setOnClickListener(l);
        return t;
    }

    private void applyAudio() {
        for (Map.Entry<String, WebView> e : webs.entrySet()) {
            boolean on = e.getKey().equals(audioId);
            e.getValue().evaluateJavascript("window.__nmvMute=" + (on ? "false" : "true") + ";", null);
            TextView s = soundBtns.get(e.getKey());
            if (s != null) s.setText(on ? "🔊" : "🔇");
        }
    }

    private void rebuild() {
        for (FrameLayout t : tiles.values()) if (t.getParent() != null) ((ViewGroup) t.getParent()).removeView(t);
        for (int i = stage.getChildCount() - 1; i >= 0; i--) stage.removeViewAt(i);
        for (String id : ids) if (!tiles.containsKey(id)) tiles.put(id, makeTile(id));
        if (!focusId.isEmpty() && !ids.contains(focusId)) focusId = "";
        List<String> show = focusId.isEmpty() ? ids : java.util.Collections.singletonList(focusId);
        int n = show.size();
        if (n == 0) {
            TextView t = new TextView(this);
            t.setText("上の欄に、ニコ生の放送(lv番号かURL)を入れて「追加」してください。\n複数入れると、画面を分けて同時に表示します。");
            t.setTextColor(0xFFB0B8CC); t.setGravity(Gravity.CENTER); t.setPadding(dp(24), dp(24), dp(24), dp(24));
            stage.addView(t, new LinearLayout.LayoutParams(-1, -1));
            return;
        }
        boolean land = getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
        int cols = n <= 1 ? 1 : land ? (n <= 4 ? 2 : 3) : (n <= 3 ? 1 : 2);
        int rows = (n + cols - 1) / cols;
        int idx = 0;
        for (int r = 0; r < rows; r++) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            stage.addView(row, new LinearLayout.LayoutParams(-1, 0, 1));
            for (int c = 0; c < cols; c++) {
                if (idx < n) {
                    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, -1, 1);
                    lp.setMargins(1, 1, 1, 1);
                    row.addView(tiles.get(show.get(idx++)), lp);
                } else {
                    row.addView(new View(this), new LinearLayout.LayoutParams(0, -1, 1));
                }
            }
        }
        applyAudio();
    }

    /* ---------------- 枠の保存 ---------------- */
    private JSONObject loadPresets() {
        try { return new JSONObject(prefs.getString("presets", "{}")); } catch (Exception e) { return new JSONObject(); }
    }

    private void showPresets() {
        final JSONObject p = loadPresets();
        final List<String> names = new ArrayList<>();
        java.util.Iterator<String> it = p.keys();
        while (it.hasNext()) names.add(it.next());
        java.util.Collections.sort(names);
        String[] items = new String[names.size() + 1];
        for (int i = 0; i < names.size(); i++) items[i] = names.get(i) + "(" + p.optJSONArray(names.get(i)).length() + "枠)";
        items[names.size()] = "＋ いまの枠を保存…";
        new AlertDialog.Builder(this).setTitle("枠の保存").setItems(items, (d, which) -> {
            if (which == names.size()) savePresetDialog(); else presetActions(names.get(which), p);
        }).setNegativeButton("閉じる", null).show();
    }

    private void savePresetDialog() {
        if (ids.isEmpty()) { Toast.makeText(this, "保存する枠がありません", Toast.LENGTH_SHORT).show(); return; }
        final EditText e = new EditText(this);
        e.setHint("名前"); e.setSingleLine(true);
        new AlertDialog.Builder(this).setTitle("いまの枠を保存").setView(e).setPositiveButton("保存", (d, w) -> {
            String name = e.getText().toString().trim();
            if (name.isEmpty()) return;
            try {
                JSONObject p = loadPresets();
                p.put(name, new JSONArray(new ArrayList<>(ids)));
                prefs.edit().putString("presets", p.toString()).apply();
                Toast.makeText(this, "保存しました", Toast.LENGTH_SHORT).show();
            } catch (Exception ex) { Toast.makeText(this, "保存できませんでした", Toast.LENGTH_SHORT).show(); }
        }).setNegativeButton("キャンセル", null).show();
    }

    private void presetActions(final String name, final JSONObject p) {
        new AlertDialog.Builder(this).setTitle(name).setItems(new String[]{"開く(いまの枠と入れ替え)", "削除"}, (d, which) -> {
            if (which == 0) {
                JSONArray a = p.optJSONArray(name);
                manual.clear();
                if (a != null) for (int i = 0; i < a.length(); i++) { String id = a.optString(i); if (LV.matcher(id).matches()) manual.add(id); }
                if (!trackKey.isEmpty()) stopTrack();
                save(); recompute(); rebuild();
            } else {
                p.remove(name);
                prefs.edit().putString("presets", p.toString()).apply();
            }
        }).setNegativeButton("キャンセル", null).show();
    }

    /* ---------------- ギフトイベント ---------------- */
    private static final String AUD = "https://audition.nicovideo.jp/capi/v1";

    private String httpGet(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(7000); c.setReadTimeout(7000);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("User-Agent", uaReal);
        try {
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                byte[] buf = new byte[8192]; int n;
                while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
                return o.toString("UTF-8");
            }
        } finally { c.disconnect(); }
    }

    private static long tsec(String x) {
        try { return OffsetDateTime.parse(x).toEpochSecond(); } catch (Exception e) { return 0; }
    }

    private static final Pattern KEY_RE = Pattern.compile("^[\\w-]{1,80}$");

    private void onEventButton() {
        if (!trackKey.isEmpty()) { stopTrack(); return; }
        evBtn.setEnabled(false); evBtn.setText("取得中…");
        pool.execute(() -> {
            final List<String[]> evs = new ArrayList<>();   // key, title, kind, end
            try { evs.addAll(fetchEvents()); } catch (Exception ignored) { }
            ui.post(() -> { evBtn.setEnabled(true); evBtn.setText(trackKey.isEmpty() ? "ギフトイベント" : "追跡停止"); showEventDialog(evs); });
        });
    }

    private List<String[]> fetchEvents() throws Exception {
        long now = System.currentTimeMillis() / 1000;
        final List<String> lvs = new ArrayList<>();
        for (String kw : new String[]{"ギフト", "の"}) {
            try {
                String u = "https://live.nicovideo.jp/front/api/pages/search/v1/programs?keyword=" + URLEncoder.encode(kw, "UTF-8")
                    + "&sortOrder=viewCountDesc&column=main&status=onair&page=1";
                JSONArray ps = new JSONObject(httpGet(u)).getJSONObject("data").getJSONArray("programs");
                for (int i = 0; i < ps.length(); i++) {
                    String id = ps.getJSONObject(i).optString("nicoliveProgramId", "");
                    if (LV.matcher(id).matches() && !lvs.contains(id)) lvs.add(id);
                }
            } catch (Exception ignored) { }
        }
        final Map<String, String[]> found = new HashMap<>();
        List<Future<?>> fs = new ArrayList<>();
        for (int i = 0; i < Math.min(lvs.size(), 40); i++) {
            final String id = lvs.get(i);
            fs.add(pool.submit(() -> {
                try {
                    JSONArray items = new JSONObject(httpGet(AUD + "/entry_items?item_type=live&item_id=" + id
                        + "&include_owner_items=true&expose_platform=live")).getJSONObject("data").getJSONArray("entry_items");
                    for (int k = 0; k < items.length(); k++) {
                        JSONObject a = items.getJSONObject(k).optJSONObject("audition");
                        if (a == null) continue;
                        String key = a.optString("key", "");
                        if (!KEY_RE.matcher(key).matches()) continue;
                        long st = tsec(a.optString("voting_start_at")), en = tsec(a.optString("voting_end_at"));
                        if (st == 0 || en == 0 || now < st || now >= en) continue;
                        String it = a.optString("entry_item_type", "");
                        if (!it.isEmpty() && !it.equals("user")) continue;
                        String kind = evKind(a);
                        synchronized (found) { found.put(key, new String[]{key, a.optString("title", key), kind, String.valueOf(en)}); }
                    }
                } catch (Exception ignored) { }
            }));
        }
        for (Future<?> f : fs) { try { f.get(); } catch (Exception ignored) { } }
        List<String[]> out = new ArrayList<>(found.values());
        out.sort((x, y) -> {
            int gx = "gift".equals(x[2]) ? 0 : 1, gy = "gift".equals(y[2]) ? 0 : 1;
            return gx != gy ? gx - gy : Long.compare(Long.parseLong(x[3]), Long.parseLong(y[3]));
        });
        return out;
    }

    private static String evKind(JSONObject a) {
        boolean gift = false, ad = false;
        JSONArray rules = a.optJSONArray("score_rules");
        if (rules != null) for (int i = 0; i < rules.length(); i++) {
            JSONObject r = rules.optJSONObject(i);
            String k = r == null ? "" : r.optString("score_source_key", "");
            if (k.matches("(?i).*(nage|gift).*")) gift = true;
            if (k.matches("^nicoad_(live|video)$")) ad = true;
        }
        JSONArray pl = a.optJSONArray("expose_platforms");
        if (pl != null) for (int i = 0; i < pl.length(); i++) {
            String k = pl.optString(i, "");
            if (k.endsWith("_gift")) gift = true;
            if (k.endsWith("_nicoad")) ad = true;
        }
        return gift && !ad ? "gift" : (ad && !gift ? "ad" : "");
    }

    private void showEventDialog(final List<String[]> evs) {
        if (evs.isEmpty()) { Toast.makeText(this, "開催中のイベントが見つかりませんでした", Toast.LENGTH_LONG).show(); return; }
        String[] names = new String[evs.size()];
        java.text.SimpleDateFormat fmt = new java.text.SimpleDateFormat("M/d HH:mm", java.util.Locale.JAPAN);
        for (int i = 0; i < evs.size(); i++) {
            String[] e = evs.get(i);
            names[i] = ("gift".equals(e[2]) ? "🎁 " : "ad".equals(e[2]) ? "📢 " : "") + e[1] + "\n〜" + fmt.format(new java.util.Date(Long.parseLong(e[3]) * 1000));
        }
        new AlertDialog.Builder(this).setTitle("上位者を自動表示するイベント").setItems(names, (d, which) -> startTrack(evs.get(which)[0], evs.get(which)[1]))
            .setNegativeButton("キャンセル", null).show();
    }

    private void startTrack(String key, String title) {
        stopTrack();
        trackKey = key; trackTitle = title; trackGen++;
        dismissed.clear();
        evBtn.setText("追跡停止");
        Toast.makeText(this, "上位" + topN + "人の放送を自動表示します(10秒ごとに更新)", Toast.LENGTH_LONG).show();
        refreshTop();
    }

    private void stopTrack() {
        if (trackKey.isEmpty()) return;
        trackKey = ""; trackGen++; trackBusy = false;
        tracked.clear(); dismissed.clear(); labelText.clear();
        for (TextView t : labels.values()) { t.setText(""); t.setVisibility(View.GONE); }
        evBtn.setText("ギフトイベント");
        recompute(); rebuild();
    }

    private void refreshTop() {
        if (trackKey.isEmpty() || trackBusy) return;
        trackBusy = true;
        final int gen = trackGen; final String key = trackKey; final int n = topN;
        pool.execute(() -> {
            final List<String[]> top = new ArrayList<>();   // rank, uid, name, score, lv
            try {
                JSONArray es = new JSONObject(httpGet(AUD + "/auditions/" + key + "/rankings?limit=" + n)).getJSONObject("data").getJSONArray("entry_items");
                for (int i = 0; i < Math.min(es.length(), n); i++) {
                    JSONObject e = es.getJSONObject(i);
                    top.add(new String[]{String.valueOf(e.optInt("rank")), e.optString("item_id", ""), e.optString("name", ""),
                        String.valueOf(Math.round(e.optDouble("total_score", 0))), ""});
                }
                long now = System.currentTimeMillis();
                List<Future<?>> fs = new ArrayList<>();
                for (final String[] t : top) {
                    fs.add(pool.submit(() -> {
                        String uid = t[1];
                        if (!uid.matches("\\d{1,12}")) return;
                        long[] ts; String lv;
                        synchronized (liveOf) { ts = liveT.get(uid); lv = liveOf.get(uid); }
                        if (ts == null || now - ts[0] > 30000) {
                            lv = liveOfUser(uid);
                            synchronized (liveOf) { liveT.put(uid, new long[]{now}); liveOf.put(uid, lv); }
                        }
                        t[4] = lv == null ? "" : lv;
                        if (lv != null) {
                            String[] c;
                            synchronized (smCache) { c = smCache.get(lv); }
                            if (c == null || now - Long.parseLong(c[0]) > 30000) {
                                int[] k = summonsOf(lv);
                                c = new String[]{String.valueOf(now), String.valueOf(k[0]), String.valueOf(k[1]), String.valueOf(k[2])};
                                synchronized (smCache) { smCache.put(lv, c); }
                            }
                            String tx = (c[1].equals("0") ? "" : " 召喚獣" + c[1]) + (c[2].equals("0") ? "" : " 改" + c[2]) + (c[3].equals("0") ? "" : " 神" + c[3]);
                            synchronized (smText) { smText.put(lv, tx); }
                        }
                    }));
                }
                for (Future<?> f : fs) { try { f.get(); } catch (Exception ignored) { } }
            } catch (Exception ignored) { top.clear(); }
            ui.post(() -> {
                trackBusy = false;
                if (gen != trackGen || trackKey.isEmpty()) return;
                if (!top.isEmpty()) applyTop(top);
                ui.postDelayed(this::refreshTop, 10000);
            });
        });
    }

    /** 番組のギフト履歴から、召喚獣(通常/改/神)の個数を数える */
    private int[] summonsOf(String lv) {
        int[] out = new int[3];
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("https://api.gift.nicovideo.jp/v3/contents/nage_agv/" + lv + "/histories").openConnection();
            c.setConnectTimeout(6000); c.setReadTimeout(6000);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("x-frontend-id", "9"); c.setRequestProperty("x-frontend-version", "657.0.0");
            c.setRequestProperty("Origin", "https://gift.nicovideo.jp"); c.setRequestProperty("Referer", "https://gift.nicovideo.jp/");
            c.setRequestProperty("User-Agent", uaReal);
            if (c.getResponseCode() != 200) return out;
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) { byte[] buf = new byte[8192]; int n; while ((n = in.read(buf)) > 0) o.write(buf, 0, n); }
            JSONArray hs = new JSONObject(o.toString("UTF-8")).getJSONObject("data").getJSONArray("histories");
            for (int i = 0; i < hs.length(); i++) {
                JSONObject item = hs.getJSONObject(i).optJSONObject("item");
                String name = item == null ? "" : java.text.Normalizer.normalize(item.optString("name", ""), java.text.Normalizer.Form.NFKC).replaceAll("\\s+", "");
                if (!name.startsWith("召喚獣")) continue;
                if (name.contains("神") || name.contains("ゴッド")) out[2]++;
                else if (name.contains("改")) out[1]++;
                else if (name.equals("召喚獣")) out[0]++;
            }
        } catch (Exception ignored) { } finally { if (c != null) c.disconnect(); }
        return out;
    }

    private String liveOfUser(String uid) {
        try {
            JSONArray l = new JSONObject(httpGet("https://live.nicovideo.jp/front/api/v2/user-broadcast-history?providerId=" + uid
                + "&providerType=user&isIncludeNonPublic=false&offset=0&limit=10")).getJSONObject("data").getJSONArray("programsList");
            for (int i = 0; i < l.length(); i++) {
                JSONObject it = l.getJSONObject(i);
                Object idv = it.opt("id");
                String id = idv instanceof JSONObject ? ((JSONObject) idv).optString("value", "") : String.valueOf(idv);
                JSONObject sc = it.optJSONObject("program") == null ? null : it.optJSONObject("program").optJSONObject("schedule");
                if (sc != null && "ON_AIR".equals(sc.optString("status")) && LV.matcher(id).matches()) return id;
            }
        } catch (Exception ignored) { }
        return null;
    }

    private void applyTop(List<String[]> top) {
        List<String> next = new ArrayList<>();
        Map<String, String> lab = new HashMap<>();
        java.text.NumberFormat nf = java.text.NumberFormat.getIntegerInstance();
        for (String[] t : top) {
            if (t[4].isEmpty()) continue;
            if (!next.contains(t[4])) next.add(t[4]);
            String sm; synchronized (smText) { sm = smText.get(t[4]); }
            lab.put(t[4], t[0] + "位 " + t[2] + " " + nf.format(Long.parseLong(t[3])) + "pt" + (sm == null ? "" : sm));
        }
        boolean same = next.equals(tracked);
        tracked.clear(); tracked.addAll(next);
        labelText.clear(); labelText.putAll(lab);
        for (Map.Entry<String, TextView> e : labels.entrySet()) {
            String lt = labelText.get(e.getKey());
            e.getValue().setText(lt == null ? "" : lt);
            e.getValue().setVisibility(lt == null ? View.GONE : View.VISIBLE);
        }
        if (!same) { recompute(); rebuild(); }
    }

    @Override public void onConfigurationChanged(Configuration c) { super.onConfigurationChanged(c); rebuild(); }

    /* ギフト・ログイン用の全面ウィンドウ(ログイン状態は枠と共通) */
    private void openOverlay(String title, String url) {
        closeOverlay();
        overlayIsLogin = title.startsWith("ログイン");
        overlay = new FrameLayout(this);
        overlay.setBackgroundColor(0xFF0F1420);
        overlay.setClickable(true);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        LinearLayout top = new LinearLayout(this);
        top.setBackgroundColor(0xFF1A2132);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView tt = new TextView(this);
        tt.setText(title); tt.setTextColor(Color.WHITE); tt.setPadding(dp(12), 0, 0, 0);
        top.addView(tt, new LinearLayout.LayoutParams(0, -2, 1));
        top.addView(btn("閉じる", v -> closeOverlay()));
        col.addView(top, new LinearLayout.LayoutParams(-1, -2));
        overlayWeb = new WebView(this);
        configure(overlayWeb, false);   // ログイン・ギフトは、そのままのスマホ表示(UAを偽らない)
        overlayWeb.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String u) { CookieManager.getInstance().flush(); updateLoginLabel(); }
        });
        overlayWeb.loadUrl(url);
        col.addView(overlayWeb, new LinearLayout.LayoutParams(-1, 0, 1));
        overlay.addView(col, new FrameLayout.LayoutParams(-1, -1));
        root.addView(overlay, new FrameLayout.LayoutParams(-1, -1));
    }

    private boolean overlayIsLogin = false;

    private boolean loggedIn() {
        String c = CookieManager.getInstance().getCookie("https://www.nicovideo.jp");
        return c != null && c.contains("user_session=") && !c.contains("user_session=deleted");
    }

    private void updateLoginLabel() { if (loginBtn != null) loginBtn.setText(loggedIn() ? "ログイン済" : "ログイン"); }

    private void closeOverlay() {
        if (overlay == null) return;
        CookieManager.getInstance().flush();
        boolean wasLogin = overlayIsLogin; overlayIsLogin = false;
        if (wasLogin) {   // ログイン後は、すでに開いている枠も読み込み直して、ログイン状態にする
            ui.post(() -> { updateLoginLabel(); for (WebView w : webs.values()) w.reload(); });
        }
        root.removeView(overlay);
        if (overlayWeb != null) { overlayWeb.stopLoading(); overlayWeb.destroy(); }
        overlay = null; overlayWeb = null;
    }

    private boolean full = false;
    private void setFull(boolean on) {
        full = on;
        toolbar.setVisibility(on ? View.GONE : View.VISIBLE);
        int flags = on ? (View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE) : View.SYSTEM_UI_FLAG_VISIBLE;
        getWindow().getDecorView().setSystemUiVisibility(flags);
        if (on) Toast.makeText(this, "戻るボタンで元の表示に戻ります", Toast.LENGTH_SHORT).show();
    }

    @Override public void onBackPressed() {
        if (overlay != null) { closeOverlay(); return; }
        if (!focusId.isEmpty()) { focusId = ""; rebuild(); return; }
        if (full) { setFull(false); return; }
        super.onBackPressed();
    }

    @Override protected void onDestroy() {
        trackKey = ""; pool.shutdownNow();
        for (WebView w : webs.values()) w.destroy();
        webs.clear();
        super.onDestroy();
    }
}
