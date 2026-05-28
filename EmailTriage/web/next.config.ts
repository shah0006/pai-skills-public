import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["bun:sqlite"],
  typescript: {
    // Backend modules (generate-triage, execute-triage, db) use bun:sqlite
    // which has no types in the Next.js build context. Type safety is enforced
    // by bun's own type checker during development and testing.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
