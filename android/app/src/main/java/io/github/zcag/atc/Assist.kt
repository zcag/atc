package io.github.zcag.atc

import android.content.Intent
import android.os.Bundle
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

class AssistService : VoiceInteractionService() {
    override fun onLaunchVoiceAssistFromKeyguard() = startActivity(Live.assist(this))
}

class AssistSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?) = object : VoiceInteractionSession(this) {
        override fun onShow(args: Bundle?, showFlags: Int) {
            super.onShow(args, showFlags)
            startAssistantActivity(Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_ASSIST, true))
            hide()
        }
    }
}

class AssistRecognition : RecognitionService() {
    override fun onStartListening(intent: Intent?, listener: Callback) = listener.error(SpeechRecognizer.ERROR_CLIENT)
    override fun onCancel(listener: Callback?) {}
    override fun onStopListening(listener: Callback?) {}
}
