import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	devIndicators: false,
	serverExternalPackages: ["@copilotkit/runtime"],
};

export default nextConfig;
