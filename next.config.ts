import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Route handlers use the Node runtime by default; keep the bundle lean.
  serverExternalPackages: [],
};

export default nextConfig;
