import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source; Next transpiles them.
  transpilePackages: ["@deepblue/core", "@deepblue/db"],
  // Native/wasm server deps must not be bundled by webpack/turbopack.
  // drizzle-orm must be external too: bundling it breaks its interop with
  // the (external) pglite package on Windows.
  serverExternalPackages: ["@electric-sql/pglite", "postgres", "drizzle-orm"],
  // Workspace packages use NodeNext ".js" import specifiers for ".ts" sources.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;
