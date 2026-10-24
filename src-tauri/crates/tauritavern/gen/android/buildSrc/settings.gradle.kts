// Resolve Kotlin artifacts straight from Maven Central instead of via the
// Gradle Plugin Portal's redirect.
pluginManagement {
    repositories {
        mavenCentral()
        google()
        gradlePluginPortal()
    }
}
