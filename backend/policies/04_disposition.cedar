// Only the assigned receiver of this particular lot may report returned or
// disposed stock. Kept in its own policy because 30_avp.sh skips existing names.
permit(principal, action == PantryPass::Action::"ReportDisposition", resource)
when { resource.receiver == principal };
