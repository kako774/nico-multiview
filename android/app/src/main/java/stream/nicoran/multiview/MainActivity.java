package stream.nicoran.multiview;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;
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

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** ニコ生マルチビュー(Android版・試作)。ニコ生の視聴ページを、画面を分けて複数同時に表示する。 */
public class MainActivity extends Activity {
    private static final String DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    private static final Pattern LV = Pattern.compile("lv\\d+", Pattern.CASE_INSENSITIVE);

    private final List<String> ids = new ArrayList<>();
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

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences("mv", Context.MODE_PRIVATE);
        playerJs = readAsset("player.js");
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
        row2.addView(btn("ログイン", v -> openOverlay("ログイン", "https://account.nicovideo.jp/login?site=nicolive")));
        row2.addView(btn("全て消音", v -> { audioId = ""; applyAudio(); }));
        row2.addView(btn("全画面", v -> setFull(true)));
        toolbar.addView(row2, new LinearLayout.LayoutParams(-1, -2));

        stage = new LinearLayout(this);
        stage.setOrientation(LinearLayout.VERTICAL);
        main.addView(stage, new LinearLayout.LayoutParams(-1, 0, 1));

        setContentView(root);

        String saved = prefs.getString("ids", "");
        for (String s : saved.split(",")) if (LV.matcher(s).matches() && !ids.contains(s)) ids.add(s);
        Matcher m = LV.matcher(String.valueOf(getIntent() == null ? "" : getIntent().getDataString()));
        if (m.find()) addId(m.group().toLowerCase());
        rebuild();
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

    private void save() { prefs.edit().putString("ids", String.join(",", ids)).apply(); }

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

    private void addId(String id) { if (!ids.contains(id)) { ids.add(id); save(); } }

    private void removeId(String id) {
        ids.remove(id); save();
        WebView w = webs.remove(id);
        FrameLayout t = tiles.remove(id);
        soundBtns.remove(id);
        if (t != null && t.getParent() != null) ((ViewGroup) t.getParent()).removeView(t);
        if (w != null) { w.stopLoading(); w.destroy(); }
        if (audioId.equals(id)) audioId = "";
        rebuild();
    }

    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility"})
    private WebView makeWeb(final String id) {
        WebView w = new WebView(this);
        configure(w);
        w.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String url) {
                v.evaluateJavascript(playerJs, null);
                v.evaluateJavascript("window.__nmvMute=" + (id.equals(audioId) ? "false" : "true") + ";", null);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !"https".equals(r.getUrl().getScheme());
            }
        });
        w.loadUrl("https://live.nicovideo.jp/watch/" + id);
        return w;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configure(WebView w) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(DESKTOP_UA);
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
        bar.addView(chip("✕", v -> removeId(id)));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.END);
        f.addView(bar, lp);
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
        int n = ids.size();
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
                    row.addView(tiles.get(ids.get(idx++)), lp);
                } else {
                    row.addView(new View(this), new LinearLayout.LayoutParams(0, -1, 1));
                }
            }
        }
        applyAudio();
    }

    @Override public void onConfigurationChanged(Configuration c) { super.onConfigurationChanged(c); rebuild(); }

    /* ギフト・ログイン用の全面ウィンドウ(ログイン状態は枠と共通) */
    private void openOverlay(String title, String url) {
        closeOverlay();
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
        configure(overlayWeb);
        overlayWeb.setWebViewClient(new WebViewClient());
        overlayWeb.loadUrl(url);
        col.addView(overlayWeb, new LinearLayout.LayoutParams(-1, 0, 1));
        overlay.addView(col, new FrameLayout.LayoutParams(-1, -1));
        root.addView(overlay, new FrameLayout.LayoutParams(-1, -1));
    }

    private void closeOverlay() {
        if (overlay == null) return;
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
        if (full) { setFull(false); return; }
        super.onBackPressed();
    }

    @Override protected void onDestroy() {
        for (WebView w : webs.values()) w.destroy();
        webs.clear();
        super.onDestroy();
    }
}
