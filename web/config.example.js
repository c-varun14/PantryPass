// Copy to config.js for local work. infra/70_hosting.sh generates the real one.
// Nothing secret belongs here: subs and the client id are public identifiers.
window.PP_CONFIG = {
  // demoPassword: "optional, set by infra/70_hosting.sh only with PUBLISH_DEMO_PASSWORD=1",
  apiUrl: "https://EXAMPLE.execute-api.ap-south-1.amazonaws.com",
  region: "ap-south-1",
  clientId: "EXAMPLE_CLIENT_ID",
  people: [
    { name: "Asha (donor)", username: "donor1", role: "donor", sub: "DONOR_SUB" },
    { name: "Ravi (receiver)", username: "receiver1", role: "receiver", sub: "RECEIVER_SUB" },
    { name: "Meera (coordinator)", username: "coordinator1", role: "coordinator", sub: "COORDINATOR_SUB" },
  ],
};
