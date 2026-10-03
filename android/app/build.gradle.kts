plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 화면은 데스크탑과 함께 쓰는 웹 코어(../app)와 안드로이드 화면(../web)을 앱 안에 묶어 넣는다.
//   assets/www/app/  ← 저장소의 app/ (편집기·메모 파일 형식·인덱서 등 공용 코드)
//   assets/www/m/    ← android/web/ (휴대폰 화면)
val webOut = layout.buildDirectory.dir("generated/web")
val syncWeb by tasks.registering(Sync::class) {
    from(rootDir.resolve("../app")) { into("www/app") }
    from(rootDir.resolve("web")) {
        into("www/m")
        exclude("dev/**")
    }
    into(webOut)
}

android {
    namespace = "com.memoking.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.memoking.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    sourceSets["main"].assets.srcDir(webOut.get().asFile)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

tasks.named("preBuild").configure { dependsOn(syncWeb) }
