package claude

import "testing"

func TestAskingOnlyForAnOpenDialog(t *testing.T) {
	for state, want := range map[string]string{
		`{"tempo":"blocked","needs":"approve Bash: git push","needsOverlay":"approve Bash: git push"}`:     "Bash: git push",
		`{"tempo":"blocked","needs":"approve the review on GitHub; then the flight decision"}`:             "",
		`{"tempo":"blocked","needs":"approve Bash: git push","needsOverlay":"approve Bash: git status"}`:   "",
		`{"tempo":"idle","needs":"approve Bash: git push","needsOverlay":"approve Bash: git push"}`:        "",
		`{"tempo":"blocked","needs":"awaiting input: pick one","needsOverlay":"awaiting input: pick one"}`: "",
	} {
		if got := asking([]byte(state)).Approve; got != want {
			t.Errorf("%s: got %q, want %q", state, got, want)
		}
	}
	q := asking([]byte(`{"tempo":"blocked","needs":"Which one?","block":{"questions":[{"question":"Which one?"}]}}`))
	if len(q.Questions) != 1 {
		t.Errorf("questions: %+v", q)
	}
}
