package android.media.audiopolicy;

public class AudioMix {
    public static final int ROUTE_FLAG_LOOP_BACK = 2;
    public static class Builder {
        public Builder(AudioMixingRule rule) {}
        public Builder setFormat(android.media.AudioFormat f) { return this; }
        public Builder setRouteFlags(int flags) { return this; }
        public AudioMix build() { return null; }
    }
}
