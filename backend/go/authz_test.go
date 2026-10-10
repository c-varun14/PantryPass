package main

import (
	"reflect"
	"testing"
)

func TestRoleFromClaims(t *testing.T) {
	cases := []struct {
		name   string
		claims map[string]string
		want   string
	}{
		{"donor bracketed", map[string]string{"cognito:groups": "[donor]"}, "donor"},
		{"receiver bare", map[string]string{"cognito:groups": "receiver"}, "receiver"},
		{"coordinator", map[string]string{"cognito:groups": "[coordinator]"}, "coordinator"},
		{"donor wins over receiver", map[string]string{"cognito:groups": "[receiver, donor]"}, "donor"},
		{"receiver wins over coordinator", map[string]string{"cognito:groups": "[coordinator,receiver]"}, "receiver"},
		{"unknown group", map[string]string{"cognito:groups": "[admin]"}, "user"},
		{"no groups claim", map[string]string{"sub": "abc"}, "user"},
		{"empty groups", map[string]string{"cognito:groups": "[]"}, "user"},
		{"whitespace padded", map[string]string{"cognito:groups": "[ donor ]"}, "donor"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := roleFromClaims(c.claims); got != c.want {
				t.Fatalf("roleFromClaims(%v) = %q, want %q", c.claims, got, c.want)
			}
		})
	}
}

func TestParseGroups(t *testing.T) {
	got := parseGroups("[donor, receiver,,]")
	want := []string{"donor", "receiver"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseGroups = %v, want %v", got, want)
	}
	if got := parseGroups(""); len(got) != 0 {
		t.Fatalf("parseGroups(\"\") = %v, want empty", got)
	}
}
