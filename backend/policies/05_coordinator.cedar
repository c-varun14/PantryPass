// Only a coordinator (role from the signed Cognito group claim) may resolve a
// count dispute or trigger a callback retry.
permit(principal, action in [
    PantryPass::Action::"ResolveDispute",
    PantryPass::Action::"RetryCallbacks"
  ], resource)
when { principal.role == "coordinator" };
