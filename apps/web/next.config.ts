import type { NextConfig } from "next";
import dotenv from "dotenv";

// The workspace keeps local server credentials in the root .env. Load them
// for both `next dev` and `next start`; deployed environments still override
// these values with their explicit runtime configuration.
dotenv.config({ path: new URL("../../.env", import.meta.url), quiet: true });

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: false,
};

export default nextConfig;
