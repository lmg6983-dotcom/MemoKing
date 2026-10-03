package com.memoking.app.drive

import android.app.Activity
import android.content.Context
import android.content.Intent
import com.google.android.gms.auth.GoogleAuthUtil
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Tasks
import java.util.concurrent.TimeUnit

/**
 * 휴대폰에 이미 로그인된 구글 계정으로 Drive 권한 받기 (Google Play 서비스).
 * 사용자는 앱 안에서 계정을 고르고 "허용"만 누르면 된다 — 브라우저·비밀번호·클라이언트 ID 입력 없음.
 *
 * 구글은 이 앱(패키지 이름 + 서명 SHA-1)이 어느 Google Cloud 프로젝트에 "Android" OAuth 클라이언트로
 * 등록돼 있어야 권한을 준다. 개발자가 한 번만 등록하면 된다 (android/DRIVE-SETUP.md).
 */
object NativeAuth {
    private const val SCOPE = "https://www.googleapis.com/auth/drive"

    private fun request(): AuthorizationRequest =
        AuthorizationRequest.builder().setRequestedScopes(listOf(Scope(SCOPE))).build()

    fun available(ctx: Context): Boolean = try {
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(ctx) == ConnectionResult.SUCCESS
    } catch (e: Throwable) {
        false
    }

    /** 사람이 읽을 오류 문구 */
    fun describe(e: Throwable): String {
        val api = e as? ApiException ?: e.cause as? ApiException
        return when (api?.statusCode) {
            CommonStatusCodes.DEVELOPER_ERROR ->
                "이 앱이 아직 Google에 등록되지 않았어요. 개발자가 한 번 등록해야 해요 (android/DRIVE-SETUP.md)"
            CommonStatusCodes.NETWORK_ERROR -> "인터넷에 연결되지 않았어요"
            CommonStatusCodes.CANCELED, 16 -> "로그인을 취소했어요"
            else -> e.message ?: "Google 계정으로 연결하지 못했어요"
        }
    }

    /**
     * 화면에서 로그인: 이미 허용했으면 바로 토큰, 처음이면 계정 고르기·허용 화면을 띄운다(startForResult).
     * onToken / onError 는 화면 스레드에서 불린다.
     */
    fun begin(activity: Activity, startForResult: (android.content.IntentSender) -> Unit, onToken: (String) -> Unit, onError: (String) -> Unit) {
        Identity.getAuthorizationClient(activity).authorize(request())
            .addOnSuccessListener { result ->
                val pending = result.pendingIntent
                if (result.hasResolution() && pending != null) startForResult(pending.intentSender)
                else result.accessToken?.let(onToken) ?: onError("Google이 권한을 주지 않았어요")
            }
            .addOnFailureListener { e -> onError(describe(e)) }
    }

    /** 계정 고르기·허용 화면에서 돌아왔을 때 */
    fun finish(activity: Activity, data: Intent?): String {
        val result: AuthorizationResult = Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(data)
        return result.accessToken ?: throw GoogleAuth.AuthError("Google이 권한을 주지 않았어요")
    }

    /** 배경에서 토큰 받기 (이미 허용한 뒤라면 화면 없이). 다시 허용이 필요하면 오류 */
    fun token(ctx: Context): String {
        val result = try {
            Tasks.await(Identity.getAuthorizationClient(ctx).authorize(request()), 30, TimeUnit.SECONDS)
        } catch (e: Exception) {
            throw GoogleAuth.AuthError(describe(e.cause ?: e))
        }
        if (result.hasResolution()) throw GoogleAuth.AuthError("Google Drive 권한을 다시 허용해 주세요. 설정 › 연결하기")
        return result.accessToken ?: throw GoogleAuth.AuthError("Google Drive 권한을 다시 허용해 주세요. 설정 › 연결하기")
    }

    /** 만료된 토큰을 Play 서비스 저장소에서 지운다 (다음 요청 때 새로 받게) */
    fun clear(ctx: Context, token: String) {
        try {
            GoogleAuthUtil.clearToken(ctx, token)
        } catch (e: Exception) {
            // 무시
        }
    }
}
