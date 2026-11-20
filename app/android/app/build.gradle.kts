import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The commit the APK was built from, with "-dirty" when the Android project had uncommitted changes,
// so each recording's bundle says exactly which build was on screen.
val gitCommit: String = run {
    val head = providers.exec { workingDir(rootDir); commandLine("git", "rev-parse", "--short=7", "HEAD"); isIgnoreExitValue = true }
        .standardOutput.asText.get().trim()
    val dirty = providers.exec { workingDir(rootDir); commandLine("git", "status", "--porcelain", "--", "."); isIgnoreExitValue = true }
        .standardOutput.asText.get().isNotBlank()
    if (Regex("[0-9a-f]{7,40}").matches(head)) head + (if (dirty) "-dirty" else "") else "unknown"
}

// The upload key. Meta's store takes builds signed with one key for the app's whole life, and Android installs
// an update only over a build signed with the same key, so it lives outside the repository and is backed up
// by hand: ~/.config/polycap/android/upload.properties (storeFile, storePassword, keyAlias, keyPassword),
// made by `npm run app -- keystore`, or the file POLYCAP_ANDROID_SIGNING names. Debug builds use it too
// when it is there, so a sideloaded build installs over the store's; without it they fall back to the
// debug key, and a release build stops.
val uploadKey = Properties().apply {
    val path = providers.environmentVariable("POLYCAP_ANDROID_SIGNING")
        .getOrElse(System.getProperty("user.home") + "/.config/polycap/android/upload.properties")
    File(path).takeIf { it.isFile }?.inputStream()?.use { load(it) }
}.takeIf { it.getProperty("storeFile") != null }

android {
    namespace = "net.polydance.capture"
    compileSdk = 35

    signingConfigs {
        if (uploadKey != null) create("upload") {
            storeFile = file(uploadKey.getProperty("storeFile"))
            storePassword = uploadKey.getProperty("storePassword")
            keyAlias = uploadKey.getProperty("keyAlias")
            keyPassword = uploadKey.getProperty("keyPassword")
            enableV1Signing = true
            enableV2Signing = true
        }
    }

    defaultConfig {
        applicationId = "net.polydance.capture"
        // 30 for the microphone foreground-service type. Quest's MediaProjection needs Horizon OS
        // v68+, which is well above this floor.
        minSdk = 30
        // 34 opts into the Android 14 MediaProjection rules (consent before startForeground, one
        // virtual display per token), which is what a shipped companion app would live under.
        targetSdk = 34
        versionCode = 29
        versionName = "0.22.0"
        // A resource, read at run time: a BuildConfig constant is copied into every class that uses it, and a
        // class Gradle did not recompile kept an older build's commit (2026-10-05).
        resValue("string", "git_commit", gitCommit)
        // Where a headset that signs itself in uploads; adb's CONFIGURE can still point a debug build elsewhere.
        resValue("string", "default_server", "https://capture.polydance.net")
        // The store takes 64-bit builds; the Platform SDK also ships 32-bit and x86 libraries the Quest never loads.
        ndk { abiFilters += "arm64-v8a" }
    }

    // One shared application/data identity. Flavors are mutually exclusive installs on a headset,
    // not copies of the product: protocol, versions, dependencies and signing stay in one place.
    flavorDimensions += "headset"
    productFlavors {
        create("quest") {
            dimension = "headset"
            // The app in Meta's Developer Dashboard (private/docs/STORE.md): the Platform SDK signs the headset in with it.
            // 1300818073125870 since 0.14.3 (2026-10-12): the first record, 1593561244982561, was made under the wrong team.
            resValue("string", "meta_app_id", "1300818073125870")
        }
        create("androidXr") {
            dimension = "headset"
            // Travels through the existing appBuild.versionName contract without a receiver change.
            versionNameSuffix = "-androidxr"
            // The receiver's web OAuth client in Google Cloud (private/docs/PLAY.md): Credential Manager's ID token names it,
            // and the receiver's POLYCAP_GOOGLE_CLIENT_ID must be the same. Not a secret. Empty: no Google sign-in.
            resValue("string", "google_server_client_id", "")
        }
    }

    buildFeatures { buildConfig = true }

    buildTypes {
        debug {
            // Debug builds may upload to a receiver on this Mac over plain HTTP on the home network.
            manifestPlaceholders["cleartext"] = "true"
            if (uploadKey != null) signingConfig = signingConfigs.getByName("upload")
        }
        release {
            // The build for Meta's store (private/docs/STORE.md): HTTPS only, not debuggable, signed with the upload key.
            manifestPlaceholders["cleartext"] = "false"
            isMinifyEnabled = false
            signingConfig = if (uploadKey != null) signingConfigs.getByName("upload") else null
        }
    }

    lint {
        // One language, strings built at runtime; translation resources would be noise in a spike.
        disable += "SetTextI18n"
        // Credential Manager brings AndroidX's Kotlin extensions to the Android XR flavor only; shared code keeps plain
        // Android calls so both flavors read alike, and lint's 57 suggestions to switch would be noise.
        disable += "UseKtx"
        // Meta's store wants targetSdk 34 for Quest apps (private/docs/STORE.md); Google Play's newer floor does not apply.
        disable += "ExpiredTargetSdkVersion"
        disable += "OldTargetApi"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    // Uploads run as WorkManager jobs: they survive the app closing, wait for a network and back off.
    implementation("androidx.work:work-runtime:2.9.1")
    // Meta's Platform SDK for Android apps: entitlement, the signed-in user and their proof (src/quest MetaSignIn).
    // Quest only: Android XR has no Horizon OS, and shared code reaches sign-in through HeadsetSignIn.
    "questImplementation"("com.meta.horizon.platform.ovr:android-platform-sdk:77.0.1")
    // Meta Spatial SDK for the immersive scene (src/quest ImmersiveTableActivity, CAP-10, 2026-10-21): passthrough, a table,
    // the followed threads' models, and Interaction SDK's grab with hands and controllers. vr brings toolkit and isdk. About
    // 56 MB of arm64 native libraries, so the Quest APK grows by that much; Android XR has none of it
    // (docs/IMMERSIVE-VIEWER-RESEARCH.md).
    "questImplementation"("com.meta.spatial:meta-spatial-sdk:0.14.0")
    "questImplementation"("com.meta.spatial:meta-spatial-sdk-toolkit:0.14.0")
    "questImplementation"("com.meta.spatial:meta-spatial-sdk-vr:0.14.0")
    // Sign in with Google through Credential Manager (src/androidXr GoogleSignIn). Android XR only: Quest has no Google services.
    // googleid stays at 1.1.1: 1.2.1 is built with Kotlin metadata 2.4, which this project's Kotlin (2.0 then, 2.2 since 2026-10-21) cannot read (2026-10-16).
    "androidXrImplementation"("androidx.credentials:credentials:1.6.0")
    "androidXrImplementation"("androidx.credentials:credentials-play-services-auth:1.6.0")
    "androidXrImplementation"("com.google.android.libraries.identity.googleid:googleid:1.1.1")
}

// A store build signed with anything but the upload key is useless: stop before packaging one. Every flavor's
// release APK (packageQuestRelease, packageAndroidXrRelease) and bundle (signAndroidXrReleaseBundle) is covered.
tasks.matching { Regex("^package\\w+Release$|^sign\\w+ReleaseBundle$").matches(it.name) }.configureEach {
    doFirst {
        if (uploadKey == null) throw GradleException("No upload key: make one with `npm run app -- keystore` (private/docs/STORE.md), or set POLYCAP_ANDROID_SIGNING")
    }
}
