package io.github.zcag.atc

import android.content.Intent
import android.os.Bundle
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

class AssistService : VoiceInteractionService() {
    override fun onReady() {
        super.onReady()
        active = this
    }

    override fun onShutdown() {
        active = null
        super.onShutdown()
    }

    override fun onLaunchVoiceAssistFromKeyguard() = startActivity(Live.assist(this))

    companion object {
        @Volatile private var active: AssistService? = null

        fun open(path: String) = active?.runCatching {
            showSession(Bundle().apply { putString(MainActivity.EXTRA_PATH, path) }, 0)
        }?.isSuccess == true
    }
}

class AssistSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?) = object : VoiceInteractionSession(this) {
        override fun onShow(args: Bundle?, showFlags: Int) {
            super.onShow(args, showFlags)
            val page = args?.getString(MainActivity.EXTRA_PATH)
            startAssistantActivity(Intent(context, MainActivity::class.java).apply {
                if (page != null) putExtra(MainActivity.EXTRA_PATH, page) else putExtra(MainActivity.EXTRA_ASSIST, true)
            })
            hide()
        }
    }
}

class AssistRecognition : RecognitionService() {
    override fun onStartListening(intent: Intent?, listener: Callback) = listener.error(SpeechRecognizer.ERROR_CLIENT)
    override fun onCancel(listener: Callback?) {}
    override fun onStopListening(listener: Callback?) {}
}
