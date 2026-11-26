package io.github.zcag.atc

import android.app.Activity
import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import com.google.zxing.integration.android.IntentIntegrator
import android.widget.Chronometer
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import android.content.pm.PackageManager
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File
import java.security.cert.X509Certificate

class MainActivity : Activity() {
    companion object {
        const val EXTRA_ASSIST = "assist"
        const val EXTRA_PATH = "path"
        const val HOLD = "/#/hold"
        private const val REQ_FILE = 2
        private const val COOKIE_AGE = 400 * 24 * 3600
    }

    private lateinit var prefs: Prefs
    private lateinit var bridge: Bridge
    lateinit var updater: Updater
    private var web: WebView? = null
    private var files: ValueCallback<Array<Uri>>? = null
    private var photo: File? = null
    private val sslWaiting = mutableListOf<SslErrorHandler>()
    private var lastBack = 0L
    private var unlockThen: Intent? = null
    private var root: FrameLayout? = null
    private var callBar: LinearLayout? = null
    private var callLabel: TextView? = null
    private var callTimer: Chronometer? = null
    private var bars = androidx.core.graphics.Insets.NONE
    private var lightStatus: Boolean? = null
    private val scope = MainScope()
    private var offline: View? = null
    private var veil: View? = null
    private var failed: String? = null
    private val ui = Handler(Looper.getMainLooper())
    private val retry = Runnable { failed?.let { web?.loadUrl(it) } }
    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(n: Network) { ui.postDelayed(retry, 1500) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
        prefs = Prefs(this)
        paint()
        bridge = Bridge(this)
        updater = Updater(this)
        prefs.server?.let { restoreLogin(it) }
        route(intent)
        if (prefs.server != null) started()
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(network)
        scope.launch { Calls.state.collect { showCall(it) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        route(intent)
    }

    override fun onResume() {
        super.onResume()
        web?.onResume()
        unlockThen?.let { i -> unlockThen = null; ui.post { unlock(i) } }
        if (prefs.server == null) return
        Push.sync(this)
        Live.refresh(this)
        updater.maybeCheck()
        updater.resume()
    }

    override fun onPause() {
        super.onPause()
        web?.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onStop() {
        super.onStop()
        js("window.leaveHold?.()")
    }

    override fun onDestroy() {
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(network) }
        ui.removeCallbacks(retry)
        scope.cancel()
        web?.destroy()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val w = web
        when {
            w == null -> @Suppress("DEPRECATION") super.onBackPressed()
            w.canGoBack() -> w.goBack()
            SystemClock.uptimeMillis() - lastBack < 2000 -> menu()
            else -> {
                lastBack = SystemClock.uptimeMillis()
                Toast.makeText(this, "Press back again for options", Toast.LENGTH_SHORT).show()
            }
        }
    }

    fun js(code: String) = web?.evaluateJavascript(code, null)

    fun openOutside(url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme != "http" && uri.scheme != "https") return
        if (uri.host != serverHost()) return runOnUiThread { runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) } }
        downloadOwn(url, "open") { f, type ->
            val view = Intent(Intent.ACTION_VIEW).setDataAndType(FileProvider.getUriForFile(this, "$packageName.files", f), type)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            runCatching { startActivity(Intent.createChooser(view, f.name)) }
                .onFailure { Toast.makeText(this, "No app on this phone opens ${f.name}", Toast.LENGTH_LONG).show() }
        }
    }

    fun openInBrowser(url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme != "http" && uri.scheme != "https") return
        val probe = Intent(Intent.ACTION_VIEW, Uri.parse("https://example.org/")).addCategory(Intent.CATEGORY_BROWSABLE)
        val browser = packageManager.resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
            ?.takeIf { it != packageName && it != "android" }
            ?: packageManager.queryIntentActivities(probe, 0).map { it.activityInfo.packageName }.firstOrNull { it != packageName }
            ?: return runOnUiThread { Toast.makeText(this, "No browser on this phone", Toast.LENGTH_LONG).show() }
        runOnUiThread {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(browser)) }
                .onFailure { Toast.makeText(this, "The browser didn't open it", Toast.LENGTH_LONG).show() }
        }
    }

    fun copyImage(url: String) {
        if (Uri.parse(url).host != serverHost()) return
        downloadOwn(url, "clip") { f, _ ->
            val clip = ClipData.newUri(contentResolver, f.name, FileProvider.getUriForFile(this, "$packageName.files", f))
            getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
            if (Build.VERSION.SDK_INT < 33) Toast.makeText(this, "Image copied", Toast.LENGTH_SHORT).show()
        }
    }

    private fun downloadOwn(url: String, dirName: String, then: (File, String) -> Unit) {
        val name = Uri.parse(url).lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "file"
        Thread {
            val dir = File(cacheDir, dirName).apply { deleteRecursively(); mkdirs() }
            val f = File(dir, name)
            val ok = runCatching { Net.download(this, url, f) }.isSuccess
            runOnUiThread {
                if (!ok) return@runOnUiThread Toast.makeText(this, "Could not download $name", Toast.LENGTH_LONG).show()
                then(f, android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "application/octet-stream")
            }
        }.start()
    }

    private fun started() {
        Push.start(this)
        updater.check(manual = false)
    }

    private fun route(intent: Intent) {
        intent.data?.takeIf { it.scheme == "atc" }?.let { return atcLink(it.toString()) }
        val assist = intent.getBooleanExtra(EXTRA_ASSIST, false) || intent.action == Intent.ACTION_ASSIST
        if (assist && Calls.state.value.live) return toCall()
        setShowWhenLocked(assist)
        setTurnScreenOn(assist)
        if (assist && getSystemService(KeyguardManager::class.java).isKeyguardLocked) {
            unlockThen = intent
            return
        }
        open(intent, assist)
    }

    private fun atcLink(link: String) {
        setShowWhenLocked(false)
        setTurnScreenOn(false)
        val server = prefs.server
        if (link.startsWith("atc://open")) {
            if (server == null) return setup()
            val path = Pairing.openPath(link) ?: return Toast.makeText(this, "That link does not name a page on atc", Toast.LENGTH_LONG).show()
            return open(Intent().putExtra(EXTRA_PATH, path), false)
        }
        if (web == null) if (server != null) browse("$server/") else setup()
        val p = Pairing.parse(link) ?: return Toast.makeText(this, "That is not an atc pairing link", Toast.LENGTH_LONG).show()
        if (prefs.spentCode != p.code) confirmPair(p)
    }

    private fun confirmPair(p: Pairing) {
        val old = prefs.server?.takeIf { Uri.parse(it).host != p.host }
        Ui(this).message("Pair with ${p.host}?",
            "This phone will use the atc server at ${p.url}." + old?.let { " It replaces $it." }.orEmpty() + " Continue only if you started this pairing yourself.",
            Ui.Act("Cancel"), Ui.Act("Pair", primary = true) { pair(p) })
    }

    private fun scanned(text: String?) {
        if (text == null) return
        val p = Pairing.parse(text) ?: return Toast.makeText(this, "That QR code is not an atc pairing", Toast.LENGTH_LONG).show()
        if (prefs.server == null || Uri.parse(prefs.server).host == p.host) pair(p) else confirmPair(p)
    }

    private fun pair(p: Pairing) {
        Toast.makeText(this, "Pairing with ${p.host}", Toast.LENGTH_SHORT).show()
        Thread {
            val r = runCatching { Pairer.claim(this, p, Build.MODEL) }
            runOnUiThread { r.fold({ paired(p, it) }, { pairFailed(p, it) }) }
        }.start()
    }

    private fun paired(p: Pairing, c: Claimed) {
        prefs.spentCode = p.code
        adopt(p.url, c.pin)
        prefs.token = c.token
        restoreLogin(p.url, replace = true) {
            browse("${p.url}/")
            firstRun()
            started()
        }
    }

    private fun pairFailed(p: Pairing, e: Throwable) {
        val k = Ui(this)
        if (e !is CertificateMismatch) return run { k.message("Could not pair", "${p.host}: ${e.message ?: "no answer"}") }
        k.dialog("Certificate does not match", body = k.column(k.dp(10),
            k.text("${e.host} presented a certificate that is not the one this pairing names, so atc did not connect and sent it nothing.", 14f, k.pal.dim),
            k.check("Expected", detail = pretty(e.want)),
            k.check("Presented", detail = e.got?.let(::pretty) ?: "none"),
        ), acts = listOf(Ui.Act("OK", primary = true)))
    }

    private fun restoreLogin(server: String, replace: Boolean = false, then: () -> Unit = {}) {
        val token = prefs.token
        val cookies = CookieManager.getInstance()
        val has = cookies.getCookie(server)?.split(";")?.any { it.trim().startsWith("atc=") } == true
        if (token == null || (has && !replace)) return then()
        cookies.setCookie(server, "atc=$token; Path=/; Max-Age=$COOKIE_AGE; HttpOnly; SameSite=Strict") {
            cookies.flush()
            then()
        }
    }

    private fun adopt(url: String, pin: String?) {
        val old = prefs.server
        val endpoint = prefs.endpoint
        if (old != null && old != url && endpoint != null) Push.unregister(this, old, endpoint)
        if (old != url) prefs.token = null
        prefs.server = url
        prefs.pin = pin
        prefs.registered = null
        prefs.feed = null
        prefs.feedError = null
        Live.changed(this)
        web?.destroy()
        web = null
    }

    private fun firstRun() {
        if (prefs.checklist != null) return
        prefs.checklist = "1"
        prefs.hinted = "1"
        startActivity(Intent(this, ChecklistActivity::class.java))
    }

    private fun toCall() {
        setShowWhenLocked(false)
        setTurnScreenOn(false)
        startActivity(CallActivity.open(this))
        val server = prefs.server
        if (web == null && server != null) browse("$server/")
    }

    private fun unlock(intent: Intent) = getSystemService(KeyguardManager::class.java)
        .requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() = open(intent, true)
            override fun onDismissCancelled() = finish()
            override fun onDismissError() {
                Toast.makeText(this@MainActivity, "Could not ask to unlock", Toast.LENGTH_LONG).show()
                finish()
            }
        })

    private fun open(intent: Intent, assist: Boolean) {
        val server = prefs.server ?: return setup()
        val path = intent.getStringExtra(EXTRA_PATH)?.takeIf(Pairing::isLocalPath)
            ?: intent.data?.takeIf { it.host == serverHost() }?.let { u ->
                u.encodedPath.orEmpty().ifEmpty { "/" } + u.encodedQuery?.let { "?$it" }.orEmpty() + u.encodedFragment?.let { "#$it" }.orEmpty()
            }
            ?: if (assist) HOLD else null
        val w = web
        if (w == null) return browse(server + (path ?: "/"))
        if (path == null) return
        if (path == HOLD) veilUntil(w, ".hold")
        w.loadUrl(server + path)
    }

    private fun veilUntil(w: WebView, selector: String) {
        if (veil == null) veil = View(this).apply { setBackgroundColor(Look.palette(this@MainActivity).board); setOnClickListener {} }
            .also { root?.addView(it, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT) }
        val giveUp = SystemClock.uptimeMillis() + 2500
        val lift = Runnable { veil?.let { root?.removeView(it) }; veil = null }
        ui.postDelayed(lift, 3000)
        val check = object : Runnable {
            override fun run() = w.evaluateJavascript("!!document.querySelector('$selector')") { found ->
                if (found != "true" && SystemClock.uptimeMillis() < giveUp) ui.postDelayed(this, 16)
                else w.postVisualStateCallback(0, object : WebView.VisualStateCallback() {
                    override fun onComplete(id: Long) { ui.removeCallbacks(lift); lift.run() }
                })
            }
        }
        ui.post(check)
    }

    private fun menu() = Ui(this).menu("atc", listOf(
        Ui.Act("Change server") { setup() },
        Ui.Act("Set up this phone") { startActivity(Intent(this, ChecklistActivity::class.java)) },
        Ui.Act("Check for updates") { updater.check(manual = true) },
        Ui.Act("Close atc") { finish() },
    ))

    private fun setup() {
        web?.destroy()
        web = null
        val ui = Ui(this)
        val pal = ui.pal
        val field = ui.field("https://atc.example").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setText(prefs.server ?: "https://")
        }
        val status = ui.column(ui.dp(10))
        var trust: Pair<String, String>? = null
        var asked = 0
        lateinit var go: TextView
        fun say(vararg rows: View) {
            status.removeAllViews()
            rows.forEachIndexed { i, v -> status.addView(v, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { if (i > 0) topMargin = ui.dp(10) }) }
        }
        fun connect(url: String, pin: String?) {
            adopt(url, pin)
            browse(url)
            firstRun()
            started()
        }
        go = ui.button("Connect", primary = true) {
            val url = serverUrl(field.text.toString())
                ?: return@button run { field.error = "Enter an address starting with https:// or http://" }
            trust?.takeIf { it.first == url }?.let { return@button connect(url, it.second) }
            val host = Uri.parse(url).host!!
            val pinned = prefs.pinFor(host)
            val n = ++asked
            say(ui.text("Checking $host…", 13f, pal.dim))
            Thread {
                val r = Net.reach(url, Pin.decode(pinned))
                runOnUiThread {
                    if (n != asked || web != null) return@runOnUiThread
                    val answers = ui.check("$host answers", ok = true)
                    when (r) {
                        Reach.Ok -> connect(url, pinned?.let { "$host $it" })
                        is Reach.Untrusted -> {
                            trust = url to "$host ${Pin.encode(r.anchor)}"
                            go.text = "Trust and connect"
                            say(answers, ui.check(
                                if (r.replaces) "Its certificate authority is not the one you trusted." else "Its certificate is not one this phone trusts.",
                                "Trust it only if this is your server's own certificate authority (pairing with a QR code checks it for you). atc then accepts any certificate it signs, so renewals keep working.",
                                "${r.anchor.subjectX500Principal.name}\nSHA-256 ${pretty(sha256(r.anchor.encoded))}",
                            ))
                        }
                        is Reach.Refused -> say(answers, ui.check("atc won't connect: ${r.why}.", "It sent the server nothing. Fix the certificate, or check the address."))
                        is Reach.Down -> say(ui.check("$host did not answer.", "${r.why}. If you reach it over Tailscale, check that Tailscale is connected."))
                    }
                }
            }.start()
        }
        field.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) {
                if (trust == null && status.childCount == 0) return
                trust = null
                asked++
                go.text = "Connect"
                status.removeAllViews()
            }
        })
        field.setOnEditorActionListener { _, _, _ -> go.performClick() }
        val back = prefs.server?.let { s -> ui.button("Cancel", quiet = true) { browse("$s/") } }
        val gap = ui.dp(10)
        show(android.widget.ScrollView(this).apply {
            isFillViewport = true
            addView(ui.column(gap,
                ui.mark(),
                ui.heading("Connect to your atc").apply { setPadding(0, ui.dp(4), 0, 0) },
                ui.text("Scan the code from atc pair, or from Settings › Devices on a device already logged in.", 14f, pal.dim),
                ui.actions(listOf(ui.button("Scan QR") { scan() }), null).apply { gravity = Gravity.START },
                ui.text("Or enter the address you open atc at in a browser.", 14f, pal.dim).apply { setPadding(0, ui.dp(8), 0, 0) },
                ui.text("Server address", 13f, bold = true),
                field,
                status,
                ui.actions(listOfNotNull(back, go), grow = go),
            ).apply {
                gravity = Gravity.CENTER_VERTICAL
                setPadding(ui.dp(18), ui.dp(22), ui.dp(18), ui.dp(16))
            })
        })
    }

    private fun scan() = IntentIntegrator(this)
        .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
        .setPrompt("Scan the atc pairing code")
        .setBeepEnabled(false)
        .setOrientationLocked(false)
        .initiateScan()

    private fun browse(url: String) {
        val w = WebView(this)
        web = w
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString AtcApp/${BuildConfig.VERSION_CODE}"
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(w, true)
        }
        openBridge(w)
        w.webViewClient = object : WebViewClient() {
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) = sslError(handler, error)

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) = Push.sync(this@MainActivity)

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) unreachable(request.url.toString(), error.description.toString())
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (failed == null) reachable()
                failed = null
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                if (request.url.host == serverHost()) Shared.serve(request.url.path) else null

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame || request.url.host == serverHost()) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams) =
                chooseFile(callback, params)
        }
        show(w)
        w.loadUrl(url)
    }

    private fun openBridge(w: WebView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT))
            return run { android.util.Log.w("atc", "this WebView cannot limit the bridge to atc's own frames, so the page gets none") }
        val origins = bridgeOrigins(prefs.server ?: return)
        val gate = Gate(bridge)
        runCatching { WebViewCompat.addDocumentStartJavaScript(w, gate.startScript(origins), origins) }
            .onSuccess { w.addJavascriptInterface(gate, Gate.NAME) }
            .onFailure { android.util.Log.w("atc", "no bridge for $origins", it) }
    }

    private fun unreachable(url: String, why: String, refused: Boolean = false) {
        failed = url
        ui.removeCallbacks(retry)
        ui.postDelayed(retry, 10_000)
        if (offline != null) return
        val k = Ui(this)
        val tailscale = packageManager.getLaunchIntentForPackage("com.tailscale.ipn")?.takeIf { !refused }
        val since = java.text.SimpleDateFormat("HH:mm", java.util.Locale.ROOT).format(java.util.Date())
        val retryNow = k.button("Retry", primary = true) { ui.removeCallbacks(retry); retry.run() }
        val v = k.column(k.dp(10),
            k.heading(if (refused) "atc refused ${serverHost()}" else "Offline since $since"),
            k.text(if (refused) "${why.replaceFirstChar { it.uppercase() }}, so atc did not connect and sent it nothing."
                else "${serverHost()} did not answer ($why). atc tries again on its own and opens as soon as it answers.", 14f, k.pal.dim),
            if (refused) k.text("If its certificate changed on purpose, choose Change server and enter the address again.", 14f, k.pal.dim)
            else tailscale?.let { k.text("If you reach it over Tailscale, check that Tailscale is connected.", 14f, k.pal.dim) },
            k.actions(listOfNotNull(
                if (refused) k.button("Change server", quiet = true) { setup() } else null,
                tailscale?.let { t -> k.button("Open Tailscale") { startActivity(t) } },
                retryNow,
            ), grow = retryNow),
        ).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(k.dp(18), k.dp(22), k.dp(18), k.dp(16))
            setBackgroundColor(k.pal.board)
            setOnClickListener {}
        }
        offline = v
        root?.addView(v, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
    }

    private fun reachable() {
        ui.removeCallbacks(retry)
        offline?.let { root?.removeView(it) }
        offline = null
    }

    private fun show(v: View) {
        offline = null
        val frame = FrameLayout(this).apply { addView(v) }
        root = frame
        val bar = callBar()
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(bar, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            addView(frame, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        ViewCompat.setOnApplyWindowInsetsListener(page) { _, insets ->
            bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            pad()
            WindowInsetsCompat.CONSUMED
        }
        setContentView(page)
        paint()
        showCall(Calls.state.value)
    }

    fun paint() {
        val pal = Look.palette(this)
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(pal.board))
        root?.setBackgroundColor(pal.board)
        web?.setBackgroundColor(pal.board)
        val bars = WindowCompat.getInsetsController(window, window.decorView)
        bars.isAppearanceLightNavigationBars = !pal.dark
        if (lightStatus != null) lightStatus = !pal.dark else bars.isAppearanceLightStatusBars = !pal.dark
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun callBar(): LinearLayout {
        val label = TextView(this).apply { setTextColor(android.graphics.Color.WHITE); textSize = 15f }
        val timer = Chronometer(this).apply { setTextColor(android.graphics.Color.WHITE); textSize = 15f; setPadding(dp(10), 0, 0, 0) }
        callLabel = label
        callTimer = timer
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xff30a46c.toInt())
            visibility = View.GONE
            contentDescription = "Return to the call"
            setOnClickListener { startActivity(CallActivity.open(this@MainActivity)) }
            addView(label)
            addView(timer)
            callBar = this
        }
    }

    private fun pad() {
        val bar = callBar ?: return
        val on = bar.visibility == View.VISIBLE
        (bar.parent as? View)?.setPadding(bars.left, 0, bars.right, bars.bottom)
        bar.setPadding(dp(16), bars.top + dp(8), dp(16), dp(10))
        root?.setPadding(0, if (on) 0 else bars.top, 0, 0)
    }

    private fun showCall(st: Calls.State) {
        val bar = callBar ?: return
        val on = st.live
        val status = WindowCompat.getInsetsController(window, window.decorView)
        if (on && lightStatus == null) lightStatus = status.isAppearanceLightStatusBars.also { status.isAppearanceLightStatusBars = false }
        if (!on) lightStatus?.let { status.isAppearanceLightStatusBars = it; lightStatus = null }
        val active = st.phase == Calls.Phase.Active
        callLabel?.text = if (active) "Tap to return to the call" else "Assistant · " + CallActivity.status(st)
        callTimer?.apply {
            visibility = if (active) View.VISIBLE else View.GONE
            if (active) { base = st.since; start() } else stop()
        }
        if ((bar.visibility == View.VISIBLE) == on) return
        bar.visibility = if (on) View.VISIBLE else View.GONE
        pad()
    }

    private fun serverHost() = prefs.server?.let { Uri.parse(it).host }

    private fun sslError(handler: SslErrorHandler, error: SslError) {
        val leaf = error.certificate.x509Certificate
        val url = Uri.parse(error.url)
        val host = url.host ?: return handler.cancel()
        val main = host == serverHost()
        val refuse = { why: String -> handler.cancel(); refused(host, main, error.url, why) }
        if (leaf == null) return refuse("it sent no certificate atc could read")
        if (error.hasError(SslError.SSL_IDMISMATCH)) return refuse(Pin.wrongName(leaf, host) ?: "its certificate is not for $host")
        if (error.hasError(SslError.SSL_EXPIRED) || error.hasError(SslError.SSL_NOTYETVALID))
            return refuse("its certificate is not valid today (valid ${Pin.day(leaf.notBefore)} to ${Pin.day(leaf.notAfter)})")
        if (!main) return signedByServerAuthority(handler, host, url.port, leaf, refuse)
        sslWaiting += handler
        if (sslWaiting.size > 1) return
        val server = prefs.server ?: return handler.cancel()
        val pinned = Pin.decode(prefs.pinFor(host))
        val decide = { ok: Boolean ->
            sslWaiting.forEach { if (ok) it.proceed() else it.cancel() }
            sslWaiting.clear()
        }
        Thread {
            val fetched = runCatching { Pin.chainOf(host, if (url.port > 0) url.port else 443) }
            val chain = fetched.getOrDefault(emptyList()).takeIf { it.firstOrNull()?.encoded?.contentEquals(leaf.encoded) == true }
            val candidate = if (chain == null || pinned != null) null else Net.caFor(server, chain) ?: chain.last()
            runOnUiThread {
                val k = Ui(this)
                when {
                    chain == null -> {
                        decide(false)
                        refused(host, true, error.url, fetched.exceptionOrNull()?.let { "atc could not fetch its certificate to check it (${it.message ?: it.javaClass.simpleName})" }
                            ?: "the certificate it sent when atc checked it is not the one the page got")
                    }
                    pinned != null && Pin.validates(chain, pinned) -> decide(true)
                    pinned != null -> {
                        decide(false)
                        refused(host, true, error.url, "its certificate is not signed by the authority you trusted")
                    }
                    else -> k.dialog("Trust $host?", meta = candidate!!.subjectX500Principal.name, body = k.column(k.dp(10),
                        k.text("Its certificate is not one this phone trusts. Trust it only if this is your server's own certificate authority. atc then accepts any certificate it signs, so renewals keep working.", 14f, k.pal.dim),
                        k.check("SHA-256", detail = pretty(sha256(candidate.encoded))),
                    ), acts = listOf(
                        Ui.Act("Cancel") { decide(false) },
                        Ui.Act("Trust and connect", primary = true) { prefs.pin = "$host ${Pin.encode(candidate)}"; decide(true) },
                    ), cancelable = false)
                }
            }
        }.start()
    }

    private val refusedHosts = mutableSetOf<String>()

    /** Says why atc did not connect: for the server, its offline screen and a dialog; for anything else on the page, once per host. */
    private fun refused(host: String, main: Boolean, url: String, why: String) {
        if (!main) {
            if (refusedHosts.add(host)) Toast.makeText(this, "atc refused $host: $why.", Toast.LENGTH_LONG).show()
            return
        }
        unreachable(url, why, refused = true)
    }

    private fun signedByServerAuthority(handler: SslErrorHandler, host: String, port: Int, leaf: X509Certificate, refuse: (String) -> Unit) {
        val anchor = Pin.decode(prefs.pinFor(serverHost())) ?: return refuse("this phone does not trust its certificate")
        Thread {
            val chain = runCatching { Pin.chainOf(host, if (port > 0) port else 443) }.getOrDefault(emptyList())
            val ok = chain.firstOrNull()?.encoded?.contentEquals(leaf.encoded) == true && Pin.validates(chain, anchor)
            runOnUiThread { if (ok) handler.proceed() else refuse("its certificate is not signed by the authority you trusted for ${serverHost()}") }
        }.start()
    }

    private fun chooseFile(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        files?.onReceiveValue(null)
        files = callback
        val wantsImage = params.acceptTypes.all { it.isEmpty() } || params.acceptTypes.any { it.startsWith("image") }
        val camera = if (!wantsImage) null else File(cacheDir, "photo-${System.currentTimeMillis()}.jpg").let { f ->
            photo = f
            Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(MediaStore.EXTRA_OUTPUT, FileProvider.getUriForFile(this, "$packageName.files", f))
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(params.createIntent(), null)
        if (camera != null) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(camera))
        return runCatching { startActivityForResult(chooser, REQ_FILE) }.onFailure { files = null }.isSuccess
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        IntentIntegrator.parseActivityResult(requestCode, resultCode, data)?.let { return scanned(it.contents) }
        if (requestCode != REQ_FILE) return super.onActivityResult(requestCode, resultCode, data)
        val shot = photo?.takeIf { it.length() > 0 }?.let { FileProvider.getUriForFile(this, "$packageName.files", it) }
        val uris = if (resultCode != RESULT_OK) null
        else data?.clipData?.let { c -> Array(c.itemCount) { c.getItemAt(it).uri } }
            ?: data?.data?.let { arrayOf(it) }
            ?: shot?.let { arrayOf(it) }
        files?.onReceiveValue(uris)
        files = null
        photo = null
    }
}
