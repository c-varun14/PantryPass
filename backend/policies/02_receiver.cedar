// Only the assigned receiver of this particular lot may accept it, report the
// receipt, report distribution, or close it. resource.receiver is taken from the
// lot item on the server, not from the request.
permit(principal, action in [
    PantryPass::Action::"Accept",
    PantryPass::Action::"Receipt",
    PantryPass::Action::"ReportDistribution",
    PantryPass::Action::"Close"
  ], resource)
when { resource.receiver == principal };
