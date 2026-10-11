// Open offers: a lot announced to every receiver has no receiver yet, so policy sees the stand-in user
// "unclaimed" as its receiver. Any receiver may claim it (Accept). The first claim to commit wins:
// DynamoDB's version condition rejects every later claimant. Donors and coordinators cannot claim.
permit(principal, action == PantryPass::Action::"Accept", resource)
when { principal.role == "receiver" && resource.receiver == PantryPass::User::"unclaimed" };
