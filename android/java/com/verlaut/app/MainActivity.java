package com.verlaut.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

/**
 * Verlaut-WebView-Container.
 *
 * Bewusst minimal und ohne externe Bibliotheken (nur Android-Framework): eine
 * WebView, die die konfigurierte Server-Origin (HTTPS, Secure Context) lädt.
 * Alle Krypto/Logik lebt in der PWA. Der Container liefert nur, was ein
 * Browser-Tab nicht kann: Kamera-/Mikrofon-Freigabe, Datei-Upload-Dialog,
 * Downloads und ein App-Icon. Keine Werbe-IDs, keine Analytics.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "verlaut";
    private static final String KEY_URL = "server_url";
    // Build-Zeit-Default (per build.sh gesetzt). Zur Laufzeit änderbar.
    private static final String DEFAULT_URL = "@@SERVER_URL@@";

    private static final int REQ_PERMS = 42;
    private static final int REQ_FILE = 1;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                String base = currentBase();
                String host = base == null ? null : Uri.parse(base).getHost();
                // Eigene Origin bleibt in der WebView; alles andere im Browser.
                if (host != null && host.equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                // Hauptframe nicht erreichbar (falsche/abwesende Server-URL)
                // -> Nutzer nach der korrekten Adresse fragen.
                if (req.isForMainFrame()) {
                    runOnUiThread(() -> promptForUrl(true));
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // getUserMedia freigeben — aber NUR Mikrofon/Kamera, nichts anderes.
            // Die WebView lädt ohnehin nur die eigene Server-Origin.
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                final java.util.ArrayList<String> allow = new java.util.ArrayList<>();
                for (String r : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)
                            || PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) {
                        allow.add(r);
                    }
                }
                runOnUiThread(() -> {
                    if (allow.isEmpty()) request.deny();
                    else request.grant(allow.toArray(new String[0]));
                });
            }

            // <input type=file> -> System-Dateiauswahl (Bilder).
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("image/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "Bild wählen"), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        // Downloads (z. B. neue APK) an den System-Browser delegieren.
        web.setDownloadListener((url, ua, disp, mime, len) -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {}
        });

        ensurePermissions();

        String url = currentBase();
        if (url == null || url.isEmpty() || url.contains("@@")) {
            promptForUrl(true);
        } else {
            web.loadUrl(url);
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private String currentBase() {
        String saved = prefs().getString(KEY_URL, null);
        if (saved != null && !saved.isEmpty()) return saved;
        return DEFAULT_URL;
    }

    private void promptForUrl(final boolean firstRun) {
        final EditText in = new EditText(this);
        in.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        String cur = currentBase();
        in.setText(cur != null && !cur.contains("@@") ? cur : "https://");
        new AlertDialog.Builder(this)
                .setTitle("Verlaut-Server")
                .setMessage("Adresse deines Verlaut-Servers (HTTPS):")
                .setView(in)
                .setPositiveButton("Speichern", (d, w) -> {
                    String v = in.getText().toString().trim();
                    if (!v.isEmpty()) {
                        prefs().edit().putString(KEY_URL, v).apply();
                        web.loadUrl(v);
                    }
                })
                .setNegativeButton("Abbrechen", null)
                .setCancelable(!firstRun)
                .show();
    }

    private void ensurePermissions() {
        String[] need = { Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO };
        boolean missing = false;
        for (String p : need) {
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                missing = true;
                break;
            }
        }
        if (missing) requestPermissions(need, REQ_PERMS);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && fileCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{ data.getData() };
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
