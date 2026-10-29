package io.github.zcag.atc

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
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
import android.webkit.PermissionRequest
import android.webkit.WebResourceError
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

class MainActivity : Activity() {
    companion object {
        const val EXTRA_ASSIST = "assist"
        const val EXTRA_PATH = "path"
        private const val REQ_MIC = 1
        private const val REQ_FILE = 2
    }

    private lateinit var prefs: Prefs
    private lateinit var bridge: Bridge
    lateinit var updater: Updater
    private var web: WebView? = null
    private var files: ValueCallback<Array<Uri>>? = null
    private var photo: File? = null
    private var mic: PermissionRequest? = null
    private val sslWaiting = mutableListOf<SslErrorHandler>()
    private var lastBack = 0L
    private var unlockThen: Intent? = null
    private var root: FrameLayout? = null
    private var offline: View? = null
    private var failed: String? = null
    private val ui = Handler(Looper.getMainLooper())
    private val retry = Runnable { failed?.let { web?.loadUrl(it) } }
    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(n: Network) { ui.postDelayed(retry, 1500) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        prefs = Prefs(this)
        bridge = Bridge(this)
        updater = Updater(this)
        route(intent)
        if (prefs.server != null) started()
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(network)
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

    override fun onDestroy() {
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(network) }
        ui.removeCallbacks(retry)
        bridge.shutdown()
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
        val assist = intent.getBooleanExtra(EXTRA_ASSIST, false) || intent.action == Intent.ACTION_ASSIST
        setShowWhenLocked(assist)
        setTurnScreenOn(assist)
        if (assist && getSystemService(KeyguardManager::class.java).isKeyguardLocked) {
            unlockThen = intent
            return
        }
        open(intent, assist)
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
            ?: if (assist) "/#/assist" else null
        val w = web
        if (w == null) browse(server + (path ?: "/")) else if (path != null) w.loadUrl(server + path)
    }

    private fun menu() = AlertDialog.Builder(this)
        .setItems(arrayOf("Change server", "Check for updates", "Voice settings", "Close atc")) { _, i ->
            when (i) {
                0 -> setup()
                1 -> updater.check(manual = true)
                2 -> runCatching { startActivity(Intent("com.android.settings.TTS_SETTINGS")) }
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
            val old = prefs.server
            val endpoint = prefs.endpoint
            if (old != null && old != url && endpoint != null) Push.unregister(this, old, endpoint)
            prefs.server = url
            prefs.pin = null
            prefs.registered = null
            prefs.feed = null
            prefs.feedError = null
            Live.changed(this)
            browse(url)
            started()
        }
        field.setOnEditorActionListener { _, _, _ -> go.performClick() }
        val pad = (24 * resources.displayMetrics.density).toInt()
        show(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(TextView(this@MainActivity).apply { text = "atc server"; textSize = 22f })
            addView(TextView(this@MainActivity).apply { text = "The address you open atc at in a browser." })
            addView(field)
            addView(go)
        })
    }

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
            override fun onPermissionRequest(request: PermissionRequest) = permission(request)

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
            setBackgroundColor(if (resources.configuration.isNightModeActive) 0xFF151C27.toInt() else 0xFFDDE2EA.toInt())
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
        ViewCompat.setOnApplyWindowInsetsListener(frame) { view, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(frame)
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

    private fun permission(request: PermissionRequest) {
        if (request.origin.host != serverHost() || PermissionRequest.RESOURCE_AUDIO_CAPTURE !in request.resources) return request.deny()
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
            return request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        mic?.deny()
        mic = request
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode != REQ_MIC) return
        val request = mic ?: return
        mic = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        else request.deny()
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
