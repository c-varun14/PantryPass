# PantryPass UI checklist (manual QA + role rehearsal)

Run against the live hosted build. Use synthetic demo lots only. Tick each box when it passes.

## Devices and widths

- [ ] 375px wide: no horizontal page scroll, 16px side gutter
- [ ] 375px: action bar buttons are full width and tappable
- [ ] 768px: lot list and detail still stack cleanly
- [ ] 1280px: split view shows list and detail side by side
- [ ] Light theme: all text and banners readable
- [ ] Dark theme: all text and banners readable, dispute and deny colours distinct
- [ ] Reduced motion (OS setting on): skeletons and `success-pulse` do not animate
- [ ] Keyboard only: every screen reachable, no mouse needed

## Sign-in

- [ ] Donor, receiver and coordinator each sign in and land on their own home
- [ ] Wrong password shows the error banner, password field cleared and focused
- [ ] Empty username or password shows "Enter your username." / "Enter your password."
- [ ] Role switcher: "Choose a different role" returns to the role cards
- [ ] Role switcher: a signed-in role card shows "Signed in" and switches without re-entering a password
- [ ] Coordinator-only `#/exceptions` redirects donor and receiver away

## Donor flow

- [ ] Create lot: pick receiver, set quantity (1 to 500), "Offer lot" opens the lot
- [ ] Create lot with no receivers in directory: submit disabled, message shown
- [ ] Countdown shows "Receiver has MM:SS to respond" on an offered lot
- [ ] Declare handoff: stepper capped at offered quantity, timeline shows "Donor declared handoff of N"
- [ ] Hero card "Report distribution" is disabled, with the hint "Your request would be refused."
- [ ] "Try it anyway" shows the deny panel: Actor, Action ReportDistribution, Decision DENY (Verified Permissions), Request id
- [ ] Toast reads "Refused by Verified Permissions. Nothing changed."
- [ ] Timeline gains a "Refused: ... tried report distribution" row with meta "Verified Permissions said DENY" and the pulse
- [ ] Quantities unchanged after the refusal

## Receiver flow

- [ ] Accept: lot moves from "Needs you" to stage ACCEPTED
- [ ] Report what arrived, matching count: no mismatch banner, quantity shows Received
- [ ] Report what arrived, mismatching count: "Counts disagree" banner and Donor declared / Receiver reported compare boxes shown
- [ ] Report distribution: preview "After this: N remaining" updates, cannot exceed remaining
- [ ] Return or dispose: needs at least 1, cannot exceed remaining, error text shown otherwise
- [ ] Close: blocked with "Distribute, return or dispose the remaining N first." while remaining > 0
- [ ] Close: blocked with "This lot has a count dispute." while disputed
- [ ] Close: succeeds when remaining is 0 and no dispute; timeline shows "Accounted for"
- [ ] Double-tap "Report distribution" or "Confirm and close": only one request sent (button disabled while busy, same idem key)
- [ ] Re-submitting after a success does not change quantities

## Coordinator flow

- [ ] Exceptions list shows three sections: Unanswered pickup, Count dispute, Callback stuck, with counts
- [ ] Empty state "All clear" when nothing is open
- [ ] Unanswered pickup: lot appears after the 90s deadline, banner "Nobody responded in time. No distribution or disposal is assumed."
- [ ] Unanswered pickup: copy says no distribution or disposal is assumed
- [ ] Count dispute: "Resolve dispute" opens the lot, sheet shows both counts
- [ ] Resolve dispute: value below already distributed/returned/disposed shows "Too low" and cannot save
- [ ] Resolve dispute: saving updates received count, dispute clears, Remaining rebalances
- [ ] Callback stuck: "Retry callback" shows "Retrying…" and disables while in flight
- [ ] Callback retry success: toast "Callbacks retried" and list refreshes
- [ ] Callback retry failure: error toast with friendly title, no crash
- [ ] "Retry all callbacks" appears only when a callback is stuck

## Failure states

- [ ] Offline: offline banner appears, existing numbers stay visible, no crash
- [ ] Back online: banner clears and lot refreshes
- [ ] 409 stale version on any action: friendly "changed since you opened it" message, sheet rebuilds with fresh numbers
- [ ] 403 on a lot URL: "Not a participant in this lot" panel
- [ ] 404 on a lot URL: "Lot not found" panel
- [ ] Expired session: user returned to sign-in with a readable message, no stuck spinner
- [ ] Lots list shows skeletons while loading, then "Updated Ns ago"

## Accessibility and performance

- [ ] Focus order on sign-in: username (or password) focused on open
- [ ] Focus order on lot page: header, stepper, quantity, hero, timeline, action bar
- [ ] Sheets trap focus and return focus to the trigger on close
- [ ] Every input has a visible label (`for` matches id); steppers announce their label
- [ ] Status banners and deny panel use role alert/status and are announced
- [ ] Colour is never the only signal (chips and text carry the state)
- [ ] Lighthouse mobile performance, accessibility, best practices, SEO each >= 95
- [ ] Lighthouse mobile run on the hosted URL, not localhost, with the score recorded
