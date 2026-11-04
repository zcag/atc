package android.media.audiopolicy;

public class AudioMixingRule {
    public static final int RULE_MATCH_ATTRIBUTE_USAGE = 1, RULE_MATCH_ATTRIBUTE_CAPTURE_PRESET = 2, RULE_MATCH_UID = 4;
    public static final int MIX_ROLE_PLAYERS = 0, MIX_ROLE_INJECTOR = 1;
    public static class Builder {
        public Builder addMixRule(int rule, Object property) { return this; }
        public Builder setTargetMixRole(int role) { return this; }
        public Builder allowPrivilegedPlaybackCapture(boolean allow) { return this; }
        public Builder voiceCommunicationCaptureAllowed(boolean allow) { return this; }
        public AudioMixingRule build() { return null; }
    }
}
