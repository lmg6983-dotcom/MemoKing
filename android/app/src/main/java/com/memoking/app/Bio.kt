package com.memoking.app

import android.app.Activity
import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 잠긴 메모를 지문 · 얼굴로 열기 (안드로이드 11+).
 *   비밀번호로 한 번 연 뒤 고르면, 그 비밀번호를 휴대폰 보안 칩(Android Keystore)의 열쇠로 감싸 둔다.
 *   그 열쇠는 지문 · 얼굴을 확인해야만 쓸 수 있고(BiometricPrompt + CryptoObject), 휴대폰 밖으로 나가지 않는다.
 *   지문을 새로 등록하면 열쇠가 무효가 되어 다시 비밀번호로 (KeyPermanentlyInvalidatedException → 모두 잊는다).
 *   감싼 비밀번호는 memoking_bio 설정에 (백업 규칙에서 뺀다 — 새 휴대폰에서는 어차피 열 수 없다)
 */
object Bio {
    private const val KEY = "memoking_bio"
    private const val PREFS = "memoking_bio"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** 지문 · 얼굴(강한 생체 인증)을 쓸 수 있나 */
    fun available(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        val bm = ctx.getSystemService(BiometricManager::class.java) ?: return false
        return bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
    }

    fun has(ctx: Context, memoId: String) = prefs(ctx).contains(memoId)

    fun forget(ctx: Context, memoId: String) = prefs(ctx).edit().remove(memoId).apply()

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val spec = KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG) // 쓸 때마다 지문 · 얼굴
            .setInvalidatedByBiometricEnrollment(true)
            .build()
        gen.init(spec)
        return gen.generateKey()
    }

    private fun dropKey() {
        try {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(KEY)
        } catch (e: Exception) {
            // 없음
        }
    }

    private fun prompt(activity: Activity, title: String, cipher: Cipher, done: (Cipher?) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return done(null)
        val p = BiometricPrompt.Builder(activity)
            .setTitle(title)
            .setSubtitle("지문이나 얼굴로 확인해 주세요")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButton("비밀번호로", activity.mainExecutor) { _, _ -> done(null) }
            .build()
        p.authenticate(BiometricPrompt.CryptoObject(cipher), CancellationSignal(), activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                done(result.cryptoObject?.cipher)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                done(null) // 취소 · 너무 많이 틀림 — 비밀번호 칸은 그대로
            }
        })
    }

    /** 비밀번호를 지문 열쇠로 감싸 둔다 → 됐는가 */
    fun save(activity: Activity, memoId: String, password: String, done: (Boolean) -> Unit) {
        val cipher = try {
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            dropKey()
            prefs(activity).edit().clear().apply()
            return save(activity, memoId, password, done) // 새 열쇠로 한 번 더
        } catch (e: Exception) {
            return done(false)
        }
        prompt(activity, "다음부터 지문으로 열기", cipher) { ok ->
            if (ok == null) return@prompt done(false)
            try {
                val ct = ok.doFinal(password.toByteArray(Charsets.UTF_8))
                val v = Base64.encodeToString(ok.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
                prefs(activity).edit().putString(memoId, v).apply()
                done(true)
            } catch (e: Exception) {
                done(false)
            }
        }
    }

    /** 지문 · 얼굴을 확인하고 감싸 둔 비밀번호 → 비밀번호 | null (취소 · 열쇠 무효 · 저장 없음) */
    fun open(activity: Activity, memoId: String, done: (String?) -> Unit) {
        val saved = prefs(activity).getString(memoId, null) ?: return done(null)
        val (iv, ct) = saved.split(":").takeIf { it.size == 2 }?.map { Base64.decode(it, Base64.NO_WRAP) } ?: return done(null)
        val cipher = try {
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            // 지문을 새로 등록했다 — 감싸 둔 것은 모두 못 쓴다
            dropKey()
            prefs(activity).edit().clear().apply()
            return done(null)
        } catch (e: Exception) {
            return done(null)
        }
        prompt(activity, "잠긴 메모 열기", cipher) { ok ->
            if (ok == null) return@prompt done(null)
            try {
                done(String(ok.doFinal(ct), Charsets.UTF_8))
            } catch (e: Exception) {
                done(null)
            }
        }
    }
}
