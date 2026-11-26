plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val commits = providers.exec { commandLine("git", "rev-list", "--count", "HEAD") }
    .standardOutput.asText.get().trim().toInt()

val secrets = file(providers.gradleProperty("atc.secrets").getOrElse("${System.getProperty("user.home")}/.config/atc/android"))
val password = secrets.resolve("keystore.env").takeIf { it.exists() }?.readLines()
    ?.firstOrNull { it.startsWith("KEY_PASSWORD=") }?.substringAfter("=")
val appLinkHost = providers.gradleProperty("atc.appLinkHost").orNull
    ?: secrets.resolve("app.env").takeIf { it.exists() }?.readLines()
        ?.firstOrNull { it.startsWith("APP_LINK_HOST=") }?.substringAfter("=")?.trim()?.ifEmpty { null }

android {
    namespace = "io.github.zcag.atc"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.zcag.atc"
        minSdk = 29
        targetSdk = 35
        versionCode = commits + rootProject.file("version-base").readText().trim().toInt()
        versionName = "0.$commits"
        ndk { abiFilters += (findProperty("atc.abi") as String? ?: "arm64-v8a") }
        buildConfigField("String", "APP_LINK_HOST", "\"${appLinkHost.orEmpty()}\"")
        if (appLinkHost != null) manifestPlaceholders["appLinkHost"] = appLinkHost
    }

    signingConfigs {
        if (password != null) create("release") {
            storeFile = secrets.resolve("release.jks")
            storePassword = password
            keyAlias = "atc"
            keyPassword = password
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    if (appLinkHost != null) listOf("debug", "release").forEach { sourceSets[it].manifest.srcFile("src/appLink/AndroidManifest.xml") }

    buildFeatures.buildConfig = true
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions.unitTests.isReturnDefaultValues = true
}

kotlin { compilerOptions.jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17 }

dependencies {
    implementation("org.unifiedpush.android:connector:3.3.5")
    implementation("androidx.core:core:1.15.0")
    implementation("androidx.core:core-remoteviews:1.1.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.car.app:app:1.7.0")
    implementation("com.google.android.filament:filament-android:1.75.1")
    implementation("com.google.android.filament:gltfio-android:1.75.1")
    implementation("com.google.android.filament:filament-utils-android:1.75.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

abstract class LookColors : DefaultTask() {
    @get:InputFile abstract val tokens: RegularFileProperty
    @get:OutputDirectory abstract val out: DirectoryProperty

    @TaskAction fun run() {
        val css = tokens.get().asFile.readText()
        fun raw(name: String) = Regex("""--$name:\s*([^;]+);""").find(css)?.groupValues?.get(1)?.trim()
            ?: throw GradleException("web/tokens.css has no --$name, which the app's colours come from")
        fun side(v: String, dark: Boolean): String {
            val body = Regex("""^light-dark\((.+)\)$""").find(v)?.groupValues?.get(1) ?: return v
            var depth = 0
            val cut = body.indices.first { i -> body[i].also { if (it == '(') depth++ else if (it == ')') depth-- } == ',' && depth == 0 }
            return (if (dark) body.substring(cut + 1) else body.substring(0, cut)).trim()
        }
        fun rgb(v: String, dark: Boolean): Int {
            val s = side(v, dark)
            Regex("""^var\(--([\w-]+)\)$""").find(s)?.let { return rgb(raw(it.groupValues[1]), dark) }
            Regex("""^#([0-9a-fA-F]{6})$""").find(s)?.let { return it.groupValues[1].toInt(16) }
            val (l, c, h) = Regex("""^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)$""").find(s)?.groupValues?.drop(1)?.map { it.toDouble() }
                ?: throw GradleException("web/tokens.css: the app can't read $s as a colour")
            val a = c * Math.cos(Math.toRadians(h))
            val b = c * Math.sin(Math.toRadians(h))
            val lm = Math.pow(l / 100 + .3963377774 * a + .2158037573 * b, 3.0)
            val mm = Math.pow(l / 100 - .1055613458 * a - .0638541728 * b, 3.0)
            val sm = Math.pow(l / 100 - .0894841775 * a - 1.2914855480 * b, 3.0)
            fun ch(x: Double) = Math.round(255 * (if (x <= .0031308) 12.92 * x else 1.055 * Math.pow(x, 1 / 2.4) - .055)).toInt().coerceIn(0, 255)
            return (ch(4.0767416621 * lm - 3.3077115913 * mm + .2309699292 * sm) shl 16) or
                (ch(-1.2684380046 * lm + 2.6097574011 * mm - .3413193965 * sm) shl 8) or
                ch(-.0041960863 * lm - .7034186147 * mm + 1.7076147010 * sm)
        }
        fun blend(x: Int, y: Int, r: Double) = listOf(16, 8, 0).fold(0) { acc, sh ->
            acc or (Math.round(((x shr sh) and 255) * (1 - r) + ((y shr sh) and 255) * r).toInt() shl sh)
        }
        listOf(false to "values", true to "values-night").forEach { (dark, dir) ->
            val c = listOf("board", "line", "ink", "dim", "faint", "needs", "turn", "work").associateWith { rgb(raw(it), dark) }
            val all = c + mapOf("line_strong" to blend(c.getValue("line"), c.getValue("ink"), .35), "on_needs" to blend(c.getValue("needs"), 0, .82))
            val f = out.get().asFile.resolve("$dir/look.xml")
            f.parentFile.mkdirs()
            f.writeText("<resources>\n" + all.entries.joinToString("") { (k, v) -> "    <color name=\"$k\">#%06x</color>\n".format(v) } + "</resources>\n")
        }
    }
}

val lookColors = tasks.register<LookColors>("lookColors") {
    tokens = rootProject.file("../web/tokens.css")
    out = layout.buildDirectory.dir("generated/look")
}

androidComponents.onVariants { v -> v.sources.res?.addGeneratedSourceDirectory(lookColors, LookColors::out) }
