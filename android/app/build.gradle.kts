import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// local.properties(저장소에 올리지 않음) → 환경 변수 순으로 찾는다
fun secret(key: String, env: String): String {
    val props = Properties()
    val file = rootDir.resolve("local.properties")
    if (file.exists()) file.inputStream().use { props.load(it) }
    return (props.getProperty("memoking.$key") ?: System.getenv(env) ?: "").trim().replace("\"", "")
}

// 화면은 데스크탑과 함께 쓰는 웹 코어(../app)와 안드로이드 화면(../web)을 앱 안에 묶어 넣는다.
//   assets/www/app/  ← 저장소의 app/ (편집기·메모 파일 형식·인덱서 등 공용 코드)
//   assets/www/m/    ← android/web/ (휴대폰 화면)
val webOut = layout.buildDirectory.dir("generated/web")
val syncWeb by tasks.registering(Sync::class) {
    from(rootDir.resolve("../app")) {
        into("www/app")
        // 데스크탑에서만 쓰는 것 (글자 인식 OCR 15MB · 매직키 검색) 은 APK 에 넣지 않는다
        exclude("vendor/tesseract/**", "vendor/fuzzysort.js", "ocr.html", "magic.html", "js/ocr.js", "js/magic*.js", "styles/magic.css")
    }
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
        versionCode = 34
        versionName = "0.10.6"

        // 받아쓰기(Vosk) 네이티브 라이브러리: 실제 휴대폰용만 (APK 크기)
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }

        // Google Drive 동기화용 OAuth 클라이언트 ("데스크톱 앱" 유형). 비워 두면 앱 설정에서 붙여 넣는다.
        // 넣는 곳: android/local.properties 의 memoking.googleClientId / memoking.googleClientSecret,
        //         또는 환경 변수 MEMOKING_GOOGLE_CLIENT_ID / MEMOKING_GOOGLE_CLIENT_SECRET (GitHub Actions 비밀 값)
        buildConfigField("String", "GOOGLE_CLIENT_ID", "\"${secret("googleClientId", "MEMOKING_GOOGLE_CLIENT_ID")}\"")
        buildConfigField("String", "GOOGLE_CLIENT_SECRET", "\"${secret("googleClientSecret", "MEMOKING_GOOGLE_CLIENT_SECRET")}\"")
    }

    // 디버그 서명 키를 저장소에 고정 — CI 가 새로 만든 APK 를 지우지 않고 업데이트로 설치할 수 있다
    // (디버그용 공개 키라 비밀이 아니다. 스토어 배포용 릴리스 키는 따로 만들어 저장소 밖에 둔다)
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
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

dependencies {
    // 휴대폰에 로그인된 구글 계정으로 Drive 권한 받기 (계정 고르기·허용만)
    implementation("com.google.android.gms:play-services-auth:21.3.0")

    // 받아쓰기: 오픈소스 음성 인식 Vosk (alphacep/vosk-api, Apache-2.0) — 인터넷 없이 휴대폰 안에서 한국어를 글로
    implementation("com.alphacephei:vosk-android:0.3.75")

    // 동기화 엔진 단위 테스트 (PC 에서 JVM 으로)
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303") // 안드로이드 org.json 대신 진짜 구현
}

tasks.withType<Test>().configureEach {
    environment("LC_ALL", "C.UTF-8") // 한글 파일 이름
    systemProperty("file.encoding", "UTF-8")
}

tasks.named("preBuild").configure { dependsOn(syncWeb) }
