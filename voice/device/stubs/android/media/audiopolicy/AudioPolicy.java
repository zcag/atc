package android.media.audiopolicy;

public class AudioPolicy {
    public static class Builder {
        public Builder(android.content.Context c) {}
        public Builder addMix(AudioMix mix) { return this; }
        public Builder setLooper(android.os.Looper l) { return this; }
        public AudioPolicy build() { return null; }
    }
    public android.media.AudioRecord createAudioRecordSink(AudioMix mix) { return null; }
    public android.media.AudioTrack createAudioTrackSource(AudioMix mix) { return null; }
}
