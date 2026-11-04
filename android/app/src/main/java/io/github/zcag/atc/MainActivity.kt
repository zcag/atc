package io.github.zcag.atc

import android.app.Activity
import android.app.AlertDialog
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
import android.widget.Button
import android.widget.Chronometer
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File

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
        AlertDialog.Builder(this)
            .setTitle("Pair with ${p.host}?")
            .setMessage("This phone will use the atc server at ${p.url}." + old?.let { " It replaces $it." }.orEmpty() + " Continue only if you started this pairing yourself.")
            .setPositiveButton("Pair") { _, _ -> pair(p) }
            .setNegativeButton("Cancel", null)
            .show()
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
        AlertDialog.Builder(this).apply {
            if (e is CertificateMismatch) {
                setTitle("Certificate does not match")
                setMessage("${e.host} presented a certificate that is not the one this pairing names, so atc did not connect and sent it nothing.\n\nExpected:\n${pretty(e.want)}\n\nPresented:\n${e.got?.let(::pretty) ?: "none"}")
            } else {
                setTitle("Could not pair")
                setMessage("${p.host}: ${e.message ?: "no answer"}")
            }
            setPositiveButton("OK", null)
        }.show()
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
        val path = intent.getStringExtra(EXTRA_PATH)
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

    private fun menu() = AlertDialog.Builder(this)
        .setItems(arrayOf("Change server", "Set up this phone", "Check for updates", "Close atc")) { _, i ->
            when (i) {
                0 -> setup()
                1 -> startActivity(Intent(this, ChecklistActivity::class.java))
                2 -> updater.check(manual = true)
                else -> finish()
            }
        }
        .show()

    private fun setup() {
        web?.destroy()
        web = null
        val field = EditText(this).apply {
            hint = "https://atc.example"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            isSingleLine = true
            setText(prefs.server ?: "https://")
        }
        val go = Button(this).apply { text = "Continue" }
        go.setOnClickListener {
            val url = serverUrl(field.text.toString())
                ?: return@setOnClickListener run { field.error = "Enter a URL starting with https:// or http://" }
            adopt(url, null)
            browse(url)
            firstRun()
            started()
        }
        field.setOnEditorActionListener { _, _, _ -> go.performClick() }
        val pad = (24 * resources.displayMetrics.density).toInt()
        show(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(TextView(this@MainActivity).apply { text = "atc server"; textSize = 22f })
            addView(TextView(this@MainActivity).apply { text = "Scan the code from atc pair, or Settings › Devices on a device already logged in." })
            addView(Button(this@MainActivity).apply { text = "Scan QR"; setOnClickListener { scan() } })
            addView(TextView(this@MainActivity).apply { text = "Or enter the address you open atc at in a browser."; setPadding(0, pad, 0, 0) })
            addView(field)
            addView(go)
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
        w.addJavascriptInterface(bridge, "AtcApp")
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
                if (request.url.host == serverHost()) return false
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

    private fun unreachable(url: String, why: String) {
        failed = url
        ui.removeCallbacks(retry)
        ui.postDelayed(retry, 10_000)
        if (offline != null) return
        val tailscale = packageManager.getLaunchIntentForPackage("com.tailscale.ipn")
        val pad = (24 * resources.displayMetrics.density).toInt()
        val v = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(Look.palette(this@MainActivity).board)
            setOnClickListener {}
            addView(TextView(context).apply { text = "Can't reach atc"; textSize = 22f; gravity = Gravity.CENTER })
            addView(TextView(context).apply {
                text = "${serverHost()} did not answer ($why).\n\nIf you reach it over Tailscale, check that Tailscale is connected. atc retries on its own and opens as soon as the server answers."
                gravity = Gravity.CENTER
                setPadding(0, pad / 2, 0, pad)
            })
            if (tailscale != null) addView(Button(context).apply { text = "Open Tailscale"; setOnClickListener { startActivity(tailscale) } })
            addView(Button(context).apply { text = "Retry now"; setOnClickListener { ui.removeCallbacks(retry); retry.run() } })
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
        if (leaf == null || host != serverHost() || error.hasError(SslError.SSL_IDMISMATCH)) return handler.cancel()
        sslWaiting += handler
        if (sslWaiting.size > 1) return
        val server = prefs.server ?: return handler.cancel()
        val pinned = Pin.decode(prefs.pinFor(host))
        val decide = { ok: Boolean ->
            sslWaiting.forEach { if (ok) it.proceed() else it.cancel() }
            sslWaiting.clear()
        }
        Thread {
            val chain = runCatching { Pin.chainOf(host, if (url.port > 0) url.port else 443) }.getOrDefault(emptyList())
                .takeIf { it.firstOrNull()?.encoded?.contentEquals(leaf.encoded) == true }
            val candidate = if (chain == null || pinned != null) null else Net.caFor(server, chain) ?: chain.last()
            runOnUiThread {
                when {
                    chain == null -> decide(false)
                    pinned != null && Pin.validates(chain, pinned) -> decide(true)
                    pinned != null -> {
                        decide(false)
                        unreachable(error.url, "its certificate is not from the authority you trusted")
                        AlertDialog.Builder(this)
                            .setTitle("Certificate changed")
                            .setMessage("$host presented a certificate that is not signed by the authority you trusted, so atc refused to connect.\n\nIf the server's certificate authority was replaced on purpose, choose Change server and enter it again.")
                            .setPositiveButton("OK", null)
                            .setNeutralButton("Change server") { _, _ -> setup() }
                            .show()
                    }
                    else -> AlertDialog.Builder(this)
                        .setTitle("Trust this server?")
                        .setMessage("$host uses a certificate this device does not trust. Trust it only if the fingerprint matches your server's certificate authority. atc will then accept any certificate it signs, so renewals keep working.\n\nAuthority:\n${candidate!!.subjectX500Principal.name}\n\nSHA-256:\n${pretty(sha256(candidate.encoded))}")
                        .setPositiveButton("Trust") { _, _ -> prefs.pin = "$host ${Pin.encode(candidate)}"; decide(true) }
                        .setNegativeButton("Cancel") { _, _ -> decide(false) }
                        .setCancelable(false)
                        .show()
                }
            }
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
