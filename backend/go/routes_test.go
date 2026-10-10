package main

import "testing"

func TestCheckDisposition(t *testing.T) {
	cases := []struct {
		name                          string
		returned, disposed, remaining int64
		wantStatus                    int
		wantMsg                       string
	}{
		{"returned only fits", 2, 0, 5, 0, ""},
		{"disposed only fits", 0, 5, 5, 0, ""},
		{"both fit exactly", 2, 3, 5, 0, ""},
		{"negative returned", -1, 2, 5, 400, "returned and disposed must be >= 0"},
		{"negative disposed", 1, -2, 5, 400, "returned and disposed must be >= 0"},
		{"nothing to record", 0, 0, 5, 400, "at least one of returned or disposed must be > 0"},
		{"exceeds remaining", 3, 3, 5, 409, "exceeds remaining"},
		{"exceeds with zero remaining", 1, 0, 0, 409, "exceeds remaining"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			status, msg := checkDisposition(c.returned, c.disposed, c.remaining)
			if status != c.wantStatus || msg != c.wantMsg {
				t.Fatalf("checkDisposition(%d,%d,%d) = (%d,%q), want (%d,%q)",
					c.returned, c.disposed, c.remaining, status, msg, c.wantStatus, c.wantMsg)
			}
		})
	}
}

func TestCheckResolve(t *testing.T) {
	cases := []struct {
		name                                    string
		reconciled, distributed, returned, disp int64
		wantStatus                              int
	}{
		{"equal to accounted", 10, 4, 3, 3, 0},
		{"above accounted", 12, 4, 3, 3, 0},
		{"below accounted", 9, 4, 3, 3, 409},
		{"zero reconciled with nothing accounted", 0, 0, 0, 0, 0},
		{"negative reconciled", -1, 0, 0, 0, 409},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			status, _ := checkResolve(c.reconciled, c.distributed, c.returned, c.disp)
			if status != c.wantStatus {
				t.Fatalf("checkResolve(%d; %d,%d,%d) status = %d, want %d",
					c.reconciled, c.distributed, c.returned, c.disp, status, c.wantStatus)
			}
		})
	}
}
