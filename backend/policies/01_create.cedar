// Only an authenticated donor may create a lot. The role comes from the signed
// token (the Lambda derives it from the Cognito group claim), never the body.
permit(principal, action == PantryPass::Action::"CreateLot", resource)
when { principal.role == "donor" };
