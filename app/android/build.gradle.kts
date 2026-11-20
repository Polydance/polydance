// Same AGP and Gradle as an Android app that had already shipped to these headsets. Kotlin 2.2 since
// 2026-10-21: Meta's Spatial SDK 0.14.0 (the Quest immersive scene) is built with Kotlin 2.2 metadata, which 2.0 cannot read.
plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.2.21" apply false
}
