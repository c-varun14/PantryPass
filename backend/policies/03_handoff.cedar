// Only the donor of this particular lot may declare the handoff quantity.
permit(principal, action == PantryPass::Action::"DeclareHandoff", resource)
when { resource.donor == principal };
