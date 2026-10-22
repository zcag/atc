plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val commits = providers.exec { commandLine("git", "rev-list", "--count", "HEAD") }
    .standardOutput.asText.get().trim().toInt()

val secrets = file(providers.gradleProperty("atc.secrets").getOrElse("${System.getProperty("user.home")}/.secrets/atc-android"))
val password = secrets.resolve("keystore.env").takeIf { it.exists() }?.readLines()
    ?.firstOrNull { it.startsWith("KEY_PASSWORD=") }?.substringAfter("=")

android {
    namespace = "io.github.zcag.atc"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.zcag.atc"
        minSdk = 29
        targetSdk = 35
        versionCode = commits
        versionName = "0.$commits"
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
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
