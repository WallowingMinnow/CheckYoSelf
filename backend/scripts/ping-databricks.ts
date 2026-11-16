// Run with: npm run check:databricks
// Proves the Databricks settings in backend/.env really work, step by step.
// Prints settings NAMES and hosts only — never tokens or secrets.
import { OAuthM2MTokenProvider } from "../src/auth";
import { config, missingDatabricksSettings } from "../src/config";
import { callDatabricks, invocationsPath } from "../src/databricks";

function step(text: string) {
  console.log(`- ${text}`);
}

try {
  console.log("Databricks connection check");
  step(`host: ${config.databricksHost || "(missing)"}`);
  step(
    `path: ${config.databricksEndpoint ? invocationsPath(config.invocationsPath, config.databricksEndpoint) : config.invocationsPath}`,
  );
  step(`auth: ${config.authType}`);

  const missing = missingDatabricksSettings();
  if (missing.length > 0) {
    console.error(`Failed: missing in backend/.env: ${missing.join(", ")}`);
    process.exit(1);
  }

  if (config.authType === "oauth-m2m") {
    step(`getting an OAuth token from ${config.workspaceHost}/oidc/v1/token ...`);
    await new OAuthM2MTokenProvider({
      workspaceHost: config.workspaceHost,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    }).getToken();
    step("OAuth token received.");
  }

  step(`calling "${config.databricksEndpoint}" ...`);
  const reply = await callDatabricks([{ role: "user", content: "Reply with just the word OK." }]);
  // Only this line means the connection is VERIFIED. Filled-in settings alone are not proof.
  console.log(`Success. Connection verified. Model replied: ${reply.trim().slice(0, 100)}`);
} catch (err) {
  console.error(`Failed: ${(err as Error).message}`);
  process.exit(1);
}
