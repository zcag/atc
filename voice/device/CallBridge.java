import android.content.AttributionSource;
import android.content.Context;
import android.content.ContextWrapper;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.media.audiopolicy.AudioMix;
import android.media.audiopolicy.AudioMixingRule;
import android.media.audiopolicy.AudioPolicy;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.Uri;
import android.os.Bundle;
import android.os.Looper;
import android.telephony.PhoneStateListener;
import android.telephony.PreciseCallState;
import android.telephony.TelephonyManager;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

public class CallBridge {
    static final String PKG = "com.android.shell";
    static final int RATE = 16000, FRAME = 640, REDIRECT_PSTN = 1, USAGE_CALL_ASSISTANT = 17, SOURCE_VOICE_DOWNLINK = 3, SOURCE_VOICE_UPLINK = 2;
    static final String TAP = "/data/local/tmp/delta-call-tap";
    static final String[] PRECISE = {"idle", "active", "holding", "dialing", "alerting", "incoming", "waiting", "disconnected", "disconnecting"};
    static final String[] SIMPLE = {"idle", "ringing", "offhook"};

    static OutputStream control;
    static final JSONObject state = new JSONObject();
    static volatile LocalSocket audio;
    static boolean listening;

    static class ShellContext extends ContextWrapper {
        ShellContext() { super(null); }
        @Override public String getPackageName() { return PKG; }
        @Override public String getOpPackageName() { return PKG; }
        @Override public String getAttributionTag() { return null; }
        @Override public AttributionSource getAttributionSource() { return new AttributionSource.Builder(2000).setPackageName(PKG).build(); }
        @Override public Context getApplicationContext() { return this; }
        @Override public int getDeviceId() { return 0; }
        @Override public String getSystemServiceName(Class<?> cls) { return cls.getSimpleName(); }
        @Override public Object getSystemService(String name) {
            if (!name.equals("TelephonyRegistryManager") && !name.equals("telephony_registry")) return null;
            try {
                return Class.forName("android.telephony.TelephonyRegistryManager").getConstructor(Context.class).newInstance(this);
            } catch (ReflectiveOperationException e) { throw new RuntimeException(e); }
        }
    }

    static Object service(String name, String stub) throws Exception {
        Object binder = Class.forName("android.os.ServiceManager").getMethod("getService", String.class).invoke(null, name);
        return Class.forName(stub + "$Stub").getMethod("asInterface", Class.forName("android.os.IBinder")).invoke(null, binder);
    }

    static Object invoke(Object target, String name, Object... known) throws Exception {
        for (Method m : target.getClass().getMethods()) {
            if (!m.getName().equals(name)) continue;
            Class<?>[] types = m.getParameterTypes();
            Object[] args = new Object[types.length];
            int strings = 0;
            for (int i = 0; i < types.length; i++) {
                if (types[i] == String.class) args[i] = strings++ == 0 ? PKG : null;
                else if (types[i] == int.class) args[i] = 0;
                else if (types[i] == boolean.class) args[i] = false;
                for (Object k : known) if (k != null && types[i].isInstance(k) || (types[i] == boolean.class && k instanceof Boolean)) args[i] = k;
            }
            return m.invoke(target, args);
        }
        throw new NoSuchMethodException(name);
    }

    static synchronized void emit(JSONObject event) {
        if (control == null) return;
        try {
            control.write((event.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            control.flush();
        } catch (IOException e) { control = null; }
    }

    static void update(String key, Object value, String event) {
        try {
            synchronized (state) { state.put(key, value); }
            JSONObject e = new JSONObject(state.toString()).put("event", event);
            emit(e);
        } catch (Exception ignored) {}
    }

    static void command(JSONObject c) throws Exception {
        String cmd = c.getString("cmd");
        Object telecom = service("telecom", "com.android.internal.telecom.ITelecomService");
        switch (cmd) {
            case "answer":
                Thread a = arming;
                if (a != null) a.join(4000);
                invoke(telecom, "acceptRingingCall");
                break;
            case "hangup": invoke(telecom, "endCall"); break;
            case "dial": invoke(telecom, "placeCall", Uri.fromParts("tel", c.getString("number"), null), new Bundle()); break;
            case "mute": invoke(service("audio", "android.media.IAudioService"), "setMicrophoneMute", c.getBoolean("on")); break;
            case "state": break;
            default: throw new IllegalArgumentException("unknown cmd " + cmd);
        }
        update("last_cmd", cmd, "ok");
    }

    static void serveControl() {
        try (LocalServerSocket server = new LocalServerSocket("delta-call")) {
            while (true) {
                LocalSocket s = server.accept();
                synchronized (CallBridge.class) { control = s.getOutputStream(); }
                update("client", true, "hello");
                new Thread(() -> {
                    try (BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8))) {
                        for (String line; (line = in.readLine()) != null; ) {
                            try { command(new JSONObject(line)); }
                            catch (Exception e) { emit(new JSONObject().put("event", "error").put("error", String.valueOf(e.getCause() != null ? e.getCause() : e))); }
                        }
                    } catch (Exception ignored) {}
                }).start();
            }
        } catch (IOException e) { throw new RuntimeException(e); }
    }

    static Object call(Object target, String name, Class<?> type, Object arg) throws Exception {
        Method m = target.getClass().getDeclaredMethod(name, type);
        m.setAccessible(true);
        return m.invoke(target, arg);
    }

    static AudioFormat format(int mask) {
        return new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(mask).build();
    }

    static AudioTrack uplink() throws Exception {
        AudioAttributes.Builder attrs = new AudioAttributes.Builder().setContentType(AudioAttributes.CONTENT_TYPE_SPEECH);
        call(attrs, "setSystemUsage", int.class, USAGE_CALL_ASSISTANT);
        AudioTrack.Builder b = new AudioTrack.Builder().setAudioAttributes(attrs.build())
                .setAudioFormat(format(AudioFormat.CHANNEL_OUT_MONO))
                .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
                .setBufferSizeInBytes(FRAME * 4);
        call(b, "setCallRedirectionMode", int.class, REDIRECT_PSTN);
        return b.build();
    }

    static AudioRecord downlink() throws Exception {
        return capture(SOURCE_VOICE_DOWNLINK);
    }

    static AudioRecord capture(int source) throws Exception {
        AudioAttributes.Builder attrs = new AudioAttributes.Builder();
        call(attrs, "setInternalCapturePreset", int.class, source);
        AudioRecord.Builder b = new AudioRecord.Builder().setAudioFormat(format(AudioFormat.CHANNEL_IN_MONO)).setContext(new ShellContext());
        call(b, "setAudioAttributes", AudioAttributes.class, attrs.build());
        call(b, "setCallRedirectionMode", int.class, REDIRECT_PSTN);
        return b.build();
    }

    static int audioMode() throws Exception {
        return (int) invoke(service("audio", "android.media.IAudioService"), "getMode");
    }

    static int waitForCallMode() throws Exception {
        for (int i = 0; i < 40; i++) {
            int mode = audioMode();
            if (mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION) return mode;
            Thread.sleep(50);
        }
        return audioMode();
    }

    static class Voip {
        final AudioPolicy policy;
        final AudioMix players, injector;
        final AudioRecord rec;
        final AudioTrack play;

        Voip() throws Exception {
            AudioMixingRule.Builder heard = new AudioMixingRule.Builder().setTargetMixRole(AudioMixingRule.MIX_ROLE_PLAYERS)
                    .addMixRule(AudioMixingRule.RULE_MATCH_ATTRIBUTE_USAGE, new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).build());
            heard.voiceCommunicationCaptureAllowed(true).allowPrivilegedPlaybackCapture(true);
            players = new AudioMix.Builder(heard.build()).setFormat(format(AudioFormat.CHANNEL_OUT_MONO)).setRouteFlags(AudioMix.ROUTE_FLAG_LOOP_BACK).build();
            AudioAttributes.Builder mic = new AudioAttributes.Builder();
            call(mic, "setInternalCapturePreset", int.class, MediaRecorder.AudioSource.VOICE_COMMUNICATION);
            AudioMixingRule said = new AudioMixingRule.Builder().setTargetMixRole(AudioMixingRule.MIX_ROLE_INJECTOR)
                    .addMixRule(AudioMixingRule.RULE_MATCH_ATTRIBUTE_CAPTURE_PRESET, mic.build()).build();
            injector = new AudioMix.Builder(said).setFormat(format(AudioFormat.CHANNEL_IN_MONO)).setRouteFlags(AudioMix.ROUTE_FLAG_LOOP_BACK).build();
            policy = new AudioPolicy.Builder(null).setLooper(Looper.getMainLooper()).addMix(players).addMix(injector).build();
            int res = (int) staticCall("registerAudioPolicyStatic", policy);
            if (res != 0) throw new IllegalStateException("registerAudioPolicy " + res);
            rec = policy.createAudioRecordSink(players);
            play = policy.createAudioTrackSource(injector);
            rec.startRecording();
            play.play();
        }

        void release() {
            rec.release();
            play.release();
            try { staticCall("unregisterAudioPolicyAsyncStatic", policy); }
            catch (Exception e) { emit(new JSONObject(java.util.Map.of("event", "error", "error", "voip release: " + e))); }
        }

        static Object staticCall(String name, AudioPolicy p) throws Exception {
            Method m = AudioManager.class.getDeclaredMethod(name, AudioPolicy.class);
            m.setAccessible(true);
            return m.invoke(null, p);
        }
    }

    static void serveAudio() {
        try (LocalServerSocket server = new LocalServerSocket("delta-call-audio")) {
            while (true) {
                LocalSocket s = server.accept();
                if (audio != null) { s.close(); continue; }
                audio = s;
                new Thread(() -> pump(s)).start();
            }
        } catch (IOException e) { throw new RuntimeException(e); }
    }

    static Voip early;
    static volatile Thread arming;

    static void armVoip(boolean ringing) {
        try {
            for (int i = 0; !ringing && i < 60 && audioMode() != AudioManager.MODE_IN_COMMUNICATION; i++) Thread.sleep(50);
            synchronized (CallBridge.class) {
                if (early == null && audio == null && (ringing || audioMode() == AudioManager.MODE_IN_COMMUNICATION)) {
                    long t = System.currentTimeMillis();
                    early = new Voip();
                    emit(new JSONObject().put("event", "voip").put("armed_ms", System.currentTimeMillis() - t).put("ringing", ringing));
                }
            }
        } catch (Exception e) { emit(new JSONObject(java.util.Map.of("event", "error", "error", "voip arm: " + e))); }
    }

    static synchronized void disarmVoip() {
        if (early != null) early.release();
        early = null;
    }

    static void pump(LocalSocket s) {
        AudioRecord rec = null;
        AudioTrack play = null;
        Voip voip = null;
        try {
            synchronized (CallBridge.class) { voip = early; early = null; }
            if (voip != null && waitForCallMode() != AudioManager.MODE_IN_COMMUNICATION) {
                voip.release();
                voip = null;
            }
            if (voip != null || audioMode() == AudioManager.MODE_IN_COMMUNICATION) {
                if (voip == null) voip = new Voip();
                rec = voip.rec;
                play = voip.play;
                byte[] stale = new byte[FRAME * 50];
                while (rec.read(stale, 0, stale.length, AudioRecord.READ_NON_BLOCKING) > 0) {}
            } else {
                rec = downlink();
                play = uplink();
                rec.startRecording();
                play.play();
            }
            synchronized (state) { state.put("path", voip != null ? "voip" : "pstn"); }
            update("audio", true, "audio");
            AudioTrack track = play;
            InputStream in = s.getInputStream();
            boolean tap = new File(TAP).exists();
            long t = System.currentTimeMillis();
            OutputStream got = tap ? new FileOutputStream(TAP + "-got-" + t + ".pcm") : null;
            if (tap) tapUplink(TAP + "-uplink-" + t + ".pcm", s);
            Thread writer = new Thread(() -> {
                byte[] buf = new byte[FRAME];
                try {
                    for (int n; (n = in.read(buf)) > 0; ) {
                        if (got != null) got.write(buf, 0, n);
                        track.write(buf, 0, n);
                    }
                    if (got != null) got.close();
                } catch (IOException ignored) {}
            });
            writer.start();
            OutputStream out = s.getOutputStream();
            byte[] buf = new byte[FRAME];
            for (int n; (n = rec.read(buf, 0, FRAME)) > 0 && audio == s; ) out.write(buf, 0, n);
        } catch (Exception e) {
            emit(new JSONObject(java.util.Map.of("event", "error", "error", "audio: " + e)));
        } finally {
            if (voip != null) voip.release();
            else {
                if (rec != null) rec.release();
                if (play != null) play.release();
            }
            try { s.close(); } catch (IOException ignored) {}
            audio = null;
            update("audio", false, "audio");
        }
    }

    static void tapUplink(String path, LocalSocket s) {
        new Thread(() -> {
            AudioRecord rec = null;
            try (OutputStream f = new FileOutputStream(path)) {
                rec = capture(SOURCE_VOICE_UPLINK);
                rec.startRecording();
                byte[] buf = new byte[FRAME];
                for (int n; (n = rec.read(buf, 0, FRAME)) > 0 && audio == s; ) f.write(buf, 0, n);
            } catch (Exception e) {
                emit(new JSONObject(java.util.Map.of("event", "error", "error", "tap: " + e)));
            } finally {
                if (rec != null) rec.release();
            }
        }).start();
    }

    static void closeAudio() {
        LocalSocket s = audio;
        audio = null;
        if (s != null) try { s.shutdownInput(); s.close(); } catch (IOException ignored) {}
    }

    public static void main(String[] args) throws Exception {
        Looper.prepareMainLooper();
        Class<?> tsm = Class.forName("android.os.TelephonyServiceManager");
        Class.forName("android.telephony.TelephonyFrameworkInitializer").getMethod("setTelephonyServiceManager", tsm)
                .invoke(null, tsm.getConstructor().newInstance());
        update("call", "idle", "state");
        new Thread(CallBridge::serveControl).start();
        new Thread(CallBridge::serveAudio).start();
        TelephonyManager tm = TelephonyManager.class.getDeclaredConstructor(Context.class).newInstance(new ShellContext());
        tm.listen(new PhoneStateListener() {
            @Override public void onCallStateChanged(int s, String number) {
                if (!listening) System.out.println("delta-call bridge ready");
                listening = true;
                if (number != null && !number.isEmpty()) update("number", number, "number");
                if (s == 0) {
                    synchronized (state) { state.remove("number"); }
                    closeAudio();
                    disarmVoip();
                } else if (audio == null) {
                    Thread t = new Thread(() -> armVoip(s == 1));
                    if (s == 1) arming = t;
                    t.start();
                }
                update("call", SIMPLE[s], "state");
            }
            public void onPreciseCallStateChanged(PreciseCallState s) {
                int fg = s.getForegroundCallState(), ringing = s.getRingingCallState();
                update("precise", PRECISE[ringing > 0 && fg <= 0 ? ringing : Math.max(fg, 0)], "precise");
            }
        }, PhoneStateListener.LISTEN_CALL_STATE | 0x800);
        new android.os.Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (!listening) throw new IllegalStateException("no phone state callback: listener not registered");
        }, 5000);
        Looper.loop();
    }
}
