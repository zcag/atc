pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "atc"
include(":app")
include(":cubism")
project(":cubism").projectDir = file("live2d/Framework/framework")
