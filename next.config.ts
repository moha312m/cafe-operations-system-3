import type { NextConfig } from "next";

// Verification keeps generated output and historical evidence apart while
// checking the same application and test sources with the normal strict flags.
const integrationVerification = process.env.NEXTCUP_INTEGRATION_VERIFY === "1";

const nextConfig: NextConfig = {
  distDir: integrationVerification ? ".next-integration" : process.env.CASHIER_TOUCH_BUILD === "1" ? ".next-touch" : ".next",
  ...(integrationVerification ? { typescript: { tsconfigPath: "tsconfig.integration.json" } } : {}),
};

export default nextConfig;
