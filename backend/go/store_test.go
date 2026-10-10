package main

import "testing"

// Must equal trust.event_hash in backend/trust.py for the same inputs.
func TestEventHashMatchesPython(t *testing.T) {
	got := eventHash("", "lot-1", "000000000001#ab", "sub-1", "Accept", "ALLOW", `{"a": 1}`, 1)
	want := "c4cddbcde3d606c1c85327d7bbce578c8da0a175c52eb1cfb256b9ce1b8cf506"
	if got != want {
		t.Fatalf("eventHash = %s, want %s", got, want)
	}
}

func TestPublicHidesPickupMaterial(t *testing.T) {
	it := item{"lot_id": sVal("l"), "pickup_hash": sVal("h"), "pickup_salt": sVal("s"), "task_token": sVal("t"), "stage": sVal("X")}
	out := public(it)
	for _, k := range []string{"pickup_hash", "pickup_salt", "task_token"} {
		if _, ok := out[k]; ok {
			t.Fatalf("%s leaked", k)
		}
	}
	if out["stage"] != "X" {
		t.Fatal("stage missing")
	}
}
