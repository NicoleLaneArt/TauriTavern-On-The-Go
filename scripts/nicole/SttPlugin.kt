package io.affex.stt

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileOutputStream
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.Locale

@InvokeArg
class ListenConfig {
    var language: String? = null
    var interimResults: Boolean = false
    var continuous: Boolean = false
    var maxDuration: Int = 0
}

@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")
    ]
)
class SttPlugin(private val activity: Activity) : Plugin(activity) {

    private var speechRecognizer: SpeechRecognizer? = null
    private var isListening = false
    private var currentLanguage: String? = null
    
    // Pending permission request invoke to resolve after user responds
    private var pendingPermissionInvoke: Invoke? = null
    
    // maxDuration handling
    private var maxDurationHandler: Handler? = null
    private var maxDurationRunnable: Runnable? = null
    
    // Continuous mode restart handling
    private var consecutiveErrors = 0
    private var lastErrorTime = 0L
    private val restartHandler = Handler(Looper.getMainLooper())

    companion object {
        private const val TAG = "SttPlugin"
        private const val PERMISSION_REQUEST_CODE = 1001
        private const val MAX_CONSECUTIVE_ERRORS = 3
        private const val RESTART_DELAY_MS = 150L
        private const val STOP_FALLBACK_MS = 4000L
        private const val RECORD_SAMPLE_RATE = 16000
        // 1.0 = real time. Raise once accuracy is confirmed.
        private const val FEED_SPEED = 1.0
        private const val ERROR_RESET_TIME_MS = 30000L // 30 seconds
    }

    init {
        Log.d(TAG, "============================================")
        Log.d(TAG, "SttPlugin INIT")
        Log.d(TAG, "  Package: ${activity.packageName}")
        Log.d(TAG, "  Android SDK: ${Build.VERSION.SDK_INT}")
        Log.d(TAG, "  Device: ${Build.MANUFACTURER} ${Build.MODEL}")
        
        activity.runOnUiThread {
            val available = SpeechRecognizer.isRecognitionAvailable(activity)
            Log.d(TAG, "  SpeechRecognizer available: $available")
            
            if (available) {
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(activity)
                Log.d(TAG, "  SpeechRecognizer created successfully")
            } else {
                Log.w(TAG, "  Speech recognition NOT available on device")
                Log.w(TAG, "  Hint: Install Google app from Play Store")
            }
        }
        Log.d(TAG, "============================================")
    }

    fun cleanup() {
        Log.d(TAG, "cleanup() CALLED")
        pressRecording = false
        try { audioRecord?.stop() } catch (_: Exception) {}
        audioRecord?.release()
        audioRecord = null
        Log.d(TAG, "  isListening: $isListening")
        Log.d(TAG, "  consecutiveErrors: $consecutiveErrors")
        
        // Cancel max duration timer
        maxDurationRunnable?.let { maxDurationHandler?.removeCallbacks(it) }
        maxDurationHandler = null
        maxDurationRunnable = null
        Log.d(TAG, "  Max duration timer cancelled")
        
        // Cancel restart handler
        restartHandler.removeCallbacksAndMessages(null)
        Log.d(TAG, "  Restart handler cancelled")
        
        // Reset error tracking
        consecutiveErrors = 0
        lastErrorTime = 0L
        
        activity.runOnUiThread {
            speechRecognizer?.destroy()
            speechRecognizer = null
            Log.d(TAG, "  SpeechRecognizer destroyed")
        }
    }
    
    /**
     * Called when the plugin's activity is destroyed.
     * Ensures proper cleanup of speech recognizer resources.
     */
    override fun onDestroy() {
        Log.d(TAG, "onDestroy() CALLED")
        super.onDestroy()
        cleanup()
    }
    
    /**
     * Handle permission request results.
     * Uses Tauri's PermissionState system instead of deprecated onRequestPermissionsResult.
     */
    @Deprecated("Use PermissionState from Tauri instead")
    private fun handlePermissionResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        
        if (requestCode == PERMISSION_REQUEST_CODE) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            
            pendingPermissionInvoke?.let { invoke ->
                val result = JSObject()
                if (granted) {
                    result.put("microphone", "granted")
                    result.put("speechRecognition", "granted")
                } else {
                    val canRequest = ActivityCompat.shouldShowRequestPermissionRationale(
                        activity, Manifest.permission.RECORD_AUDIO
                    )
                    result.put("microphone", if (canRequest) "denied" else "permanently_denied")
                    result.put("speechRecognition", if (canRequest) "denied" else "permanently_denied")
                }
                invoke.resolve(result)
                pendingPermissionInvoke = null
            }
        }
    }

    @Command
    fun startListening(invoke: Invoke) {
        Log.d(TAG, "startListening called")
        // Drop any pending stop fallback from a previous session.
        restartHandler.removeCallbacksAndMessages(null)
        val config = invoke.parseArgs(ListenConfig::class.java)
        Log.d(TAG, "Config parsed: language=${config.language}, interimResults=${config.interimResults}, continuous=${config.continuous}")

        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(TAG, "Microphone permission not granted, requesting...")
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.RECORD_AUDIO),
                PERMISSION_REQUEST_CODE
            )
            invoke.reject("Microphone permission required. Please grant permission and try again.")
            return
        }
        Log.d(TAG, "Microphone permission granted")

        // Nicole's build: on Android 13+ record straight through until the user
        // taps stop, then transcribe the whole recording with the phone's own
        // speech engine (no live recognizer, no beeps, no auto-ending).
        if (Build.VERSION.SDK_INT >= 33) {
            startPressRecording(config, invoke)
            return
        }

        val recognitionAvailable = SpeechRecognizer.isRecognitionAvailable(activity)
        Log.d(TAG, "Speech recognition available: $recognitionAvailable")
        if (!recognitionAvailable) {
            invoke.reject("Speech recognition not available on this device. Please install Google app.")
            return
        }

        if (isListening) {
            Log.w(TAG, "Already listening, rejecting")
            invoke.reject("Already listening")
            return
        }

        Log.d(TAG, "Preparing to start on UI thread...")
        activity.runOnUiThread {
            try {
                Log.d(TAG, "On UI thread, preparing SpeechRecognizer...")
                // Recreate speech recognizer if null
                if (speechRecognizer == null) {
                    Log.d(TAG, "SpeechRecognizer is null, creating new one...")
                    if (SpeechRecognizer.isRecognitionAvailable(activity)) {
                        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(activity)
                        Log.d(TAG, "SpeechRecognizer created successfully")
                    } else {
                        Log.e(TAG, "Speech recognition not available on UI thread check")
                        invoke.reject("Speech recognition not available")
                        return@runOnUiThread
                    }
                } else {
                    Log.d(TAG, "SpeechRecognizer already exists")
                }
                
                val intent = createRecognizerIntent(config)
                currentLanguage = config.language ?: Locale.getDefault().toLanguageTag()
                Log.d(TAG, "Starting speech recognition:")
                Log.d(TAG, "  - Package: ${activity.packageName}")
                Log.d(TAG, "  - Language: $currentLanguage")
                Log.d(TAG, "  - Interim results: ${config.interimResults}")
                Log.d(TAG, "  - Continuous: ${config.continuous}")
                Log.d(TAG, "  - Max duration: ${config.maxDuration}ms")

                speechRecognizer?.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {
                        Log.d(TAG, "Ready for speech")
                        isListening = true
                        val event = JSObject()
                        event.put("state", "listening")
                        trigger("stateChange", event)
                    }

                    override fun onBeginningOfSpeech() {
                        Log.d(TAG, "Beginning of speech detected")
                        val event = JSObject()
                        event.put("state", "processing")
                        trigger("stateChange", event)
                    }

                    override fun onRmsChanged(rmsdB: Float) {}

                    override fun onBufferReceived(buffer: ByteArray?) {}

                    override fun onEndOfSpeech() {
                        Log.d(TAG, "End of speech detected")
                        val event = JSObject()
                        event.put("state", "processing")
                        trigger("stateChange", event)
                    }

                    override fun onError(error: Int) {
                        val errorMessage = getErrorMessage(error)
                        val currentTime = System.currentTimeMillis()
                        
                        // Reset consecutive errors if enough time passed
                        if (currentTime - lastErrorTime > ERROR_RESET_TIME_MS) {
                            Log.d(TAG, "Resetting error counter - enough time passed (${(currentTime - lastErrorTime) / 1000}s)")
                            consecutiveErrors = 0
                        }
                        lastErrorTime = currentTime
                        consecutiveErrors++
                        
                        Log.e(TAG, "Speech recognition error: $errorMessage (code: $error) [consecutive: $consecutiveErrors]")
                        
                        // Log additional details for ERROR_NO_MATCH
                        if (error == SpeechRecognizer.ERROR_NO_MATCH) {
                            Log.w(TAG, "ERROR_NO_MATCH details:")
                            Log.w(TAG, "  - Language: $currentLanguage")
                            Log.w(TAG, "  - Interim results enabled: ${config.interimResults}")
                            Log.w(TAG, "  - This means speech was detected but not recognized")
                            Log.w(TAG, "  - Possible causes: wrong language, unclear audio, background noise")
                        }
                        
                        // Log additional details for ERROR_CLIENT
                        if (error == SpeechRecognizer.ERROR_CLIENT) {
                            Log.e(TAG, "ERROR_CLIENT details:")
                            Log.e(TAG, "  - Package: ${activity.packageName}")
                            Log.e(TAG, "  - Language: $currentLanguage")
                            Log.e(TAG, "  - Recognition available: ${SpeechRecognizer.isRecognitionAvailable(activity)}")
                            Log.e(TAG, "  - Hint: This usually means audio input is not working. Try a physical device.")
                        }
                        
                        // Don't restart on ERROR_CLIENT or if too many consecutive errors
                        val shouldRestart = config.continuous && 
                            (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) &&
                            consecutiveErrors < MAX_CONSECUTIVE_ERRORS
                        
                        if (shouldRestart) {
                            Log.d(TAG, "Restarting recognition in ${RESTART_DELAY_MS}ms (attempt $consecutiveErrors/$MAX_CONSECUTIVE_ERRORS)")
                            // Add delay before restart to avoid overwhelming the service
                            restartHandler.postDelayed({
                                if (isListening && speechRecognizer != null) {
                                    Log.d(TAG, "Executing delayed restart")
                                    speechRecognizer?.startListening(intent)
                                }
                            }, RESTART_DELAY_MS)
                            return
                        }
                        
                        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                            Log.e(TAG, "Too many consecutive errors ($consecutiveErrors). Stopping continuous mode.")
                        }
                        
                        isListening = false
                        consecutiveErrors = 0
                        
                        val event = JSObject()
                        event.put("code", getErrorCode(error))
                        event.put("message", errorMessage)
                        event.put("details", "Android error code: $error")
                        trigger("error", event)

                        val stateEvent = JSObject()
                        stateEvent.put("state", "idle")
                        trigger("stateChange", stateEvent)
                    }

                    override fun onResults(results: Bundle?) {
                        // Save continuous state before setting isListening to false
                        val shouldContinue = config.continuous && isListening
                        isListening = false
                        
                        val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        val confidences = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)

                        Log.d(TAG, "onResults called - matches: ${matches?.size ?: 0}, shouldContinue: $shouldContinue")
                        if (!matches.isNullOrEmpty()) {
                            Log.d(TAG, "Final result: ${matches[0]}")
                            // Reset error counter on successful result
                            consecutiveErrors = 0
                            
                            val event = JSObject()
                            event.put("transcript", matches[0])
                            event.put("isFinal", true)
                            if (confidences != null && confidences.isNotEmpty()) {
                                event.put("confidence", confidences[0].toDouble())
                            }
                            trigger("result", event)
                        }

                        // Restart listening if in continuous mode
                        if (shouldContinue) {
                            Log.d(TAG, "Restarting listener for continuous mode (with delay)")
                            isListening = true
                            // Add small delay before restart
                            restartHandler.postDelayed({
                                if (isListening && speechRecognizer != null) {
                                    speechRecognizer?.startListening(intent)
                                }
                            }, RESTART_DELAY_MS)
                        } else {
                            val stateEvent = JSObject()
                            stateEvent.put("state", "idle")
                            trigger("stateChange", stateEvent)
                        }
                    }

                    override fun onPartialResults(partialResults: Bundle?) {
                        if (config.interimResults) {
                            val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            Log.d(TAG, "onPartialResults called - matches: ${matches?.size ?: 0}")
                            if (!matches.isNullOrEmpty()) {
                                Log.d(TAG, "Partial result: ${matches[0]}")
                                val event = JSObject()
                                event.put("transcript", matches[0])
                                event.put("isFinal", false)
                                trigger("result", event)
                            }
                        }
                    }

                    override fun onEvent(eventType: Int, params: Bundle?) {}

                    override fun onSegmentResults(segmentResults: Bundle) {
                        val matches = segmentResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        Log.d(TAG, "onSegmentResults - matches: ${matches?.size ?: 0}")
                        if (!matches.isNullOrEmpty() && matches[0].isNotBlank()) {
                            consecutiveErrors = 0
                            val event = JSObject()
                            event.put("transcript", matches[0])
                            event.put("isFinal", true)
                            trigger("result", event)
                        }
                    }

                    override fun onEndOfSegmentedSession() {
                        Log.d(TAG, "onEndOfSegmentedSession - isListening: $isListening")
                        if (isListening && config.continuous) {
                            // The service ended the session on its own; keep recording.
                            restartHandler.postDelayed({
                                if (isListening && speechRecognizer != null) {
                                    speechRecognizer?.startListening(intent)
                                }
                            }, RESTART_DELAY_MS)
                            return
                        }
                        isListening = false
                        val stateEvent = JSObject()
                        stateEvent.put("state", "idle")
                        trigger("stateChange", stateEvent)
                    }
                })

                Log.d(TAG, "Starting listener with intent")
                speechRecognizer?.startListening(intent)
                Log.d(TAG, "Listener started")
                
                // Setup maxDuration timer if specified
                if (config.maxDuration > 0) {
                    Log.d(TAG, "Setting up maxDuration timer: ${config.maxDuration}ms")
                    maxDurationHandler = Handler(Looper.getMainLooper())
                    maxDurationRunnable = Runnable {
                        Log.d(TAG, "maxDuration reached, stopping recognition")
                        speechRecognizer?.stopListening()
                        speechRecognizer?.cancel()
                        isListening = false
                        
                        val event = JSObject()
                        event.put("state", "idle")
                        trigger("stateChange", event)
                        
                        val errorEvent = JSObject()
                        errorEvent.put("code", "TIMEOUT")
                        errorEvent.put("message", "Max duration reached")
                        errorEvent.put("details", "Recognition stopped after maxDuration limit")
                        trigger("error", errorEvent)
                    }
                    maxDurationHandler?.postDelayed(maxDurationRunnable!!, config.maxDuration.toLong())
                }
                
                invoke.resolve()

            } catch (e: Exception) {
                invoke.reject("Failed to start listening: ${e.message}")
            }
        }
    }

    @Command
    fun stopListening(invoke: Invoke) {
        Log.i(TAG, "============================================")
        Log.i(TAG, "stopListening() CALLED")
        if (pressRecording && Build.VERSION.SDK_INT >= 33) {
            stopPressRecordingAndTranscribe()
            invoke.resolve()
            return
        }
        Log.d(TAG, "  isListening: $isListening")
        Log.d(TAG, "  consecutiveErrors: $consecutiveErrors")
        
        // Cancel max duration timer
        maxDurationRunnable?.let { maxDurationHandler?.removeCallbacks(it) }
        maxDurationHandler = null
        maxDurationRunnable = null
        Log.d(TAG, "  Max duration timer cancelled")
        
        // Cancel any pending restarts
        restartHandler.removeCallbacksAndMessages(null)
        consecutiveErrors = 0
        Log.d(TAG, "  Restart handler cancelled, errors reset")
        
        activity.runOnUiThread {
            try {
                Log.d(TAG, "  Stopping on UI thread...")
                // Nicole's build: stop without cancel() so the utterance in
                // progress is still recognized and delivered through onResults
                // (which emits "idle" because isListening is now false).
                isListening = false
                speechRecognizer?.stopListening()
                Log.d(TAG, "  SpeechRecognizer stopping; waiting for final result")

                // Fallback: if no result/error arrives (e.g. stopped between
                // continuous-mode restarts), still report idle.
                restartHandler.postDelayed({
                    speechRecognizer?.cancel()
                    val event = JSObject()
                    event.put("state", "idle")
                    trigger("stateChange", event)
                }, STOP_FALLBACK_MS)

                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject("Failed to stop listening: ${e.message}")
            }
        }
    }

    @Command
    fun isAvailable(invoke: Invoke) {
        Log.i(TAG, "============================================")
        Log.i(TAG, "isAvailable() CALLED")
        
        val result = JSObject()
        val available = SpeechRecognizer.isRecognitionAvailable(activity)
        result.put("available", available)
        Log.d(TAG, "  Speech recognition available: $available")
        
        if (!available) {
            result.put("reason", "Speech recognition not available on this device. Please install Google app or enable voice input.")
            Log.w(TAG, "  Reason: Speech recognition not available")
        } else {
            // Check if Google app is installed (common cause of ERROR_CLIENT)
            try {
                val packageManager = activity.packageManager
                val googleAppPackage = "com.google.android.googlequicksearchbox"
                val googleAppInfo = packageManager.getPackageInfo(googleAppPackage, 0)
                result.put("googleAppInstalled", true)
                result.put("googleAppVersion", googleAppInfo.versionName)
                Log.d(TAG, "  Google app installed: ${googleAppInfo.versionName}")
            } catch (e: Exception) {
                result.put("googleAppInstalled", false)
                result.put("reason", "Google app not installed. Please install it from Play Store for speech recognition.")
                Log.w(TAG, "  Google app not installed: ${e.message}")
            }
        }
        
        Log.d(TAG, "============================================")
        invoke.resolve(result)
    }

    @Command
    fun getSupportedLanguages(invoke: Invoke) {
        Log.i(TAG, "============================================")
        Log.i(TAG, "getSupportedLanguages() CALLED")
        
        val result = JSObject()
        val languagesArray = org.json.JSONArray()

        val locales = Locale.getAvailableLocales()
        val addedCodes = mutableSetOf<String>()
        Log.d(TAG, "  Total locales available: ${locales.size}")

        for (locale in locales) {
            val code = locale.toLanguageTag()
            if (code.contains("-") && !addedCodes.contains(code)) {
                addedCodes.add(code)
                val langObj = JSObject()
                langObj.put("code", code)
                langObj.put("name", locale.displayName)
                languagesArray.put(langObj)
            }
        }
        
        Log.d(TAG, "  Languages with regional codes: ${addedCodes.size}")

        result.put("languages", languagesArray)
        Log.d(TAG, "============================================")
        invoke.resolve(result)
    }

    @Command
    fun checkPermission(invoke: Invoke) {
        Log.i(TAG, "============================================")
        Log.i(TAG, "checkPermission() CALLED")
        
        val result = JSObject()

        val hasPermission = ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        val shouldShowRationale = ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.RECORD_AUDIO)
        
        Log.d(TAG, "  RECORD_AUDIO granted: $hasPermission")
        Log.d(TAG, "  Should show rationale: $shouldShowRationale")
        
        val micPermission = when {
            hasPermission -> "granted"
            shouldShowRationale -> "denied"
            else -> "unknown"
        }
        Log.d(TAG, "  Result: $micPermission")

        result.put("microphone", micPermission)
        result.put("speechRecognition", micPermission)

        Log.d(TAG, "============================================")
        invoke.resolve(result)
    }

    @Command
    fun requestPermission(invoke: Invoke) {
        Log.i(TAG, "============================================")
        Log.i(TAG, "requestPermission() CALLED")
        
        val alreadyGranted = ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        Log.d(TAG, "  Already granted: $alreadyGranted")
        
        if (alreadyGranted) {
            val result = JSObject()
            result.put("microphone", "granted")
            result.put("speechRecognition", "granted")
            Log.d(TAG, "  Returning already granted")
            invoke.resolve(result)
            return
        }

        // Store invoke to resolve after user responds to permission dialog
        pendingPermissionInvoke = invoke
        Log.d(TAG, "  Requesting RECORD_AUDIO permission...")

        ActivityCompat.requestPermissions(
            activity,
            arrayOf(Manifest.permission.RECORD_AUDIO),
            PERMISSION_REQUEST_CODE
        )
        Log.d(TAG, "  Permission dialog shown, waiting for result...")
        // Nicole's build: the dialog result is never routed back to this plugin,
        // so poll until the permission is granted (or give up after 60s).
        val pollHandler = Handler(Looper.getMainLooper())
        val startedAt = System.currentTimeMillis()
        val poll = object : Runnable {
            override fun run() {
                val pending = pendingPermissionInvoke ?: return
                val granted = ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                if (granted || System.currentTimeMillis() - startedAt > 60_000L) {
                    val result = JSObject()
                    val state = if (granted) "granted" else "denied"
                    result.put("microphone", state)
                    result.put("speechRecognition", state)
                    pendingPermissionInvoke = null
                    pending.resolve(result)
                } else {
                    pollHandler.postDelayed(this, 400L)
                }
            }
        }
        pollHandler.postDelayed(poll, 400L)
    }

    // ---- Nicole's build: press-to-record, then transcribe the recording ----

    @Volatile private var pressRecording = false
    private var audioRecord: AudioRecord? = null
    private var recordThread: Thread? = null
    private var recordFile: File? = null
    private var recordLanguage: String = Locale.getDefault().toLanguageTag()
    private var fileRecognizer: SpeechRecognizer? = null
    private var fileDescriptor: ParcelFileDescriptor? = null
    private val recordHandler = Handler(Looper.getMainLooper())

    private fun emitState(state: String, transcribing: Boolean = false) {
        val event = JSObject()
        event.put("state", state)
        if (transcribing) event.put("transcribing", true)
        trigger("stateChange", event)
    }

    private fun emitError(code: String, message: String) {
        val event = JSObject()
        event.put("code", code)
        event.put("message", message)
        trigger("error", event)
    }

    @android.annotation.SuppressLint("MissingPermission")
    @androidx.annotation.RequiresApi(33)
    private fun startPressRecording(config: ListenConfig, invoke: Invoke) {
        if (pressRecording || isListening) {
            invoke.reject("Already listening")
            return
        }
        recordLanguage = config.language ?: Locale.getDefault().toLanguageTag()
        val minBuffer = AudioRecord.getMinBufferSize(
            RECORD_SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        val bufferSize = maxOf(minBuffer, RECORD_SAMPLE_RATE) // ~0.5s of audio
        val recorder = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                RECORD_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize
            )
        } catch (e: Exception) {
            invoke.reject("Could not open the microphone: ${e.message}")
            return
        }
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            invoke.reject("Could not open the microphone.")
            return
        }
        val file = File(activity.cacheDir, "dictation-${System.currentTimeMillis()}.pcm")
        audioRecord = recorder
        recordFile = file
        pressRecording = true
        recorder.startRecording()
        recordThread = Thread {
            val buffer = ByteArray(bufferSize)
            FileOutputStream(file).use { out ->
                while (pressRecording) {
                    val read = recorder.read(buffer, 0, buffer.size)
                    if (read > 0) out.write(buffer, 0, read)
                }
            }
        }.apply { name = "tt-dictation-recorder"; start() }

        if (config.maxDuration > 0) {
            recordHandler.postDelayed({
                if (pressRecording) {
                    Log.d(TAG, "Max recording duration reached; transcribing")
                    stopPressRecordingAndTranscribe()
                }
            }, config.maxDuration.toLong())
        }
        Log.d(TAG, "Press-to-record started -> ${file.name}")
        emitState("listening")
        invoke.resolve()
    }

    @androidx.annotation.RequiresApi(33)
    private fun stopPressRecordingAndTranscribe() {
        recordHandler.removeCallbacksAndMessages(null)
        if (!pressRecording) return
        pressRecording = false
        try { audioRecord?.stop() } catch (_: Exception) {}
        try { recordThread?.join(2000) } catch (_: Exception) {}
        audioRecord?.release()
        audioRecord = null
        recordThread = null
        val file = recordFile
        recordFile = null
        if (file == null || !file.exists() || file.length() < RECORD_SAMPLE_RATE / 2) {
            file?.delete()
            emitState("idle")
            return
        }
        emitState("processing", transcribing = true)
        val onDevice = SpeechRecognizer.isOnDeviceRecognitionAvailable(activity)
        transcribeFile(file, if (onDevice) listOf(true, false) else listOf(false))
    }

    @androidx.annotation.RequiresApi(33)
    private fun transcribeFile(file: File, attempts: List<Boolean>) {
        val useOnDevice = attempts.first()
        val remaining = attempts.drop(1)
        activity.runOnUiThread {
            var gotText = false
            var finished = false
            fun finish(errorCode: String? = null, errorMessage: String? = null) {
                if (finished) return
                finished = true
                try { fileRecognizer?.destroy() } catch (_: Exception) {}
                fileRecognizer = null
                try { fileDescriptor?.close() } catch (_: Exception) {}
                fileDescriptor = null
                if (!gotText && errorCode != null && remaining.isNotEmpty()) {
                    Log.w(TAG, "Transcription attempt failed ($errorCode); trying fallback engine")
                    transcribeFile(file, remaining)
                    return
                }
                file.delete()
                if (!gotText && errorCode != null) emitError(errorCode, errorMessage ?: "Transcription failed")
                emitState("idle")
            }
            fun deliver(bundle: Bundle?) {
                val text = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!text.isNullOrBlank()) {
                    gotText = true
                    val event = JSObject()
                    event.put("transcript", text)
                    event.put("isFinal", true)
                    trigger("result", event)
                }
            }
            try {
                val recognizer = if (useOnDevice) SpeechRecognizer.createOnDeviceSpeechRecognizer(activity)
                    else SpeechRecognizer.createSpeechRecognizer(activity)
                fileRecognizer = recognizer
                // Feed the recording through a pipe at talking speed: some engines drop
                // audio when handed a whole file at once.
                val pipe = ParcelFileDescriptor.createPipe()
                val pfd = pipe[0]
                fileDescriptor = pfd
                val writeSide = pipe[1]
                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, recordLanguage)
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pfd)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, RECORD_SAMPLE_RATE)
                    putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
                }
                recognizer.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {}
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {}
                    override fun onPartialResults(partialResults: Bundle?) {}
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                    override fun onSegmentResults(segmentResults: Bundle) { deliver(segmentResults) }
                    override fun onEndOfSegmentedSession() { finish() }
                    override fun onResults(results: Bundle?) { deliver(results); finish() }
                    override fun onError(error: Int) {
                        Log.e(TAG, "File transcription error: ${getErrorMessage(error)} ($error), onDevice=$useOnDevice")
                        if (useOnDevice && (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED ||
                                error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE)) {
                            try { recognizer.triggerModelDownload(intent) } catch (_: Exception) {}
                        }
                        if (gotText || error == SpeechRecognizer.ERROR_NO_MATCH) finish()
                        else finish(getErrorCode(error), "The phone could not transcribe the recording: ${getErrorMessage(error)}")
                    }
                })
                Log.d(TAG, "Transcribing ${file.length()} bytes (onDevice=$useOnDevice)")
                recognizer.startListening(intent)
                Thread {
                    try {
                        ParcelFileDescriptor.AutoCloseOutputStream(writeSide).use { out ->
                            java.io.FileInputStream(file).use { input ->
                                val bytesPerSecond = RECORD_SAMPLE_RATE * 2L
                                val chunk = ByteArray((bytesPerSecond / 10).toInt()) // 100 ms
                                val started = android.os.SystemClock.elapsedRealtime()
                                var sent = 0L
                                while (true) {
                                    val n = input.read(chunk)
                                    if (n <= 0) break
                                    out.write(chunk, 0, n)
                                    sent += n
                                    val dueMs = (sent * 1000 / bytesPerSecond / FEED_SPEED).toLong()
                                    val aheadMs = dueMs - (android.os.SystemClock.elapsedRealtime() - started)
                                    if (aheadMs > 0) Thread.sleep(aheadMs)
                                }
                            }
                        }
                    } catch (e: Exception) {
                        Log.d(TAG, "Recording feed ended: ${e.message}")
                    }
                }.apply { name = "tt-dictation-feeder"; start() }
            } catch (e: Exception) {
                finish("TRANSCRIBE_FAILED", "The phone could not transcribe the recording: ${e.message}")
            }
        }
    }

    private fun createRecognizerIntent(config: ListenConfig): Intent {
        Log.d(TAG, "createRecognizerIntent() - Building intent")
        
        return Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
            )

            // CRITICAL: Set calling package to identify the app to Google services
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
            Log.d(TAG, "  CALLING_PACKAGE: ${activity.packageName}")
            
            val language = config.language ?: Locale.getDefault().toLanguageTag()
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language)
            putExtra("android.speech.extra.EXTRA_ADDITIONAL_LANGUAGES", arrayOf(language))
            Log.d(TAG, "  LANGUAGE: $language")
            
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, config.interimResults)
            Log.d(TAG, "  PARTIAL_RESULTS: ${config.interimResults}")
            
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
            Log.d(TAG, "  MAX_RESULTS: 5")
            
            // Enable secure offline mode (prevents ERROR_CLIENT)
            putExtra(RecognizerIntent.EXTRA_SECURE, true)
            Log.d(TAG, "  SECURE: true")
            
            // Keep listening even after pause
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 3000L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 3000L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1000L)

            // Nicole's build: one continuous session on Android 13+ (no restart
            // beeps between phrases); text arrives per segment.
            if (config.continuous && Build.VERSION.SDK_INT >= 33) {
                putExtra(
                    RecognizerIntent.EXTRA_SEGMENTED_SESSION,
                    RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS
                )
                Log.d(TAG, "  SEGMENTED_SESSION: enabled")
            }
            Log.d(TAG, "  SILENCE_LENGTH: 3000ms, MINIMUM_LENGTH: 1000ms")
        }
    }

    private fun getErrorCode(errorCode: Int): String {
        return when (errorCode) {
            SpeechRecognizer.ERROR_AUDIO -> "AUDIO_ERROR"
            SpeechRecognizer.ERROR_CLIENT -> "UNKNOWN"
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "PERMISSION_DENIED"
            SpeechRecognizer.ERROR_NETWORK -> "NETWORK_ERROR"
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "TIMEOUT"
            SpeechRecognizer.ERROR_NO_MATCH -> "NO_SPEECH"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "BUSY"
            SpeechRecognizer.ERROR_SERVER -> "NETWORK_ERROR"
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "TIMEOUT"
            else -> "UNKNOWN"
        }
    }

    private fun getErrorMessage(errorCode: Int): String {
        val message = when (errorCode) {
            SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
            SpeechRecognizer.ERROR_CLIENT -> "Client side error"
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Insufficient permissions"
            SpeechRecognizer.ERROR_NETWORK -> "Network error"
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
            SpeechRecognizer.ERROR_NO_MATCH -> "No speech detected"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognition service busy"
            SpeechRecognizer.ERROR_SERVER -> "Server error"
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech input"
            else -> "Unknown error ($errorCode)"
        }
        Log.d(TAG, "getErrorMessage($errorCode) -> $message")
        return message
    }
}
